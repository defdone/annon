/**
 * Recovery without a second payment (plan 25, 2.4; profile section 10). `authorize` records the
 * purchase before the wallet signs and the payload before anything sees it; whatever happens to the
 * client afterwards, the record alone says what to do next. A lost one-time secret loses nothing:
 * `unlock` with the recorded public key still records the purchase, and `reopen` with a fresh key
 * gets the file key.
 *
 * One open purchase per wallet and file, kept by the store: `authorize` refuses a new one until
 * `nextStep` closes the recorded one (paid and recorded on NEAR, or never payable).
 */

import { isBuyer, isPaymentUsed } from '../near/rpc.js';
import { blockHeader, type EvmLog, PayError } from './base.js';
import { status } from './pay.js';
import { type PurchaseRecord, purchaseKey, resendable } from './purchase.js';
import type { Store } from './store.js';

export type NextStep =
  /**
   * Paid, not yet recorded on NEAR: send `unlock` with these args (any relayer may). The header
   * is always there: a stop between now and the unlock would otherwise refuse a paid buyer. The
   * purchase stays open.
   */
  | { step: 'unlock'; args: { file_id: string; buyer_key: string; logs: EvmLog[]; header: string } }
  /**
   * NEAR has this wallet as a buyer: closed. The wallet signs `reopen` with a fresh one-time key if
   * it needs the key again. `txHash` is this purchase's payment, missing when the wallet was
   * recorded by another payment.
   */
  | { step: 'reopen'; txHash?: string }
  /**
   * Not on Base yet, and this recorded payload can still settle: send it again, as it is. Never
   * given once NEAR has recorded this wallet as a buyer of the file by another payment.
   */
  | { step: 'resend'; header: string }
  /** It may still settle, with nothing to resend: wait. Do not start another purchase. */
  | { step: 'wait' }
  /** Expired or canceled at a finalized block, never paid: closed. A new purchase is safe. */
  | { step: 'buy' };

export interface NextStepOptions {
  nearRpc: string;
  baseRpc: string;
  /** The store the purchase is recorded in: `nextStep` closes it there once it is settled. */
  store: Store<PurchaseRecord>;
}

/** What to do with a recorded purchase. Safe to call any number of times, from any tab. */
export async function nextStep(r: PurchaseRecord, o: NextStepOptions): Promise<NextStep> {
  const close = async () => {
    const key = purchaseKey(r.terms.contractId, r.terms.fileId, r.terms.buyer);
    if (!(await o.store.compareAndSet(key, r, null))) {
      const e = new PayError('store_conflict', 'the purchase changed meanwhile: load it again');
      e.purchase = r;
      throw e;
    }
  };
  const s = await status(o.baseRpc, r);
  if (
    s.state === 'paid' &&
    (await isPaymentUsed(o.nearRpc, r.terms.contractId, s.txHash, s.logIndex))
  ) {
    await close();
    return { step: 'reopen', txHash: s.txHash };
  }
  // A buyer on NEAR by another payment (another tab's): the purchase is done, whatever this
  // payment's state; never resend it.
  if (await isBuyer(o.nearRpc, r.terms.contractId, r.terms.fileId, r.terms.buyer)) {
    await close();
    return s.state === 'paid' ? { step: 'reopen', txHash: s.txHash } : { step: 'reopen' };
  }
  if (s.state === 'pending') {
    const header = resendable(r, Math.floor(Date.now() / 1000));
    return header ? { step: 'resend', header } : { step: 'wait' };
  }
  if (s.state !== 'paid') {
    await close();
    return { step: 'buy' };
  }
  // Rebuilt from the RPC's block and checked to hash to the log's block hash, which MPC verifies.
  const header = await blockHeader(o.baseRpc, `0x${(s.logs[0] as EvmLog).block_hash}`);
  return {
    step: 'unlock',
    args: { file_id: r.terms.fileId, buyer_key: r.terms.buyerKey, logs: s.logs, header },
  };
}
