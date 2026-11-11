/** Typed keeper calls only; scheduling, retry and accounting belong to the caller. */
import { view } from '../near/rpc.js';
import { account, bytes, uint } from '../settle-near/codec.js';
import { type Identity, parseIdentity } from '../settle-near/identity.js';
import type { NearWallet } from '../wallet/wallet.js';

export interface DeliveryStep {
  state: 0 | 1 | 2;
  attempt: number;
}
export interface DeliveryInfo {
  id: number;
  amount: string;
  sender: string;
  purchase: string | null;
  reason: number;
  fund: DeliveryStep;
  funded: string;
  slots: { to: Identity; amount: string; step: DeliveryStep }[];
}
export interface MaterializeRefundArgs {
  leaf: { delivery_id: number; refund: Identity; amount: string };
  index: number;
  proof: string[];
}
export interface RefundRoot {
  root: string;
  count: number;
}
const integer = (v: number, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(v) || v < 0 || v > max) throw new TypeError('invalid contract integer');
};
const delivery = (v: unknown): DeliveryInfo => {
  const d = v as DeliveryInfo;
  integer(d.id);
  account(d.sender);
  uint(d.amount, 128);
  uint(d.funded, 128);
  if (d.purchase !== null) bytes(d.purchase, 32);
  integer(d.reason, 255);
  const step = (s: DeliveryStep) => {
    integer(s.state, 2);
    integer(s.attempt, 0xffffffff);
  };
  step(d.fund);
  if (!Array.isArray(d.slots) || d.slots.length > 9) throw new TypeError('invalid delivery slots');
  for (const slot of d.slots) {
    parseIdentity(slot.to);
    uint(slot.amount, 128);
    step(slot.step);
  }
  return d;
};
export async function getDelivery(
  url: string,
  contract: string,
  deliveryId: number,
): Promise<DeliveryInfo | null> {
  integer(deliveryId);
  const d = await view(url, contract, 'get_delivery', { delivery_id: deliveryId });
  return d === null ? null : delivery(d);
}
export async function listDeliveries(
  url: string,
  contract: string,
  from = 0,
  limit = 50,
  onError?: (error: unknown) => void,
): Promise<DeliveryInfo[]> {
  integer(from);
  integer(limit, 50);
  const ds = await view(url, contract, 'list_deliveries', { from, limit });
  if (!Array.isArray(ds) || ds.length > limit) throw new TypeError('invalid deliveries');
  return ds.flatMap((d) => {
    try {
      return [delivery(d)];
    } catch (error) {
      if (!onError) throw error;
      onError(error);
      return [];
    }
  });
}
/** How many delivery ids exist; some have no record yet (refund leaves), so scan them all. */
export async function deliveryCount(url: string, contract: string): Promise<number> {
  const n = await view(url, contract, 'delivery_count', {});
  integer(n as number);
  return n as number;
}
export async function refundRoot(url: string, contract: string): Promise<RefundRoot> {
  const r = (await view(url, contract, 'refund_root', {})) as RefundRoot;
  bytes(r.root, 32);
  integer(r.count, 2 ** 32);
  return r;
}
export function fundDelivery(
  wallet: Pick<NearWallet, 'call'>,
  contract: string,
  deliveryId: number,
): Promise<unknown> {
  integer(deliveryId);
  return wallet.call({
    receiverId: account(contract),
    method: 'fund_delivery',
    args: { delivery_id: deliveryId },
    gas: 150000000000000n,
  });
}
export function paySlot(
  wallet: Pick<NearWallet, 'call'>,
  contract: string,
  deliveryId: number,
  slot: number,
): Promise<unknown> {
  integer(deliveryId);
  integer(slot, 0xffffffff);
  return wallet.call({
    receiverId: account(contract),
    method: 'pay_slot',
    args: { delivery_id: deliveryId, slot },
    gas: 80000000000000n,
  });
}
export function materializeRefund(
  wallet: Pick<NearWallet, 'call'>,
  contract: string,
  args: MaterializeRefundArgs,
  deposit: bigint,
): Promise<unknown> {
  integer(args.leaf.delivery_id);
  integer(args.index, 0xffffffff);
  uint(args.leaf.amount, 128);
  parseIdentity(args.leaf.refund);
  if (args.proof.length !== 32) throw new TypeError('refund proof must have 32 siblings');
  for (const sibling of args.proof) bytes(sibling, 32);
  if (deposit <= 0n) throw new TypeError('materialize_refund needs a storage deposit');
  return wallet.call({
    receiverId: account(contract),
    method: 'materialize_refund',
    args,
    gas: 100000000000000n,
    deposit,
  });
}
