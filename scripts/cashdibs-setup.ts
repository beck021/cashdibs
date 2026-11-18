/**
 * prepare the two institutional Testnet accounts.
 *   npm run cashdibs:setup
 * Idempotent. Keys are written (0600) before any network call, so a failed run can simply be re-run.
 * Real Testnet only. The sender's USDC comes from https://faucet.circle.com (Stellar Testnet, 10 USDC / request / 24h).
 */
import { Asset, BASE_FEE, Horizon, Keypair, Operation, TransactionBuilder, Networks } from '@stellar/stellar-sdk';
import { CIRCLE_TESTNET_USDC_ISSUER } from '../lib/cashdibs/constants';
import { loadOrCreateKeys } from '../lib/cashdibs/keystore';

const HORIZON = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
const server = new Horizon.Server(HORIZON);

async function fund(pub: string) {
  try { await server.loadAccount(pub); return 'exists'; } catch { /* not created yet */ }
  const r = await fetch(`https://friendbot.stellar.org?addr=${pub}`);
  if (!r.ok) throw new Error(`Friendbot returned ${r.status}`);
  return 'funded';
}

async function ensureTrustline(secret: string) {
  const kp = Keypair.fromSecret(secret);
  const acct = await server.loadAccount(kp.publicKey());
  if (acct.balances.some((b: any) => b.asset_code === 'USDC' && b.asset_issuer === CIRCLE_TESTNET_USDC_ISSUER)) return 'present';
  const tx = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: new Asset('USDC', CIRCLE_TESTNET_USDC_ISSUER) })).setTimeout(60).build();
  tx.sign(kp); await server.submitTransaction(tx); return 'added';
}

async function main() {
  const { keys, created } = loadOrCreateKeys();
  console.log(created ? 'Generated new keys in .testnet/cashdibs-keys.json (mode 600, git-ignored).' : 'Reusing keys from .testnet/cashdibs-keys.json.');
  for (const role of ['sender', 'anchor'] as const) {
    const k = keys[role];
    console.log(`${role}: ${k.publicKey}`);
    console.log(`  account:   ${await fund(k.publicKey)}`);
    console.log(`  trustline: ${await ensureTrustline(k.secret)}`);
  }
  console.log('\nNEXT (manual, one minute): open https://faucet.circle.com, choose Stellar Testnet + USDC, paste the SENDER address above.');
  console.log('Then run: npm run cashdibs:preflight');
}
main().catch(e => { console.error('\nSetup stopped:', e.message, '\nRe-run `npm run cashdibs:setup` to resume; nothing is duplicated.'); process.exit(1); });
