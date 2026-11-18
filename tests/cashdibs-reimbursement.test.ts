import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { FixturePayoutNetwork, ReimbursementService } from '../lib/cashdibs/reimbursement/service';
import { MemoryAudit, MemoryReimbursementStore } from '../lib/cashdibs/stores/memory';
import { VerifiedPickup } from '../lib/cashdibs/types';

const pickup: VerifiedPickup = { pickupRef: 'pk-1', agentId: 'agent-a', amountMinor: 1_500_000, status: 'COLLECTED', evidenceRef: 'ev-1', collectedAt: '2026-11-18T01:00:00Z' };
const mk = () => { const net = new FixturePayoutNetwork(); const store = new MemoryReimbursementStore(); const audit = new MemoryAudit(); return { net, store, audit, svc: new ReimbursementService({ store, network: net, audit }) }; };

describe('intent creation', () => {
  it('creates exactly one PENDING intent per pickup, even when the event is delivered twice', async () => {
    const t = mk(); const a = await t.svc.createIntent(pickup); const b = await t.svc.createIntent(pickup);
    expect(a.status).toBe('PENDING'); expect(b.reference).toBe(a.reference); expect(t.audit.records.filter(r => r.action === 'INTENT_CREATED').length).toBe(1);
  });
  it.each(['WAITING', 'READY', 'IN_PROGRESS', 'NEEDS_REVIEW'])('refuses a %s pickup', async s => {
    await expect(mk().svc.createIntent({ ...pickup, status: s as any })).rejects.toMatchObject({ code: 'PICKUP_NOT_COLLECTED' });
  });
  it('requires evidence', async () => { await expect(mk().svc.createIntent({ ...pickup, evidenceRef: '' })).rejects.toMatchObject({ code: 'EVIDENCE_REQUIRED' }); });
  it.each([0, -5, 1.5, NaN])('rejects amount %s', async n => { await expect(mk().svc.createIntent({ ...pickup, amountMinor: n })).rejects.toMatchObject({ code: 'INVALID_AMOUNT' }); });
  it('a conflicting second event for the same pickup goes to NEEDS_REVIEW and does not create a second intent', async () => {
    const t = mk(); await t.svc.createIntent(pickup);
    await expect(t.svc.createIntent({ ...pickup, amountMinor: 2_000_000 })).rejects.toMatchObject({ code: 'PICKUP_CONFLICT' });
    expect((await t.store.get('pk-1'))!.status).toBe('NEEDS_REVIEW');
    expect((await t.store.get('pk-1'))!.amountMinor).toBe(1_500_000);
  });
});

describe('settlement', () => {
  it('settles once; re-processing never sends again', async () => {
    const t = mk(); await t.svc.createIntent(pickup);
    const a = await t.svc.process('pk-1'); const b = await t.svc.process('pk-1');
    expect(a.status).toBe('SETTLED'); expect(b.status).toBe('SETTLED'); expect(t.net.calls).toBe(1); expect(t.net.acceptedCount).toBe(1);
  });
  it('timeout before the provider acted: UNKNOWN, then retry with the same reference settles once', async () => {
    const t = mk(); await t.svc.createIntent(pickup); t.net.failNext = 'timeout';
    expect((await t.svc.process('pk-1')).status).toBe('UNKNOWN');
    expect((await t.svc.process('pk-1')).status).toBe('SETTLED'); expect(t.net.acceptedCount).toBe(1);
  });
  it('response lost AFTER the provider accepted: reconciled via getReimbursement, no duplicate', async () => {
    const t = mk(); await t.svc.createIntent(pickup); t.net.loseResponseAfterAccept = true;
    expect((await t.svc.process('pk-1')).status).toBe('UNKNOWN');
    const s = await t.svc.process('pk-1'); expect(s.status).toBe('SETTLED'); expect(t.net.acceptedCount).toBe(1); expect(t.net.calls).toBe(1);
  });
  it('provider rejection -> NEEDS_REVIEW (not silently retried)', async () => {
    const t = mk(); await t.svc.createIntent(pickup); t.net.failNext = 'reject';
    const r = await t.svc.process('pk-1'); expect(r.status).toBe('NEEDS_REVIEW'); expect(r.needsReviewReason).toMatch(/rejected/);
    await t.svc.process('pk-1'); expect(t.net.calls).toBe(1);
  });
  it('gives up after maxAttempts repeated timeouts', async () => {
    const net = new FixturePayoutNetwork(); const store = new MemoryReimbursementStore();
    const svc = new ReimbursementService({ store, network: net, audit: new MemoryAudit(), maxAttempts: 2 });
    await svc.createIntent(pickup);
    for (let i = 0; i < 3; i++) { net.failNext = 'timeout'; await svc.process('pk-1'); }
    expect((await store.get('pk-1'))!.status).toBe('NEEDS_REVIEW');
  });
  it('provider reporting a different amount -> NEEDS_REVIEW', async () => {
    const t = mk(); await t.svc.createIntent(pickup);
    t.net.getReimbursement = async () => ({ status: 'SETTLED', providerRef: 'x', amountMinor: 1 });
    expect((await t.svc.process('pk-1')).status).toBe('NEEDS_REVIEW');
  });
  it('concurrent process() calls settle once', async () => {
    const t = mk(); await t.svc.createIntent(pickup);
    await Promise.all([t.svc.process('pk-1'), t.svc.process('pk-1'), t.svc.process('pk-1')]);
    expect(t.net.acceptedCount).toBe(1); expect((await t.store.get('pk-1'))!.status).toBe('SETTLED');
  });
});

describe('never tops up the till', () => {
  it('the reimbursement module has no inventory dependency at all', () => {
    const src = readFileSync('lib/cashdibs/reimbursement/service.ts', 'utf8');
    const imports = src.split('\n').filter(l => l.startsWith('import'));
    expect(imports.join('\n')).not.toMatch(/inventory|prisma|CashInventory|onHand/i);
    expect(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')).not.toMatch(/onHandMinor|heldMinor|holdCashAtomic/);
  });
});
