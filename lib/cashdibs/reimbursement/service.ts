import { AuditSink, Clock, PayoutNetwork, ReimbursementStore, systemClock } from '../ports';
import { CashdibsError, ReimbursementIntent, VerifiedPickup } from '../types';
import { assertCentavos } from '../units';
import { redact } from '../redact';

/**
 * Off-chain PHP reimbursement of the agent after a VERIFIED pickup.
 *
 * Deliberately has NO dependency on inventory: a reimbursement credit never changes the till's
 * physical cash (only a separate restock does). There is no code path here that could top it up.
 */
export interface ReimbursementDeps { store: ReimbursementStore; network: PayoutNetwork; audit: AuditSink; clock?: Clock; maxAttempts?: number }

export class ReimbursementService {
  private clock: Clock;
  constructor(private d: ReimbursementDeps) { this.clock = d.clock ?? systemClock; }
  private iso() { return new Date(this.clock.now()).toISOString(); }
  private async audit(i: ReimbursementIntent, action: string, from?: string, to?: string, reason?: string) {
    await this.d.audit.record({ correlationId: i.pickupRef, at: this.iso(), actor: 'reimbursement-service', action, from, to, reason });
  }

  /** Create the single durable intent for a verified pickup. Same pickup twice -> same intent. */
  async createIntent(p: VerifiedPickup): Promise<ReimbursementIntent> {
    if (p.status !== 'COLLECTED') throw new CashdibsError('PICKUP_NOT_COLLECTED', 'reimbursement requires a COLLECTED pickup', 409);
    if (!p.evidenceRef) throw new CashdibsError('EVIDENCE_REQUIRED', 'verified-handover evidence reference is required', 409);
    if (!p.pickupRef || !p.agentId) throw new CashdibsError('INVALID_PICKUP', 'pickupRef and agentId are required');
    assertCentavos(p.amountMinor, 'reimbursement amount');
    const now = this.iso();
    const { intent, created } = await this.d.store.createIfAbsent({
      pickupRef: p.pickupRef, agentId: p.agentId, amountMinor: p.amountMinor, reference: `cd-reimb-${p.pickupRef}`,
      evidenceRef: p.evidenceRef, status: 'PENDING', attempts: 0, createdAt: now, updatedAt: now });
    if (created) { await this.audit(intent, 'INTENT_CREATED', 'NONE', 'PENDING'); return intent; }
    if (intent.amountMinor !== p.amountMinor || intent.agentId !== p.agentId) {
      await this.d.store.transition(p.pickupRef, ['PENDING', 'SUBMITTED', 'UNKNOWN', 'SETTLED', 'NEEDS_REVIEW'], { status: intent.status === 'SETTLED' ? 'SETTLED' : 'NEEDS_REVIEW', needsReviewReason: 'second event for same pickup with different amount/agent' });
      throw new CashdibsError('PICKUP_CONFLICT', 'a different reimbursement already exists for this pickup', 409);
    }
    return intent;
  }

  /** Send (or resend with the SAME reference) and settle from the provider's answer. Safe to call repeatedly. */
  async process(pickupRef: string): Promise<ReimbursementIntent> {
    let i = await this.d.store.get(pickupRef);
    if (!i) throw new CashdibsError('INTENT_NOT_FOUND', 'no reimbursement intent for this pickup', 404);
    if (i.status === 'SETTLED' || i.status === 'NEEDS_REVIEW') return i;
    const max = this.d.maxAttempts ?? 5;

    // ask first: after an unknown outcome the provider may already have it
    try {
      const g = await this.d.network.getReimbursement(pickupRef);
      if (g.status !== 'NOT_FOUND') {
        if (g.amountMinor !== undefined && g.amountMinor !== i.amountMinor) return this.review(i, `provider amount ${g.amountMinor} != intent ${i.amountMinor}`);
        return this.apply(i, g.status, g.providerRef);
      }
    } catch (e: any) { return this.unknown(i, e); }

    if (i.attempts >= max) return this.review(i, `exceeded ${max} send attempts`);
    const s = await this.d.store.transition(pickupRef, ['PENDING', 'UNKNOWN'], { attempts: i.attempts + 1 });
    if (!s) return (await this.d.store.get(pickupRef))!;
    i = s;
    try {
      const r = await this.d.network.requestReimbursement(pickupRef, i.amountMinor, i.reference);
      return this.apply(i, r.status, r.providerRef);
    } catch (e: any) { return this.unknown(i, e); } // timeout/5xx: same reference on retry = no double pay
  }

  private async apply(i: ReimbursementIntent, st: string, providerRef?: string): Promise<ReimbursementIntent> {
    if (st === 'SETTLED') {
      const u = await this.d.store.transition(i.pickupRef, ['PENDING', 'SUBMITTED', 'UNKNOWN'], { status: 'SETTLED', providerRef, settledAt: this.iso(), lastError: undefined });
      if (u) await this.audit(u, 'SETTLED', i.status, 'SETTLED');
      return u ?? (await this.d.store.get(i.pickupRef))!;
    }
    if (st === 'REJECTED') return this.review(i, 'provider rejected the reimbursement');
    const u = await this.d.store.transition(i.pickupRef, ['PENDING', 'SUBMITTED', 'UNKNOWN'], { status: 'SUBMITTED', providerRef });
    if (u && i.status !== 'SUBMITTED') await this.audit(u, 'SUBMITTED', i.status, 'SUBMITTED');
    return u ?? (await this.d.store.get(i.pickupRef))!;
  }

  private async unknown(i: ReimbursementIntent, e: any) {
    const u = await this.d.store.transition(i.pickupRef, ['PENDING', 'SUBMITTED', 'UNKNOWN'], { status: 'UNKNOWN', lastError: String(redact(e?.message ?? e)).slice(0, 300) });
    if (u && i.status !== 'UNKNOWN') await this.audit(u, 'UNKNOWN', i.status, 'UNKNOWN', 'provider timeout/error');
    return u ?? (await this.d.store.get(i.pickupRef))!;
  }

  private async review(i: ReimbursementIntent, reason: string) {
    const u = await this.d.store.transition(i.pickupRef, ['PENDING', 'SUBMITTED', 'UNKNOWN'], { status: 'NEEDS_REVIEW', needsReviewReason: reason });
    if (u) await this.audit(u, 'NEEDS_REVIEW', i.status, 'NEEDS_REVIEW', reason);
    return u ?? (await this.d.store.get(i.pickupRef))!;
  }
}

/** Labeled fixture of the partner's reimbursement endpoint. Idempotent on `reference`. */
export class FixturePayoutNetwork implements PayoutNetwork {
  readonly simulated = true;
  private rows = new Map<string, { providerRef: string; status: any; amountMinor: number; reference: string }>();
  failNext: 'timeout' | 'reject' | null = null;
  /** when true, the request is recorded but the response is lost (timeout after the provider acted) */
  loseResponseAfterAccept = false;
  calls = 0;
  async requestReimbursement(pickupRef: string, amountMinor: number, reference: string) {
    this.calls++;
    if (this.failNext === 'timeout') { this.failNext = null; throw new Error('ETIMEDOUT'); }
    let r = this.rows.get(reference);
    if (!r) { r = { providerRef: `fx-${this.rows.size + 1}`, status: this.failNext === 'reject' ? 'REJECTED' : 'SETTLED', amountMinor, reference }; this.failNext = null; this.rows.set(reference, r); }
    if (this.loseResponseAfterAccept) { this.loseResponseAfterAccept = false; throw new Error('ECONNRESET'); }
    return { providerRef: r.providerRef, status: r.status };
  }
  async getReimbursement(pickupRef: string) {
    const r = [...this.rows.values()].find(x => x.reference === `cd-reimb-${pickupRef}`);
    return r ? { providerRef: r.providerRef, status: r.status, amountMinor: r.amountMinor } : { status: 'NOT_FOUND' as const };
  }
  get acceptedCount() { return this.rows.size; }
}
