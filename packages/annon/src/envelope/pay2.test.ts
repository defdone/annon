import { readFileSync } from 'node:fs';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { describe, expect, it } from 'vitest';
import { pay2Boundaries } from '../../test/pay2-boundaries.js';
import { bitCases } from '../../test/sampling.js';
import {
  inspect,
  type Listing,
  open,
  type PreviewPackage,
  seal,
  sealWithKey,
  signedBy,
} from './pay2.js';

interface Input {
  K: string;
  fileId: string;
  ckdSecret: string;
  sellerKey: string;
  contractId: string;
  name: string;
  mime: string;
  chunkLog2: number;
  previewLen: number;
  data: { utf8: string } | { pattern: number };
}
const vectors = JSON.parse(
  readFileSync(new URL('../../../../specs/vectors/pay2.json', import.meta.url), 'utf8'),
) as {
  contractId: string;
  seller: string;
  valid: {
    id: string;
    input: Input;
    cipherHash: string;
    publishText: string;
    sellerSig: string;
    file: string;
  }[];
  preview: {
    of: string;
    package: PreviewPackage;
    expect: { name: string; mime: string; size: number; preview: { pattern: number } };
    invalid: {
      id: string;
      package: PreviewPackage;
      fileId: string;
      registered: string;
      expect: string;
    }[];
  };
  invalid: { id: string; listing: Listing; expect: string; file: string }[];
};

const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));
const pattern = (len: number) => Uint8Array.from({ length: len }, (_, j) => j % 251);
const dataOf = (d: Input['data']) =>
  'utf8' in d ? new TextEncoder().encode(d.utf8) : pattern(d.pattern);
const first = vectors.valid[0]?.input as Input;
const CONTRACT = vectors.contractId;
const SELLER = vectors.seller;
const ckd = hex(first.ckdSecret);

/** A wallet's `personal_sign`: EIP-191, r ‖ s ‖ v. */
const wallet = (priv: Uint8Array) => async (text: string) => {
  const t = new TextEncoder().encode(text);
  const digest = keccak_256(
    new Uint8Array([
      ...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${t.length}`),
      ...t,
    ]),
  );
  const rec = secp256k1.sign(digest, priv, { prehash: false, format: 'recovered' });
  return new Uint8Array([...rec.subarray(1), 27 + (rec[0] ?? 0)]);
};
const sign = wallet(hex(first.sellerKey));
const finishOpts = { contractId: CONTRACT, ckdSecret: ckd, seller: SELLER, sign };

const listingOf = (fileId: string | Uint8Array, cipherHash: string | Uint8Array): Listing => ({
  fileId,
  cipherHash,
  seller: SELLER,
});
const opts = (listing: Listing) => ({ listing, contractId: CONTRACT, ckdSecret: async () => ckd });
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'opened',
    (e: { code?: string }) => e.code ?? String(e),
  );

describe('PAY2 vectors', () => {
  for (const v of vectors.valid) {
    it(`opens ${v.id}`, async () => {
      const { meta, data } = await open(b64(v.file), opts(listingOf(v.input.fileId, v.cipherHash)));
      expect(meta).toEqual({ name: v.input.name, mime: v.input.mime, size: data.length });
      expect(Buffer.from(data).equals(Buffer.from(dataOf(v.input.data)))).toBe(true);
    });

    it(`encodes ${v.id} to the same bytes and signing text`, async () => {
      const i = v.input;
      const sealed = await sealWithKey(hex(i.K), dataOf(i.data), {
        fileId: hex(i.fileId),
        name: i.name,
        mime: i.mime,
        chunkLog2: i.chunkLog2,
        previewLen: i.previewLen,
      });
      expect(Buffer.from(sealed.cipherHash).toString('hex')).toBe(v.cipherHash);
      let shown = '';
      const file = await sealed.finish({
        ...finishOpts,
        sign: (text) => {
          shown = text;
          return sign(text);
        },
      });
      expect(shown).toBe(v.publishText);
      expect(Buffer.from(file).toString('base64')).toBe(v.file);
    });
  }

  for (const v of vectors.invalid) {
    it(`refuses ${v.id} with ${v.expect}`, async () => {
      expect(await code(open(b64(v.file), opts(v.listing)))).toBe(v.expect);
    });
  }

  it('rebuilds the preview package', async () => {
    const src = vectors.valid.find((v) => v.id === vectors.preview.of);
    if (!src) throw new Error('missing vector');
    const i = src.input;
    const sealed = await sealWithKey(hex(i.K), dataOf(i.data), { ...i, fileId: hex(i.fileId) });
    await sealed.finish(finishOpts);
    expect(await sealed.preview({ meta: true, data: true })).toEqual(vectors.preview.package);
  });
});

describe('PAY2 attacks beyond the vectors', () => {
  // Three full data chunks, so two of them can trade places.
  const C = 65536;
  const data = pattern(3 * C);
  const fileId = new Uint8Array(32).fill(7);
  const make = async () => {
    const s = await seal(data, { fileId, name: 'x', mime: '', chunkLog2: 16 });
    return { listing: listingOf(fileId, s.cipherHash), file: await s.finish(finishOpts) };
  };
  const headerLen = (f: Uint8Array) => new DataView(f.buffer, f.byteOffset).getUint32(8);
  const chunkAt = (f: Uint8Array, i: number) => headerLen(f) + 272 + (i - 1) * (C + 16);

  it('round-trips a fresh random key', async () => {
    const { listing, file } = await make();
    expect((await open(file, opts(listing))).data).toEqual(data);
  });

  it('refuses swapped chunks, with or without the hash list swapped too', async () => {
    const { listing, file } = await make();
    const swapped = file.slice();
    swapped.set(file.subarray(chunkAt(file, 1), chunkAt(file, 2)), chunkAt(file, 2));
    swapped.set(file.subarray(chunkAt(file, 2), chunkAt(file, 3)), chunkAt(file, 1));
    expect(await code(open(swapped, opts(listing)))).toBe('chunk_hash_mismatch');
    const both = swapped.slice();
    // After one key commitment: h_1 at 54 + 64, h_2 at 54 + 96.
    both.set(file.subarray(54 + 64, 54 + 96), 54 + 96);
    both.set(file.subarray(54 + 96, 54 + 128), 54 + 64);
    expect(await code(open(both, opts(listing)))).toBe('cipher_hash_mismatch');
  });

  it('refuses a repeated chunk and a dropped one', async () => {
    const { listing, file } = await make();
    const repeated = file.slice();
    repeated.set(file.subarray(chunkAt(file, 1), chunkAt(file, 2)), chunkAt(file, 2));
    expect(await code(open(repeated, opts(listing)))).toBe('chunk_hash_mismatch');
    const dropped = new Uint8Array([
      ...file.subarray(0, chunkAt(file, 2)),
      ...file.subarray(chunkAt(file, 3)),
    ]);
    expect(await code(open(dropped, opts(listing)))).toBe('bad_body_length');
  });

  it('refuses the wrong CKD point', async () => {
    const { listing, file } = await make();
    const wrong = { ...opts(listing), ckdSecret: async () => new Uint8Array(48).fill(1) };
    expect(await code(open(file, wrong))).toBe('key_unwrap_failed');
  });

  it('runs the keyless checks, the seller signature included, before paying', async () => {
    const { listing, file } = await make();
    expect(await inspect(file, listing, CONTRACT)).toMatchObject({ usable: true });
    expect(await code(inspect(file, listing, 'other.near'))).toBe('seller_signature_invalid');
    const other = { ...listing, cipherHash: new Uint8Array(32) };
    expect(await code(inspect(file, other, CONTRACT))).toBe('cipher_hash_mismatch');
  });

  it('refuses to finish with a signature from another wallet', async () => {
    const s = await seal(data, { fileId, name: 'x', mime: '', chunkLog2: 16 });
    const stranger = wallet(new Uint8Array(32).fill(3));
    await expect(s.finish({ ...finishOpts, sign: stranger })).rejects.toThrow(
      /not from the seller/,
    );
  });

  it('never seals a preview over a tenth of the file or 64 KiB', async () => {
    const id = new Uint8Array(32);
    const tooLong = (size: number, previewLen: number) =>
      seal(pattern(size), { fileId: id, name: 'a', mime: '', previewLen });
    await expect(tooLong(100, 11)).rejects.toThrow(RangeError);
    await expect(tooLong(10 * 70000, 65537)).rejects.toThrow(RangeError);
    await expect(tooLong(100, 10)).resolves.toBeTruthy();
  });
});

// Checks that don't assume which error a change causes: they hold for every possible change.
describe('PAY2 against single-bit changes (boundary sample, or every bit with ANNON_EXHAUSTIVE=1)', () => {
  const flips = (bytes: Uint8Array, boundaries: number[]) =>
    bitCases(bytes.length, boundaries).map((bit) => {
      const f = bytes.slice();
      f[bit >> 3] = (f[bit >> 3] ?? 0) ^ (1 << (bit & 7));
      return { bit, f };
    });

  for (const id of ['empty', 'small']) {
    it(`refuses flipped bits (boundary sample, or every bit with ANNON_EXHAUSTIVE=1) of ${id} with a Pay2Error`, async () => {
      const v = vectors.valid.find((x) => x.id === id) as (typeof vectors.valid)[number];
      const listing = listingOf(v.input.fileId, v.cipherHash);
      const wrong: string[] = [];
      for (const { bit, f } of flips(b64(v.file), pay2Boundaries(b64(v.file)))) {
        const got = await open(f, opts(listing)).then(
          () => 'opened',
          (e: Error) => (e.name === 'Pay2Error' ? 'refused' : `crashed: ${e.message}`),
        );
        if (got !== 'refused') wrong.push(`bit ${bit}: ${got}`);
      }
      expect(wrong).toEqual([]);
    });
  }
});

describe('EIP-191 against a signature made by another library', () => {
  // Signed with viem's signMessage; the same vector the contract tests (contracts/annon/src/evm.rs).
  const text = 'Annon: list a file for sale\ncontract: x';
  const sig = hex(
    'a0b1241b6a8e97f459e365636c15fe34dceece91c6f78ec04fb79c69bef010592472ee3522a86fdef71d7117ccd342deb84ad74a90768cbb550af1afd10a11691b',
  );
  const signer = '0x1a642f0e3c3af545e7acbd38b07251b3990914f1';

  it('recovers the viem signer, in any address case', () => {
    expect(signedBy(text, sig, signer)).toBe(true);
    expect(signedBy(text, sig, signer.toUpperCase().replace('0X', '0x'))).toBe(true);
  });

  it('refuses another text, another signer and the high-s twin', () => {
    expect(signedBy(`${text} `, sig, signer)).toBe(false);
    expect(signedBy(text, sig, `0x${'00'.repeat(20)}`)).toBe(false);
    const N = secp256k1.Point.Fn.ORDER;
    const s = BigInt(`0x${Buffer.from(sig.subarray(32, 64)).toString('hex')}`);
    const twin = sig.slice();
    twin.set(hex((N - s).toString(16).padStart(64, '0')), 32);
    twin[64] = twin[64] === 27 ? 28 : 27;
    expect(signedBy(text, twin, signer)).toBe(false);
  });
});
