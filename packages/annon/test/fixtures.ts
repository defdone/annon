import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import type { Purchase } from '../src/settle-near/purchase.js';
import { NEAR_USDC, type Terms } from '../src/settle-near/terms.js';
export const evm = { kind: 'evm', id: `0x${'11'.repeat(20)}` } as const;
export const terms: Terms = {
  network: 'near:mainnet',
  contract: 'annon.near',
  file_id: `0x${'22'.repeat(32)}`,
  seller: evm,
  pay2_version: 2,
  cipher_hash: `0x${'33'.repeat(32)}`,
  moderator: null,
  near: {
    token: NEAR_USDC,
    price: '200000',
    recipients: [{ identity: evm, bps: 10000 }],
    remainder: 0,
  },
  base: { usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', price: '200000', pay_to: evm.id },
};
export const purchase: Purchase = {
  version: 2,
  refund: evm,
  network: 'eip155:8453',
  contract: 'annon.near',
  route: 'base-usdc',
  asset: must(terms.base).usdc,
  file_id: terms.file_id,
  terms_hash: terms.cipher_hash,
  price: '200000',
  nonce: `0x${'44'.repeat(32)}`,
  buyer_key: `0x${Buffer.from(bls.G1.Point.BASE.toBytes(true)).toString('hex')}`,
  recovery: evm,
  expires_at: '1800003600',
};
/** A fixture invariant; failures explain missing setup rather than crashing later. */
export function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('missing fixture value');
  return value;
}
