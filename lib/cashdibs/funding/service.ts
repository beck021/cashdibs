import { randomUUID } from 'node:crypto';
import { AccountLock, AuditSink, Clock, FundingStore, HoldGate, RemittanceSource, Sep31Provider, Signer, StellarObserver, StellarSubmitter, systemClock } from '../ports';
import { memoFromTransaction, normalizeMemo } from '../memo';
import { isAnchorFunded, isAnchorTerminalFailure, providerStatusAdvances } from '../state';
import { preparePayment } from '../stellar/payment';
import { senderPreflight } from '../stellar/preflight';
import { CashdibsError, FundingAttempt, MemoSpec, Remittance } from '../types';
import { parseUnits } from '../units';
import { redact } from '../redact';

export interface FundingConfig {
  passphrase: string;
  usdcIssuer: string;
  usdcCode: string;
  /** max seconds a signed payment may stay valid; also capped by quote and hold expiry */
  maxValiditySec: number;
  /** require the quote to still be valid this long after submit time */
  quoteMarginSec: number;
  /** ledger-close slack past maxTime before "never landed" can be declared */
  deadlineGraceSec: number;
}
export const defaultFundingConfig = (usdcIssuer: string, passphrase: string): FundingConfig =>
  ({ passphrase, usdcIssuer, usdcCode: 'USDC', maxValiditySec: 300, quoteMarginSec: 30, deadlineGraceSec: 15 });

export interface FundingDeps {
  store: FundingStore; holds: HoldGate; remittances: RemittanceSource; provider: Sep31Provider;
  observer: StellarObserver; submitter: StellarSubmitter; signer: Signer; audit: AuditSink; lock: AccountLock;
  config: FundingConfig; clock?: Clock;
}

export type FundResult = { attempt: FundingAttempt; anchorFunded: boolean; explorerUrl?: string };

export class FundingService {
  private clock: Clock;
  constructor(private d: FundingDeps) { this.clock = d.clock ?? systemClock; }

  private async audit(a: { payoutId: string }, action: string, from?: string, to?: string, reason?: string) {
    await this.d.audit.record({ correlationId: a.payoutId, at: new Date(this.clock.now()).toISOString(), actor: 'funding-service', action, from, to, reason });
  }

  /**
   Idempotent per payout: repeated calls resume the SAME signed payment; they never build a second one.
   */
  async fund(payoutId: string, reservationId: string): Promise<FundResult> {
    const existing = await this.d.store.get(payoutId);
    if (existing) {
      if (existing.reservationId !== reservationId) throw new CashdibsError('RESERVATION_MISMATCH', 'payout is already bound to a different reservation', 409);
      return this.resume(existing);
    }
    const attempt = await this.prepare(payoutId, reservationId);
    return this.resume(attempt);
  }

  private async prepare(payoutId: string, reservationId: string): Promise<FundingAttempt> {
    const d = this.d, cfg = d.config;
    const rem = await d.remittances.getByPayoutId(payoutId);
    if (!rem) throw new CashdibsError('REMITTANCE_MISSING', 'no recorded sender funding/quote for this payout; CAD funding must be recorded first', 409);
    if (rem.providerMode !== d.provider.mode) throw new CashdibsError('PROVIDER_MODE_MISMATCH', `remittance was created in ${rem.providerMode} mode`, 409);
    if (rem.assetCode !== cfg.usdcCode || rem.assetIssuer !== cfg.usdcIssuer) throw new CashdibsError('WRONG_ASSET', 'remittance asset is not the configured Testnet USDC', 409);
    const need = parseUnits(rem.usdcAmountUnits, 'usdcAmountUnits');

    // 1. shared hold gate: the cash hold must exist and be CONFIRMED before any USDC moves
    const { state, hold } = await d.holds.getHold(reservationId);
    if (state !== 'CONFIRMED' || !hold) throw new CashdibsError('HOLD_NOT_CONFIRMED', `cash hold is ${state}; USDC is only sent against a CONFIRMED hold`, 409);
    const nowMs = this.clock.now();
    if (Date.parse(hold.expiresAt) <= nowMs) throw new CashdibsError('HOLD_EXPIRED', 'cash hold has expired', 409);
    if (hold.phpAmountMinor !== rem.phpQuotedCentavos) throw new CashdibsError('HOLD_AMOUNT_MISMATCH', 'hold amount differs from the quoted PHP payout', 409);

    // 2. quote must still be good with margin
    const quoteExp = Date.parse(rem.quoteExpiresAt);
    if (quoteExp - nowMs < cfg.quoteMarginSec * 1000) throw new CashdibsError('QUOTE_EXPIRED', 'SEP-38 quote has expired or is about to', 409);

    // 3. provider instructions are re-read and validated field by field
    const pay = await d.provider.getPayment(rem.sep31PaymentId);
    if (isAnchorTerminalFailure(pay.status)) throw new CashdibsError('ANCHOR_TERMINAL', `anchor payment is ${pay.status}`, 409);
    if (pay.status !== 'pending_sender' && pay.status !== 'pending_stellar') throw new CashdibsError('ANCHOR_NOT_AWAITING_FUNDS', `anchor payment is ${pay.status}`, 409);
    const ins = await d.provider.getFundingInstructions(rem.sep31PaymentId);
    if (ins.assetCode !== cfg.usdcCode || ins.assetIssuer !== cfg.usdcIssuer) throw new CashdibsError('WRONG_ASSET', 'anchor asked for a different asset or issuer', 409);
    if (ins.amountUnits !== rem.usdcAmountUnits) throw new CashdibsError('AMOUNT_MISMATCH', 'anchor amount differs from the quoted USDC amount', 409);
    const memo = normalizeMemo(ins.memo);

    // 4. claim the hold so the expiry sweeper cannot release it while USDC is in flight
    const attemptId = randomUUID();
    if (!(await d.holds.claimForFunding(reservationId, attemptId))) throw new CashdibsError('HOLD_CLAIM_LOST', 'could not claim the hold for funding (state changed)', 409);

    try {
      return await d.lock.withLock(d.signer.publicKey, async () => {
        const pre = await senderPreflight(d.observer, d.signer.publicKey, cfg.usdcIssuer, need);
        if (!pre.ok) throw new CashdibsError('SENDER_PREFLIGHT_FAILED', pre.problems.join('; '), 409);
        const snap = await d.observer.getAccount(d.signer.publicKey, cfg.usdcIssuer);
        const nowSec = Math.floor(nowMs / 1000);
        const maxTime = Math.min(nowSec + cfg.maxValiditySec, Math.floor(quoteExp / 1000) - cfg.quoteMarginSec, Math.floor(Date.parse(hold.expiresAt) / 1000));
        const p = preparePayment({ signer: d.signer, destination: ins.destination, assetCode: ins.assetCode, assetIssuer: ins.assetIssuer, amountUnits: ins.amountUnits,
          memo, sequence: snap.sequence, maxTimeSec: maxTime, nowSec, passphrase: cfg.passphrase });
        const iso = new Date(nowMs).toISOString();
        const row: FundingAttempt = {
          payoutId, attemptId, status: 'PREPARED', reservationId, anchorPaymentId: rem.sep31PaymentId, sourceAccount: d.signer.publicKey,
          destination: ins.destination, memo, assetCode: ins.assetCode, assetIssuer: ins.assetIssuer, amountUnits: ins.amountUnits,
          sequence: (BigInt(snap.sequence) + 1n).toString(), maxTime: p.maxTime, quoteExpiresAt: rem.quoteExpiresAt,
          envelopeXdr: p.envelopeXdr, txHash: p.hash, missesAfterDeadline: 0, createdAt: iso, updatedAt: iso,
        };
        // 5. persist envelope + hash BEFORE any submit
        const { attempt, created } = await d.store.createIfAbsent(row);
        if (created) await this.audit(attempt, 'PREPARED', 'NOT_SUBMITTED', 'PREPARED');
        else await d.holds.releaseFundingClaim(reservationId, attemptId); // raced: another worker's attempt stands
        return attempt;
      });
    } catch (e) {
      await d.holds.releaseFundingClaim(reservationId, attemptId).catch(() => undefined); // nothing was persisted or sent
      throw e;
    }
  }

  /** Submit (if not yet) then reconcile. Safe to call any number of times. */
  async resume(a: FundingAttempt): Promise<FundResult> {
    if (a.status === 'CONFIRMED') return this.result(await this.refreshProvider(a));
    if (a.status === 'FAILED') return this.result(a);
    if (a.status === 'PREPARED') {
      const moved = await this.d.store.transition(a.payoutId, ['PREPARED'], { status: 'SUBMITTED', submittedAt: new Date(this.clock.now()).toISOString() });
      if (moved) { await this.audit(a, 'SUBMIT', 'PREPARED', 'SUBMITTED'); await this.submit(moved); }
    } else if (a.status === 'SUBMITTED' || a.status === 'UNKNOWN') {
      // re-sending the identical signed envelope is idempotent: same hash, same sequence, cannot pay twice
      await this.submit(a);
    }
    return this.reconcile(a.payoutId);
  }

  private async submit(a: FundingAttempt): Promise<void> {
    try {
      const r = await this.d.submitter.submit(a.envelopeXdr);
      if (r.hash !== a.txHash) {
        await this.d.store.transition(a.payoutId, ['SUBMITTED', 'UNKNOWN'], { status: 'UNKNOWN', needsOperatorReason: `network returned hash ${r.hash} != persisted ${a.txHash}` });
      }
    } catch (e: any) {
      // ANY error (timeout, 5xx, tx_bad_seq that may mean "already landed") is not proof of failure.
      await this.d.store.transition(a.payoutId, ['SUBMITTED', 'UNKNOWN'], { status: 'UNKNOWN', lastError: String(redact(e?.message ?? e)).slice(0, 300) });
    }
  }

  /** Decide the outcome from ledger evidence only. */
  async reconcile(payoutId: string): Promise<FundResult> {
    const d = this.d;
    let a = (await d.store.get(payoutId))!;
    if (a.status === 'CONFIRMED' || a.status === 'FAILED') return this.result(await this.refreshProvider(a));
    const nowSec = Math.floor(this.clock.now() / 1000);
    let receipt;
    try { receipt = await d.observer.getReceipt(a.txHash); }
    catch (e: any) { return this.result(await this.setUnknown(a, `Horizon unreachable: ${e?.message ?? e}`)); }

    if (receipt) {
      if (!receipt.successful) return this.result(await this.fail(a, 'ledger result: transaction failed'));
      const mismatch = this.verify(a, receipt);
      if (mismatch) return this.result((await d.store.transition(payoutId, ['PREPARED', 'SUBMITTED', 'UNKNOWN'], { status: 'UNKNOWN', needsOperatorReason: mismatch })) ?? a);
      const c = await d.store.transition(payoutId, ['PREPARED', 'SUBMITTED', 'UNKNOWN'], { status: 'CONFIRMED', ledger: receipt.ledger, stellarVerifiedAt: new Date(this.clock.now()).toISOString(), confirmedAt: new Date(this.clock.now()).toISOString(), needsOperatorReason: undefined });
      if (c) { await this.audit(c, 'CONFIRMED', a.status, 'CONFIRMED'); a = c; } else a = (await d.store.get(payoutId))!;
      return this.result(await this.refreshProvider(a));
    }

    // not found: only "cannot ever land" proves failure
    if (nowSec > a.maxTime + d.config.deadlineGraceSec) {
      let closeT = 0; try { closeT = await d.observer.latestLedgerCloseTime(); } catch { /* stay unknown */ }
      if (closeT > a.maxTime) {
        const misses = a.missesAfterDeadline + 1;
        if (misses >= 2) return this.result(await this.fail(a, 'not on ledger after maxTime expired (two consecutive checks)'));
        a = (await d.store.transition(payoutId, ['PREPARED', 'SUBMITTED', 'UNKNOWN'], { missesAfterDeadline: misses })) ?? a;
        return this.result(a.status === 'PREPARED' || a.status === 'SUBMITTED' ? ((await this.setUnknown(a, 'awaiting second post-deadline check')) ) : a);
      }
    }
    return this.result(await this.setUnknown(a, 'not yet visible on Horizon'));
  }

  private verify(a: FundingAttempt, r: import('../ports').TxReceipt): string | null {
    if (r.source !== a.sourceAccount) return 'on-chain source differs from the prepared payment';
    if (r.operationCount !== 1 || r.payments.length !== 1) return 'on-chain transaction does not have exactly one payment operation';
    const p = r.payments[0];
    if (p.to !== a.destination) return 'on-chain destination differs from anchor instructions';
    if (p.assetCode !== a.assetCode || p.assetIssuer !== a.assetIssuer) return 'on-chain asset/issuer differs';
    if (p.amountUnits !== a.amountUnits) return 'on-chain amount differs';
    const m = r.memo; if (!m || m.type !== a.memo.type || m.value !== a.memo.value) return 'on-chain memo differs';
    return null;
  }

  private async setUnknown(a: FundingAttempt, reason: string) {
    const u = await this.d.store.transition(a.payoutId, ['PREPARED', 'SUBMITTED', 'UNKNOWN'], { status: 'UNKNOWN', lastError: reason.slice(0, 300) });
    if (u && a.status !== 'UNKNOWN') await this.audit(u, 'UNKNOWN', a.status, 'UNKNOWN', reason);
    return u ?? (await this.d.store.get(a.payoutId))!;
  }

  private async fail(a: FundingAttempt, reason: string) {
    const f = await this.d.store.transition(a.payoutId, ['PREPARED', 'SUBMITTED', 'UNKNOWN'], { status: 'FAILED', failureReason: reason });
    if (f) { await this.audit(f, 'FAILED', a.status, 'FAILED', reason); await this.d.holds.releaseFundingClaim(a.reservationId, a.attemptId); }
    return f ?? (await this.d.store.get(a.payoutId))!;
  }

  /** Record the anchor's view. Never lowers or regresses; never decides funding by itself. */
  async refreshProvider(a: FundingAttempt): Promise<FundingAttempt> {
    try {
      const p = await this.d.provider.getPayment(a.anchorPaymentId);
      if (!providerStatusAdvances(a.providerStatus, p.status)) return a;
      const patch = { providerStatus: p.status, providerStatusAt: p.statusEventAt };
      const u = await this.d.store.transition(a.payoutId, [a.status], patch);
      return u ?? a;
    } catch { return a; }
  }

  private result(a: FundingAttempt): FundResult {
    return { attempt: a, anchorFunded: a.status === 'CONFIRMED' && !!a.providerStatus && isAnchorFunded(a.providerStatus),
      explorerUrl: a.status === 'CONFIRMED' ? `https://stellar.expert/explorer/testnet/tx/${a.txHash}` : undefined };
  }
}
