import { FundingStatus, ReimbursementStatus, Sep31Status } from './types';

/**
 * Provider statuses are EVIDENCE, mapped explicitly. A successful ledger payment alone does not
 * mean the partner matched it or authorized pickup.
 */
const SEP31_RANK: Record<Sep31Status, number> = {
  pending_customer_info_update: 0,
  pending_transaction_info_update: 0,
  pending_sender: 1,
  pending_stellar: 2,
  pending_receiver: 3,
  pending_external: 4,
  completed: 5,
  // terminal-but-not-success states never "advance" funding; handled separately
  refunded: -1,
  expired: -1,
  error: -1,
};

export function sep31Rank(s: Sep31Status): number {
  return SEP31_RANK[s] ?? -1;
}

/** The receiving anchor has matched our Stellar payment and is processing the payout. */
export function isAnchorFunded(s: Sep31Status): boolean {
  return s === 'pending_receiver' || s === 'pending_external' || s === 'completed';
}

export function isAnchorTerminalFailure(s: Sep31Status): boolean {
  return s === 'refunded' || s === 'expired' || s === 'error';
}

/** True if `next` would move the provider status forward or sideways (ignore stale/duplicate regressions). */
export function providerStatusAdvances(prev: Sep31Status | undefined, next: Sep31Status): boolean {
  if (!prev) return true;
  if (isAnchorTerminalFailure(next)) return true; // terminal evidence is always recorded
  if (isAnchorTerminalFailure(prev)) return false;
  return sep31Rank(next) >= sep31Rank(prev);
}

export const FUNDING_TERMINAL: FundingStatus[] = ['CONFIRMED', 'FAILED'];
export const FUNDING_OPEN: FundingStatus[] = ['PREPARED', 'SUBMITTED', 'UNKNOWN'];

export const REIMBURSEMENT_TERMINAL: ReimbursementStatus[] = ['SETTLED'];
