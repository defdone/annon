import { readFileSync } from 'node:fs';
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { base58 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { bitCases } from '../../test/sampling.js';
import { open, seal } from '../envelope/pay2.js';
import {
  appId,
  CkdError,
  decrypt,
  fileAppId,
  hashPoint,
  keyFromSecret,
  oneTimeKey,
  openAnswer,
} from './near-ckd.js';

const G1 = bls.G1.Point;
const G2 = bls.G2.Point;
const Fr = bls.fields.Fr;
const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const g1 = (p: InstanceType<typeof G1>) => `bls12381g1:${base58.encode(p.toBytes(true))}`;
const g2 = (p: InstanceType<typeof G2>) => `bls12381g2:${base58.encode(p.toBytes(true))}`;
const code = (f: () => unknown) => {
  try {
    f();
    return 'accepted';
  } catch (e) {
    return e instanceof CkdError ? e.code : `crashed: ${(e as Error).message}`;
  }
};

// NEAR's own vectors and app-id snapshot (github.com/near/mpc at the commit the contract pins).
const near = JSON.parse(
  readFileSync(new URL('../../../../specs/vectors/ckd-near-mpc.json', import.meta.url), 'utf8'),
) as {
  ckd: {
    a: string;
    app_id: string;
    app_pk1: string;
    big_c: string;
    big_y: string;
    hash_point: string;
    pk: string;
    s: string;
    sig: string;
  }[];
  appIds: { account: string; path: string; appId: string }[];
};

describe("NEAR's CKD vectors", () => {
  for (const [i, v] of near.ckd.entries()) {
    it(`reproduces vector ${i}: one-time key, hash point and decrypted signature`, () => {
      const pk = G2.fromBytes(hex(v.pk));
      const id = hex(v.app_id);
      expect(toHex(keyFromSecret(hex(v.a)).publicKeyBytes)).toBe(v.app_pk1);
      expect(toHex(hashPoint(pk, id).toBytes(true))).toBe(v.hash_point);
      const sig = decrypt(
        BigInt(`0x${v.a}`),
        G1.fromBytes(hex(v.big_y)),
        G1.fromBytes(hex(v.big_c)),
        pk,
        id,
      );
      expect(toHex(sig.toBytes(true))).toBe(v.sig);
    });

    it(`opens vector ${i} through the contract-facing API`, () => {
      const answer = {
        big_y: g1(G1.fromBytes(hex(v.big_y))),
        big_c: g1(G1.fromBytes(hex(v.big_c))),
      };
      const secret = openAnswer(answer, {
        secret: hex(v.a),
        appId: hex(v.app_id),
        mpcKey: g2(G2.fromBytes(hex(v.pk))),
      });
      expect(toHex(secret)).toBe(v.sig);
    });
  }

  it("derives every app id in NEAR's snapshot", () => {
    for (const x of near.appIds) expect(toHex(appId(x.account, x.path))).toBe(x.appId);
  });
});

// A simulated MPC network for the cases the vectors don't cover: msk, its public key and the
// ElGamal answer the network sends (Y = y·G1, C = msk·H + y·A).
const msk = 0x1234567890abcdefn;
const pk = G2.BASE.multiply(msk);
const mpcKey = g2(pk);
const CONTRACT = 'v1.annon.defdone.near';
const fileId = new Uint8Array(32).fill(0x11);
function answerFor(A: Uint8Array, id: Uint8Array, y = 0x777n) {
  const sig = hashPoint(pk, id).multiply(msk);
  return {
    sig,
    answer: { big_y: g1(G1.BASE.multiply(y)), big_c: g1(sig.add(G1.fromBytes(A).multiply(y))) },
  };
}

describe('openAnswer', () => {
  const key = oneTimeKey();
  const id = fileAppId(CONTRACT, fileId);
  const { sig, answer } = answerFor(key.publicKeyBytes, id);
  const opts = { secret: key.secret, appId: id, mpcKey };

  it('returns the 48-byte key NEAR released for this file', () => {
    expect(toHex(openAnswer(answer, opts))).toBe(toHex(sig.toBytes(true)));
  });

  it("uses the contract's path: file/ and the file id in lowercase hex", () => {
    expect(toHex(fileAppId(CONTRACT, fileId))).toBe(
      toHex(appId(CONTRACT, `file/${'11'.repeat(32)}`)),
    );
  });

  it('refuses an answer for another file, contract, one-time key or MPC key', () => {
    expect(
      code(() => openAnswer(answer, { ...opts, appId: fileAppId(CONTRACT, new Uint8Array(32)) })),
    ).toBe('ckd_invalid');
    expect(
      code(() => openAnswer(answer, { ...opts, appId: fileAppId('other.near', fileId) })),
    ).toBe('ckd_invalid');
    expect(code(() => openAnswer(answer, { ...opts, secret: oneTimeKey().secret }))).toBe(
      'ckd_invalid',
    );
    expect(
      code(() => openAnswer(answer, { ...opts, mpcKey: g2(G2.BASE.multiply(msk + 1n)) })),
    ).toBe('ckd_invalid');
  });

  it('passes on the contract error, so the client knows to call reopen', () => {
    const error = { error: 'MPC did not release the key; call reopen' };
    expect(code(() => openAnswer(error, opts))).toBe('ckd_failed');
  });

  it('refuses malformed answers without crashing', () => {
    for (const bad of [
      null,
      {},
      'x',
      { big_y: answer.big_y },
      { ...answer, big_c: 'bls12381g2:abc' },
      { ...answer, big_y: 'bls12381g1:0OIl' },
    ]) {
      expect(code(() => openAnswer(bad, opts))).toBe('ckd_invalid');
    }
  });

  it('refuses the identity point and a point outside the prime subgroup', () => {
    const zero = `bls12381g1:${base58.encode(G1.ZERO.toBytes(true))}`;
    expect(code(() => openAnswer({ ...answer, big_y: zero }, opts))).toBe('ckd_invalid');
    expect(code(() => openAnswer({ big_y: zero, big_c: zero }, opts))).toBe('ckd_invalid');
    // A point on the curve but not in the subgroup: the first x with a square root, compressed by hand.
    const Fp = bls.fields.Fp;
    let x = 1n;
    for (; ; x++) {
      const rhs = Fp.add(Fp.mul(Fp.mul(x, x), x), 4n);
      try {
        Fp.sqrt(rhs);
        break;
      } catch {}
    }
    const bytes = hex(x.toString(16).padStart(96, '0'));
    bytes[0] = (bytes[0] ?? 0) | 0x80;
    expect(
      G1.fromAffine({ x, y: Fp.sqrt(Fp.add(Fp.mul(Fp.mul(x, x), x), 4n)) }).isTorsionFree(),
    ).toBe(false);
    expect(
      code(() => openAnswer({ ...answer, big_c: `bls12381g1:${base58.encode(bytes)}` }, opts)),
    ).toBe('ckd_invalid');
  });

  it('refuses single-bit changes (boundary sample, or every bit with ANNON_EXHAUSTIVE=1) of big_y and big_c', () => {
    const wrong: string[] = [];
    for (const field of ['big_y', 'big_c'] as const) {
      const bytes = base58.decode(answer[field].slice('bls12381g1:'.length));
      for (const bit of bitCases(bytes.length, [0, 1, bytes.length])) {
        const f = bytes.slice();
        f[bit >> 3] = (f[bit >> 3] ?? 0) ^ (1 << (bit & 7));
        const got = code(() =>
          openAnswer({ ...answer, [field]: `bls12381g1:${base58.encode(f)}` }, opts),
        );
        if (got !== 'ckd_invalid') wrong.push(`${field} bit ${bit}: ${got}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('gives the seller and every buyer the same key, so the file opens for both', async () => {
    const seller = oneTimeKey();
    const buyer = oneTimeKey();
    const sellerSecret = openAnswer(answerFor(seller.publicKeyBytes, id, 5n).answer, {
      ...opts,
      secret: seller.secret,
    });
    const buyerSecret = openAnswer(answerFor(buyer.publicKeyBytes, id, 9n).answer, {
      ...opts,
      secret: buyer.secret,
    });
    expect(toHex(buyerSecret)).toBe(toHex(sellerSecret));

    // The PAY2 envelope with this key, end to end (the seller's wallet is a fixed test key).
    const { secp256k1 } = await import('@noble/curves/secp256k1.js');
    const { keccak_256 } = await import('@noble/hashes/sha3.js');
    const priv = new Uint8Array(32).fill(1);
    const seller20 = `0x${toHex(keccak_256(secp256k1.getPublicKey(priv, false).subarray(1)).subarray(12))}`;
    const sign = async (text: string) => {
      const t = new TextEncoder().encode(text);
      const d = keccak_256(
        new Uint8Array([
          ...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${t.length}`),
          ...t,
        ]),
      );
      const r = secp256k1.sign(d, priv, { prehash: false, format: 'recovered' });
      return new Uint8Array([...r.subarray(1), 27 + (r[0] ?? 0)]);
    };
    const data = new TextEncoder().encode('pay, friend, and enter');
    const sealed = await seal(data, { fileId, name: 'door.txt', mime: 'text/plain' });
    const file = await sealed.finish({
      contractId: CONTRACT,
      ckdSecret: sellerSecret,
      seller: seller20,
      sign,
    });
    const listing = { fileId, cipherHash: sealed.cipherHash, seller: seller20 };
    const opened = await open(file, {
      listing,
      contractId: CONTRACT,
      ckdSecret: async () => buyerSecret,
    });
    expect(new TextDecoder().decode(opened.data)).toBe('pay, friend, and enter');
  });

  it('makes one-time keys that are valid, distinct scalars', () => {
    const keys = Array.from({ length: 20 }, () => oneTimeKey());
    expect(new Set(keys.map((k) => k.publicKey)).size).toBe(20);
    for (const k of keys) {
      const a = BigInt(`0x${toHex(k.secret)}`);
      expect(a > 0n && a < Fr.ORDER).toBe(true);
      expect(k.publicKey).toBe(keyFromSecret(k.secret).publicKey);
    }
  });
});
