import { createHash } from 'node:crypto';
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  encodeIdentity,
  identityJson,
  identityText,
  intentsAccount,
  parseIdentity,
  solanaWalletAuth,
  verifyAuthorization,
} from './identity.js';
import {
  baseNonceV2,
  buildPurchaseMessage,
  encodePurchase,
  type Purchase,
  parsePurchaseMessage,
  parseRefundPrefix,
  purchaseId,
  reopenTextV2,
} from './purchase.js';
import { RefundTree, refundLeaf, verifyRefundProof } from './refund.js';
import {
  encodeTerms,
  NEAR_USDC,
  publishTextV2,
  registerTextV2,
  type Terms,
  termsHash,
} from './terms.js';

const h = (n: number, bytes = 32) => `0x${n.toString(16).padStart(bytes * 2, '0')}`;
const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}`;
const evm = { kind: 'evm', id: h(1, 20) } as const;
const near = { kind: 'near', id: 'seller.near' } as const;
const seed = new Uint8Array(32).fill(7);
const sol = {
  kind: 'solana',
  id: Buffer.from(ed25519.getPublicKey(seed)).toString('hex'),
} as const;
const key = hex(bls.G1.Point.BASE.toBytes(true));
const terms: Terms = {
  network: 'near:mainnet',
  contract: 'annon.near',
  file_id: h(3),
  seller: near,
  pay2_version: 2,
  cipher_hash: h(4),
  moderator: null,
  near: {
    token: NEAR_USDC,
    price: '200000',
    recipients: [{ identity: evm, bps: 10000 }],
    remainder: 0,
  },
  base: null,
};
const purchase: Purchase = {
  version: 2,
  refund: evm,
  network: 'near:mainnet',
  contract: 'annon.near',
  route: 'near-usdc',
  asset: NEAR_USDC,
  file_id: h(3),
  terms_hash: termsHash(terms),
  price: '200000',
  nonce: h(6),
  buyer_key: key,
  recovery: sol,
  expires_at: '1794350000',
};

describe('identities and authoritative authorization', () => {
  it('normalizes API values and writes Borsh, JSON, text and Intents ids', () => {
    expect(parseIdentity({ kind: 'evm', id: `0x${'AB'.repeat(20)}` })).toEqual({
      kind: 'evm',
      id: `0x${'ab'.repeat(20)}`,
    });
    expect(
      parseIdentity({ kind: 'solana', id: base58.encode(ed25519.getPublicKey(seed)) }),
    ).toEqual(sol);
    expect(identityText(sol)).toBe(`Solana ${base58.encode(ed25519.getPublicKey(seed))}`);
    expect(identityText(evm)).toBe(`EVM ${evm.id}`);
    expect(identityText(near)).toBe('NEAR seller.near');
    expect(identityJson(sol)).toBe(JSON.stringify(sol));
    for (const id of [evm, sol, near]) expect(intentsAccount(id)).toBe(id.id);
    expect(hex(encodeIdentity(evm))).toBe(`0x00${evm.id.slice(2)}`);
    expect(hex(encodeIdentity(sol))).toBe(`0x01${sol.id}`);
    expect(hex(encodeIdentity(near))).toBe(`0x020b000000${Buffer.from(near.id).toString('hex')}`);
    expect(encodeIdentity({ kind: 'near', id: 'a'.repeat(64) })).toHaveLength(69);
  });
  it.each(['a', 'a'.repeat(65), 'A.near', '.ab', 'ab.', 'a..b', 'a--b', 'a-_b', 'a/b'])(
    'rejects invalid NEAR id %s',
    (id) => expect(() => parseIdentity({ kind: 'near', id })).toThrow(),
  );
  it.each([
    { kind: 'evm', id: h(1) },
    { kind: 'solana', id: '1' },
    { kind: 'unknown', id: 'ab' },
    { ...evm, extra: 1 },
  ])('rejects invalid identities %j', (id) => expect(() => parseIdentity(id)).toThrow());
  it('verifies viem EIP-191 and rejects wrong text, kind, v and high s', async () => {
    const account = privateKeyToAccount(`0x${'01'.repeat(32)}`);
    const id = parseIdentity({ kind: 'evm', id: account.address });
    const text = 'Authoritative UTF-8: żółć';
    const sig = await account.signMessage({ message: text });
    expect(verifyAuthorization(id, text, { kind: 'evm', sig })).toBe(true);
    expect(verifyAuthorization(id, `${text}!`, { kind: 'evm', sig })).toBe(false);
    expect(verifyAuthorization(id, text, { kind: 'solana', sig })).toBe(false);
    expect(verifyAuthorization(id, text, { kind: 'evm', sig: `${sig.slice(0, -2)}00` })).toBe(
      false,
    );
    const raw = Buffer.from(sig.slice(2), 'hex');
    const s = BigInt(`0x${raw.subarray(32, 64).toString('hex')}`);
    raw.set(
      Buffer.from(
        (BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141') - s)
          .toString(16)
          .padStart(64, '0'),
        'hex',
      ),
      32,
    );
    raw[64] = raw[64] === 27 ? 28 : 27;
    expect(verifyAuthorization(id, text, { kind: 'evm', sig: hex(raw) })).toBe(false);
  });
  it('checks exact UTF-8 Solana wallet signed bytes and strict Ed25519', () => {
    const text = 'Annon: authorization ż';
    const signedMessage = new TextEncoder().encode(text);
    const signature = ed25519.sign(signedMessage, seed);
    const auth = solanaWalletAuth(sol, text, { signature, signedMessage });
    expect(verifyAuthorization(sol, text, auth)).toBe(true);
    expect(verifyAuthorization(sol, `${text} `, auth)).toBe(false);
    expect(verifyAuthorization(evm, text, auth)).toBe(false);
    expect(() =>
      solanaWalletAuth(sol, text, {
        signature,
        signedMessage: new Uint8Array([...signedMessage, 10]),
      }),
    ).toThrow(/signed bytes/);
    expect(verifyAuthorization(sol, text, { kind: 'solana', sig: h(0, 64) })).toBe(false);
  });
  it('authorizes NEAR only by predecessor without auth', () => {
    expect(verifyAuthorization(near, 'T', undefined, 'seller.near')).toBe(true);
    expect(verifyAuthorization(near, 'T', undefined, 'relayer.near')).toBe(false);
    expect(verifyAuthorization(near, 'T', { kind: 'evm', sig: h(0, 65) }, 'seller.near')).toBe(
      false,
    );
  });
});

describe('terms and texts', () => {
  it('hashes domain + Borsh with SHA256', () => {
    expect(termsHash(terms)).toBe(
      `0x${createHash('sha256').update('annon/terms/v2\0').update(encodeTerms(terms)).digest('hex')}`,
    );
    expect(termsHash({ ...terms, moderator: 'mod.near' })).not.toBe(termsHash(terms));
  });
  it('writes exact registration and publish text without trailing newline', () => {
    expect(registerTextV2(terms, key, 1794350000)).toBe(
      [
        'Annon: list a file for sale',
        'Signing this lets whoever holds the seller key below open the file.',
        'contract: annon.near',
        `file: ${h(3)}`,
        'seller: NEAR seller.near',
        'price: 0.2 USDC on NEAR',
        `split: EVM ${evm.id} 100.00%`,
        `remainder: EVM ${evm.id}`,
        'base: none',
        `cipher: ${h(4)}`,
        'moderator: (none)',
        `terms: ${termsHash(terms)}`,
        `seller key: ${key}`,
        'valid until: 2026-11-10 22:33:20 UTC',
      ].join('\n'),
    );
    expect(publishTextV2('annon.near', h(3), h(4))).toBe(
      `Annon: publish a file\ncontract: annon.near\nfile: ${h(3)}\nheader: ${h(4)}`,
    );
  });
  it('accepts eight sorted mixed recipients and rejects unsorted/duplicate/invalid splits', () => {
    const recipients = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
      identity: { kind: 'evm' as const, id: h(n, 20) },
      bps: 1250,
    }));
    expect(
      encodeTerms({ ...terms, near: { ...terms.near, recipients, remainder: 7 } }).length,
    ).toBeGreaterThan(0);
    for (const bad of [
      [],
      [...recipients, recipients[0]],
      [...recipients].reverse(),
      [recipients[0], recipients[0]],
      [{ identity: evm, bps: 9999 }],
      [{ identity: evm, bps: 0 }],
    ])
      expect(() =>
        encodeTerms({ ...terms, near: { ...terms.near, recipients: bad as typeof recipients } }),
      ).toThrow();
    for (const nearTerms of [
      { ...terms.near, price: '0' },
      { ...terms.near, price: '0200000' },
      { ...terms.near, remainder: 1 },
      { ...terms.near, token: 'other.near' },
    ])
      expect(() => encodeTerms({ ...terms, near: nearTerms })).toThrow();
  });
});

describe('purchase wire protocol', () => {
  it('round trips compact canonical JSON with its decoded commitment', () => {
    const msg = buildPurchaseMessage(purchase);
    expect(msg.startsWith(`{"annon":2,"refund":${identityJson(evm)},"purchase":{"network":`)).toBe(
      true,
    );
    expect(parseRefundPrefix(`${msg.slice(0, msg.indexOf('"purchase"'))}broken`)).toEqual(evm);
    expect(parsePurchaseMessage(msg)).toEqual(purchase);
    expect(purchaseId(purchase)).toBe(
      `0x${createHash('sha256').update('annon/purchase/v2\0').update(encodePurchase(purchase)).digest('hex')}`,
    );
    expect(baseNonceV2(purchaseId(purchase))).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it('accepts full u128/u64 integers without number conversion', () => {
    const p = {
      ...purchase,
      price: ((1n << 128n) - 1n).toString(),
      expires_at: ((1n << 64n) - 1n).toString(),
    };
    expect(parsePurchaseMessage(buildPurchaseMessage(p))).toEqual(p);
  });
  it.each([
    '00',
    '01',
    '+1',
    '-1',
    '1.0',
    '1e2',
    ' 1',
    '1 ',
    '340282366920938463463374607431768211456',
  ])('rejects noncanonical/out-of-range price %s', (price) =>
    expect(() => buildPurchaseMessage({ ...purchase, price })).toThrow(),
  );
  it('rejects structural ambiguity, unknown/duplicate/reordered keys, escapes and whitespace', () => {
    const msg = buildPurchaseMessage(purchase);
    const bad = [
      msg.replace('"annon":2', '"annon":2,"annon":2'),
      msg.replace('"price":', '"extra":0,"price":'),
      msg.replace('"price":"200000"', '"price":200000'),
      msg.replace('"annon":2,', '"annon":2, '),
      msg.replace('"network":', '"netw\\u006frk":'),
      msg.replace(
        `"kind":"evm","id":${JSON.stringify(evm.id)}`,
        `"id":${JSON.stringify(evm.id)},"kind":"evm"`,
      ),
      msg.replace(purchaseId(purchase), h(9)),
      `${msg} `,
      msg.slice(0, -1),
      msg.replace('"route":"near-usdc"', '"route":"base-usdc"'),
    ];
    for (const b of bad) expect(() => parsePurchaseMessage(b)).toThrow();
  });
  it('bounds the full message and independent refund prefix', () => {
    expect(() => parsePurchaseMessage(' '.repeat(1025))).toThrow();
    expect(parseRefundPrefix(buildPurchaseMessage(purchase) + 'x'.repeat(100000))).toEqual(evm);
    expect(() =>
      parseRefundPrefix(`{"annon":2,"refund":{"kind":"near","id":"${'a'.repeat(161)}"},`),
    ).toThrow();
    expect(() => parseRefundPrefix('{"annon":2,"refund":{"kind":"near","id":"a..b"},')).toThrow();
    const max = {
      ...purchase,
      contract: 'a'.repeat(64),
      refund: { kind: 'near' as const, id: 'b'.repeat(64) },
      recovery: { kind: 'near' as const, id: 'c'.repeat(64) },
    };
    expect(new TextEncoder().encode(buildPurchaseMessage(max)).length).toBeLessThanOrEqual(1024);
  });
  it('rejects duplicate/unknown fields at every object and a reordered purchase', () => {
    const msg = buildPurchaseMessage(purchase);
    for (const needle of [
      '"annon":2',
      `"refund":${identityJson(evm)}`,
      '"price":"200000"',
      `"recovery":${identityJson(sol)}`,
    ]) {
      expect(() => parsePurchaseMessage(msg.replace(needle, `${needle},${needle}`))).toThrow();
    }
    for (const needle of ['"refund":{', '"purchase":{', '"recovery":{'])
      expect(() => parsePurchaseMessage(msg.replace(needle, `${needle}"extra":0,`))).toThrow();
    const obj = JSON.parse(msg);
    const entries = Object.entries(obj.purchase).reverse();
    expect(() =>
      parsePurchaseMessage(JSON.stringify({ ...obj, purchase: Object.fromEntries(entries) })),
    ).toThrow();
    expect(() =>
      parsePurchaseMessage(msg.replace(sol.id, base58.encode(ed25519.getPublicKey(seed)))),
    ).toThrow();
    expect(() => parsePurchaseMessage(msg.replace(sol.id, sol.id.toUpperCase()))).toThrow();
  });
  it('rejects every single-bit change of the canonical message', () => {
    const raw = new TextEncoder().encode(buildPurchaseMessage(purchase));
    for (let bit = 0; bit < raw.length * 8; bit++) {
      const bad = raw.slice();
      bad[bit >> 3] = (bad[bit >> 3] ?? 0) ^ (1 << (bit & 7));
      expect(() => parsePurchaseMessage(new TextDecoder().decode(bad))).toThrow();
    }
  }, 30000);
  it('bounds oversized UTF-8 messages while preserving the refund destination', () => {
    const msg = buildPurchaseMessage(purchase);
    const oversized = msg.replace('"network":"near:mainnet"', `"network":"${'ż'.repeat(512)}"`);
    expect(() => parsePurchaseMessage(oversized)).toThrow(/1024/);
    expect(parseRefundPrefix(oversized)).toEqual(evm);
    for (const bad of [
      msg.replace('"annon":2', '"annon":2.0'),
      msg.replace('"annon":2', '"annon":2e0'),
      msg.replace('"annon":2', '"annon":"2"'),
      msg.replace('"kind":"evm"', '"kind":"solana"'),
      msg.replace(evm.id, `${evm.id}0`),
    ])
      expect(() => parseRefundPrefix(bad)).toThrow();
  });
  it('rejects malformed, identity and non-subgroup BLS keys', () => {
    for (const buyer_key of [h(0, 48), `0xc0${'00'.repeat(47)}`, h(1, 48)])
      expect(() => buildPurchaseMessage({ ...purchase, buyer_key })).toThrow();
    expect(() =>
      buildPurchaseMessage({ ...purchase, expires_at: '18446744073709551616' }),
    ).toThrow();
  });
  it('rejects an on-curve BLS key outside the prime-order subgroup', () => {
    const fp = bls.fields.Fp;
    let x = 1n;
    let y = 0n;
    for (; ; x++) {
      try {
        y = fp.sqrt(fp.add(fp.mul(fp.mul(x, x), x), 4n));
        break;
      } catch {}
    }
    expect(bls.G1.Point.fromAffine({ x, y }).isTorsionFree()).toBe(false);
    const encoded = Buffer.from(x.toString(16).padStart(96, '0'), 'hex');
    encoded[0] = (encoded[0] ?? 0) | 0x80;
    expect(() => buildPurchaseMessage({ ...purchase, buyer_key: hex(encoded) })).toThrow();
  });
  it('binds every purchase field', () => {
    for (const p of [
      { ...purchase, refund: near },
      { ...purchase, recovery: near },
      { ...purchase, nonce: h(7) },
      { ...purchase, network: 'near:testnet' },
      { ...purchase, contract: 'other.near' },
      { ...purchase, price: '1' },
      { ...purchase, expires_at: '1' },
      {
        ...purchase,
        route: 'base-usdc' as const,
        network: 'eip155:8453',
        asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      },
    ])
      expect(purchaseId(p)).not.toBe(purchaseId(purchase));
  });
  it('writes the reopen text', () => {
    expect(
      reopenTextV2({
        contract: 'annon.near',
        purchase_id: purchaseId(purchase),
        file_id: purchase.file_id,
        recovery: sol,
        fresh_key: key,
        nonce: h(6),
        deadline: 1794350000,
      }),
    ).toBe(
      `Annon: open a purchased file again\ncontract: annon.near\npurchase: ${purchaseId(purchase)}\nfile: ${h(3)}\nrecovery: ${identityText(sol)}\nnew key: ${key}\nnonce: ${h(6)}\nvalid until: 2026-11-10 22:33:20 UTC`,
    );
  });
});

describe('depth-32 refund accumulator', () => {
  const fields = (n: number) => ({
    network: 'near:mainnet',
    contract: 'annon.near',
    delivery_id: String(n),
    refund: evm,
    amount: String(n + 1),
  });
  it('produces full depth proofs for 0, 1, 3 and 5 leaves', () => {
    const roots = new Set<string>();
    for (const n of [0, 1, 3, 5]) {
      const leaves = Array.from({ length: n }, (_, i) => refundLeaf(fields(i)));
      const tree = new RefundTree();
      for (const leaf of leaves) tree.append(leaf);
      roots.add(tree.root);
      expect(tree.count).toBe(n);
      expect(tree.frontier).toHaveLength(32);
      for (let i = 0; i < n; i++) {
        const proof = RefundTree.proof(leaves, i);
        expect(proof).toHaveLength(32);
        expect(verifyRefundProof(leaves[i] as string, i, proof, tree.root)).toBe(true);
        expect(
          verifyRefundProof(refundLeaf({ ...fields(i), amount: '99' }), i, proof, tree.root),
        ).toBe(false);
        expect(verifyRefundProof(leaves[i] as string, i + 1, proof, tree.root)).toBe(false);
        expect(verifyRefundProof(leaves[i] as string, i, proof.slice(1), tree.root)).toBe(false);
        expect(verifyRefundProof(leaves[i] as string, i, proof, h(0))).toBe(false);
      }
      expect(() => RefundTree.proof(leaves, n)).toThrow();
    }
    expect(roots.size).toBe(4);
  });
  it('carries through powers of two and invalidates old proofs', () => {
    const leaves = Array.from({ length: 33 }, (_, i) => refundLeaf(fields(i)));
    const tree = new RefundTree();
    tree.append(leaves[0] as string);
    const old = RefundTree.proof(leaves.slice(0, 1), 0);
    for (const leaf of leaves.slice(1)) tree.append(leaf);
    expect(verifyRefundProof(leaves[0] as string, 0, old, tree.root)).toBe(false);
    expect(
      verifyRefundProof(leaves[32] as string, 32, RefundTree.proof(leaves, 32), tree.root),
    ).toBe(true);
    for (const index of [-1, 0.5, 2 ** 32])
      expect(verifyRefundProof(leaves[0] as string, index, old, tree.root)).toBe(false);
  });
});
