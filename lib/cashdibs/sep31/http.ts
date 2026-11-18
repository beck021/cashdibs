import { Keypair, WebAuth, Networks } from '@stellar/stellar-sdk';
import { Sep31CreateInput, Sep31Provider } from '../ports';
import { horizonAmountToUnits } from '../units';
import { CashdibsError, FundingInstructions, MemoSpec, Sep31Payment, Sep31Quote, Sep31Status } from '../types';

/**
 * PARTNER MODE (unverified against a live anchor: no partner access in the build environment).
 * Follows SEP-1 discovery, SEP-10 auth, SEP-38 quote, SEP-31 transactions. SEP-12 customer
 * registration is NOT done here: callers pass opaque customer ids obtained out of band, so KYC
 * fields never transit this module or its logs.
 */
export interface HttpProviderConfig {
  homeDomain: string; // e.g. testanchor.stellar.org
  clientKeypair: Keypair; // the sending provider's SEP-10 account
  networkPassphrase?: string;
  fetchImpl?: typeof fetch;
  sellAsset?: string; // SEP-38 asset id of what we deliver, e.g. stellar:USDC:G...
  buyAsset?: string; // e.g. iso4217:PHP
  sendingAnchorSep38Required?: boolean;
}

const STATUSES: Sep31Status[] = ['pending_sender', 'pending_stellar', 'pending_customer_info_update', 'pending_transaction_info_update', 'pending_receiver', 'pending_external', 'completed', 'refunded', 'expired', 'error'];

export class HttpSep31Provider implements Sep31Provider {
  readonly mode = 'partner' as const;
  private f: typeof fetch;
  private toml?: Record<string, string>;
  private jwt?: { token: string; exp: number };
  private pass: string;
  constructor(private cfg: HttpProviderConfig) {
    this.f = cfg.fetchImpl ?? fetch;
    this.pass = cfg.networkPassphrase ?? Networks.TESTNET;
  }

  private async json(url: string, init?: RequestInit): Promise<any> {
    const res = await this.f(url, init);
    const text = await res.text();
    let body: any; try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
    if (!res.ok) {
      // never echo the response body (may contain customer data); status + provider error code only
      throw new CashdibsError('SEP31_HTTP_ERROR', `provider returned ${res.status}${body?.error ? `: ${String(body.error).slice(0, 120)}` : ''}`, res.status >= 500 ? 502 : 400, res.status >= 500 || res.status === 429);
    }
    return body;
  }

  /** SEP-1 */
  async discover(): Promise<Record<string, string>> {
    if (this.toml) return this.toml;
    const txt = await (await this.f(`https://${this.cfg.homeDomain}/.well-known/stellar.toml`)).text();
    const get = (k: string) => new RegExp(`^${k}\\s*=\\s*"([^"]+)"`, 'm').exec(txt)?.[1];
    const t: Record<string, string> = {};
    for (const k of ['WEB_AUTH_ENDPOINT', 'TRANSFER_SERVER_SEP0024', 'DIRECT_PAYMENT_SERVER', 'ANCHOR_QUOTE_SERVER', 'SIGNING_KEY']) { const v = get(k); if (v) t[k] = v; }
    if (!t.WEB_AUTH_ENDPOINT || !t.DIRECT_PAYMENT_SERVER || !t.SIGNING_KEY) throw new CashdibsError('SEP1_INCOMPLETE', 'anchor toml lacks WEB_AUTH_ENDPOINT/DIRECT_PAYMENT_SERVER/SIGNING_KEY', 502);
    return (this.toml = t);
  }

  /** SEP-10: verify the server's challenge before signing it. */
  private async auth(): Promise<string> {
    if (this.jwt && this.jwt.exp * 1000 > Date.now() + 30_000) return this.jwt.token;
    const t = await this.discover();
    const account = this.cfg.clientKeypair.publicKey();
    const ch = await this.json(`${t.WEB_AUTH_ENDPOINT}?account=${account}&home_domain=${this.cfg.homeDomain}`);
    const { tx } = WebAuth.readChallengeTx(ch.transaction, t.SIGNING_KEY, this.pass, this.cfg.homeDomain, new URL(t.WEB_AUTH_ENDPOINT).host);
    tx.sign(this.cfg.clientKeypair);
    const r = await this.json(t.WEB_AUTH_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ transaction: tx.toXDR() }) });
    const payload = JSON.parse(Buffer.from(String(r.token).split('.')[1], 'base64url').toString());
    this.jwt = { token: r.token, exp: payload.exp };
    return r.token;
  }
  private async authed(url: string, init: RequestInit = {}) {
    const token = await this.auth();
    return this.json(url, { ...init, headers: { ...(init.headers as object), authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
  }

  /** SEP-38 firm quote */
  async getQuote(input: { usdcAmountUnits: string; assetCode: string; assetIssuer: string }): Promise<Sep31Quote> {
    const t = await this.discover();
    if (!t.ANCHOR_QUOTE_SERVER) throw new CashdibsError('SEP38_UNAVAILABLE', 'anchor has no ANCHOR_QUOTE_SERVER', 502);
    const amount = (Number(BigInt(input.usdcAmountUnits)) / 1e7).toFixed(7);
    const q = await this.authed(`${t.ANCHOR_QUOTE_SERVER}/quote`, { method: 'POST', body: JSON.stringify({
      sell_asset: this.cfg.sellAsset ?? `stellar:${input.assetCode}:${input.assetIssuer}`, buy_asset: this.cfg.buyAsset ?? 'iso4217:PHP',
      sell_amount: amount, context: 'sep31' }) });
    return { quoteId: q.id, expiresAt: q.expires_at, simulated: false };
  }

  async createPayment(input: Sep31CreateInput, quoteRef: string): Promise<Sep31Payment> {
    const t = await this.discover();
    const amount = (Number(BigInt(input.usdcAmountUnits)) / 1e7).toFixed(7);
    const r = await this.authed(`${t.DIRECT_PAYMENT_SERVER}/transactions`, { method: 'POST', headers: { 'idempotency-key': input.idempotencyKey }, body: JSON.stringify({
      amount, asset_code: input.assetCode, asset_issuer: input.assetIssuer, quote_id: quoteRef,
      sender_id: input.senderCustomerId, receiver_id: input.receiverCustomerId }) });
    const memo = this.memoOf(r.stellar_memo_type, r.stellar_memo);
    const instructions: FundingInstructions = { destination: r.stellar_account_id, assetCode: input.assetCode, assetIssuer: input.assetIssuer, amountUnits: input.usdcAmountUnits, memo };
    return { id: r.id, status: 'pending_sender', rawStatus: 'pending_sender', statusEventAt: new Date().toISOString(), instructions, quoteId: quoteRef, simulated: false };
  }

  private memoOf(type?: string, value?: string): MemoSpec | null {
    if (!type || !value) return null;
    if (type !== 'text' && type !== 'id' && type !== 'hash') throw new CashdibsError('INVALID_MEMO', `unsupported memo type ${type}`, 502);
    return { type, value };
  }

  async getPayment(id: string): Promise<Sep31Payment> {
    const t = await this.discover();
    const r = (await this.authed(`${t.DIRECT_PAYMENT_SERVER}/transactions/${encodeURIComponent(id)}`)).transaction;
    const status = STATUSES.includes(r.status) ? (r.status as Sep31Status) : 'error'; // unknown literal never counts as success
    return { id: r.id, status, rawStatus: String(r.status), statusEventAt: r.updated_at ?? r.started_at ?? new Date().toISOString(),
      stellarTransactionId: r.stellar_transaction_id, simulated: false,
      instructions: r.stellar_account_id ? { destination: r.stellar_account_id, assetCode: r.amount_in_asset?.split(':')[1] ?? '', assetIssuer: r.amount_in_asset?.split(':')[2] ?? '', amountUnits: r.amount_in ? horizonAmountToUnits(String(r.amount_in)).toString() : '0', memo: this.memoOf(r.stellar_memo_type, r.stellar_memo) } : undefined };
  }

  async getFundingInstructions(id: string): Promise<FundingInstructions> {
    const p = await this.getPayment(id);
    if (!p.instructions) throw new CashdibsError('SEP31_NO_INSTRUCTIONS', 'payment has no funding instructions', 502);
    return p.instructions;
  }
}
