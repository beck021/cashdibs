import { StellarObserver } from '../ports';
import { CashdibsError } from '../types';

export interface PreflightResult {
  ok: boolean;
  account: string;
  xlmStroops: string;
  usdcUnits: string;
  hasUsdcTrustline: boolean;
  required: { usdcUnits: string; minXlmStroops: string };
  problems: string[];
}

/** Base reserve (0.5 XLM) x (2 + trustlines) plus fee headroom; deliberately conservative. */
export const MIN_SENDER_XLM_STROOPS = 20_000_000n; // 2 XLM

/** can this account send `requiredUsdcUnits`? Read-only. */
export async function senderPreflight(observer: StellarObserver, account: string, usdcIssuer: string, requiredUsdcUnits: bigint, minXlm = MIN_SENDER_XLM_STROOPS): Promise<PreflightResult> {
  let snap;
  try { snap = await observer.getAccount(account, usdcIssuer); }
  catch (e: any) { throw new CashdibsError('PREFLIGHT_UNAVAILABLE', `could not read ${account} from Horizon: ${e?.message ?? e}`, 502, true); }
  const problems: string[] = [];
  if (!snap.hasUsdcTrustline) problems.push('no USDC trustline to the Circle Testnet issuer');
  if (snap.usdcUnits < requiredUsdcUnits) problems.push(`USDC balance ${snap.usdcUnits} < required ${requiredUsdcUnits} (base units); request more from faucet.circle.com`);
  if (snap.xlmStroops < minXlm) problems.push(`XLM balance ${snap.xlmStroops} stroops is below the ${minXlm} reserve/fee floor`);
  return { ok: problems.length === 0, account, xlmStroops: snap.xlmStroops.toString(), usdcUnits: snap.usdcUnits.toString(), hasUsdcTrustline: snap.hasUsdcTrustline,
    required: { usdcUnits: requiredUsdcUnits.toString(), minXlmStroops: minXlm.toString() }, problems };
}
