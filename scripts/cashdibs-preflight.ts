/** read-only check that the sender can fund the demo payment.   npm run cashdibs:preflight [usdcUnits] */
import { Horizon } from '@stellar/stellar-sdk';
import { CIRCLE_TESTNET_USDC_ISSUER } from '../lib/cashdibs/constants';
import { loadOrCreateKeys } from '../lib/cashdibs/keystore';
import { HorizonObserver } from '../lib/cashdibs/stellar/payment';
import { senderPreflight } from '../lib/cashdibs/stellar/preflight';

(async () => {
  const { keys } = loadOrCreateKeys();
  const need = BigInt(process.argv[2] || '10000000'); // default 1 USDC
  const o = new HorizonObserver(new Horizon.Server(process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org'));
  const r = await senderPreflight(o, keys.sender.publicKey, CIRCLE_TESTNET_USDC_ISSUER, need);
  console.log(JSON.stringify(r, null, 2));
  if (!r.ok) { console.error('\nPREFLIGHT FAILED:\n- ' + r.problems.join('\n- ')); process.exit(1); }
  console.log('\nPREFLIGHT OK');
})().catch(e => { console.error(e.message); process.exit(1); });
