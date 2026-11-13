import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bitCases } from '../../test/sampling.js';
import { inspectHeader, open, type PreviewPackage, sealWithKey } from '../envelope/pay2.js';
import { openStream, sealStreamWithKey } from '../envelope/stream.js';
import {
  type Authorization,
  encodeIdentity,
  type Identity,
  identityJson,
  identityText,
  parseIdentity,
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
  type ReopenV2,
  reopenTextV2,
} from './purchase.js';
import {
  encodeRefundLeaf,
  type RefundLeaf,
  RefundTree,
  refundLeaf,
  verifyRefundProof,
} from './refund.js';
import { encodeTerms, publishTextV2, registerTextV2, type Terms, termsHash } from './terms.js';

const v = JSON.parse(
  readFileSync(new URL('../../../../specs/vectors/near-settlement.json', import.meta.url), 'utf8'),
) as {
  negative: {
    id: string;
    kind: 'purchase' | 'refund_prefix' | 'terms' | 'authorization' | 'merkle';
    input: unknown;
    expected: { sdk: 'reject' | false; contract: string };
    context?: { network: string; asset: string; route: number; contract: string };
  }[];
  identities: {
    identity: Identity;
    borsh: string;
    json: string;
    text: string;
    intents_account: string;
    base58?: string;
  }[];
  terms: {
    id: string;
    terms: Terms;
    borsh: string;
    terms_hash: string;
    seller_key: string;
    deadline: number;
    register_text: string;
  }[];
  purchases: {
    id: string;
    purchase: Purchase;
    borsh: string;
    purchase_id: string;
    message: string;
    message_bytes: number;
    base_nonce_v2: string;
    reopen: ReopenV2;
    reopen_text: string;
  }[];
  refunds: { fields: RefundLeaf; borsh: string; leaf: string }[];
  merkle: {
    count: number;
    leaves: string[];
    sdk_frontier: (string | null)[];
    root: string;
    proofs: { index: number; proof: string[] }[];
  }[];
  authorizations: {
    identity: Identity;
    text: string;
    auth: Authorization | null;
    predecessor?: string;
  }[];
  pay2: {
    id: string;
    input: {
      K: string;
      fileId: string;
      ckdSecret: string;
      contractId: string;
      name: string;
      mime: string;
      chunkLog2: number;
      previewLen: number;
      data_utf8: string;
    };
    seller: Identity;
    auth_kind: 0 | 1 | 2;
    cipher_hash: string;
    header_hash: string;
    whole_header_hash: string;
    publish_text: string;
    auth: Authorization | null;
    trailer: string;
    header: string;
    file: string;
    preview: PreviewPackage;
  }[];
};
const bytes = (s: string) => Uint8Array.from(Buffer.from(s.replace(/^0x/, ''), 'hex'));
const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}`;
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));
const stream = (b: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(b);
      c.close();
    },
  });
const collect = async (s: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(s).arrayBuffer());

describe('independent near-settlement wire vectors', () => {
  it('publishes negative vectors with explicit contract and SDK expectations', () => {
    expect(v.negative.length).toBeGreaterThanOrEqual(15);
    for (const x of v.negative) {
      expect(x.expected.contract.length).toBeGreaterThan(0);
      if (x.kind === 'purchase') expect(() => parsePurchaseMessage(x.input as string)).toThrow();
      else if (x.kind === 'refund_prefix')
        expect(() => parseRefundPrefix(x.input as string)).toThrow();
      else if (x.kind === 'terms') expect(() => encodeTerms(x.input as Terms)).toThrow();
      else if (x.kind === 'authorization') {
        const a = x.input as { identity: Identity; text: string; auth: Authorization };
        expect(verifyAuthorization(a.identity, a.text, a.auth)).toBe(x.expected.sdk);
      } else {
        const m = x.input as { leaf: string; index: number; proof: string[]; root: string };
        expect(verifyRefundProof(m.leaf, m.index, m.proof, m.root)).toBe(x.expected.sdk);
      }
    }
  });
  for (const x of v.identities)
    it(`identity ${x.text}`, () => {
      expect(hex(encodeIdentity(x.identity))).toBe(x.borsh);
      expect(identityJson(x.identity)).toBe(x.json);
      expect(identityText(x.identity)).toBe(x.text);
      expect(parseIdentity(x.identity).id).toBe(x.intents_account);
      if (x.base58) expect(parseIdentity({ kind: 'solana', id: x.base58 })).toEqual(x.identity);
    });
  for (const x of v.terms)
    it(`terms ${x.id}`, () => {
      expect(hex(encodeTerms(x.terms))).toBe(x.borsh);
      expect(termsHash(x.terms)).toBe(x.terms_hash);
      expect(registerTextV2(x.terms, x.seller_key, x.deadline)).toBe(x.register_text);
    });
  for (const x of v.purchases)
    it(`purchase ${x.id}`, () => {
      expect(hex(encodePurchase(x.purchase))).toBe(x.borsh);
      expect(purchaseId(x.purchase)).toBe(x.purchase_id);
      expect(buildPurchaseMessage(x.purchase)).toBe(x.message);
      expect(parsePurchaseMessage(x.message)).toEqual(x.purchase);
      expect(new TextEncoder().encode(x.message).length).toBe(x.message_bytes);
      expect(baseNonceV2(x.purchase_id)).toBe(x.base_nonce_v2);
      expect(reopenTextV2(x.reopen)).toBe(x.reopen_text);
    });
  for (const [i, x] of v.refunds.entries())
    it(`refund leaf ${i}`, () => {
      expect(hex(encodeRefundLeaf(x.fields))).toBe(x.borsh);
      expect(refundLeaf(x.fields)).toBe(x.leaf);
    });
  for (const x of v.merkle)
    it(`Merkle ${x.count} leaves`, () => {
      const tree = new RefundTree();
      for (const leaf of x.leaves) tree.append(leaf);
      expect(tree.root).toBe(x.root);
      expect(tree.frontier).toEqual(x.sdk_frontier);
      for (const p of x.proofs) {
        expect(RefundTree.proof(x.leaves, p.index)).toEqual(p.proof);
        expect(verifyRefundProof(x.leaves[p.index] as string, p.index, p.proof, x.root)).toBe(true);
        // Every bit of every sibling and of the leaf must remain bound to this root.
        for (let level = 0; level < 32; level++) {
          const proof = [...p.proof];
          const raw = bytes(proof[level] as string);
          raw[0] = (raw[0] ?? 0) ^ 1;
          proof[level] = hex(raw);
          expect(verifyRefundProof(x.leaves[p.index] as string, p.index, proof, x.root)).toBe(
            false,
          );
        }
      }
    });
  for (const [i, x] of v.authorizations.entries())
    it(`cross-library authorization ${i}`, () => {
      expect(verifyAuthorization(x.identity, x.text, x.auth ?? undefined, x.predecessor)).toBe(
        true,
      );
      if (x.identity.kind !== 'near') {
        expect(verifyAuthorization(x.identity, `${x.text}!`, x.auth ?? undefined)).toBe(false);
        const raw = bytes(x.auth?.sig as string);
        for (const bit of bitCases(raw.length, [0, 32, 64, raw.length])) {
          const bad = raw.slice();
          bad[bit >> 3] = (bad[bit >> 3] ?? 0) ^ (1 << (bit & 7));
          expect(
            verifyAuthorization(x.identity, x.text, {
              kind: x.auth?.kind as Authorization['kind'],
              sig: hex(bad),
            }),
          ).toBe(false);
        }
      }
    });
  for (const x of v.pay2)
    it(`PAY2 v2 independent ${x.id} buffered and streaming`, async () => {
      const i = x.input;
      const listing = {
        fileId: i.fileId,
        cipherHash: x.cipher_hash,
        seller: x.seller,
        ...(x.seller.kind === 'near' ? { publishedHeaderHash: x.header_hash } : {}),
      };
      const opts = { listing, contractId: i.contractId, ckdSecret: async () => bytes(i.ckdSecret) };
      const data = new TextEncoder().encode(i.data_utf8);
      expect((await open(b64(x.file), opts)).data).toEqual(data);
      expect(hex((await inspectHeader(b64(x.header), listing, i.contractId)).headerHash)).toBe(
        x.whole_header_hash,
      );
      expect(publishTextV2(i.contractId, i.fileId, x.header_hash)).toBe(x.publish_text);
      const sealOpts = {
        ...i,
        fileId: bytes(i.fileId),
        version: 2 as const,
        authKind: x.auth_kind,
      };
      const finishOpts = {
        contractId: i.contractId,
        ckdSecret: bytes(i.ckdSecret),
        seller: x.seller,
        sign: async (text: string) => {
          expect(text).toBe(x.publish_text);
          if (x.seller.kind === 'solana')
            return {
              signature: bytes(x.auth?.sig as string),
              signedMessage: new TextEncoder().encode(text),
            };
          return x.auth?.sig as string;
        },
      };
      const s = await sealWithKey(bytes(i.K), data, sealOpts);
      expect(hex(s.cipherHash)).toBe(x.cipher_hash);
      expect(Buffer.from(await s.finish(finishOpts)).toString('base64')).toBe(x.file);
      expect(await s.preview({ meta: true, data: true })).toEqual(x.preview);
      const streamed = await sealStreamWithKey(bytes(i.K), stream(data), data.length, sealOpts);
      expect(
        Buffer.from(await collect(await streamed.finish(stream(data), finishOpts))).toString(
          'base64',
        ),
      ).toBe(x.file);
      expect(await collect(openStream(stream(b64(x.file)), opts))).toEqual(data);
    });
});
