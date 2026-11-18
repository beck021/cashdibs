import { describe, expect, it } from 'vitest';
import { build } from './cashdibs-harness';

const P = 'demo-ca-ph-001', R = 'res-1';

describe('happy path', () => {
  it('prepares, persists, submits, confirms, and reports anchor status separately', async () => {
    const t = await build(); const pay = await t.init();
    const r = await t.svc.fund(P, R);
    expect(r.attempt.status).toBe('CONFIRMED');
    expect(r.attempt.ledger).toBe(123);
    expect(r.anchorFunded).toBe(false); // ledger success alone is NOT anchor match
    expect(r.explorerUrl).toContain(r.attempt.txHash);
    t.provider.markStellarPaid(pay.id, r.attempt.txHash);
    const again = await t.svc.fund(P, R);
    expect(again.anchorFunded).toBe(true);
    expect(t.chain.submits).toBeGreaterThanOrEqual(1);
    expect(t.chain.ledger.size).toBe(1);
  });
  it('persists envelope and hash before the first submit', async () => {
    const t = await build(); await t.init();
    let seen: any = null;
    const orig = t.chain.submit.bind(t.chain);
    t.chain.submit = async (x: string) => { seen = await t.store.get(P); return orig(x); };
    await t.svc.fund(P, R);
    expect(seen.status).toBe('SUBMITTED'); expect(seen.envelopeXdr.length).toBeGreaterThan(50); expect(seen.txHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('gates (nothing is signed or sent when a gate fails)', () => {
  const gate = async (mut: (t: Awaited<ReturnType<typeof build>>) => void | Promise<void>, code: string) => {
    const t = await build(); await t.init(); await mut(t);
    await expect(t.svc.fund(P, R)).rejects.toMatchObject({ code });
    expect(t.chain.submits).toBe(0); expect(await t.store.get(P)).toBeNull();
    return t;
  };
  it('requires a recorded remittance', async () => { const t = await build(); await expect(t.svc.fund(P, R)).rejects.toMatchObject({ code: 'REMITTANCE_MISSING' }); });
  it('hold HELD (not CONFIRMED)', () => gate(t => { t.holds.state = 'HELD'; }, 'HOLD_NOT_CONFIRMED'));
  it('hold RELEASED', () => gate(t => { t.holds.state = 'RELEASED'; }, 'HOLD_NOT_CONFIRMED'));
  it('hold missing', () => gate(t => { t.holds.state = 'MISSING'; }, 'HOLD_NOT_CONFIRMED'));
  it('hold expired before funding', () => gate(t => t.clock.adv(16 * 60), 'HOLD_EXPIRED'));
  it('quote expired', () => gate(t => { t.rem.quoteExpiresAt = new Date(t.clock.now() + 5_000).toISOString(); }, 'QUOTE_EXPIRED'));
  it('hold amount differs from quote', () => gate(t => { t.holds.hold.phpAmountMinor = 1; }, 'HOLD_AMOUNT_MISMATCH'));
  it('anchor amount differs', () => gate(async t => { t.rem.usdcAmountUnits = '250000001'; }, 'AMOUNT_MISMATCH'));
  it('anchor payment already terminal', () => gate(t => t.provider.setStatus(t.rem.sep31PaymentId, 'expired'), 'ANCHOR_TERMINAL'));
  it('anchor payment not awaiting funds', () => gate(t => t.provider.setStatus(t.rem.sep31PaymentId, 'pending_receiver'), 'ANCHOR_NOT_AWAITING_FUNDS'));
  it('wrong asset in remittance', () => gate(t => { t.rem.assetIssuer = t.anchor.publicKey(); }, 'WRONG_ASSET'));
  it('no trustline', async () => { const t = await gate(t => { t.chain.trustline = false; }, 'SENDER_PREFLIGHT_FAILED'); expect(t.holds.released.length).toBe(1); });
  it('insufficient USDC', async () => { const t = await gate(t => { t.chain.usdc = 1n; }, 'SENDER_PREFLIGHT_FAILED'); expect(t.holds.released.length).toBe(1); });
  it('low XLM', () => gate(t => { t.chain.xlm = 1n; }, 'SENDER_PREFLIGHT_FAILED'));
  it('hold claim lost', () => gate(t => { t.holds.claimOk = false; }, 'HOLD_CLAIM_LOST'));
  it('bound to a different reservation', async () => {
    const t = await build(); await t.init(); await t.svc.fund(P, R);
    await expect(t.svc.fund(P, 'other')).rejects.toMatchObject({ code: 'RESERVATION_MISMATCH' });
  });
});

describe('unknown outcomes never create a second payment', () => {
  it('timeout but landed -> reconciles to CONFIRMED with exactly one ledger entry', async () => {
    const t = await build(); await t.init(); t.chain.mode = 'timeout-landed';
    const r = await t.svc.fund(P, R);
    expect(r.attempt.status).toBe('CONFIRMED'); expect(t.chain.ledger.size).toBe(1);
  });
  it('timeout, not yet visible -> UNKNOWN; retry resubmits the SAME hash and lands once', async () => {
    const t = await build(); await t.init(); t.chain.mode = 'timeout-lost';
    const a = await t.svc.fund(P, R); expect(a.attempt.status).toBe('UNKNOWN');
    const hash = a.attempt.txHash; t.chain.mode = 'ok';
    const b = await t.svc.fund(P, R);
    expect(b.attempt.status).toBe('CONFIRMED'); expect(b.attempt.txHash).toBe(hash); expect(t.chain.ledger.size).toBe(1);
    expect(t.holds.claims.length).toBe(1); // one attempt, one claim
  });
  it('tx_bad_seq style error is NOT treated as failure', async () => {
    const t = await build(); await t.init(); t.chain.mode = 'reject';
    const r = await t.svc.fund(P, R); expect(r.attempt.status).toBe('UNKNOWN'); expect(t.holds.released.length).toBe(0);
  });
  it('Horizon down during reconcile stays UNKNOWN', async () => {
    const t = await build(); await t.init(); t.chain.mode = 'timeout-lost'; t.chain.receiptDown = true;
    const r = await t.svc.fund(P, R); expect(r.attempt.status).toBe('UNKNOWN'); expect(t.holds.released.length).toBe(0);
  });
  it('FAILED only after maxTime + two post-deadline checks with ledger past maxTime', async () => {
    const t = await build(); await t.init(); t.chain.mode = 'timeout-lost';
    const a = await t.svc.fund(P, R); expect(a.attempt.status).toBe('UNKNOWN');
    t.clock.adv(400); // past maxTime + grace on our clock
    let r = await t.svc.reconcile(P); expect(r.attempt.status).toBe('UNKNOWN'); // ledger close time not past maxTime yet
    t.chain.closeTime = Math.floor(t.clock.now() / 1000);
    r = await t.svc.reconcile(P); expect(r.attempt.status).toBe('UNKNOWN'); expect(r.attempt.missesAfterDeadline).toBe(1);
    r = await t.svc.reconcile(P); expect(r.attempt.status).toBe('FAILED');
    expect(t.holds.released.length).toBe(1);
  });
  it('a payment that lands late (before maxTime) after a lost response is still found', async () => {
    const t = await build(); await t.init(); t.chain.mode = 'timeout-lost';
    const a = await t.svc.fund(P, R);
    t.chain.mode = 'ok'; await t.chain.submit(a.attempt.envelopeXdr); // network delivers it later
    t.clock.adv(10);
    expect((await t.svc.reconcile(P)).attempt.status).toBe('CONFIRMED');
  });
  it('failed on ledger -> FAILED and hold claim released; no automatic re-send', async () => {
    const t = await build(); await t.init(); t.chain.mode = 'fail-on-ledger';
    const r = await t.svc.fund(P, R); expect(r.attempt.status).toBe('FAILED'); expect(t.holds.released.length).toBe(1);
    t.chain.mode = 'ok'; const again = await t.svc.fund(P, R);
    expect(again.attempt.status).toBe('FAILED'); expect(t.chain.submits).toBe(1);
  });
  it('concurrent fund() calls produce exactly one payment', async () => {
    const t = await build(); await t.init();
    const rs = await Promise.allSettled([t.svc.fund(P, R), t.svc.fund(P, R), t.svc.fund(P, R)]);
    expect(t.chain.ledger.size).toBe(1);
    expect(rs.some(r => r.status === 'fulfilled')).toBe(true);
  });
});

describe('on-chain verification', () => {
  const tamper = async (patch: (r: any) => void) => {
    const t = await build(); await t.init(); t.chain.mode = 'timeout-lost';
    const a = await t.svc.fund(P, R); t.chain.mode = 'ok'; await t.chain.submit(a.attempt.envelopeXdr);
    patch(t.chain.ledger.get(a.attempt.txHash)); return (await t.svc.reconcile(P)).attempt;
  };
  it('wrong destination -> not confirmed, operator reason set', async () => { const a = await tamper(r => { r.payments[0].to = 'GX'; }); expect(a.status).toBe('UNKNOWN'); expect(a.needsOperatorReason).toMatch(/destination/); });
  it('wrong amount', async () => { const a = await tamper(r => { r.payments[0].amountUnits = '1'; }); expect(a.status).toBe('UNKNOWN'); expect(a.needsOperatorReason).toMatch(/amount/); });
  it('wrong issuer', async () => { const a = await tamper(r => { r.payments[0].assetIssuer = 'GX'; }); expect(a.needsOperatorReason).toMatch(/asset/); });
  it('wrong memo', async () => { const a = await tamper(r => { r.memo = { type: 'text', value: 'nope' }; }); expect(a.needsOperatorReason).toMatch(/memo/); });
  it('extra operation', async () => { const a = await tamper(r => { r.operationCount = 2; }); expect(a.needsOperatorReason).toMatch(/exactly one/); });
});

describe('provider status handling', () => {
  it('stale pending_sender after completed is ignored', async () => {
    const t = await build(); const p = await t.init(); const r = await t.svc.fund(P, R);
    t.provider.setStatus(p.id, 'completed'); await t.svc.fund(P, R);
    t.provider.setStatus(p.id, 'pending_sender'); const x = await t.svc.fund(P, R);
    expect(x.attempt.providerStatus).toBe('completed'); expect(r.attempt.status).toBe('CONFIRMED');
  });
  it('anchor refunded is recorded even after confirmation', async () => {
    const t = await build(); const p = await t.init(); await t.svc.fund(P, R);
    t.provider.setStatus(p.id, 'refunded'); const x = await t.svc.fund(P, R);
    expect(x.attempt.providerStatus).toBe('refunded'); expect(x.anchorFunded).toBe(false);
  });
});

describe('secrets', () => {
  it('audit records never contain the envelope or a secret key', async () => {
    const t = await build(); await t.init(); const r = await t.svc.fund(P, R);
    const dump = JSON.stringify(t.audit.records);
    expect(dump).not.toContain(r.attempt.envelopeXdr); expect(dump).not.toMatch(/\bS[A-Z2-7]{55}\b/);
  });
});
