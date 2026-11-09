/**
 * Recovery without a second payment (plan 25, 2.4). `authorize` saves the job before the wallet
 * signs; whatever happens to the client afterwards, the job alone says what to do next. Nothing in
 * it is secret: if the one-time key's secret is lost, `unlock` with the job's public key still
 * records the purchase, and `reopen` with a fresh key gets the file key.
 *
 * One purchase at a time per wallet and file: the store behind `persist` must refuse a new job
 * while `nextStep` of the saved one is anything but `buy` (two tabs, a retry, a restart). Then the
 * second attempt fails before the wallet is asked, and no second payment can exist.
 */

import { isPaymentUsed } from '../near/rpc.js';
import { blockHeader, type EvmLog } from './base.js';
import { type PaymentJob, status } from './pay.js';

export type NextStep =
  /**
   * Paid, not yet recorded on NEAR: send `unlock` with these args (any relayer may). The header
   * is always there: a stop between now and the unlock would otherwise refuse a paid buyer.
   */
  | { step: 'unlock'; args: { file_id: string; buyer_key: string; logs: EvmLog[]; header: string } }
  /** Paid and recorded: the wallet signs `reopen` with a fresh one-time key to get the file key. */
  | { step: 'reopen'; txHash: string }
  /** Signed and still valid, not on Base yet: it may settle. Do not start another purchase. */
  | { step: 'wait' }
  /** Expired or canceled, never paid: a new purchase with a new key is safe. */
  | { step: 'buy' };

/** What to do with a saved job. Safe to call any number of times, from any device. */
export async function nextStep(
  job: PaymentJob,
  o: { nearRpc: string; baseRpc: string },
): Promise<NextStep> {
  const s = await status(o.baseRpc, job);
  if (s.state === 'pending') return { step: 'wait' };
  if (s.state !== 'paid') return { step: 'buy' };
  if (await isPaymentUsed(o.nearRpc, job.contractId, s.txHash, s.logIndex)) {
    return { step: 'reopen', txHash: s.txHash };
  }
  // Rebuilt from the RPC's block and checked to hash to the log's block hash, which MPC verifies.
  const header = await blockHeader(o.baseRpc, `0x${(s.logs[0] as EvmLog).block_hash}`);
  return {
    step: 'unlock',
    args: { file_id: job.fileId, buyer_key: job.buyerKey, logs: s.logs, header },
  };
}

/** The key a store uses for "one purchase at a time": the wallet and the file. */
export const purchaseKey = (job: Pick<PaymentJob, 'contractId' | 'fileId' | 'buyer'>) =>
  `${job.contractId}/${job.fileId}/${job.buyer.toLowerCase()}`;
