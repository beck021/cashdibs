import { Keypair, Memo } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { normalizeMemo, toStellarMemo } from '../lib/cashdibs/memo';
import { redact } from '../lib/cashdibs/redact';
import { FixtureSep31Provider } from '../lib/cashdibs/sep31/fixture';
import { HttpSep31Provider } from '../lib/cashdibs/sep31/http';
import { isAnchorFunded, providerStatusAdvances } from '../lib/cashdibs/state';
import { preparePayment, KeypairSigner, TESTNET_PASSPHRASE } from '../lib/cashdibs/stellar/payment';
import { senderPreflight } from '../lib/cashdibs/stellar/preflight';
import { availableCentavos, assertCentavos, horizonAmountToUnits, parseUnits, unitsToHorizonAmount } from '../lib/cashdibs/units';
import { FakeChain, ISSUER } from './cashdibs-harness';

describe('units', () => {
  it('round-trips exactly', () => { for (const s of ['1', '9999999', '10000000', '250000000', '123456789012345']) expect(horizonAmountToUnits(unitsToHorizonAmount(s)).toString()).toBe(s); });
  it('formats 25 USDC', () => expect(unitsToHorizonAmount('250000000')).toBe('25.0000000'));
  it.each(['0', '-1', '1.5', '01', '', 'abc', '9223372036854775808'])('rejects %j', s => expect(() => parseUnits(s)).toThrow());
  it.each(['1.12345678', '-1', '.5', '1e3'])('rejects horizon amount %j', s => expect(() => horizonAmountToUnits(s)).toThrow());
  it('available = onHand - held - buffer (demo fixture)', () => { expect(availableCentavos(4_000_000, 1_500_000, 0)).toBe(2_500_000); expect(() => assertCentavos(0.5)).toThrow(); });
});

describe('memo', () => {
  it('accepts text/id/hash and rejects bad ones', () => {
    expect(toStellarMemo({ type: 'text', value: 'abc' })).toBeInstanceOf(Memo);
    expect(() => normalizeMemo(null)).toThrow(/memo/);
    expect(() => normalizeMemo({ type: 'text', value: 'x'.repeat(29) })).toThrow();
    expect(() => normalizeMemo({ type: 'id', value: '18446744073709551616' })).toThrow();
    expect(() => normalizeMemo({ type: 'hash', value: 'abc' })).toThrow();
  });
  it('base64 hash memo is canonicalised to hex', () => {
    const b64 = Buffer.alloc(32, 7).toString('base64');
    expect(normalizeMemo({ type: 'hash', value: b64 }).value).toBe('07'.repeat(32));
  });
});

describe('payment building', () => {
  const sk = Keypair.random(), dest = Keypair.random().publicKey();
  const base = { signer: new KeypairSigner(sk), destination: dest, assetCode: 'USDC', assetIssuer: ISSUER, amountUnits: '250000000', memo: { type: 'text' as const, value: 'cdabc' }, sequence: '100', maxTimeSec: 2000, nowSec: 1000, passphrase: TESTNET_PASSPHRASE };
  it('is deterministic about sequence+1, hash, and maxTime', () => { const p = preparePayment(base); expect(p.hash).toMatch(/^[0-9a-f]{64}$/); expect(p.maxTime).toBe(2000); expect(p.sequence).toBe('101'); });
  it('refuses mainnet', () => expect(() => preparePayment({ ...base, passphrase: 'Public Global Stellar Network ; September 2015' })).toThrow(/Testnet/));
  it('refuses expired deadline, self-payment, bad destination', () => {
    expect(() => preparePayment({ ...base, maxTimeSec: 1000 })).toThrow();
    expect(() => preparePayment({ ...base, destination: sk.publicKey() })).toThrow();
    expect(() => preparePayment({ ...base, destination: 'nope' })).toThrow();
  });
});

describe('preflight', () => {
  it('passes with trustline, USDC and XLM', async () => { const c = new FakeChain(); expect((await senderPreflight(c, 'G', ISSUER, 250000000n)).ok).toBe(true); });
  it('reports every problem', async () => { const c = new FakeChain(); c.trustline = false; c.usdc = 0n; c.xlm = 0n; const r = await senderPreflight(c, 'G', ISSUER, 1n); expect(r.problems.length).toBe(3); });
  it('Horizon down is retryable, not "ok"', async () => { const c = new FakeChain(); c.horizonDown = true; await expect(senderPreflight(c, 'G', ISSUER, 1n)).rejects.toMatchObject({ code: 'PREFLIGHT_UNAVAILABLE', retryable: true }); });
});

describe('SEP-31 fixture', () => {
  const p = new FixtureSep31Provider(Keypair.random().publicKey(), ISSUER);
  it('is labeled simulated and idempotent on the key', async () => {
    const i = { payoutId: 'x', idempotencyKey: 'k1', usdcAmountUnits: '10000000', assetCode: 'USDC', assetIssuer: ISSUER, phpQuotedCentavos: 100 };
    const a = await p.createPayment(i, 'q'), b = await p.createPayment(i, 'q');
    expect(a.simulated).toBe(true); expect(b.id).toBe(a.id); expect((await p.getQuote()).simulated).toBe(true);
    expect(Buffer.byteLength(a.instructions!.memo!.value)).toBeLessThanOrEqual(28);
  });
  it('rejects other issuers', async () => { await expect(p.createPayment({ payoutId: 'x', idempotencyKey: 'k2', usdcAmountUnits: '1', assetCode: 'USDC', assetIssuer: Keypair.random().publicKey(), phpQuotedCentavos: 1 }, 'q')).rejects.toMatchObject({ code: 'ASSET_NOT_SUPPORTED' }); });
});

describe('status mapping', () => {
  it('only match-states count as anchor funded', () => { for (const s of ['pending_sender', 'pending_stellar', 'refunded', 'error', 'expired'] as const) expect(isAnchorFunded(s)).toBe(false); for (const s of ['pending_receiver', 'pending_external', 'completed'] as const) expect(isAnchorFunded(s)).toBe(true); });
  it('stale statuses do not regress', () => { expect(providerStatusAdvances('completed', 'pending_sender')).toBe(false); expect(providerStatusAdvances('pending_sender', 'completed')).toBe(true); expect(providerStatusAdvances('completed', 'refunded')).toBe(true); expect(providerStatusAdvances('refunded', 'completed')).toBe(false); });
});

describe('redaction', () => {
  it('strips secret keys, envelopes, tokens and KYC fields', () => {
    const secret = Keypair.random().secret();
    const out = JSON.stringify(redact({ msg: `key ${secret}`, envelopeXdr: 'AAAA', jwt: 't', nested: { first_name: 'A', ok: 1 } }));
    expect(out).not.toContain(secret); expect(out).not.toContain('AAAA'); expect(out).not.toContain('"A"'); expect(out).toContain('"ok":1');
  });
});

describe('HTTP provider (mock transport; partner behavior unverified)', () => {
  it('does not echo response bodies in errors and maps unknown statuses to error', async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('stellar.toml')) return new Response('WEB_AUTH_ENDPOINT="https://a/auth"\nDIRECT_PAYMENT_SERVER="https://a/sep31"\nSIGNING_KEY="GAAA"');
      return new Response(JSON.stringify({ error: 'x', first_name: 'LEAK' }), { status: 500 });
    }) as any;
    const p = new HttpSep31Provider({ homeDomain: 'a', clientKeypair: Keypair.random(), fetchImpl });
    await expect(p.getPayment('1')).rejects.toSatisfy((e: any) => !String(e.message).includes('LEAK'));
  });
  it('fails closed when toml is incomplete', async () => {
    const p = new HttpSep31Provider({ homeDomain: 'a', clientKeypair: Keypair.random(), fetchImpl: (async () => new Response('')) as any });
    await expect(p.discover()).rejects.toMatchObject({ code: 'SEP1_INCOMPLETE' });
  });
});
