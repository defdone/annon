/** Resume by purchase commitment; wallet addresses never establish entitlement. */
import { getPurchase } from '../near/rpc.js';

import { blockHeader, type EvmLog, PayError } from './base.js';
import { status } from './pay.js';
import { type PurchaseRecord, purchaseKey, resendable } from './purchase.js';
import type { Store } from './store.js';

type NextStep =
  | { step: 'claim_key'; args: { purchase_id: string; grant: number } }
  | { step: 'unlock'; args: { purchase: string; logs: EvmLog[]; header: string | null } }
  | { step: 'resend'; header: string }
  | { step: 'wait' }
  | { step: 'buy' };
interface NextStepOptions {
  nearRpc: string;
  baseRpc: string;
  store: Store<PurchaseRecord>;
}
export async function nextStep(r: PurchaseRecord, o: NextStepOptions): Promise<NextStep> {
  if (await getPurchase(o.nearRpc, r.purchase.contract, r.id))
    return { step: 'claim_key', args: { purchase_id: r.id, grant: 0 } };
  if (r.purchase.route === 'near-usdc') return { step: 'wait' };
  const s = await status(o.baseRpc, r);
  if (s.state === 'pending') {
    const header = resendable(r, Math.floor(Date.now() / 1000));
    return header ? { step: 'resend', header } : { step: 'wait' };
  }
  if (s.state !== 'paid') {
    if (
      r.paymentState !== s.state &&
      !(await o.store.compareAndSet(purchaseKey(r.id), r, {
        ...r,
        revision: r.revision + 1,
        paymentState: s.state,
      }))
    )
      throw new PayError('store_conflict');
    return { step: 'buy' };
  }
  return {
    step: 'unlock',
    args: {
      purchase: r.message,
      logs: s.logs,
      header: await blockHeader(o.baseRpc, `0x${(s.logs[0] as EvmLog).block_hash}`),
    },
  };
}
