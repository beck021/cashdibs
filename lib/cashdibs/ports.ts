import {
  AuditRecord, ConfirmedHold, FundingAttempt, FundingInstructions, FundingStatus, MemoSpec,
  ReimbursementIntent, ReimbursementStatus, Remittance, Sep31Payment, Sep31Quote,
} from './types';

export interface Clock { now(): number } // epoch ms
export const systemClock: Clock = { now: () => Date.now() };

/** The shared hold gate (the host app owns the real implementation). */
export type HoldState = 'HELD' | 'CONFIRMED' | 'CONSUMED' | 'RELEASED' | 'EXPIRED' | 'MISSING';
export interface HoldGate {
  getHold(reservationId: string): Promise<{ state: HoldState; hold?: ConfirmedHold }>;
  /** Atomically mark the CONFIRMED hold as "funding in flight" so the sweeper cannot release it. false = lost the race / not CONFIRMED. */
  claimForFunding(reservationId: string, attemptId: string): Promise<boolean>;
  releaseFundingClaim(reservationId: string, attemptId: string): Promise<void>;
}

export interface RemittanceSource { getByPayoutId(payoutId: string): Promise<Remittance | null> }

export interface FundingStore {
  get(payoutId: string): Promise<FundingAttempt | null>;
  createIfAbsent(a: FundingAttempt): Promise<{ attempt: FundingAttempt; created: boolean }>;
  /** compare-and-set: applies patch only if current status is in `from`; returns null otherwise */
  transition(payoutId: string, from: FundingStatus[], patch: Partial<FundingAttempt>): Promise<FundingAttempt | null>;
}

export interface ReimbursementStore {
  get(pickupRef: string): Promise<ReimbursementIntent | null>;
  createIfAbsent(i: ReimbursementIntent): Promise<{ intent: ReimbursementIntent; created: boolean }>;
  transition(pickupRef: string, from: ReimbursementStatus[], patch: Partial<ReimbursementIntent>): Promise<ReimbursementIntent | null>;
}

export interface AuditSink { record(r: AuditRecord): Promise<void> }
export interface AccountLock { withLock<T>(account: string, fn: () => Promise<T>): Promise<T> }

// ---- SEP-31 provider --------------------------------------------------------
export interface Sep31CreateInput {
  payoutId: string;
  idempotencyKey: string;
  usdcAmountUnits: string;
  assetCode: string;
  assetIssuer: string;
  phpQuotedCentavos: number;
  /** opaque SEP-12 ids only; no KYC fields ever pass through this layer */
  senderCustomerId?: string;
  receiverCustomerId?: string;
}
export interface Sep31Provider {
  readonly mode: 'fixture' | 'partner';
  getQuote(input: { usdcAmountUnits: string; assetCode: string; assetIssuer: string }): Promise<Sep31Quote>;
  createPayment(input: Sep31CreateInput, quoteRef: string): Promise<Sep31Payment>;
  getPayment(id: string): Promise<Sep31Payment>;
  getFundingInstructions(id: string): Promise<FundingInstructions>;
}

// ---- Stellar ----------------------------------------------------------------
export interface AccountSnapshot { sequence: string; xlmStroops: bigint; usdcUnits: bigint; hasUsdcTrustline: boolean }
export interface TxReceipt {
  hash: string; successful: boolean; ledger: number; source: string;
  memo: MemoSpec | null;
  payments: { to: string; assetCode: string; assetIssuer: string; amountUnits: string }[];
  operationCount: number;
}
export interface StellarObserver {
  getAccount(account: string, usdcIssuer: string): Promise<AccountSnapshot>;
  getReceipt(hash: string): Promise<TxReceipt | null>;
  /** close time (epoch seconds) of the latest closed ledger */
  latestLedgerCloseTime(): Promise<number>;
}
export interface StellarSubmitter { submit(envelopeXdr: string): Promise<{ hash: string; ledger?: number }> }
export interface Signer { publicKey: string; signEnvelope(txXdr: string, networkPassphrase: string): string }

// ---- Payout network (agent reimbursement) ------------------------------------
export type NetworkReimbursementStatus = 'NOT_FOUND' | 'PENDING' | 'SUBMITTED' | 'SETTLED' | 'REJECTED';
export interface PayoutNetwork {
  requestReimbursement(pickupRef: string, amountMinor: number, reference: string): Promise<{ providerRef: string; status: NetworkReimbursementStatus }>;
  getReimbursement(pickupRef: string): Promise<{ providerRef?: string; status: NetworkReimbursementStatus; amountMinor?: number }>;
}
