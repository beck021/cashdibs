import { Keypair, Operation, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { AccountSnapshot, HoldGate, HoldState, RemittanceSource, StellarObserver, StellarSubmitter, TxReceipt } from '../lib/cashdibs/ports';
import { memoFromTransaction } from '../lib/cashdibs/memo';
import { TESTNET_PASSPHRASE, KeypairSigner } from '../lib/cashdibs/stellar/payment';
import { FixtureSep31Provider } from '../lib/cashdibs/sep31/fixture';
import { MemoryAccountLock, MemoryAudit, MemoryFundingStore } from '../lib/cashdibs/stores/memory';
import { FundingService, defaultFundingConfig } from '../lib/cashdibs/funding/service';
import { ConfirmedHold, Remittance } from '../lib/cashdibs/types';
import { horizonAmountToUnits } from '../lib/cashdibs/units';

export const ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

export class FakeClock { constructor(public ms = Date.UTC(2026, 10, 18, 0, 0, 0)) {} now() { return this.ms; } adv(s: number) { this.ms += s * 1000; } }

export class FakeChain implements StellarObserver, StellarSubmitter {
  ledger = new Map<string, TxReceipt>();
  usdc = 1_000_000_000n; xlm = 100_000_000n; trustline = true; seq = 1000n;
  /** what submit() does: 'ok' lands; 'timeout-landed' lands then throws; 'timeout-lost' throws w/o landing; 'reject' throws w/o landing */
  mode: 'ok' | 'timeout-landed' | 'timeout-lost' | 'reject' | 'fail-on-ledger' = 'ok';
  horizonDown = false; receiptDown = false; closeTime = 0; submits = 0; lastCloseOffset = 0;
  async getAccount(_a: string, _i: string): Promise<AccountSnapshot> {
    if (this.horizonDown) throw new Error('horizon down');
    return { sequence: this.seq.toString(), xlmStroops: this.xlm, usdcUnits: this.usdc, hasUsdcTrustline: this.trustline };
  }
  async getReceipt(hash: string) { if (this.horizonDown || this.receiptDown) throw new Error('horizon down'); return this.ledger.get(hash) ?? null; }
  async latestLedgerCloseTime() { return this.closeTime; }
  async submit(xdr: string) {
    this.submits++;
    const tx = TransactionBuilder.fromXDR(xdr, TESTNET_PASSPHRASE) as Transaction;
    if (tx.signatures.length !== 1) throw new Error('unsigned');
    const hash = tx.hash().toString('hex');
    const land = (ok = true) => {
      if (this.ledger.has(hash)) return;
      const ops = tx.operations as any[];
      this.ledger.set(hash, { hash, successful: ok, ledger: 123, source: tx.source, memo: memoFromTransaction(tx.memo), operationCount: ops.length,
        payments: ops.filter(o => o.type === 'payment').map(o => ({ to: o.destination, assetCode: o.asset.code, assetIssuer: o.asset.issuer, amountUnits: horizonAmountToUnits(o.amount).toString() })) });
      if (ok) this.usdc -= horizonAmountToUnits(ops[0].amount);
    };
    if (this.mode === 'ok') { land(); return { hash, ledger: 123 }; }
    if (this.mode === 'fail-on-ledger') { land(false); throw new Error('tx_failed'); }
    if (this.mode === 'timeout-landed') { land(); throw new Error('ETIMEDOUT'); }
    if (this.mode === 'reject') throw new Error('tx_bad_seq');
    throw new Error('ETIMEDOUT');
  }
}

export class FakeHolds implements HoldGate {
  state: HoldState = 'CONFIRMED'; claims: string[] = []; released: string[] = []; claimOk = true;
  constructor(public hold: ConfirmedHold) {}
  async getHold() { return { state: this.state, hold: this.state === 'MISSING' ? undefined : this.hold }; }
  async claimForFunding(_r: string, a: string) { if (!this.claimOk || this.state !== 'CONFIRMED') return false; this.claims.push(a); return true; }
  async releaseFundingClaim(_r: string, a: string) { this.released.push(a); }
}

export function build(opts: { php?: number; usdc?: string } = {}) {
  const clock = new FakeClock();
  const sender = Keypair.random(), anchor = Keypair.random();
  const provider = new FixtureSep31Provider(anchor.publicKey(), ISSUER, clock);
  const chain = new FakeChain();
  const holds = new FakeHolds({ reservationId: 'res-1', agentId: 'agent-a', phpAmountMinor: opts.php ?? 1_500_000, expiresAt: new Date(clock.now() + 15 * 60_000).toISOString() });
  const store = new MemoryFundingStore(); const audit = new MemoryAudit();
  const rem: Remittance = { payoutId: 'demo-ca-ph-001', providerMode: 'fixture', quoteId: 'q', quoteExpiresAt: new Date(clock.now() + 10 * 60_000).toISOString(), cadTotalCents: 4000, phpQuotedCentavos: opts.php ?? 1_500_000,
    usdcAmountUnits: opts.usdc ?? '250000000', assetCode: 'USDC', assetIssuer: ISSUER, sep31PaymentId: '', createdAt: new Date(clock.now()).toISOString() };
  const remittances: RemittanceSource = { getByPayoutId: async id => (id === rem.payoutId && rem.sep31PaymentId ? { ...rem } : null) };
  const svc = new FundingService({ store, holds, remittances, provider, observer: chain, submitter: chain, signer: new KeypairSigner(sender), audit, lock: new MemoryAccountLock(), config: defaultFundingConfig(ISSUER, TESTNET_PASSPHRASE), clock });
  return { clock, sender, anchor, provider, chain, holds, store, audit, rem, svc, remittances,
    async init() { const p = await provider.createPayment({ payoutId: rem.payoutId, idempotencyKey: rem.payoutId, usdcAmountUnits: rem.usdcAmountUnits, assetCode: 'USDC', assetIssuer: ISSUER, phpQuotedCentavos: rem.phpQuotedCentavos }, 'q'); rem.sep31PaymentId = p.id; return p; } };
}
