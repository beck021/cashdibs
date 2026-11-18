import { Account, Asset, BASE_FEE, Horizon, Keypair, Operation, StrKey, Transaction, TransactionBuilder, Networks } from '@stellar/stellar-sdk';
import { AccountSnapshot, Signer, StellarObserver, StellarSubmitter, TxReceipt } from '../ports';
import { toStellarMemo, memoFromTransaction } from '../memo';
import { CashdibsError, MemoSpec } from '../types';
import { horizonAmountToUnits, unitsToHorizonAmount } from '../units';

export const TESTNET_PASSPHRASE = Networks.TESTNET;

export class KeypairSigner implements Signer {
  constructor(private kp: Keypair) {}
  get publicKey() { return this.kp.publicKey(); }
  signEnvelope(txXdr: string, passphrase: string) {
    const tx = TransactionBuilder.fromXDR(txXdr, passphrase) as Transaction;
    tx.sign(this.kp);
    return tx.toEnvelope().toXDR('base64');
  }
}

export interface PreparedPayment { envelopeXdr: string; hash: string; sequence: string; maxTime: number }

/**
 * Build and sign ONE classic payment of USDC. Does not touch the network. The caller persists the
 * returned envelope and hash BEFORE submitting.
 */
export function preparePayment(args: {
  signer: Signer; destination: string; assetCode: string; assetIssuer: string; amountUnits: string;
  memo: MemoSpec; sequence: string; maxTimeSec: number; nowSec: number; passphrase: string; fee?: string;
}): PreparedPayment {
  if (!StrKey.isValidEd25519PublicKey(args.destination)) throw new CashdibsError('INVALID_DESTINATION', 'anchor destination is not a valid Stellar account');
  if (!StrKey.isValidEd25519PublicKey(args.assetIssuer)) throw new CashdibsError('INVALID_ASSET', 'asset issuer is not valid');
  if (args.destination === args.signer.publicKey) throw new CashdibsError('INVALID_DESTINATION', 'source and destination are identical');
  if (args.passphrase !== TESTNET_PASSPHRASE) throw new CashdibsError('WRONG_NETWORK', 'this build only signs for Stellar Testnet');
  if (args.maxTimeSec <= args.nowSec) throw new CashdibsError('DEADLINE_PASSED', 'no time left to submit before the hold or quote expires');
  const acct = new Account(args.signer.publicKey, args.sequence);
  const tx = new TransactionBuilder(acct, { fee: args.fee ?? BASE_FEE, networkPassphrase: args.passphrase,
    timebounds: { minTime: 0, maxTime: args.maxTimeSec }, memo: toStellarMemo(args.memo) })
    .addOperation(Operation.payment({ destination: args.destination, asset: new Asset(args.assetCode, args.assetIssuer), amount: unitsToHorizonAmount(args.amountUnits) }))
    .build();
  const hash = tx.hash().toString('hex');
  const signed = args.signer.signEnvelope(tx.toEnvelope().toXDR('base64'), args.passphrase);
  return { envelopeXdr: signed, hash, sequence: (BigInt(args.sequence) + 1n).toString(), maxTime: args.maxTimeSec };
}

export class HorizonSubmitter implements StellarSubmitter {
  constructor(private server: Horizon.Server, private passphrase = TESTNET_PASSPHRASE) {}
  async submit(envelopeXdr: string) {
    const tx = TransactionBuilder.fromXDR(envelopeXdr, this.passphrase);
    const r = await this.server.submitTransaction(tx as Transaction);
    return { hash: r.hash, ledger: r.ledger };
  }
}

export class HorizonObserver implements StellarObserver {
  constructor(private server: Horizon.Server) {}
  async getAccount(account: string, usdcIssuer: string): Promise<AccountSnapshot> {
    const a = await this.server.loadAccount(account);
    let xlm = 0n, usdc = 0n, trust = false;
    for (const b of a.balances as any[]) {
      if (b.asset_type === 'native') xlm = BigInt(Math.round(Number(b.balance) * 1e7));
      else if (b.asset_code === 'USDC' && b.asset_issuer === usdcIssuer) { trust = true; usdc = horizonAmountToUnits(b.balance); }
    }
    return { sequence: a.sequenceNumber(), xlmStroops: xlm, usdcUnits: usdc, hasUsdcTrustline: trust };
  }
  async getReceipt(hash: string): Promise<TxReceipt | null> {
    try {
      const t: any = await this.server.transactions().transaction(hash).call();
      const ops: any = await this.server.operations().forTransaction(hash).limit(200).call();
      const memo: MemoSpec | null = t.memo_type === 'none' || !t.memo ? null
        : t.memo_type === 'hash' ? { type: 'hash', value: Buffer.from(t.memo, 'base64').toString('hex') }
        : { type: t.memo_type, value: String(t.memo) };
      return { hash, successful: !!t.successful, ledger: t.ledger_attr ?? t.ledger, source: t.source_account, memo, operationCount: ops.records.length,
        payments: ops.records.filter((o: any) => o.type === 'payment').map((o: any) => ({ to: o.to, assetCode: o.asset_code ?? 'XLM', assetIssuer: o.asset_issuer ?? '', amountUnits: horizonAmountToUnits(o.amount).toString() })) };
    } catch (e: any) {
      if (e?.response?.status === 404 || e?.name === 'NotFoundError') return null;
      throw e; // transport errors are NOT "not found"
    }
  }
  async latestLedgerCloseTime(): Promise<number> {
    const l: any = await this.server.ledgers().order('desc').limit(1).call();
    return Math.floor(new Date(l.records[0].closed_at).getTime() / 1000);
  }
}
export { memoFromTransaction };
