import { ed25519 } from '@noble/curves/ed25519.js';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import type { Identity } from '../settle-near/identity.js';
import {
  inspect,
  type Listing,
  open,
  parseHeader,
  sealWithKey,
  sha256,
  verifyPreview,
} from './pay2.js';
import { openStream, sealStreamWithKey } from './stream.js';

const fileId = new Uint8Array(32).fill(4);
const K = new Uint8Array(32).fill(2);
const ckd = new Uint8Array(48).fill(3);
const data = new TextEncoder().encode('v2 plaintext; '.repeat(10));
const seed = new Uint8Array(32).fill(7);
const account = privateKeyToAccount(`0x${'01'.repeat(32)}`);
const contractId = 'annon.near';
const stream = (b: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(b);
      c.close();
    },
  });
const collect = async (s: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(s).arrayBuffer());
const signEvm = (text: string) => account.signMessage({ message: text });
const signSol = async (text: string) => {
  const signedMessage = new TextEncoder().encode(text);
  return { signedMessage, signature: ed25519.sign(signedMessage, seed) };
};

for (const authKind of [0, 1, 2] as const)
  describe(`PAY2 v2 kind ${authKind}`, () => {
    const seller: Identity =
      authKind === 0
        ? { kind: 'evm', id: account.address.toLowerCase() }
        : authKind === 1
          ? { kind: 'solana', id: Buffer.from(ed25519.getPublicKey(seed)).toString('hex') }
          : { kind: 'near', id: 'seller.near' };
    const opts = {
      fileId,
      name: 'v2.txt',
      mime: 'text/plain',
      chunkLog2: 16,
      previewLen: 10,
      version: 2 as const,
      authKind,
    };
    const finish = {
      contractId,
      ckdSecret: ckd,
      seller,
      ...(authKind === 0 ? { sign: signEvm } : authKind === 1 ? { sign: signSol } : {}),
    };
    async function make() {
      const sealed = await sealWithKey(K, data, opts);
      const file = await sealed.finish(finish);
      const h = parseHeader(file);
      const listing: Listing = {
        fileId,
        cipherHash: sealed.cipherHash,
        seller,
        ...(authKind === 2
          ? { publishedHeaderHash: await sha256(file.subarray(0, h.headerLen - 65)) }
          : {}),
      };
      return {
        sealed,
        file,
        h,
        listing,
        openOpts: { listing, contractId, ckdSecret: async () => ckd },
      };
    }
    it('opens, inspects and previews a file; stream output is byte-identical', async () => {
      const { sealed, file, h, listing, openOpts } = await make();
      expect(h.version).toBe(2);
      expect(h.authKind).toBe(authKind);
      expect((await open(file, openOpts)).data).toEqual(data);
      expect((await inspect(file, listing, contractId)).usable).toBe(true);
      expect(
        (await verifyPreview(await sealed.preview({ meta: true, data: true }), listing)).preview,
      ).toEqual(data.subarray(0, 10));
      const s = await sealStreamWithKey(K, stream(data), data.length, opts);
      expect(s.cipherHash).toEqual(sealed.cipherHash);
      expect(await collect(await s.finish(stream(data), finish))).toEqual(file);
      expect(await collect(openStream(stream(file), openOpts))).toEqual(data);
    });
    it('checks preview auth kind against the registered seller', async () => {
      const { sealed, listing } = await make();
      const pkg = await sealed.preview({ meta: true });
      const header = Uint8Array.from(Buffer.from(pkg.header, 'base64'));
      header[7] = (authKind + 1) % 3;
      await expect(
        verifyPreview({ ...pkg, header: Buffer.from(header).toString('base64') }, listing),
      ).rejects.toHaveProperty('code', 'preview_invalid');
      await expect(
        verifyPreview(pkg, { fileId: listing.fileId, cipherHash: listing.cipherHash }),
      ).rejects.toHaveProperty('code', 'preview_invalid');
    });
    it('keeps legacy listings on v1 and accepts explicitly selected v2 EVM listings', async () => {
      if (authKind !== 0) return;
      const { file, listing, openOpts } = await make();
      const legacy = { ...listing, seller: account.address };
      await expect(open(file, { ...openOpts, listing: legacy })).rejects.toHaveProperty(
        'code',
        'unsupported_version',
      );
      expect(
        (await open(file, { ...openOpts, listing: { ...legacy, pay2Version: 2 } })).data,
      ).toEqual(data);
    });
    it('refuses kind mismatches, unknown kinds, relabelling and nonzero padding', async () => {
      const { file, listing, openOpts, h } = await make();
      for (const kind of [0, 1, 2, 3, 255]) {
        if (kind === authKind) continue;
        const b = file.slice();
        b[7] = kind;
        await expect(open(b, openOpts)).rejects.toHaveProperty('name', 'Pay2Error');
      }
      const b = file.slice();
      b[4] = 1;
      await expect(open(b, openOpts)).rejects.toHaveProperty('name', 'Pay2Error');
      await expect(
        open(file, {
          ...openOpts,
          listing: {
            ...listing,
            seller:
              authKind === 2
                ? { kind: 'evm', id: `0x${'00'.repeat(20)}` }
                : { kind: 'near', id: 'wrong.near' },
          },
        }),
      ).rejects.toHaveProperty('code', 'seller_signature_invalid');
      const padded = file.slice();
      padded[h.headerLen - 1] = (padded[h.headerLen - 1] ?? 0) ^ 1;
      await expect(open(padded, openOpts)).rejects.toHaveProperty(
        'code',
        'seller_signature_invalid',
      );
    });
    it('refuses every single-bit change before asking for a key', async () => {
      const { file, openOpts } = await make();
      for (let bit = 0; bit < file.length * 8; bit++) {
        const b = file.slice();
        b[bit >> 3] = (b[bit >> 3] ?? 0) ^ (1 << (bit & 7));
        await expect(inspect(b, openOpts.listing, contractId)).rejects.toHaveProperty(
          'name',
          'Pay2Error',
        );
      }
    }, 120000);
    it('requires the registered identity and exact Solana wallet signed message', async () => {
      const s = await sealWithKey(K, data, opts);
      await expect(
        s.finish({ ...finish, seller: { kind: 'evm', id: `0x${'00'.repeat(20)}` } }),
      ).rejects.toThrow();
      if (authKind === 1)
        await expect(
          s.finish({
            ...finish,
            sign: async (text) => ({
              ...(await signSol(text)),
              signedMessage: new TextEncoder().encode(`${text}\n`),
            }),
          }),
        ).rejects.toThrow(/signed bytes/);
      if (authKind === 2) {
        const { file, openOpts, listing } = await make();
        await expect(
          open(file, {
            ...openOpts,
            listing: {
              fileId: listing.fileId,
              cipherHash: listing.cipherHash,
              seller: listing.seller,
            },
          }),
        ).rejects.toHaveProperty('code', 'seller_signature_invalid');
        await expect(
          open(file, {
            ...openOpts,
            listing: { ...listing, publishedHeaderHash: new Uint8Array(32) },
          }),
        ).rejects.toHaveProperty('code', 'seller_signature_invalid');
      }
    });
  });
