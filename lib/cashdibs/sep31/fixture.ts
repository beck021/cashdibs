import { createHash } from 'node:crypto';
import { Clock, Sep31CreateInput, Sep31Provider, systemClock } from '../ports';
import { CashdibsError, FundingInstructions, Sep31Payment, Sep31Quote, Sep31Status } from '../types';

/**
 * LABELED FIXTURE. Stands in for the receiving anchor until partner access exists.
 * Everything it returns carries simulated:true; UI, README and the demo video must say so.
 * It does NOT verify anything on Stellar by itself: the demo calls markStellarPaid() only after
 * our own receipt check passed, which models "anchor matched the payment".
 */
export class FixtureSep31Provider implements Sep31Provider {
  readonly mode = 'fixture' as const;
  private payments = new Map<string, Sep31Payment>();
  private byKey = new Map<string, string>();
  private n = 0;
  constructor(
    private anchorAccount: string,
    private usdcIssuer: string,
    private clock: Clock = systemClock,
    private quoteTtlMs = 10 * 60_000
  ) {}

  async getQuote(): Promise<Sep31Quote> {
    return { quoteId: `fixture-q-${++this.n}`, expiresAt: new Date(this.clock.now() + this.quoteTtlMs).toISOString(), simulated: true };
  }

  async createPayment(input: Sep31CreateInput, quoteRef: string): Promise<Sep31Payment> {
    const prior = this.byKey.get(input.idempotencyKey);
    if (prior) return this.payments.get(prior)!; // idempotent create
    if (input.assetIssuer !== this.usdcIssuer) throw new CashdibsError('ASSET_NOT_SUPPORTED', 'fixture only accepts the configured USDC issuer');
    const id = `fixture-tx-${++this.n}`;
    const memo = 'cd' + createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 20); // 22 bytes
    const instructions: FundingInstructions = {
      destination: this.anchorAccount, assetCode: input.assetCode, assetIssuer: input.assetIssuer,
      amountUnits: input.usdcAmountUnits, memo: { type: 'text', value: memo },
    };
    const p: Sep31Payment = {
      id, status: 'pending_sender', rawStatus: 'pending_sender', statusEventAt: new Date(this.clock.now()).toISOString(),
      instructions, quoteId: quoteRef, simulated: true,
    };
    this.payments.set(id, p); this.byKey.set(input.idempotencyKey, id);
    return { ...p };
  }

  async getPayment(id: string): Promise<Sep31Payment> {
    const p = this.payments.get(id);
    if (!p) throw new CashdibsError('SEP31_NOT_FOUND', `no such payment ${id}`, 404);
    return { ...p };
  }
  async getFundingInstructions(id: string): Promise<FundingInstructions> {
    const p = await this.getPayment(id);
    if (!p.instructions) throw new CashdibsError('SEP31_NO_INSTRUCTIONS', 'payment has no funding instructions');
    return p.instructions;
  }

  // ---- test/demo controls (not part of the Sep31Provider interface) ----
  setStatus(id: string, status: Sep31Status, extra: Partial<Sep31Payment> = {}) {
    const p = this.payments.get(id); if (!p) throw new Error('unknown payment');
    Object.assign(p, extra, { status, rawStatus: status, statusEventAt: new Date(this.clock.now()).toISOString() });
  }
  markStellarPaid(id: string, stellarTransactionId: string) {
    this.setStatus(id, 'pending_receiver', { stellarTransactionId });
  }
}
