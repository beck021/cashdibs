import { AccountLock, AuditSink, FundingStore, ReimbursementStore } from '../ports';
import { AuditRecord, FundingAttempt, FundingStatus, ReimbursementIntent, ReimbursementStatus } from '../types';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

/** Test/demo store. A real deployment replaces this with Prisma (see docs/cashdibs/prisma-fragment.md). */
export class MemoryFundingStore implements FundingStore {
  protected rows = new Map<string, FundingAttempt>();
  protected persist(): void {}
  async get(id: string) { const r = this.rows.get(id); return r ? clone(r) : null; }
  async createIfAbsent(a: FundingAttempt) {
    const ex = this.rows.get(a.payoutId);
    if (ex) return { attempt: clone(ex), created: false };
    this.rows.set(a.payoutId, clone(a)); this.persist();
    return { attempt: clone(a), created: true };
  }
  async transition(id: string, from: FundingStatus[], patch: Partial<FundingAttempt>) {
    const cur = this.rows.get(id);
    if (!cur || !from.includes(cur.status)) return null;
    const next = { ...cur, ...patch, payoutId: cur.payoutId, updatedAt: new Date().toISOString() };
    this.rows.set(id, next); this.persist();
    return clone(next);
  }
}

export class MemoryReimbursementStore implements ReimbursementStore {
  protected rows = new Map<string, ReimbursementIntent>();
  protected persist(): void {}
  async get(ref: string) { const r = this.rows.get(ref); return r ? clone(r) : null; }
  async createIfAbsent(i: ReimbursementIntent) {
    const ex = this.rows.get(i.pickupRef);
    if (ex) return { intent: clone(ex), created: false };
    this.rows.set(i.pickupRef, clone(i)); this.persist();
    return { intent: clone(i), created: true };
  }
  async transition(ref: string, from: ReimbursementStatus[], patch: Partial<ReimbursementIntent>) {
    const cur = this.rows.get(ref);
    if (!cur || !from.includes(cur.status)) return null;
    const next = { ...cur, ...patch, pickupRef: cur.pickupRef, updatedAt: new Date().toISOString() };
    this.rows.set(ref, next); this.persist();
    return clone(next);
  }
}

export class MemoryAudit implements AuditSink {
  readonly records: AuditRecord[] = [];
  async record(r: AuditRecord) { this.records.push(clone(r)); }
}

/** In-process per-account mutex (serialises sequence-number use). Multi-instance deployments need a DB advisory lock. */
export class MemoryAccountLock implements AccountLock {
  private tails = new Map<string, Promise<unknown>>();
  async withLock<T>(account: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(account) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.tails.set(account, run.catch(() => undefined));
    return run;
  }
}
