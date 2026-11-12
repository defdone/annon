import { readFileSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { describe, expect, it } from 'vitest';
import { pay2Boundaries } from '../../test/pay2-boundaries.js';
import { bitCases, sampleCases } from '../../test/sampling.js';
import { type Listing, open, Pay2Error, sealWithKey } from './pay2.js';
import { blobSource, openTo, prepareOpen, prepareSeal } from './replay.js';
import { openStream, sealStream, sealStreamWithKey } from './stream.js';

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
  valid: { id: string; input: Input; cipherHash: string; publishText: string; file: string }[];
  invalid: { id: string; listing: Listing; expect: string; file: string }[];
};
const first = vectors.valid[0]?.input as Input;
const hex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));
const pattern = (size: number, start = 0) =>
  Uint8Array.from({ length: size }, (_, j) => (start + j) % 251);
const dataOf = (d: Input['data']) =>
  'utf8' in d ? new TextEncoder().encode(d.utf8) : pattern(d.pattern);
const sign = async (text: string) => {
  const t = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${t.length}`);
  const digest = keccak_256(new Uint8Array([...prefix, ...t]));
  const sig = secp256k1.sign(digest, hex(first.sellerKey), {
    prehash: false,
    format: 'recovered',
  });
  return new Uint8Array([...sig.subarray(1), 27 + (sig[0] ?? 0)]);
};
const finishOpts = {
  contractId: vectors.contractId,
  ckdSecret: hex(first.ckdSecret),
  seller: vectors.seller,
  sign,
};
const options = { fileId: hex(first.fileId), name: 'x', mime: '', chunkLog2: 16 };
const listingOf = (cipherHash: string | Uint8Array, fileId = options.fileId): Listing => ({
  fileId,
  cipherHash,
  seller: vectors.seller,
});
const openOpts = (listing: Listing) => ({
  listing,
  contractId: vectors.contractId,
  ckdSecret: async () => hex(first.ckdSecret),
});

// Seeded randomness makes failures reproducible. Include empty chunks and chunks crossing both
// header and crypto boundaries; tests never assume a source read is a complete PAY2 chunk.
function random(seed: number) {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}
function source(bytes: Uint8Array, seed = 1, max = 100003) {
  const next = random(seed);
  let at = 0;
  let empty = true;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (empty) {
          empty = false;
          controller.enqueue(new Uint8Array());
        } else if (at === bytes.length) controller.close();
        else {
          const end = Math.min(bytes.length, at + 1 + Math.floor(next() * max));
          controller.enqueue(bytes.subarray(at, end));
          at = end;
          empty = next() < 0.1;
        }
      },
    },
    { highWaterMark: 0 },
  );
}
async function collect(stream: ReadableStream<Uint8Array>) {
  const parts: Uint8Array[] = [];
  await stream.pipeTo(new WritableStream({ write: (part) => void parts.push(part) }));
  return Uint8Array.from(Buffer.concat(parts));
}
async function outcome(file: Uint8Array, listing: Listing, seed = 1) {
  const parts: Uint8Array[] = [];
  let error: unknown;
  try {
    await openStream(source(file, seed), openOpts(listing)).pipeTo(
      new WritableStream({ write: (part) => void parts.push(part) }),
    );
  } catch (e) {
    error = e;
  }
  return { error, data: Buffer.concat(parts) };
}
const headerLen = (file: Uint8Array) => new DataView(file.buffer, file.byteOffset).getUint32(8);

it('cancels a replayable source when sealing options fail before the first read', async () => {
  let cancelled = false;
  await expect(
    prepareSeal(
      hex(first.K),
      {
        size: 1,
        read: () =>
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
      },
      { ...options, mime: '\u0000' },
    ),
  ).rejects.toThrow('mime');
  expect(cancelled).toBe(true);
});

describe('streaming PAY2 vectors', () => {
  for (const v of vectors.valid) {
    it(`matches and opens ${v.id} with different chunking on each pass`, async () => {
      const i = v.input;
      const data = dataOf(i.data);
      const s = await sealStreamWithKey(hex(i.K), source(data, 1, 313), data.length, {
        ...i,
        fileId: hex(i.fileId),
      });
      expect(Buffer.from(s.cipherHash).toString('hex')).toBe(v.cipherHash);
      let shown = '';
      const file = await collect(
        await s.finish(source(data, 2), {
          ...finishOpts,
          sign: (text) => {
            shown = text;
            return sign(text);
          },
        }),
      );
      expect(shown).toBe(v.publishText);
      expect(Buffer.from(file).toString('base64')).toBe(v.file);
      const one = await sealWithKey(hex(i.K), data, { ...i, fileId: hex(i.fileId) });
      await one.finish(finishOpts);
      expect(await s.preview({ meta: true, data: i.previewLen > 0 })).toEqual(
        await one.preview({ meta: true, data: i.previewLen > 0 }),
      );
      const listing = listingOf(v.cipherHash, hex(i.fileId));
      expect((await open(file, openOpts(listing))).data).toEqual(data);
      let meta: unknown;
      expect(
        await collect(
          openStream(source(b64(v.file), 3, 17), {
            ...openOpts(listing),
            onMeta: (value) => {
              meta = value;
            },
          }),
        ),
      ).toEqual(data);
      expect(meta).toEqual({ name: i.name, mime: i.mime, size: data.length });
      const chunks: Uint8Array[] = [];
      expect(
        await openTo(
          blobSource(new Blob([file])),
          new WritableStream({
            write: (chunk) => void chunks.push(chunk),
          }),
          openOpts(listing),
        ),
      ).toEqual(meta);
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(data));
    });
  }
  for (const v of vectors.invalid) {
    it(`refuses ${v.id} with ${v.expect}`, async () => {
      const { error, data } = await outcome(b64(v.file), v.listing);
      expect(error).toBeInstanceOf(Pay2Error);
      expect((error as Pay2Error).code).toBe(v.expect);
      // These vectors have no valid data chunk before the fault. In particular a correctly
      // signed/hash-committed bad GCM tag or bad metadata must never leak plaintext first.
      expect(data.length).toBe(0);
      await expect(
        openTo(blobSource(new Blob([b64(v.file)])), new WritableStream(), openOpts(v.listing)),
      ).rejects.toMatchObject({ code: v.expect });
    });
  }
});

it('preserves buffered error precedence across body damage, length and key failures', async () => {
  const s = await sealWithKey(hex(first.K), pattern(2 * 65536 + 3), options);
  const file = await s.finish(finishOpts);
  const bad = file.slice();
  bad[headerLen(file) + 280] = (bad[headerLen(file) + 280] ?? 0) ^ 1;
  const opts = { ...openOpts(listingOf(s.cipherHash)), ckdSecret: async () => new Uint8Array(48) };
  for (const wire of [
    bad,
    bad.subarray(0, bad.length - 20),
    Buffer.concat([bad, new Uint8Array(65536)]),
  ]) {
    let expected: unknown;
    try {
      await open(wire, opts);
    } catch (error) {
      expected = error;
    }
    let writes = 0;
    await expect(
      openTo(
        blobSource(new Blob([wire])),
        new WritableStream({
          write() {
            writes++;
          },
        }),
        opts,
      ),
    ).rejects.toMatchObject({ code: (expected as Pay2Error).code });
    expect(writes).toBe(0);
  }
});

describe('streaming sealing', () => {
  const C = 65536;
  const nextSize = random(19);
  const sizes = [
    0,
    1,
    C - 1,
    C,
    C + 1,
    C + 46,
    C + 47,
    C + 48,
    2 * C - 1,
    2 * C,
    2 * C + 1,
    3 * C - 1,
    3 * C,
    3 * C + 1,
    ...Array.from({ length: 4 }, () => Math.floor(nextSize() * 5 * C)),
  ];
  for (const size of sizes) {
    for (const previewLen of [0, Math.min(47, Math.floor(size / 10))]) {
      it(`equals one-shot at size ${size}, preview ${previewLen}`, async () => {
        const next = random(size + 7);
        const data = Uint8Array.from({ length: size }, () => Math.floor(next() * 256));
        const K = crypto.getRandomValues(new Uint8Array(32));
        const opts = { ...options, previewLen };
        const one = await sealWithKey(K, data, opts);
        const s = await sealStreamWithKey(K, source(data, size + 1), size, opts);
        expect(s.cipherHash).toEqual(one.cipherHash);
        const file = await collect(await s.finish(source(data, size + 2, 177), finishOpts));
        const expected = await one.finish(finishOpts);
        expect(file).toEqual(expected);
        const listing = listingOf(one.cipherHash);
        expect((await open(file, openOpts(listing))).data).toEqual(data);
        expect(await collect(openStream(source(expected, size + 3), openOpts(listing)))).toEqual(
          data,
        );
      });
    }
  }

  for (const chunkLog2 of [undefined, 16, 17, 18, 19, 20, 21, 22, 23, 24]) {
    it(`supports chunkLog2 ${chunkLog2 ?? 'default'}`, async () => {
      const data = pattern(19);
      const { chunkLog2: _, ...base } = options;
      const opts = chunkLog2 === undefined ? base : { ...base, chunkLog2 };
      const one = await sealWithKey(hex(first.K), data, opts);
      const s = await sealStreamWithKey(hex(first.K), source(data, 1, 1), data.length, opts);
      const expected = await one.finish(finishOpts);
      const actual = await collect(await s.finish(source(data, 2, 1), finishOpts));
      expect(actual).toEqual(expected);
      expect(actual[5]).toBe(chunkLog2 ?? 22);
      expect(
        await collect(openStream(source(actual, 3, 1), openOpts(listingOf(s.cipherHash)))),
      ).toEqual(data);
    });
  }

  it("refuses to finish with a signature that is not the seller's", async () => {
    const data = pattern(1000);
    const s = await sealStream(source(data), data.length, options);
    const stranger = async () => new Uint8Array(65).fill(1);
    await expect(s.finish(source(data), { ...finishOpts, sign: stranger })).rejects.toThrow(
      /not from the seller/,
    );
  });

  it('uses a fresh key, respects backpressure and cancels its source', async () => {
    const data = pattern(3 * C);
    const s = await sealStream(source(data), data.length, options);
    const other = await sealStream(source(data), data.length, options);
    expect(s.cipherHash).not.toEqual(other.cipherHash);
    let pulls = 0;
    let cancelled: unknown;
    const replay = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulls++;
          c.enqueue(data.subarray(0, C));
        },
        cancel(reason) {
          cancelled = reason;
        },
      },
      { highWaterMark: 0 },
    );
    const output = await s.finish(replay, finishOpts);
    expect(pulls).toBe(0);
    const reader = output.getReader();
    await reader.read(); // Header only.
    expect(pulls).toBe(0);
    await reader.cancel('stop');
    expect(cancelled).toBe('stop');
    expect(replay.locked).toBe(false);
  });

  it('rejects incorrect sizes in either pass and changed replay chunks before emitting them', async () => {
    const data = pattern(C + 17);
    for (const size of [data.length - 1, data.length + 1]) {
      await expect(sealStream(source(data), size, options)).rejects.toThrow(RangeError);
    }
    const s = await sealStream(source(data), data.length, options);
    for (const replay of [data.subarray(0, data.length - 1), new Uint8Array([...data, 0])]) {
      await expect(collect(await s.finish(source(replay), finishOpts))).rejects.toThrow(RangeError);
    }
    const changed = data.slice();
    changed[0] = (changed[0] ?? 0) ^ 1;
    const reader = (await s.finish(source(changed), finishOpts)).getReader();
    await reader.read(); // Header.
    await reader.read(); // Metadata ciphertext.
    await expect(reader.read()).rejects.toThrow(/changed/);
  });

  it('validates sizes and format limits before reading plaintext', async () => {
    for (const size of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER, 1023 * 2 ** 24 + 1]) {
      let read = false;
      const input = new ReadableStream<Uint8Array>(
        {
          pull() {
            read = true;
          },
        },
        { highWaterMark: 0 },
      );
      await expect(sealStream(input, size, options)).rejects.toThrow(RangeError);
      expect(read).toBe(false);
      expect(input.locked).toBe(false);
    }
  });
});

describe('streaming authentication and framing', () => {
  it('rejects public header faults before requesting key material', async () => {
    const publicCodes = new Set([
      'bad_magic',
      'unsupported_version',
      'bad_chunk_size',
      'header_too_large',
      'bad_header',
      'bad_stanza',
      'file_id_mismatch',
      'cipher_hash_mismatch',
      'seller_signature_invalid',
    ]);
    for (const v of vectors.invalid.filter((v) => publicCodes.has(v.expect))) {
      let requested = false;
      await expect(
        collect(
          openStream(source(b64(v.file)), {
            ...openOpts(v.listing),
            ckdSecret: async () => {
              requested = true;
              throw new Error('key requested prematurely');
            },
          }),
        ),
      ).rejects.toMatchObject({ code: v.expect });
      expect(requested, v.id).toBe(false);
    }
  });

  it('refuses a headerLen below the fixed header as bad_header, not a crash', async () => {
    const v = vectors.valid[0] as (typeof vectors.valid)[number];
    for (const len of [0, 10, 53, 54]) {
      const file = Uint8Array.from(b64(v.file));
      new DataView(file.buffer).setUint32(8, len);
      await expect(
        collect(openStream(source(file), openOpts(listingOf(v.cipherHash)))),
      ).rejects.toMatchObject({ code: 'bad_header' });
    }
  });

  it('rejects flipped bits (boundary sample, or every bit with ANNON_EXHAUSTIVE=1) of a small three-chunk file without releasing the failed chunk', async () => {
    // Metadata, preview and final data are three independently authenticated wire chunks.
    const data = pattern(20);
    const s = await sealWithKey(hex(first.K), data, { ...options, previewLen: 2 });
    const file = await s.finish(finishOpts);
    const listing = listingOf(s.cipherHash);
    const header = headerLen(file);
    const ends = [header, header + 272, header + 272 + 18, file.length];
    for (const bit of bitCases(file.length, pay2Boundaries(file))) {
      const changed = file.slice();
      const byte = bit >> 3;
      changed[byte] = (changed[byte] ?? 0) ^ (1 << (bit & 7));
      const { error, data: received } = await outcome(changed, listing, bit + 1);
      const max = byte < (ends[2] as number) ? 0 : 2;
      if (!(error instanceof Pay2Error) || received.length > max) {
        throw new Error(`bit ${bit}: ${String(error)}, released ${received.length} bytes`);
      }
      expect(received).toEqual(Buffer.from(data.subarray(0, received.length)));
    }
  });

  it('rejects truncation at byte boundaries (sample, or every byte with ANNON_EXHAUSTIVE=1) of a small file including its preview and tags', async () => {
    const data = pattern(20);
    const s = await sealWithKey(hex(first.K), data, { ...options, previewLen: 2 });
    const file = await s.finish(finishOpts);
    const previewEnd = headerLen(file) + 272 + 18;
    for (const cut of sampleCases(file.length, pay2Boundaries(file))) {
      const { error, data: received } = await outcome(
        file.subarray(0, cut),
        listingOf(s.cipherHash),
        cut + 1,
      );
      expect(error, `cut ${cut}`).toBeInstanceOf(Pay2Error);
      expect(received.length).toBeLessThanOrEqual(cut < previewEnd ? 0 : 2);
      expect(received).toEqual(Buffer.from(data.subarray(0, received.length)));
    }
  });

  it('rejects truncations, dropped/swapped/repeated chunks, and appended bytes', async () => {
    const C = 65536;
    const data = pattern(3 * C + 19);
    const s = await sealWithKey(hex(first.K), data, options);
    const file = await s.finish(finishOpts);
    const listing = listingOf(s.cipherHash);
    const h = headerLen(file);
    const ends = [
      0,
      h,
      h + 272,
      h + 272 + C + 16,
      h + 272 + 2 * (C + 16),
      h + 272 + 3 * (C + 16),
      file.length,
    ];
    const cuts = new Set([1, 3, 4, 53, ...ends.flatMap((x) => [x - 1, x, x + 1])]);
    for (let i = 1; i < ends.length; i++) {
      cuts.add(Math.floor(((ends[i - 1] as number) + (ends[i] as number)) / 2));
    }
    for (const cut of cuts) {
      if (cut < 0 || cut >= file.length) continue;
      const { error, data: received } = await outcome(file.subarray(0, cut), listing, cut + 1);
      expect(error, `cut ${cut}`).toBeInstanceOf(Pay2Error);
      const complete = ends.slice(3, -1).filter((end) => end <= cut).length * C;
      expect(received.length).toBeLessThanOrEqual(complete);
      expect(received).toEqual(Buffer.from(data.subarray(0, received.length)));
    }
    const a = ends[2] as number;
    const b = ends[3] as number;
    const c = ends[4] as number;
    const dropped = Buffer.concat([file.subarray(0, a), file.subarray(b)]);
    const swapped = file.slice();
    swapped.set(file.subarray(b, c), a);
    swapped.set(file.subarray(a, b), b);
    const repeated = file.slice();
    repeated.set(file.subarray(a, b), b);
    for (const bad of [dropped, swapped, repeated, Buffer.concat([file, Buffer.of(0)])]) {
      const { error, data: received } = await outcome(bad, listing);
      expect(error).toBeInstanceOf(Pay2Error);
      expect(received).toEqual(Buffer.from(data.subarray(0, received.length)));
      expect(received.length).toBeLessThan(data.length);
    }
  });

  it('releases earlier authenticated chunks, but holds the final chunk until EOF', async () => {
    const C = 65536;
    const data = pattern(C + 9);
    const s = await sealWithKey(hex(first.K), data, options);
    const file = await s.finish(finishOpts);
    const end = headerLen(file) + 272 + C + 16;
    const bad = file.slice();
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1;
    const { error, data: received } = await outcome(bad, listingOf(s.cipherHash));
    expect(error).toMatchObject({ code: 'chunk_hash_mismatch' });
    expect(received).toEqual(Buffer.from(data.subarray(0, C)));
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelled: unknown;
    const input = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        c.enqueue(file.subarray(0, end));
      },
      cancel(reason) {
        cancelled = reason;
      },
    });
    const reader = openStream(input, openOpts(listingOf(s.cipherHash))).getReader();
    expect((await reader.read()).value).toEqual(data.subarray(0, C));
    controller?.enqueue(file.subarray(end));
    let settled = false;
    const last = reader.read().then((r) => {
      settled = true;
      return r;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    controller?.close();
    expect((await last).value).toEqual(data.subarray(C));
    expect((await reader.read()).done).toBe(true);
    expect(input.locked).toBe(false);
    const input2 = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(file.subarray(0, end));
      },
      cancel(reason) {
        cancelled = reason;
      },
    });
    const r2 = openStream(input2, openOpts(listingOf(s.cipherHash))).getReader();
    await r2.read();
    const pending = r2.read();
    await r2.cancel('buyer stopped');
    await pending;
    expect(cancelled).toBe('buyer stopped');
    expect(input2.locked).toBe(false);
  });

  it('propagates source errors and cancels hostile input on failure', async () => {
    const v = vectors.valid[1] as (typeof vectors.valid)[number];
    const file = b64(v.file);
    const boom = new Error('connection lost');
    const input = new ReadableStream<Uint8Array>({ start: (c) => c.error(boom) });
    await expect(collect(openStream(input, openOpts(listingOf(v.cipherHash))))).rejects.toBe(boom);
    expect(input.locked).toBe(false);
    let cancelled = false;
    const hostile = file.slice(0, 54);
    new DataView(hostile.buffer).setUint32(8, 0xffffffff);
    const bad = new ReadableStream<Uint8Array>({
      start: (c) => c.enqueue(hostile),
      cancel() {
        cancelled = true;
      },
    });
    await expect(collect(openStream(bad, openOpts(listingOf(v.cipherHash))))).rejects.toMatchObject(
      {
        code: 'header_too_large',
      },
    );
    expect(cancelled).toBe(true);
    expect(bad.locked).toBe(false);

    const failing = () => new ReadableStream<Uint8Array>({ start: (c) => c.error(boom) });
    const firstPass = failing();
    await expect(sealStream(firstPass, 1, options)).rejects.toBe(boom);
    expect(firstPass.locked).toBe(false);
    const sealed = await sealStream(source(Uint8Array.of(1)), 1, options);
    const replay = failing();
    await expect(collect(await sealed.finish(replay, finishOpts))).rejects.toBe(boom);
    expect(replay.locked).toBe(false);

    const unread = new ReadableStream<Uint8Array>();
    await openStream(unread, openOpts(listingOf(v.cipherHash))).cancel('never read');
    expect(unread.locked).toBe(false);
  });
});

it('round-trips 100 MiB with sampled peak live heap + external growth below 32 MiB', async () => {
  // Force collection at sampling boundaries so the bound measures retained/working memory,
  // rather than V8's configurable delay before collecting unreachable crypto buffers. Sample
  // BEFORE collecting as well: allocations between boundaries count toward the peak.
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  setFlagsFromString('--no-expose-gc');
  gc();
  const baseline = process.memoryUsage();
  let peak = 0;
  let peakBuffers = 0;
  const sample = () => {
    const usage = process.memoryUsage();
    peak = Math.max(peak, usage.heapUsed + usage.external - baseline.heapUsed - baseline.external);
    peakBuffers = Math.max(peakBuffers, usage.arrayBuffers - baseline.arrayBuffers);
    gc();
  };
  const size = 100 * 1024 * 1024;
  const generated = () => {
    let at = 0;
    return new ReadableStream<Uint8Array>(
      {
        pull(c) {
          sample();
          if (at === size) c.close();
          else {
            const len = Math.min(256 * 1024, size - at);
            c.enqueue(pattern(len, at));
            at += len;
          }
        },
      },
      { highWaterMark: 0 },
    );
  };
  const sealed = await sealStream(generated(), size, { ...options, chunkLog2: 20 });
  sample();
  const wire = await sealed.finish(generated(), finishOpts);
  let received = 0;
  await openStream(wire, openOpts(listingOf(sealed.cipherHash))).pipeTo(
    new WritableStream({
      write(bytes) {
        sample();
        for (let j = 0; j < bytes.length; j++) {
          if (bytes[j] !== (received + j) % 251) throw new Error(`wrong byte ${received + j}`);
        }
        received += bytes.length;
      },
    }),
  );
  sample();
  expect(received).toBe(size);
  expect(peakBuffers).toBeLessThan(16 * 1024 * 1024);
  expect(peak).toBeLessThan(32 * 1024 * 1024);
  console.info(
    `PAY2 100 MiB sampled peak growth: heap + external ${(peak / 1024 ** 2).toFixed(2)} MiB; ArrayBuffers ${(peakBuffers / 1024 ** 2).toFixed(2)} MiB`,
  );
});

it('binds the open replay to the exact first-pass header before requesting a key or writing', async () => {
  const data = pattern(65540);
  const sealed = await sealWithKey(hex(first.K), data, options);
  const original = await sealed.finish(finishOpts);
  const alternateSecret = new Uint8Array(48).fill(9);
  const alternate = await sealed.finish({ ...finishOpts, ckdSecret: alternateSecret });
  expect(original.subarray(0, headerLen(original))).not.toEqual(
    alternate.subarray(0, headerLen(alternate)),
  );
  let reads = 0;
  let keys = 0;
  let writes = 0;
  const prepared = await prepareOpen(
    { size: original.length, read: () => source(reads++ === 0 ? original : alternate) },
    openOpts(listingOf(sealed.cipherHash)),
  );
  await expect(
    prepared.writeTo(
      new WritableStream({
        write() {
          writes++;
        },
      }),
      async () => {
        keys++;
        return alternateSecret;
      },
    ),
  ).rejects.toMatchObject({ code: 'source_changed' });
  expect(keys).toBe(0);
  expect(writes).toBe(0);
});

it.each(['contents', 'shorter', 'longer'])(
  'gives a fixed code when seal replay becomes %s',
  async (change) => {
    const data = pattern(65540);
    const sealed = await sealStreamWithKey(hex(first.K), source(data), data.length, options);
    const replay =
      change === 'shorter'
        ? data.slice(0, -1)
        : change === 'longer'
          ? new Uint8Array([...data, 1])
          : data.map((b) => b ^ 1);
    await expect(collect(await sealed.finish(source(replay), finishOpts))).rejects.toMatchObject({
      code: 'source_changed',
    });
  },
);
