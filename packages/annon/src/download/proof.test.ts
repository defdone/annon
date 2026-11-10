import { readFileSync } from 'node:fs';
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { describe, expect, it } from 'vitest';
import {
  BUYER_PROOF_DST,
  buyerProof,
  purchaseProof,
  readPurchaseProof,
  sameResource,
  verifyBuyerProof,
} from './proof.js';

// Written by specs/vectors/buyer-proof.mjs and checked independently with py_ecc.
const vectors = JSON.parse(
  readFileSync(new URL('../../../../specs/vectors/buyer-proof.json', import.meta.url), 'utf8'),
) as {
  dst: string;
  valid: {
    id: string;
    secret: string;
    buyerKey: string;
    resourceUrl: string;
    proof: string;
    purchase_id: string;
    grant: number;
    header: string;
  }[];
  invalid: { id: string; buyerKey: string; resourceUrl: string; proof: string }[];
};
const bytes = (h: string) => Uint8Array.from(Buffer.from(h.slice(2), 'hex'));

describe('the buyer proof (download.md section 3)', () => {
  it('signs and verifies exactly as the shared vectors say', () => {
    expect(BUYER_PROOF_DST).toBe(vectors.dst);
    for (const v of vectors.valid) {
      expect(buyerProof(bytes(v.secret), v.resourceUrl)).toBe(v.proof);
      expect(purchaseProof(bytes(v.secret), v.resourceUrl, v.purchase_id, v.grant)).toBe(v.header);
      expect(readPurchaseProof(v.header)).toEqual({
        purchase_id: v.purchase_id,
        grant: v.grant,
        signature: v.proof,
      });
      expect(readPurchaseProof(v.proof)).toBeNull();
      expect(verifyBuyerProof(v.buyerKey, v.resourceUrl, v.proof)).toBe(true);
    }
  });

  it('refuses every invalid vector: another URL, key, DST, or a flipped byte', () => {
    for (const v of vectors.invalid) {
      expect(verifyBuyerProof(v.buyerKey, v.resourceUrl, v.proof), v.id).toBe(false);
    }
  });

  it('refuses the identity as a key or a signature, and malformed encodings', () => {
    const [v] = vectors.valid;
    if (!v) throw new Error('no vector');
    const zeroKey = `0x${Buffer.from(bls.G1.Point.ZERO.toBytes(true)).toString('hex')}`;
    expect(verifyBuyerProof(zeroKey, v.resourceUrl, v.proof)).toBe(false);
    const zeroSig = Buffer.from(bls.G2.Point.ZERO.toBytes(true)).toString('base64url');
    expect(verifyBuyerProof(v.buyerKey, v.resourceUrl, zeroSig)).toBe(false);
    // Both the identity: e(0, G1) = e(H, 0) = 1, so only the explicit check refuses it.
    expect(verifyBuyerProof(zeroKey, v.resourceUrl, zeroSig)).toBe(false);
    for (const bad of [
      `${v.proof}=`,
      v.proof.slice(1),
      `${v.proof}A`,
      '',
      'not base64!',
      `${v.proof.slice(0, -1)}+`,
    ]) {
      expect(verifyBuyerProof(v.buyerKey, v.resourceUrl, bad), bad).toBe(false);
    }
    expect(verifyBuyerProof('0x1234', v.resourceUrl, v.proof)).toBe(false);
  });
});

describe('sameResource: the client signs only for where the request goes', () => {
  it('takes URLs equal after WHATWG parsing, without the fragment', () => {
    expect(sameResource('https://a.example/f/1', 'https://a.example/f/1')).toBe(true);
    expect(sameResource('HTTPS://A.EXAMPLE:443/f/1', 'https://a.example/f/1')).toBe(true);
    expect(sameResource('https://a.example/f/1#x', 'https://a.example/f/1')).toBe(true);
    expect(sameResource('https://a.example/f/./1', 'https://a.example/f/1')).toBe(true);
  });

  it('refuses another host, port, scheme, path or query, and what does not parse', () => {
    const at = 'https://a.example/f/1?x=1';
    for (const other of [
      'https://b.example/f/1?x=1',
      'https://a.example:8443/f/1?x=1',
      'http://a.example/f/1?x=1',
      'https://a.example/f/2?x=1',
      'https://a.example/f/1?x=2',
      'https://a.example/f/1',
      'not a url',
    ]) {
      expect(sameResource(other, at), other).toBe(false);
    }
  });
});
