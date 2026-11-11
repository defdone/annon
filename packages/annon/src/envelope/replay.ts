/** Replayable file adapters shared by the browser SDK and Node file I/O. */
import {
  type Bytes,
  checkSigned,
  equal,
  type FileMeta,
  type FinishOptions,
  NEAR_CKD,
  nearCkd,
  type OpenOptions,
  Pay2Error,
  type SealOptions,
  sealWithKey,
  sha256,
  TAG,
} from './pay2.js';
import { ByteReader, openStream, readHeader, sealStreamWithKey } from './stream.js';

/** Each read starts a new bounded stream of the same immutable bytes. Never use tee(). */
export interface ReplayableSource {
  size: number;
  read(): ReadableStream<Uint8Array>;
}

/** Store encrypted bytes until use() completes, then remove the spool even on failure. */
export type Spool = <T>(
  stream: ReadableStream<Uint8Array>,
  use: (source: ReplayableSource) => Promise<T>,
) => Promise<T>;

/** @internal A single-use stream needs external storage to preserve spec 6 validation order. */
export function withReplay<T>(
  source: ReplayableSource | ReadableStream<Uint8Array>,
  use: (source: ReplayableSource) => Promise<T>,
  spool?: Spool,
): Promise<T> {
  if (!(source instanceof ReadableStream)) return use(source);
  if (!spool)
    return Promise.reject(new TypeError('a ciphertext spool is required for a single-use stream'));
  return spool(source, use);
}

export function blobSource(blob: Blob): ReplayableSource {
  return { size: blob.size, read: () => blob.stream() };
}

export type SellData = Uint8Array | ReplayableSource;
export type SellFile<T extends SellData> = T extends Uint8Array
  ? Bytes
  : ReadableStream<Uint8Array>;
export interface PreparedSeal<T extends SellData> {
  cipherHash: Bytes;
  preview: import('./pay2.js').Sealed['preview'];
  finish(opts: FinishOptions): Promise<{
    file: SellFile<T>;
    header: Bytes;
    consumed(): boolean;
    cancel(reason: unknown): Promise<void>;
  }>;
}

/** @internal Keeps registration and sell recovery independent of the file representation. */
export async function prepareSeal<T extends SellData>(
  key: Uint8Array,
  data: T,
  opts: SealOptions,
): Promise<PreparedSeal<T>> {
  if (data instanceof Uint8Array) {
    const sealed = await sealWithKey(key, data, opts);
    return {
      ...sealed,
      async finish(options) {
        const file = await sealed.finish(options);
        return {
          consumed: () => true,
          cancel: async () => {},
          file: file as SellFile<T>,
          header: file.subarray(0, new DataView(file.buffer).getUint32(8)),
        };
      },
    };
  }
  const firstPass = data.read();
  let sealed: Awaited<ReturnType<typeof sealStreamWithKey>>;
  try {
    sealed = await sealStreamWithKey(key, firstPass, data.size, opts);
  } catch (error) {
    await firstPass.cancel(error).catch(() => {});
    throw error;
  }
  return {
    ...sealed,
    async finish(options) {
      const replay = data.read();
      let wire: ReadableStream<Uint8Array>;
      try {
        wire = await sealed.finish(replay, options);
      } catch (error) {
        await replay.cancel(error).catch(() => {});
        throw error;
      }
      const reader = wire.getReader();
      let header: Bytes;
      try {
        // sealStream always emits the bounded header as its first piece.
        header = (await reader.read()).value as Bytes;
      } catch (error) {
        await reader.cancel(error);
        reader.releaseLock();
        throw error;
      }
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          reader.releaseLock();
        }
      };
      let first = true;
      let consumed = false;
      const file = new ReadableStream<Uint8Array>(
        {
          async pull(c) {
            if (first) {
              first = false;
              c.enqueue(header);
              return;
            }
            try {
              const result = await reader.read();
              if (result.done) {
                consumed = true;
                c.close();
                release();
              } else c.enqueue(result.value);
            } catch (error) {
              c.error(error);
              release();
            }
          },
          async cancel(reason) {
            await reader.cancel(reason);
            release();
          },
        },
        { highWaterMark: 0 },
      );
      return {
        file: file as SellFile<T>,
        header,
        consumed: () => consumed,
        async cancel(reason) {
          if (!released) {
            try {
              await reader.cancel(reason);
            } finally {
              release();
            }
          }
          await file.cancel(reason).catch(() => {});
        },
      };
    },
  };
}

/**
 * Spec 6 in buffered-open order with bounded memory. Validate ALL body lengths and hashes
 * before selecting a stanza or obtaining a key. Replay only immutable ciphertext. A download
 * must first be spooled to caller-owned storage. Sink contents remain provisional until success.
 */
export async function prepareOpen(source: ReplayableSource, opts: Omit<OpenOptions, 'ckdSecret'>) {
  const input = new ByteReader(source.read());
  let header: Bytes;
  let plaintextSize = 0;
  try {
    header = await readHeader(input);
    const h = await checkSigned(header, opts.listing, opts.contractId);
    const C = 2 ** h.chunkLog2;
    let mismatch = -1;
    for (let i = 0; i < h.n; i++) {
      const last = i === h.n - 1;
      const length =
        i === 0 ? h.metaLen + TAG : i === 1 && h.previewLen > 0 ? h.previewLen + TAG : C + TAG;
      const wire = await input.read(last ? C + TAG + 1 : length);
      if (last ? wire.length < TAG || wire.length > C + TAG : wire.length !== length)
        throw new Pay2Error('bad_body_length');
      if (i > 0) plaintextSize += wire.length - TAG;
      if (!equal(await sha256(wire), h.hashes[i] as Bytes) && mismatch < 0) mismatch = i;
    }
    // Length errors take precedence over every hash error, as in checkPublic.
    if (mismatch >= 0) throw new Pay2Error('chunk_hash_mismatch', `chunk ${mismatch}`);
    if (
      !h.stanzas.some((s) => s.type === NEAR_CKD && nearCkd(s.body)?.contractId === opts.contractId)
    )
      throw new Pay2Error('no_usable_stanza');
  } finally {
    await input.cancel();
    input.release();
  }
  return {
    header: header.slice(),
    async writeTo(
      sink: WritableStream<Uint8Array>,
      ckdSecret: OpenOptions['ckdSecret'],
    ): Promise<FileMeta> {
      let meta: FileMeta | undefined;
      await openStream(
        source.read(),
        {
          ...opts,
          expectedHeader: header,
          ckdSecret,
          onMeta: (value) => {
            meta = value;
          },
        },
        plaintextSize,
      ).pipeTo(sink);
      if (!meta) throw new Pay2Error('meta_invalid');
      return meta;
    },
  };
}

/** Bounded-memory open to a provisional sink, with exactly the checks and order of open(). */
export async function openTo(
  source: ReplayableSource | ReadableStream<Uint8Array>,
  sink: WritableStream<Uint8Array>,
  opts: OpenOptions & { spool?: Spool },
): Promise<FileMeta> {
  return withReplay(
    source,
    async (replay) => {
      const prepared = await prepareOpen(replay, opts);
      return prepared.writeTo(sink, opts.ckdSecret);
    },
    opts.spool,
  );
}
