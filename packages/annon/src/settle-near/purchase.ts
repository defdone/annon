/** Purchase commitment, canonical wire message and recovery text, spec §§5,9. */
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  account,
  bytes,
  concat,
  exactKeys,
  hash,
  hex,
  le,
  network,
  str,
  uint,
  utc,
  utf8,
} from './codec.js';
import {
  encodeIdentity,
  type Identity,
  identityJson,
  identityText,
  parseIdentity,
} from './identity.js';
import { BASE_USDC, NEAR_USDC, type SettlementAssets } from './terms.js';

export interface Purchase {
  version: 2;
  refund: Identity;
  network: string;
  contract: string;
  route: 'near-usdc' | 'base-usdc';
  asset: string;
  file_id: string;
  terms_hash: string;
  price: string;
  nonce: string;
  buyer_key: string;
  recovery: Identity;
  expires_at: string;
}
export function buyerKey(key: string): Uint8Array<ArrayBuffer> {
  const raw = bytes(key, 48);
  const point = bls.G1.Point.fromBytes(raw);
  if (point.is0() || !point.isTorsionFree() || hex(point.toBytes(true)) !== key)
    throw new TypeError('invalid buyer key');
  return raw;
}
export function encodePurchase(
  p: Purchase,
  assets: SettlementAssets = {},
): Uint8Array<ArrayBuffer> {
  exactKeys(p, [
    'version',
    'refund',
    'network',
    'contract',
    'route',
    'asset',
    'file_id',
    'terms_hash',
    'price',
    'nonce',
    'buyer_key',
    'recovery',
    'expires_at',
  ]);
  if (p.version !== 2 || (p.route !== 'near-usdc' && p.route !== 'base-usdc'))
    throw new TypeError('invalid purchase version/route');
  if (p.route === 'near-usdc') {
    network(p.network);
    account(p.asset);
    if (
      (assets.nearUsdc !== undefined || p.network === 'near:mainnet') &&
      p.asset !== (assets.nearUsdc ?? NEAR_USDC)
    )
      throw new TypeError('invalid NEAR asset');
  } else {
    if (p.network !== 'eip155:8453' || p.asset !== (assets.baseUsdc ?? BASE_USDC))
      throw new TypeError('invalid Base network/asset');
    bytes(p.asset, 20);
  }
  account(p.contract);
  const amount = uint(p.price, 128);
  if (amount === 0n) throw new RangeError('price must be positive');
  return concat(
    le(2, 1),
    encodeIdentity(p.refund),
    str(p.network),
    str(p.contract),
    le(p.route === 'near-usdc' ? 0 : 1, 1),
    str(p.asset),
    bytes(p.file_id, 32),
    bytes(p.terms_hash, 32),
    le(amount, 16),
    bytes(p.nonce, 32),
    buyerKey(p.buyer_key),
    encodeIdentity(p.recovery),
    le(uint(p.expires_at, 64), 8),
  );
}
export const purchaseId = (p: Purchase, assets?: SettlementAssets): string =>
  hash('annon/purchase/v2', encodePurchase(p, assets));
export const baseNonceV2 = (id: string): string =>
  hex(keccak_256(concat(utf8.encode('annon/base-payment/v2'), le(0, 1), bytes(id, 32))));

/** The API accepts normalized identities; the wire always has one canonical encoding. */
export function buildPurchaseMessage(p: Purchase, assets?: SettlementAssets): string {
  const id = purchaseId(p, assets);
  const msg = JSON.stringify({
    annon: 2,
    refund: parseIdentity(p.refund),
    purchase: {
      network: p.network,
      contract: p.contract,
      route: p.route,
      asset: p.asset,
      file_id: p.file_id,
      terms_hash: p.terms_hash,
      price: p.price,
      nonce: p.nonce,
      buyer_key: p.buyer_key,
      recovery: parseIdentity(p.recovery),
      expires_at: p.expires_at,
      purchase_id: id,
    },
  });
  if (utf8.encode(msg).length > 1024)
    throw new RangeError('purchase message exceeds 1024 UTF-8 bytes');
  return msg;
}

/** Reads only the first 160 bytes, independently of an invalid/oversized purchase body. */
export function parseRefundPrefix(msg: string): Identity {
  if (typeof msg !== 'string') throw new TypeError('expected message string');
  const prefix = msg.slice(0, 160);
  const match =
    /^\{"annon":2,"refund":(\{"kind":"(?:evm|solana|near)","id":"[a-zA-Z0-9._-]+"\}),/.exec(prefix);
  if (!match) throw new TypeError('invalid refund prefix');
  const encoded = match[1] as string;
  const id = parseIdentity(JSON.parse(encoded));
  if (identityJson(id) !== encoded || utf8.encode(match[0]).length > 160)
    throw new TypeError('noncanonical refund prefix');
  return id;
}

/**
 * Bounds work before JSON.parse, then compares with the canonical serializer. This also rejects
 * duplicate/unknown fields at every level, alternate escapes, key order and whitespace.
 */
export function parsePurchaseMessage(msg: string, assets?: SettlementAssets): Purchase {
  if (typeof msg !== 'string' || msg.length > 1024 || utf8.encode(msg).length > 1024)
    throw new RangeError('purchase message exceeds 1024 UTF-8 bytes');
  const refund = parseRefundPrefix(msg);
  const obj: unknown = JSON.parse(msg);
  exactKeys(obj, ['annon', 'refund', 'purchase']);
  if (obj.annon !== 2) throw new TypeError('invalid annon version');
  const p = obj.purchase;
  exactKeys(p, [
    'network',
    'contract',
    'route',
    'asset',
    'file_id',
    'terms_hash',
    'price',
    'nonce',
    'buyer_key',
    'recovery',
    'expires_at',
    'purchase_id',
  ]);
  const decoded: Purchase = {
    version: 2,
    refund,
    network: p.network as string,
    contract: p.contract as string,
    route: p.route as Purchase['route'],
    asset: p.asset as string,
    file_id: p.file_id as string,
    terms_hash: p.terms_hash as string,
    price: p.price as string,
    nonce: p.nonce as string,
    buyer_key: p.buyer_key as string,
    recovery: parseIdentity(p.recovery),
    expires_at: p.expires_at as string,
  };
  if (buildPurchaseMessage(decoded, assets) !== msg)
    throw new TypeError('noncanonical purchase message or incorrect purchase_id');
  return decoded;
}

export interface ReopenV2 {
  contract: string;
  purchase_id: string;
  file_id: string;
  recovery: Identity;
  fresh_key: string;
  nonce: string;
  deadline: number;
}
export function reopenTextV2(a: ReopenV2): string {
  account(a.contract);
  bytes(a.purchase_id, 32);
  bytes(a.file_id, 32);
  buyerKey(a.fresh_key);
  bytes(a.nonce, 32);
  return [
    'Annon: open a purchased file again',
    `contract: ${a.contract}`,
    `purchase: ${a.purchase_id}`,
    `file: ${a.file_id}`,
    `recovery: ${identityText(a.recovery)}`,
    `new key: ${a.fresh_key}`,
    `nonce: ${a.nonce}`,
    `valid until: ${utc(a.deadline)}`,
  ].join('\n');
}
