/**
 * Shared types for the CashDibs funding core (SEP-31 funding, Testnet USDC, reimbursement).
 * Mirrors docs/cashdibs/INTEGRATION-MAP.md and the integration contract.
 */

export class CashdibsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 400,
    public readonly retryable = false
  ) {
    super(message);
    this.name = 'CashdibsError';
  }
}

// ---- SEP-31 ---------------------------------------------------------------

export type Sep31Status =
  | 'pending_sender'
  | 'pending_stellar'
  | 'pending_customer_info_update'
  | 'pending_transaction_info_update'
  | 'pending_receiver'
  | 'pending_external'
  | 'completed'
  | 'refunded'
  | 'expired'
  | 'error';

export interface MemoSpec {
  type: 'text' | 'id' | 'hash';
  value: string;
}

export interface FundingInstructions {
  destination: string; // receiving anchor's Stellar account
  assetCode: string;
  assetIssuer: string;
  amountUnits: string; // integer string, 10^-7 USDC
  memo: MemoSpec | null;
  expiresAt?: string;
}

export interface Sep31Payment {
  id: string;
  status: Sep31Status;
  rawStatus: string; // provider's literal status, kept for reconciliation
  statusEventAt: string; // ISO UTC
  stellarTransactionId?: string; // hash the anchor matched, if any
  instructions?: FundingInstructions;
  quoteId?: string;
  /** true for the labeled fixture; UI/README/video must say so. */
  simulated: boolean;
}

export interface Sep31Quote {
  quoteId: string;
  expiresAt: string;
  simulated: boolean;
}

// ---- Records ----------------------------------------------------------------

export interface Remittance {
  payoutId: string;
  providerMode: 'fixture' | 'partner';
  quoteId: string;
  quoteExpiresAt: string; // ISO UTC
  cadTotalCents: number;
  phpQuotedCentavos: number;
  usdcAmountUnits: string;
  assetCode: string;
  assetIssuer: string;
  sep31PaymentId: string;
  createdAt: string;
}

export type FundingStatus =
  | 'NOT_SUBMITTED'
  | 'PREPARED'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'UNKNOWN'
  | 'FAILED';

export interface FundingAttempt {
  payoutId: string;
  attemptId: string;
  status: FundingStatus;
  reservationId: string;
  anchorPaymentId: string;
  sourceAccount: string;
  destination: string;
  memo: MemoSpec;
  assetCode: string;
  assetIssuer: string;
  amountUnits: string;
  sequence: string;
  maxTime: number; // unix seconds; the tx cannot land after this
  quoteExpiresAt: string;
  envelopeXdr: string; // signed; server-side only, never logged or returned to clients
  txHash: string;
  ledger?: number;
  providerStatus?: Sep31Status;
  providerStatusAt?: string;
  stellarVerifiedAt?: string;
  submittedAt?: string;
  confirmedAt?: string;
  failureReason?: string;
  lastError?: string;
  /** set when only an operator may decide (ambiguous evidence); never auto-resolved */
  needsOperatorReason?: string;
  missesAfterDeadline: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConfirmedHold {
  reservationId: string;
  agentId: string;
  phpAmountMinor: number;
  expiresAt: string;
}

export type ReimbursementStatus = 'PENDING' | 'SUBMITTED' | 'SETTLED' | 'UNKNOWN' | 'NEEDS_REVIEW';

export interface VerifiedPickup {
  pickupRef: string;
  agentId: string;
  amountMinor: number;
  status: 'COLLECTED';
  /** reference to the trusted handover evidence (never the PIN) */
  evidenceRef: string;
  collectedAt: string;
}

export interface ReimbursementIntent {
  pickupRef: string; // unique key: one intent per pickup
  agentId: string;
  amountMinor: number;
  reference: string; // stable idempotency reference sent to the provider
  evidenceRef: string;
  status: ReimbursementStatus;
  providerRef?: string;
  attempts: number;
  lastError?: string;
  needsReviewReason?: string;
  settledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditRecord {
  correlationId: string;
  at: string;
  actor: string;
  action: string;
  from?: string;
  to?: string;
  reason?: string;
}

export const explorerTxUrl = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;
