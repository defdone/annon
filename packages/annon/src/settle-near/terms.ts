/** Borsh commitments and seller texts, near-settlement.md §3. */
import { usdc, utc } from '../near/texts.js';
import {
  account,
  bytes,
  compare,
  concat,
  exactKeys,
  hash,
  le,
  network,
  str,
  uint,
} from './codec.js';
import { encodeIdentity, type Identity, identityText } from './identity.js';

export const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const NEAR_USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export interface NearTerms {
  token: string;
  price: string;
  recipients: { identity: Identity; bps: number }[];
  remainder: number;
}
export interface BaseTerms {
  usdc: string;
  price: string;
  pay_to: string;
}
export interface Terms {
  network: string;
  contract: string;
  file_id: string;
  seller: Identity;
  pay2_version: 2;
  cipher_hash: string;
  moderator: string | null;
  near: NearTerms;
  base: BaseTerms | null;
}
const price = (p: string) => {
  const n = uint(p, 128);
  if (n === 0n) throw new RangeError('price must be positive');
  return le(n, 16);
};
export function encodeTerms(t: Terms): Uint8Array<ArrayBuffer> {
  exactKeys(t, [
    'network',
    'contract',
    'file_id',
    'seller',
    'pay2_version',
    'cipher_hash',
    'moderator',
    'near',
    'base',
  ]);
  exactKeys(t.near, ['token', 'price', 'recipients', 'remainder']);
  if (t.base !== null) {
    exactKeys(t.base, ['usdc', 'price', 'pay_to']);
    if (t.base.usdc !== BASE_USDC) throw new TypeError('invalid Base USDC');
  }
  network(t.network);
  account(t.contract);
  if (t.pay2_version !== 2) throw new TypeError('unsupported PAY2 version');
  const n = t.near;
  if (
    n.token !== NEAR_USDC ||
    n.recipients.length < 1 ||
    n.recipients.length > 8 ||
    !Number.isInteger(n.remainder) ||
    n.remainder < 0 ||
    n.remainder >= n.recipients.length
  )
    throw new TypeError('invalid NEAR terms');
  let prev: Uint8Array | undefined;
  let sum = 0;
  const recipients = n.recipients.map((r) => {
    exactKeys(r, ['identity', 'bps']);
    const id = encodeIdentity(r.identity);
    if (prev && compare(prev, id) >= 0)
      throw new TypeError('recipients must be distinct and Borsh sorted');
    prev = id;
    if (!Number.isInteger(r.bps) || r.bps <= 0 || r.bps > 10000) throw new TypeError('invalid bps');
    sum += r.bps;
    return concat(id, le(r.bps, 2));
  });
  if (sum !== 10000) throw new TypeError('bps must sum to 10000');
  return concat(
    str(t.network),
    str(t.contract),
    bytes(t.file_id, 32),
    encodeIdentity(t.seller),
    le(t.pay2_version, 1),
    bytes(t.cipher_hash, 32),
    t.moderator === null ? le(0, 1) : concat(le(1, 1), str(account(t.moderator))),
    str(n.token),
    price(n.price),
    le(recipients.length, 4),
    ...recipients,
    le(n.remainder, 1),
    t.base === null
      ? le(0, 1)
      : concat(le(1, 1), bytes(t.base.usdc, 20), price(t.base.price), bytes(t.base.pay_to, 20)),
  );
}
export const termsHash = (t: Terms): string => hash('annon/terms/v2', encodeTerms(t));
export function registerTextV2(t: Terms, sellerKey: string, deadline: number): string {
  const commitment = termsHash(t);
  bytes(sellerKey, 48);
  return [
    'Annon: list a file for sale',
    'Signing this lets whoever holds the seller key below open the file.',
    `contract: ${t.contract}`,
    `file: ${t.file_id}`,
    `seller: ${identityText(t.seller)}`,
    `price: ${usdc(t.near.price)} USDC on NEAR`,
    ...t.near.recipients.map(
      (r) => `split: ${identityText(r.identity)} ${(r.bps / 100).toFixed(2)}%`,
    ),
    `remainder: ${identityText((t.near.recipients[t.near.remainder] as NearTerms['recipients'][number]).identity)}`,
    t.base ? `base: ${usdc(t.base.price)} USDC on Base to ${t.base.pay_to}` : 'base: none',
    `cipher: ${t.cipher_hash}`,
    `moderator: ${t.moderator ?? '(none)'}`,
    `terms: ${commitment}`,
    `seller key: ${sellerKey}`,
    `valid until: ${utc(deadline)}`,
  ].join('\n');
}
export function publishTextV2(contract: string, fileId: string, headerHash: string): string {
  account(contract);
  bytes(fileId, 32);
  bytes(headerHash, 32);
  return `Annon: publish a file\ncontract: ${contract}\nfile: ${fileId}\nheader: ${headerHash}`;
}
