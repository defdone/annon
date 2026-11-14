import type { UploadManifest } from '../download/upload.js';
import { AnnonError } from '../errors.js';
import { account, hex } from '../settle-near/codec.js';
/**
 * Bounded-memory PAY2 version 2 using Web Streams and the one-shot encoder's WebCrypto primitives.
 *
 * The format puts all hashes before the body, and registration precedes the final stanza/MAC/
 * signature. Sealing therefore consumes TWO streams: sealStream's first pass computes the
 * registration; finish replays the same immutable plaintext. Nothing spools or tees the file.
 * The header/hash table is bounded by the format (64 KiB / 1024 hashes), independent of size.
 * Only a few crypto chunks plus one caller-owned input buffer are retained. Upstream queues
 * and a consumer that collects the output are outside this bound; use backpressure at both ends.
 * A Blob/File can supply the two passes with separate calls to blob.stream(). A non-replayable
 * source must be spooled externally by the caller; using tee() would buffer an entire branch.
 */

import {
  type Bytes,
  bodyHash,
  checkSigned,
  chunkCount,
  chunkKey,
  commitment,
  concat,
  copy,
  equal,
  FIXED,
  type FileMeta,
  type FinishOptions,
  finishTrailer,
  gcm,
  hkdf,
  int,
  MAC,
  MAGIC,
  MAX_CHUNKS,
  MAX_HEADER,
  MAX_META,
  NEAR_CKD,
  nearCkd,
  type OpenOptions,
  Pay2Error,
  parseMeta,
  previewLimit,
  type SealOptions,
  SIG,
  sealAuth,
  sha256,
  TAG,
  wrapKeyFor,
} from './pay2.js';

const subtle = globalThis.crypto.subtle;
const utf8 = new TextEncoder();

/** A replay no longer matches the source authenticated in the first pass. */
export class SourceChangedError extends AnnonError<'source_changed'> {
  constructor() {
    super('source_changed', 'source changed between passes');
    this.name = 'SourceChangedError';
  }
}

/** Copies into a bounded destination, never concatenates or queues source chunks. */
export class ByteReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private pending: Uint8Array = new Uint8Array();
  private at = 0;
  private ended = false;
  private released = false;
  private cancellation: Promise<void> | undefined;

  constructor(source: ReadableStream<Uint8Array>) {
    this.reader = source.getReader();
  }

  /** Read exactly length bytes, or fewer only at EOF. No allocation depends on source size. */
  async read(length: number): Promise<Bytes> {
    const bytes = new Uint8Array(length);
    let at = 0;
    while (at < length) {
      if (this.at === this.pending.length) {
        this.pending = new Uint8Array();
        this.at = 0;
        if (this.ended) break;
        const result = await this.reader.read();
        if (result.done) {
          this.ended = true;
          break;
        }
        if (!(result.value instanceof Uint8Array)) throw new TypeError('expected Uint8Array');
        this.pending = result.value;
      }
      const take = Math.min(length - at, this.pending.length - this.at);
      bytes.set(this.pending.subarray(this.at, this.at + take), at);
      this.at += take;
      at += take;
      if (this.at === this.pending.length) {
        this.pending = new Uint8Array();
        this.at = 0;
      }
    }
    return bytes.subarray(0, at);
  }

  cancel(reason?: unknown): Promise<void> {
    this.cancellation ??= this.reader.cancel(reason).catch(() => {});
    return this.cancellation;
  }

  release() {
    if (this.released) return;
    this.released = true;
    this.pending = new Uint8Array();
    this.reader.releaseLock();
  }
}

/** One generator yield per consumer read, including cancellation during an outstanding read. */
function output(
  source: ReadableStream<Uint8Array>,
  produce: (input: ByteReader) => AsyncGenerator<Bytes, void, unknown>,
): ReadableStream<Uint8Array> {
  const input = new ByteReader(source);
  async function* managed() {
    try {
      yield* produce(input);
    } finally {
      await input.cancel();
      input.release();
    }
  }
  const iterator = managed();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const result = await iterator.next();
          if (result.done) controller.close();
          else controller.enqueue(result.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        // Cancel first: return() alone cannot interrupt a generator waiting on reader.read().
        await input.cancel(reason);
        await iterator.return();
        input.release(); // Also needed if the generator never started.
      },
    },
    { highWaterMark: 0 },
  );
}

interface StreamSealed {
  manifest: UploadManifest;
  headerSize(contractId: string): number;
  /** Replays encrypted body chunks before registration without CKD or a final header. */
  body(plaintext: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>;
  fileId: Bytes;
  /** Register this value before calling finish, as with the one-shot seal. */
  cipherHash: Bytes;
  preview: import('./pay2.js').Sealed['preview'];
  /**
   * A NEW stream of the same immutable plaintext, from byte zero. Signs the final header and
   * returns header then ciphertext under backpressure. Each replay chunk must match its
   * first-pass hash before it is emitted. A changed replay errors; discard its entire output.
   * First-pass length mismatches throw RangeError; replay changes throw SourceChangedError. Source errors propagate unchanged.
   */
  finish(
    plaintext: ReadableStream<Uint8Array>,
    opts: FinishOptions,
  ): Promise<ReadableStream<Uint8Array>>;
}

/** Consumes plaintext once to prepare registration, using a fresh random file key. */
export function sealStream(
  plaintext: ReadableStream<Uint8Array>,
  size: number,
  opts: SealOptions,
): Promise<StreamSealed> {
  return sealStreamWithKey(crypto.getRandomValues(new Uint8Array(32)), plaintext, size, opts);
}

/** Seals with a caller-chosen file key (the streaming sell and the vectors use it). Never reuse a key for different files. */
export async function sealStreamWithKey(
  K: Uint8Array,
  plaintext: ReadableStream<Uint8Array>,
  size: number,
  opts: SealOptions,
): Promise<StreamSealed> {
  if (opts.fileId.length !== 32 || K.length !== 32)
    throw new TypeError('fileId and K are 32 bytes');
  if (!Number.isSafeInteger(size) || size < 0)
    throw new RangeError('size must be a safe unsigned integer');
  const { version, authKind } = sealAuth(opts);
  const fileId = copy(opts.fileId);
  const key = copy(K);
  const previewLen = opts.previewLen ?? 0;
  if (!Number.isSafeInteger(previewLen) || previewLen < 0 || previewLen > previewLimit(size)) {
    throw new RangeError(`previewLen must be 0 to ${previewLimit(size)}`);
  }
  let chunkLog2 = opts.chunkLog2 ?? 22;
  while (
    opts.chunkLog2 === undefined &&
    chunkLog2 < 24 &&
    chunkCount(size, previewLen, chunkLog2) > MAX_CHUNKS
  ) {
    chunkLog2++;
  }
  if (!Number.isInteger(chunkLog2) || chunkLog2 < 16 || chunkLog2 > 24) {
    throw new RangeError('chunkLog2 must be an integer from 16 to 24');
  }
  const n = chunkCount(size, previewLen, chunkLog2);
  if (n > MAX_CHUNKS) throw new RangeError('file too large for PAY2');
  const C = 2 ** chunkLog2;
  const name = utf8.encode(opts.name);
  if (!/^[\x20-\x7e]{0,255}$/.test(opts.mime)) throw new RangeError('mime must be printable ASCII');
  const fields = concat(
    int(name.length, 2),
    name,
    int(opts.mime.length, 1),
    utf8.encode(opts.mime),
    int(size, 8),
  );
  const metaLen = Math.ceil(fields.length / 256) * 256;
  if (metaLen > MAX_META) throw new RangeError('name too long');
  const meta = concat(fields, new Uint8Array(metaLen - fields.length));
  const kc = previewLen > 0 ? 2 : 1;
  const commits: Bytes[] = [];
  for (let i = 0; i < kc; i++) commits.push(await commitment(await chunkKey(key, fileId, i)));
  // This is at most 32,886 bytes, even for the largest allowed file. Hashes live directly in it.
  const prefix = concat(
    new Uint8Array(MAGIC),
    new Uint8Array([version, chunkLog2, 1, authKind]),
    new Uint8Array(4),
    fileId,
    int(metaLen, 2),
    int(previewLen, 4),
    int(n, 4),
    ...commits,
    new Uint8Array(32 * n),
  );
  const hashes = Array.from({ length: n }, (_, i) =>
    prefix.subarray(FIXED + 32 * (kc + i), FIXED + 32 * (kc + i + 1)),
  );

  async function* encrypt(input: ByteReader, replay = false) {
    let remaining = size;
    for (let i = 0; i < n; i++) {
      const length =
        i === 0 ? metaLen : i === 1 && previewLen > 0 ? previewLen : Math.min(C, remaining);
      const piece = i === 0 ? meta : await input.read(length);
      if (piece.length !== length)
        throw replay ? new SourceChangedError() : new RangeError('plaintext shorter than size');
      if (i > 0) remaining -= length;
      const last = i === n - 1;
      if (last && (await input.read(1)).length !== 0)
        throw replay ? new SourceChangedError() : new RangeError('plaintext longer than size');
      yield await gcm('encrypt', await chunkKey(key, fileId, i), last, piece);
    }
  }
  const input = new ByteReader(plaintext);
  const previewWire: Bytes[] = [];
  try {
    let i = 0;
    for await (const wire of encrypt(input)) {
      if (i < kc) previewWire.push(wire);
      (hashes[i++] as Bytes).set(await sha256(wire));
    }
  } finally {
    await input.cancel();
    input.release();
  }
  const cipherHash = await bodyHash({
    version,
    chunkLog2,
    fileId,
    metaLen,
    previewLen,
    n,
    commits,
    hashes,
  });
  let finished: Bytes | undefined;
  return {
    manifest: {
      version,
      chunkLog2,
      metaLen,
      previewLen,
      n,
      keyCommitments: commits.map(hex),
      chunkHashes: hashes.map(hex),
    },
    headerSize(contractId) {
      account(contractId);
      return 206 + utf8.encode(contractId).length + 32 * (kc + n);
    },
    body(replay) {
      return output(replay, async function* (reader) {
        let i = 0;
        for await (const wire of encrypt(reader, true)) {
          if (!equal(await sha256(wire), hashes[i++] as Bytes)) throw new SourceChangedError();
          yield wire;
        }
      });
    },
    fileId: copy(fileId),
    cipherHash,
    async finish(replay, finishOpts) {
      const { contractId, ckdSecret } = finishOpts;
      account(contractId);
      const kw = await wrapKeyFor(ckdSecret, fileId, 'wrapKey');
      const fileKey = await subtle.importKey('raw', key, 'AES-GCM', true, ['encrypt']);
      const wrapped = new Uint8Array(await subtle.wrapKey('raw', fileKey, kw, 'AES-KW'));
      const type = utf8.encode(NEAR_CKD);
      const body = concat(new Uint8Array([contractId.length]), utf8.encode(contractId), wrapped);
      const stanza = concat(new Uint8Array([type.length]), type, int(body.length, 2), body);
      const header = concat(prefix, stanza);
      new DataView(header.buffer).setUint32(8, header.length + MAC + SIG);
      const macKey = await subtle.importKey(
        'raw',
        await hkdf(key, fileId, 'annon/pay2/header'),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const mac = new Uint8Array(await subtle.sign('HMAC', macKey, header));
      const sig = await finishTrailer(
        version,
        authKind,
        finishOpts,
        fileId,
        await sha256(header, mac),
      );
      const finalHeader = concat(header, mac, sig);
      finished = finalHeader;
      return output(replay, async function* (reader) {
        yield finalHeader;
        let i = 0;
        for await (const wire of encrypt(reader, true)) {
          if (!equal(await sha256(wire), hashes[i++] as Bytes)) {
            throw new SourceChangedError();
          }
          yield wire;
        }
      });
    },
    async preview(show) {
      if (!finished) throw new Error('call finish first: the preview carries the final header');
      if (show.data && previewLen === 0) throw new RangeError('sealed without a preview');
      const prefixOnly = finished.slice(0, prefix.length);
      prefixOnly[6] = 0;
      new DataView(prefixOnly.buffer).setUint32(8, 0);
      const b64 = (b: Uint8Array) => {
        let text = '';
        for (const byte of b) text += String.fromCharCode(byte);
        return btoa(text);
      };
      const chunks = [];
      for (const i of [0, 1]) {
        if (!(i === 0 ? show.meta : show.data)) continue;
        chunks.push({
          index: i,
          key: b64(await chunkKey(key, fileId, i)),
          data: b64(previewWire[i] as Bytes),
        });
      }
      return { v: 1, header: b64(prefixOnly), chunks };
    },
  };
}

interface OpenStreamOptions extends Omit<OpenOptions, 'ckdSecret'> {
  /** Called after registration/signature/stanza checks, BEFORE the complete body is checked. */
  ckdSecret: OpenOptions['ckdSecret'];
  /** Authenticated metadata. Like plaintext, discard it if the stream later errors. */
  onMeta?: (meta: FileMeta) => void;
  /** @internal Bind a replay to the header validated before key release. */
  expectedHeader?: Uint8Array;
}

/**
 * Checks the fixed fields that decide how much to read (spec 6, step 1, up to `headerLen`), then
 * reads the rest; `parseHeader` checks everything else on the whole header.
 */
export async function readHeader(input: ByteReader): Promise<Bytes> {
  const fixed = await input.read(FIXED);
  if (fixed.length < 4 || !MAGIC.every((byte, i) => fixed[i] === byte))
    throw new Pay2Error('bad_magic');
  if (fixed.length < FIXED) throw new Pay2Error('bad_header');
  if (fixed[4] !== 2) throw new Pay2Error('unsupported_version');
  const chunkLog2 = fixed[5] ?? 0;
  if (chunkLog2 < 16 || chunkLog2 > 24) throw new Pay2Error('bad_chunk_size');
  const dv = new DataView(fixed.buffer);
  const headerLen = dv.getUint32(8);
  if (headerLen > MAX_HEADER) throw new Pay2Error('header_too_large');
  // A headerLen below the fixed part reads nothing more; parseHeader then refuses it.
  return concat(fixed, await input.read(Math.max(0, headerLen - FIXED)));
}

/**
 * Authenticates each chunk's registered SHA-256 hash AND GCM tag before releasing plaintext.
 * The final chunk waits for EOF, so trailing bytes cannot be silently ignored. On a late error,
 * earlier authenticated chunks may already have reached the consumer: DISCARD ALL OUTPUT.
 * Unlike buffered open, key acquisition precedes complete-body validation; error precedence
 * across independent faults may differ. No unauthenticated plaintext is ever emitted.
 */
export function openStream(
  file: ReadableStream<Uint8Array>,
  opts: OpenStreamOptions,
  /** @internal Full plaintext size established by the replayable validation pass. */
  expectedSize?: number,
): ReadableStream<Uint8Array> {
  return output(file, async function* (input) {
    const header = await readHeader(input);
    if (opts.expectedHeader && !equal(header, opts.expectedHeader)) throw new SourceChangedError();
    const h = await checkSigned(header, opts.listing, opts.contractId);
    const stanza = h.stanzas
      .map((s) => (s.type === NEAR_CKD ? nearCkd(s.body) : undefined))
      .find((s) => s?.contractId === opts.contractId);
    if (!stanza) throw new Pay2Error('no_usable_stanza');
    const wrapKey = await wrapKeyFor(await opts.ckdSecret(copy(h.fileId)), h.fileId, 'unwrapKey');
    let key: CryptoKey;
    try {
      key = await subtle.unwrapKey('raw', stanza.wrapped, wrapKey, 'AES-KW', 'HKDF', false, [
        'deriveBits',
      ]);
    } catch {
      throw new Pay2Error('key_unwrap_failed');
    }
    const macKey = await subtle.importKey(
      'raw',
      await hkdf(key, h.fileId, 'annon/pay2/header'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const macAt = h.headerLen - MAC - SIG;
    if (
      !(await subtle.verify(
        'HMAC',
        macKey,
        header.subarray(macAt, macAt + MAC),
        header.subarray(0, macAt),
      ))
    )
      throw new Pay2Error('header_mac_invalid');
    const C = 2 ** h.chunkLog2;
    let meta: FileMeta | undefined;
    let size = 0;
    for (let i = 0; i < h.n; i++) {
      const last = i === h.n - 1;
      const length =
        i === 0 ? h.metaLen + TAG : i === 1 && h.previewLen > 0 ? h.previewLen + TAG : C + TAG;
      // The last is the remainder, capped with one extra byte to detect extensions without
      // reading an unbounded hostile tail. read() waits for EOF if the last fits the cap.
      const wire = await input.read(last ? C + TAG + 1 : length);
      if (last ? wire.length < TAG || wire.length > C + TAG : wire.length !== length)
        throw new Pay2Error('bad_body_length');
      if (!equal(await sha256(wire), h.hashes[i] as Bytes))
        throw new Pay2Error('chunk_hash_mismatch', `chunk ${i}`);
      const k = await chunkKey(key, h.fileId, i);
      const c = h.commits[i];
      if (c && !equal(await commitment(k), c))
        throw new Pay2Error('chunk_invalid', `chunk ${i} key commitment`);
      let piece: Bytes;
      try {
        piece = await gcm('decrypt', k, last, wire);
      } catch {
        throw new Pay2Error('chunk_invalid', `chunk ${i}`);
      }
      if (i === 0) {
        meta = parseMeta(piece, h);
        if (expectedSize !== undefined && meta.size !== expectedSize)
          throw new Pay2Error('meta_invalid', 'chunk lengths do not add up to the size');
        opts.onMeta?.({ ...meta });
      } else {
        size += piece.length;
        if (last && size !== meta?.size)
          throw new Pay2Error('meta_invalid', 'chunk lengths do not add up to the size');
        yield piece;
      }
    }
  });
}
