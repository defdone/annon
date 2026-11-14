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

/** Unordered positions, capped at 50. Pin every page and count to ONE finalized block ID;
 * removal swaps the last entry into the hole. Moving-block forward scans can skip entries.
 * New deliveries after the snapshot are discovered on the next sweep. */
export async function listOpenDeliveries(
  url: string,
  contract: string,
  from = 0,
  limit = 50,
  blockId?: string | number,
): Promise<DeliveryInfo[]> {
  integer(from);
  integer(limit, 50);
  const ds = await view(url, contract, 'list_open_deliveries', { from, limit }, blockId);
  if (!Array.isArray(ds) || ds.length > limit) throw new TypeError('invalid deliveries');
  return ds.map(delivery);
}
/** Count includes Pending and InFlight records. Use the same block ID as every sweep page. */
export async function openDeliveryCount(
  url: string,
  contract: string,
  blockId?: string | number,
): Promise<number> {
  const n = await view(url, contract, 'open_delivery_count', {}, blockId);
  integer(n as number);
  return n as number;
}

/** Attach storage funding, or pass zero to spend the caller's prepaid contract balance. */
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
  if (deposit < 0n) throw new TypeError('invalid storage deposit');
  return wallet.call({
    receiverId: account(contract),
    method: 'materialize_refund',
    args,
    gas: 100000000000000n,
    deposit,
  });
}
