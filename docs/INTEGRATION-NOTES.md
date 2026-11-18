# Integration notes

This repo is the Engineer 2 slice of a team hackathon project. These notes describe what the other half of the system (the web app and database, owned by a teammate) has to provide. Paths such as `/api/reservations` refer to that app, which is not in this repo.

## What is verified vs not
| Item | State |
|---|---|
| Funding/reimbursement logic, failure cases, secrets handling | Unit-tested with mocks (82 tests, `tests/cashdibs-*.test.ts`); mutation-checked on 3 key invariants |
| Real Testnet payment (`npm run cashdibs:demo`) | Run successfully on Testnet (see README for the transaction link). The 82 unit tests use mocks and never touch the network. |
| Horizon adapters (`HorizonObserver`, `HorizonSubmitter`) | Used by the live demo run; the unit tests only exercise a fake chain |
| `HttpSep31Provider` (SEP-1/10/38/31) | **Unverified against any real anchor.** No partner access. Fixture mode is the buildable path and is labeled `simulated: true` |
| SEP-12 customer registration | Not implemented; callers pass opaque customer ids |
| Prisma persistence | Not wired (schema owned by E1/CD-02). In-memory + JSON-file stores only |

## CD-01 mapping to E1's repo
| Contract term | Existing code |
|---|---|
| Hold HELD / CONFIRMED / CONSUMED / RELEASED | `Reservation.status` REQUESTED / CONFIRMED / FULFILLED / EXPIRED+CANCELLED+REJECTED |
| Cash hold amounts | `CashInventory.heldMinor` via `holdCashAtomic` / `releaseCashHoldAtomic` (`lib/inventory.ts`) |
| `HoldGate` port | **E1 to implement (CD-02).** `getHold` reads Reservation; `claimForFunding` must be an atomic CONFIRMED -> "funding in flight" flag that the expiry sweeper respects |
| Remittance, FundingAttempt, Pickup, Reimbursement | No models yet. See fragment below |
| Reservation route requires payout FUNDED | Old rule. CD-02 reverses it: hold first, USDC after |

**Blocking dependency on E1:** `/api/reservations` still demands `payoutStatus === FUNDED` before a hold exists, so the real flow (hold -> USDC) cannot run end-to-end until CD-02 lands. There is also no expiry sweeper; a hold left CONFIRMED forever blocks the till.

## Ports E1 must implement
`HoldGate`, `RemittanceSource`, a Prisma `FundingStore` and `ReimbursementStore` (compare-and-set `transition`, unique key on `payoutId` / `pickupRef`), and a pickup event: when a pickup becomes COLLECTED call `ReimbursementService.createIntent(pickup)` then `process(pickupRef)`. Interfaces: `lib/cashdibs/ports.ts`.

## Prisma fragment (for E1's migration)
```prisma
model FundingAttempt {
  payoutId       String @id
  attemptId      String @unique
  status         String   // PREPARED|SUBMITTED|CONFIRMED|UNKNOWN|FAILED
  reservationId  String
  anchorPaymentId String
  sourceAccount  String
  destination    String
  memoType       String
  memoValue      String
  assetCode      String
  assetIssuer    String
  amountUnits    String   // integer string, 1e-7 USDC
  sequence       String
  maxTime        Int
  envelopeXdr    String   // encrypt at rest; never log or return
  txHash         String @unique
  ledger         Int?
  providerStatus String?
  needsOperatorReason String?
  missesAfterDeadline Int @default(0)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
}
model ReimbursementIntent {
  pickupRef   String @id        // one intent per pickup
  agentId     String
  amountMinor Int
  reference   String @unique    // idempotency key sent to the provider
  evidenceRef String
  status      String            // PENDING|SUBMITTED|SETTLED|UNKNOWN|NEEDS_REVIEW
  providerRef String?
  attempts    Int @default(0)
  needsReviewReason String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```
`transition()` must be a single `UPDATE ... WHERE status IN (...)` and report rows affected.

## Safety rules the code enforces
1. Hold must be CONFIRMED, unexpired, same PHP amount as the quote, and claimed before anything is signed.
2. Anchor amount, asset, issuer and memo are validated; payment is a single USDC `payment` op with maxTime <= min(quote, hold) expiry.
3. Signed envelope and hash are persisted before the first submit. Any submit error -> UNKNOWN, never FAILED.
4. UNKNOWN resubmits the same envelope (same hash). FAILED only on a failed ledger result, or two checks after maxTime with the latest ledger close time past maxTime.
5. On-chain receipt is checked field by field; a mismatch stays UNKNOWN with `needsOperatorReason` (never auto-resolved).
6. Ledger success is not "anchor matched": `anchorFunded` additionally needs provider status pending_receiver / pending_external / completed. Stale provider statuses never regress.
7. Reimbursement: one intent per pickup, same reference on every retry, provider is asked before resending, and the module has no inventory dependency (credit never tops up the till).

## Known limits to say out loud
- Per-account lock is in-process; multiple server instances need a DB advisory lock.
- Sequence numbers come from Horizon; two unconfirmed payments from one sender are serialised, not queued.
- After a FAILED attempt there is deliberately no automatic retry; start a new payout/quote.

## Run it
```
npm ci
npm test
npm run cashdibs:setup        # creates sender + anchor accounts, trustlines (Friendbot)
# faucet.circle.com -> Stellar Testnet -> USDC -> paste the SENDER address printed above
npm run cashdibs:preflight
npm run cashdibs:demo         # prints the stellar.expert link for the real payment
```
Demo figures: till 4,000,000 centavos; hold 1,500,000 (available 2,500,000); after pickup on-hand 2,500,000; reimbursement leaves on-hand unchanged.
