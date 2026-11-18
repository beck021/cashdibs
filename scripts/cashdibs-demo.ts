/**
 * End-to-end demo on REAL Testnet:
 *   fixture quote + fixture SEP-31 anchor (labeled) -> real USDC payment -> fixture reimbursement.
 *   npm run cashdibs:demo
 * Re-running resumes the same payment (state in .testnet/cashdibs-state/), it never pays twice.
 */
import { Horizon, Keypair } from '@stellar/stellar-sdk';
import { CIRCLE_TESTNET_USDC_ISSUER as ISSUER } from '../lib/cashdibs/constants';
import { loadOrCreateKeys } from '../lib/cashdibs/keystore';
import { FundingService, defaultFundingConfig } from '../lib/cashdibs/funding/service';
import { FixturePayoutNetwork, ReimbursementService } from '../lib/cashdibs/reimbursement/service';
import { FixtureSep31Provider } from '../lib/cashdibs/sep31/fixture';
import { HorizonObserver, HorizonSubmitter, KeypairSigner, TESTNET_PASSPHRASE } from '../lib/cashdibs/stellar/payment';
import { FileFundingStore, FileReimbursementStore } from '../lib/cashdibs/stores/file';
import { MemoryAccountLock, MemoryAudit } from '../lib/cashdibs/stores/memory';
import type { HoldGate, RemittanceSource } from '../lib/cashdibs/ports';
import type { Remittance } from '../lib/cashdibs/types';
import { formatPhp } from '../lib/cashdibs/units';

const PAYOUT = 'demo-ca-ph-001', RES = 'demo-res-1', PICKUP = 'demo-pickup-1';
const AMOUNT = process.env.DEMO_USDC_UNITS || '10000000'; // 1 USDC (the faucet gives 10)

(async () => {
  const { keys } = loadOrCreateKeys();
  const server = new Horizon.Server(process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org');
  const observer = new HorizonObserver(server);
  const clock = { now: () => Date.now() };
  const provider = new FixtureSep31Provider(keys.anchor.publicKey, ISSUER);
  const store = new FileFundingStore('.testnet/cashdibs-state/funding.json');
  const audit = new MemoryAudit();

  // Till fixture. All figures are centavos.
  const till = { onHand: 4_000_000, held: 0 };
  const quoteCentavos = 1_500_000;
  const show = (l: string) => console.log(`${l.padEnd(34)} on-hand ${formatPhp(till.onHand)} | held ${formatPhp(till.held)} | available ${formatPhp(till.onHand - till.held)}`);
  show('Start');

  // 1. quote + SEP-31 payment (fixture, labeled)
  const q = await provider.getQuote();
  const sep = await provider.createPayment({ payoutId: PAYOUT, idempotencyKey: PAYOUT, usdcAmountUnits: AMOUNT, assetCode: 'USDC', assetIssuer: ISSUER, phpQuotedCentavos: quoteCentavos }, q.quoteId);
  const rem: Remittance = { payoutId: PAYOUT, providerMode: 'fixture', quoteId: q.quoteId, quoteExpiresAt: q.expiresAt, cadTotalCents: 4000, phpQuotedCentavos: quoteCentavos, usdcAmountUnits: AMOUNT, assetCode: 'USDC', assetIssuer: ISSUER, sep31PaymentId: sep.id, createdAt: new Date().toISOString() };
  const remittances: RemittanceSource = { getByPayoutId: async id => (id === PAYOUT ? rem : null) };

  // 2. cash hold FIRST (fixture gate), then USDC
  till.held += quoteCentavos; show('After CONFIRMED cash hold');
  const holds: HoldGate = {
    getHold: async () => ({ state: 'CONFIRMED', hold: { reservationId: RES, agentId: 'agent-a', phpAmountMinor: quoteCentavos, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() } }),
    claimForFunding: async () => true, releaseFundingClaim: async () => {},
  };
  const funding = new FundingService({ store, holds, remittances, provider, observer, submitter: new HorizonSubmitter(server), signer: new KeypairSigner(Keypair.fromSecret(keys.sender.secret)),
    audit, lock: new MemoryAccountLock(), config: defaultFundingConfig(ISSUER, TESTNET_PASSPHRASE), clock });
  const r = await funding.fund(PAYOUT, RES);
  console.log(`Funding: ${r.attempt.status}  hash ${r.attempt.txHash}`);
  if (r.attempt.status !== 'CONFIRMED') { console.log(r.attempt.lastError ?? r.attempt.needsOperatorReason ?? ''); console.log('Not final. Re-run to resume the SAME payment.'); process.exit(2); }
  console.log(`Explorer: ${r.explorerUrl}`);

  // 3. anchor matches (fixture: only after OUR ledger verification)
  provider.markStellarPaid(sep.id, r.attempt.txHash);
  const after = await funding.fund(PAYOUT, RES);
  console.log(`Anchor (SIMULATED) status: ${after.attempt.providerStatus}; ready for pickup authorization: ${after.anchorFunded}`);

  // 4. verified pickup (fixture until the host app provides one), then reimbursement
  till.onHand -= quoteCentavos; till.held -= quoteCentavos; show('After verified pickup');
  const net = new FixturePayoutNetwork();
  const re = new ReimbursementService({ store: new FileReimbursementStore('.testnet/cashdibs-state/reimbursement.json'), network: net, audit });
  await re.createIntent({ pickupRef: PICKUP, agentId: 'agent-a', amountMinor: quoteCentavos, status: 'COLLECTED', evidenceRef: 'demo-evidence', collectedAt: new Date().toISOString() });
  const done = await re.process(PICKUP);
  console.log(`Reimbursement (SIMULATED PHP): ${done.status} ${formatPhp(done.amountMinor)}`);
  show('After reimbursement (unchanged)');
})().catch(e => { console.error('Demo stopped:', e.code ?? '', e.message); process.exit(1); });
