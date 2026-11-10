import { describe, expect, it } from 'vitest';
import { evm, purchase, terms } from '../../test/fixtures.js';
import { parseHeader, sealAuth } from '../envelope/pay2.js';
import { encodePurchase } from './purchase.js';
import { encodeTerms, NEAR_USDC } from './terms.js';

describe('one settlement model', () => {
  it('refuses PAY2 v1 before parsing the rest', () => {
    const h = new Uint8Array(54);
    h.set([80, 65, 89, 50, 1, 16]);
    expect(() => parseHeader(h)).toThrowError(
      expect.objectContaining({ code: 'unsupported_version' }),
    );
    expect(() =>
      sealAuth({ version: 1, fileId: new Uint8Array(32), name: '', mime: '' } as never),
    ).toThrow();
  });
  it('refuses registration of version 1', () => {
    expect(() => encodeTerms({ ...terms, pay2_version: 1 } as never)).toThrow();
  });
  it.each(['near:mainnet', 'near:testnet', 'eip155:1'])('refuses Base network %s', (network) => {
    expect(() => encodePurchase({ ...purchase, network })).toThrow();
  });
  it('refuses a different or noncanonical Base asset', () => {
    for (const asset of [evm.id, purchase.asset.toUpperCase(), NEAR_USDC])
      expect(() => encodePurchase({ ...purchase, asset })).toThrow();
  });
});
