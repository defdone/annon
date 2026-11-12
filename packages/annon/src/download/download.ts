/** Download a final purchase grant with Range retries and checked chunks. */
import { type Bytes, copy, equal, parseHeader, sha256, TAG } from '../envelope/pay2.js';
import { BUYER_PROOF_HEADER, purchaseProof, sameResource } from './proof.js';
export type DownloadErrorCode =
  /** The host answered something this protocol does not allow. */
  | 'bad_response'
  /** The host did not accept the payment or purchase grant proof. */
  | 'not_authorized'
  /** The payment is still settling after every retry; send the same payload again later. */
  | 'settling'
  /** The bytes are not the file whose header was checked before paying. */
  | 'file_mismatch'
  /** The caller cancelled the download. */
  | 'cancelled'
  /** In-memory browser opening is limited; use the CLI for larger files. */
  | 'too_large';

export class DownloadError extends Error {
  readonly code: DownloadErrorCode;
  constructor(code: DownloadErrorCode, message: string = code) {
    super(message);
    this.code = code;
    this.name = 'DownloadError';
  }
}
const fail = (code: DownloadErrorCode, message?: string): never => {
  throw new DownloadError(code, message);
};

/**
 * Gated downloads go over HTTPS only: on plain HTTP anyone on the path reads the body or races the
 * buyer with the intercepted authorization. Plain HTTP only for this machine, in development.
 */
export function secureUrl(url: string): URL {
  const u = new URL(url);
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new TypeError(`${url} must be https`);
  }
  return u;
}
export interface DownloadOptions {
  /** The file: the offer's `resource.url`. */
  url: string;
  contractId: string;
  fileId: string;
  /** The header the buyer checked before paying (`Quote.header`). */
  header: Uint8Array;
  /** A grant key, obtained from this purchase or wallet recovery. */
  proof: { secret: Uint8Array; purchase_id: string; grant: number };
  payment?: { header: string };
  /** Attempts after a broken connection; each resumes from the last checked chunk. */
  retries?: number;
  /** How often a payment that is still settling is asked again (default 40). */
  settleTries?: number;
  /** Waits between those (default: `Retry-After`, or 3 s). */
  wait?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
  /** Unix seconds; defaults to now. */
  now?: () => number;
  maxBytes?: number;
  signal?: AbortSignal;
}

const b64json = (s: string | null): unknown => {
  try {
    return s === null
      ? null
      : JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
};

/**
 * The file as a stream: the header first, then each chunk once its hash matches. Throws
 * `DownloadError`; a broken connection is retried from the last checked chunk.
 */
export function download(o: DownloadOptions): ReadableStream<Uint8Array> {
  secureUrl(o.url);
  const header = copy(o.header);
  const h = parseHeader(header);
  const lengths = Array.from({ length: h.n - 1 }, (_, i) =>
    i === 0
      ? h.metaLen + TAG
      : i === 1 && h.previewLen > 0
        ? h.previewLen + TAG
        : 2 ** h.chunkLog2 + TAG,
  );
  const limit = o.maxBytes ?? Number.POSITIVE_INFINITY;
  const sizeCheck = (size: number) => {
    if (size > limit)
      fail('too_large', 'File exceeds the browser size limit. Use the CLI for larger files.');
  };
  sizeCheck(header.length + lengths.reduce((sum, n) => sum + n, 0) + TAG);
  const maxLast = 2 ** h.chunkLog2 + TAG;
  const fetcher = o.fetch ?? globalThis.fetch;
  // Cancelling aborts any request in flight and stops before the next signature or request.
  const abort = new AbortController();
  const cancelExternal = () => {
    abort.abort();
    void activeReader?.cancel().catch(() => {});
  };
  if (o.signal?.aborted) fail('cancelled');
  const cleanup = () => o.signal?.removeEventListener('abort', cancelExternal);
  const live = () => {
    if (abort.signal.aborted) fail('cancelled');
  };
  async function untilAbort<T>(pending: Promise<T>): Promise<T> {
    let stop: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      stop = () => reject(new DownloadError('cancelled'));
      abort.signal.addEventListener('abort', stop, { once: true });
      if (abort.signal.aborted) stop();
    });
    try {
      return await Promise.race([pending, cancelled]);
    } finally {
      abort.signal.removeEventListener('abort', stop);
    }
  }
  async function wait(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await untilAbort(
        o.wait
          ? o.wait(ms)
          : new Promise<void>((resolve) => {
              timer = setTimeout(resolve, ms);
            }),
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  let chunk = 0; // next chunk to check
  let offset = header.length; // its first byte in the file
  let sentHeader = false;
  let retries = o.retries ?? 3;
  // The buyer proof only for the URL the payment names: never for another host's.
  // It signs the advertised `resource.url` octets, which the host checks, not the request's spelling.
  const payment = o.payment;
  let named = '';
  if (payment) {
    const u = (b64json(payment.header) as { resource?: { url?: unknown } } | null)?.resource?.url;
    if (typeof u !== 'string' || !sameResource(u, o.url)) {
      throw new TypeError('the payment names another resource than the file URL');
    }
    named = u;
  }

  o.signal?.addEventListener('abort', cancelExternal, { once: true });

  // Where the current response ends, when the host says (Content-Range or Content-Length).
  let pos = 0;
  let end: number | undefined;

  const get = (headers: Record<string, string>) => {
    live();
    // No redirects: one could move the request to plain HTTP or another host.
    // No cookies either: the grant proof travels in `Annon-Buyer-Proof` (profile section 9).
    return untilAbort(
      fetcher(o.url, {
        redirect: 'error',
        credentials: 'omit',
        signal: abort.signal,
        headers: { ...headers, range: `bytes=${offset}-` },
      }).then(async (response) => {
        if (abort.signal.aborted) await response.body?.cancel().catch(() => {});
        return response;
      }),
    );
  };
  const body = (r: Response) => r.body && (r.status === 200 || r.status === 206);

  /** Every retry proves the same purchase grant to this URL. */
  async function authorized(): Promise<Response> {
    const proof = purchaseProof(o.proof.secret, named || o.url, o.proof.purchase_id, o.proof.grant);
    for (let i = 0; ; i++) {
      const r = await get({
        [BUYER_PROOF_HEADER]: proof,
        ...(payment ? { 'PAYMENT-SIGNATURE': payment.header } : {}),
      });
      if (abort.signal.aborted) {
        await r.body?.cancel().catch(() => {});
        live();
      }
      if (body(r)) return r;
      const pending = r.status === 503 || r.status === 402;
      await r.body?.cancel().catch(() => {});
      if (!pending) return fail('not_authorized', `the host answered ${r.status}`);
      if (i + 1 >= (o.settleTries ?? 40))
        return fail('settling', 'the purchase grant is not available yet');
      const after = Number(r.headers.get('Retry-After'));
      await wait(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 3000);
    }
  }

  async function request(): Promise<{
    reader: BodyReader;
    rest: Uint8Array;
  }> {
    const r = await authorized();
    const length = Number(r.headers.get('content-length') ?? Number.NaN);
    const total = Number((/\/(\d+)$/.exec(r.headers.get('content-range') ?? '') ?? [])[1]);
    try {
      sizeCheck(r.status === 200 ? length : offset + length);
      if (r.status === 206) sizeCheck(total);
    } catch (error) {
      await r.body?.cancel().catch(() => {});
      throw error;
    }
    const source = (r.body as ReadableStream<Uint8Array>).getReader();
    let received = r.status === 200 ? 0 : offset;
    const reader = {
      cancel: () => source.cancel(),
      async read() {
        const result = await source.read();
        live();
        if (!result.done) {
          received += result.value.length;
          try {
            sizeCheck(received);
          } catch (error) {
            await source.cancel().catch(() => {});
            throw error;
          }
        }
        return result;
      },
    };
    // Retain immediately, so external cancellation also interrupts header skipping.
    activeReader = reader;
    // A host without Range support sends everything: skip what was already checked.
    if (r.status === 200) {
      const length = Number(r.headers.get('content-length') ?? Number.NaN);
      end = Number.isSafeInteger(length) ? length : undefined;
      pos = offset;
      return { reader, rest: await skip(reader, offset, header) };
    }
    const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(r.headers.get('content-range') ?? '');
    // RFC 9110 section 14.4: first <= last < complete length, or the range is invalid.
    if (
      !range ||
      Number(range[1]) !== offset ||
      Number(range[2]) < offset ||
      (range[3] !== '*' && Number(range[2]) >= Number(range[3]))
    ) {
      await reader.cancel().catch(() => {});
      return fail('bad_response', 'the host resumed from another offset');
    }
    end = Number(range[2]) + 1;
    sizeCheck(end);
    pos = offset;
    return { reader, rest: new Uint8Array(0) };
  }

  let reader: BodyReader | undefined;
  let activeReader: BodyReader | undefined;
  let pending: Uint8Array = new Uint8Array(0);
  async function read(n: number, eofOk: boolean): Promise<Bytes> {
    n = Math.min(n, Math.max(0, limit - offset) + 1);
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      if (pending.length === 0 && !reader) {
        const got = await request();
        reader = got.reader;
        pending = got.rest;
      }
      if (pending.length === 0) {
        const r = await (reader as BodyReader).read();
        if (r.done) {
          // Retried: a connection can end cleanly in the middle, also before the end it announced.
          if (eofOk && (end === undefined || pos >= end)) break;
          throw new Error('the connection ended early');
        }
        pending = r.value;
      }
      const take = Math.min(n - at, pending.length);
      out.set(pending.subarray(0, take), at);
      pending = pending.subarray(take);
      at += take;
      pos += take;
    }
    return out.subarray(0, at);
  }

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        live();
        if (!sentHeader) {
          sentHeader = true;
          controller.enqueue(copy(header));
          return;
        }
        for (;;) {
          try {
            // The last chunk is the rest of the file: one byte over its maximum means bytes follow.
            const last = chunk === h.n - 1;
            const wire = await read(last ? maxLast + 1 : (lengths[chunk] as number), last);
            // Spec 6, step 4: a seller can sign a hash of a malformed last chunk, so its length is
            // checked on its own; one byte over the maximum is also a byte after the file.
            if (last && (wire.length < TAG || wire.length > maxLast)) {
              fail('file_mismatch', 'the last chunk has a wrong length, or bytes follow it');
            }
            if (!equal(await sha256(wire), h.hashes[chunk] as Bytes)) {
              fail('file_mismatch', `chunk ${chunk} is not the one the header names`);
            }
            controller.enqueue(wire);
            chunk++;
            offset += wire.length;
            if (last) {
              cleanup();
              controller.close();
              await reader?.cancel().catch(() => {});
            }
            return;
          } catch (e) {
            // Only a broken connection is retried: fetch's network TypeError, a stream error, or
            // an early end. A mismatch, a refusal or a cancellation ends the download.
            await activeReader?.cancel().catch(() => {});
            reader = undefined;
            pending = new Uint8Array(0);
            if (abort.signal.aborted) {
              cleanup();
              fail('cancelled');
            }
            if (e instanceof DownloadError || retries-- <= 0) {
              // Final: abort every request of this download, including a response rejected
              // before its reader was kept.
              abort.abort();
              cleanup();
              throw e;
            }
          }
        }
      },
      async cancel() {
        abort.abort();
        cleanup();
        await activeReader?.cancel().catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
}

type BodyReader = Pick<ReadableStreamDefaultReader<Uint8Array>, 'read' | 'cancel'>;

/** Drops the first `n` bytes; returns what came after them in the same read. */
async function skip(reader: BodyReader, n: number, header: Uint8Array): Promise<Uint8Array> {
  // Note: a host without Range costs bandwidth on a resume, not memory.
  let left = n;
  for (;;) {
    const r = await reader.read();
    if (r.done) throw new Error('the connection ended before the resume point');
    const at = n - left;
    const check = Math.min(r.value.length, left, Math.max(0, header.length - at));
    if (!equal(r.value.subarray(0, check), header.subarray(at, at + check)))
      fail('file_mismatch', 'the host sent another header');
    if (r.value.length >= left) return r.value.subarray(left);
    left -= r.value.length;
  }
}
