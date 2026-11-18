import { Memo, xdr } from '@stellar/stellar-sdk';
import { CashdibsError, MemoSpec } from './types';

const UINT64_MAX = 18_446_744_073_709_551_615n;

/** Convert a SEP-31 memo (hash is base64 per spec; hex also accepted) to hex. */
function hashToHex(value: string): string {
  if (/^[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase();
  const buf = Buffer.from(value, 'base64');
  if (buf.length !== 32 || buf.toString('base64') !== value) {
    throw new CashdibsError('INVALID_MEMO', 'hash memo must be 32 bytes (base64 or 64 hex chars)');
  }
  return buf.toString('hex');
}

/** Validate an anchor-supplied memo and return a canonical spec. Throws on anything malformed. */
export function normalizeMemo(m: MemoSpec | null | undefined): MemoSpec {
  if (!m || !m.value) {
    throw new CashdibsError('MEMO_REQUIRED', 'The anchor must supply a memo so it can match the payment');
  }
  switch (m.type) {
    case 'text':
      if (Buffer.byteLength(m.value, 'utf8') > 28) {
        throw new CashdibsError('INVALID_MEMO', 'text memo exceeds 28 bytes');
      }
      return m;
    case 'id':
      if (!/^\d+$/.test(m.value) || BigInt(m.value) > UINT64_MAX) {
        throw new CashdibsError('INVALID_MEMO', 'id memo must be an unsigned 64-bit integer');
      }
      return m;
    case 'hash':
      return { type: 'hash', value: hashToHex(m.value) };
    default:
      throw new CashdibsError('INVALID_MEMO', `unsupported memo type '${(m as MemoSpec).type}'`);
  }
}

export function toStellarMemo(m: MemoSpec): Memo {
  const n = normalizeMemo(m);
  if (n.type === 'text') return Memo.text(n.value);
  if (n.type === 'id') return Memo.id(n.value);
  return Memo.hash(n.value);
}

/** Read a transaction's memo back into the canonical spec (for on-chain verification). */
export function memoFromTransaction(memo: Memo): MemoSpec | null {
  if (memo.type === 'none' || memo.value == null) return null;
  if (memo.type === 'text') return { type: 'text', value: Buffer.isBuffer(memo.value) ? memo.value.toString('utf8') : String(memo.value) };
  if (memo.type === 'id') return { type: 'id', value: String(memo.value) };
  if (memo.type === 'hash') return { type: 'hash', value: Buffer.from(memo.value as Buffer).toString('hex') };
  return null;
}

export const _xdr = xdr; // keep xdr import tree-shake safe for type consumers
