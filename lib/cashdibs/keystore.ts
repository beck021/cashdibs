import fs from 'node:fs';
import path from 'node:path';
import { Keypair } from '@stellar/stellar-sdk';

export const KEY_FILE = path.join('.testnet', 'cashdibs-keys.json');
export interface CashdibsKeys { sender: { publicKey: string; secret: string }; anchor: { publicKey: string; secret: string } }

/** Two TEAM-CONTROLLED institutional Testnet accounts. Secrets stay in a 0600 file under git-ignored .testnet/. */
export function loadOrCreateKeys(file = KEY_FILE): { keys: CashdibsKeys; created: boolean } {
  if (fs.existsSync(file)) return { keys: JSON.parse(fs.readFileSync(file, 'utf8')), created: false };
  const mk = () => { const k = Keypair.random(); return { publicKey: k.publicKey(), secret: k.secret() }; };
  const keys = { sender: mk(), anchor: mk() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return { keys, created: true };
}
