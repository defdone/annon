/**
 * Downloading a bought file (`specs/download.md`, profile v1.1 section 7). The file is the offer's
 * `resource.url`. The paid request returns it to the buyer, who proves the purchase's one-time key
 * (`Annon-Buyer-Proof`); later, the buyer's wallet signs in with x402 sign-in-with-x once and the
 * host's session covers every download and resume for two hours.
 *
 * The client checks every chunk against the hash list of the header it checked before paying,
 * and resumes a broken download with a Range request from the last checked chunk.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import { type Bytes, copy, equal, parseHeader, sha256, TAG } from '../envelope/pay2.js';
import { BUYER_PROOF_HEADER, buyerProof, sameResource } from './proof.js';
import {
  fileUrn,
  SIGN_IN_HEADER,
  SIGN_IN_SECONDS,
  SIGN_IN_WITH_X,
  type SignInChallenge,
  signInHeader,
  signInMessage,
} from './siwx.js';

export type DownloadErrorCode =
  /** The host answered something this protocol does not allow. */
  | 'bad_response'
  /** No payment, session or sign-in this host takes: the wallet did not buy, or none was given. */
  | 'not_authorized'
  /** The payment is still settling after every retry; send the same payload again later. */
  | 'settling'
  /** The bytes are not the file whose header was checked before paying. */
  | 'file_mismatch'
  /** The wallet did not sign; not retried. */
  | 'wallet_refused'
  /** The caller cancelled the download. */
  | 'cancelled';

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

/** EIP-55: the address with its checksum casing, as EIP-4361 requires. */
export function checksumAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new TypeError('address must be 0x and 20 bytes');
  const lower = address.slice(2).toLowerCase();
  const h = keccak_256(new TextEncoder().encode(lower));
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    const nibble = ((h[i >> 1] as number) >> (i % 2 === 0 ? 4 : 0)) & 0xf;
    out += nibble >= 8 ? (lower[i] as string).toUpperCase() : lower[i];
  }
  return out;
}

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
  /**
   * The paid request (profile section 7): the recorded `PAYMENT-SIGNATURE` and the purchase's
   * one-time secret, which signs the buyer proof.
   */
  payment?: { header: string; secret: Uint8Array };
  /** A session this host gave earlier (`Annon-Session`). */
  session?: string;
  /** Signs in when there is no payment or session that gets the file. */
  wallet?: { address: string; signMessage(text: string): Promise<string> };
  /** Gets the session a sign-in returns, to reuse on this host for two hours. */
  onSession?: (token: string) => void;
  /** Attempts after a broken connection; each resumes from the last checked chunk. */
  retries?: number;
  /** How often a payment that is still settling is asked again (default 40). */
  settleTries?: number;
  /** Waits between those (default: `Retry-After`, or 3 s). */
  wait?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
  /** Unix seconds; defaults to now. */
  now?: () => number;
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
  const url = secureUrl(o.url);
  // A browser wallet signs in only for the page's own origin (EIP-4361): the file must be there.
  const page = (globalThis as { location?: { origin?: string } }).location?.origin;
  if (o.wallet && page !== undefined && page !== url.origin) {
    throw new TypeError(`in a browser the file must be on this page's origin (${page})`);
  }
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const wait = o.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const header = copy(o.header);
  const h = parseHeader(header);
  const lengths = Array.from({ length: h.n - 1 }, (_, i) =>
    i === 0
      ? h.metaLen + TAG
      : i === 1 && h.previewLen > 0
        ? h.previewLen + TAG
        : 2 ** h.chunkLog2 + TAG,
  );
  const maxLast = 2 ** h.chunkLog2 + TAG;
  const fetcher = o.fetch ?? globalThis.fetch;
  // Cancelling aborts any request in flight and stops before the next signature or request.
  const abort = new AbortController();
  const live = () => {
    if (abort.signal.aborted) fail('cancelled');
  };
  let chunk = 0; // next chunk to check
  let offset = header.length; // its first byte in the file
  let sentHeader = false;
  let retries = o.retries ?? 3;
  let session = o.session;
  // The buyer proof only for the URL the payment names: never for another host's.
  // It signs the advertised `resource.url` octets, which the host checks, not the request's spelling.
  let payment = o.payment;
  let named = '';
  if (payment) {
    const u = (b64json(payment.header) as { resource?: { url?: unknown } } | null)?.resource?.url;
    if (typeof u !== 'string' || !sameResource(u, o.url)) {
      throw new TypeError('the payment names another resource than the file URL');
    }
    named = u;
  }

  // Where the current response ends, when the host says (Content-Range or Content-Length).
  let pos = 0;
  let end: number | undefined;

  const get = (headers: Record<string, string>) => {
    live();
    // No redirects: one could move the request to plain HTTP or another host.
    // No cookies either: a session travels only in `Authorization` (profile section 9).
    return fetcher(o.url, {
      redirect: 'error',
      credentials: 'omit',
      signal: abort.signal,
      headers: { ...headers, range: `bytes=${offset}-` },
    });
  };
  const body = (r: Response) => r.body && (r.status === 200 || r.status === 206);

  /** The response that carries the file, from the payment, a session or a sign-in. */
  async function authorized(): Promise<Response> {
    if (payment) {
      const p = payment;
      for (let i = 0; ; i++) {
        const r = await get({
          'PAYMENT-SIGNATURE': p.header,
          [BUYER_PROOF_HEADER]: buyerProof(p.secret, named),
        });
        if (body(r)) return r;
        const pending =
          r.status === 503 ||
          (r.status === 402 &&
            (b64json(r.headers.get('PAYMENT-RESPONSE')) as { errorReason?: unknown } | null)
              ?.errorReason === 'settlement_pending');
        await r.body?.cancel().catch(() => {});
        if (!pending) break;
        if (i + 1 >= (o.settleTries ?? 40))
          return fail('settling', 'the payment is still settling');
        const after = Number(r.headers.get('Retry-After'));
        await wait(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 3000);
      }
      // Settled without the body (another copy of the payload came first): sign in instead.
      payment = undefined;
    }
    if (session) {
      const r = await get({ authorization: `Bearer ${session}` });
      if (body(r)) return r;
      await r.body?.cancel().catch(() => {});
      session = undefined;
    }
    if (!o.wallet) return fail('not_authorized', 'no payment, session or wallet gets the file');
    const bare = await get({});
    if (body(bare)) return bare;
    await bare.body?.cancel().catch(() => {});
    if (bare.status !== 402) return fail('bad_response', `the host answered ${bare.status}`);
    const pr = b64json(bare.headers.get('PAYMENT-REQUIRED')) as {
      extensions?: Record<string, { info?: SignInChallenge; supportedChains?: unknown }>;
    } | null;
    const ext = pr?.extensions?.[SIGN_IN_WITH_X];
    const c = ext?.info;
    // The wallet signs only for a chain the host takes: Base, EIP-191.
    const base =
      Array.isArray(ext?.supportedChains) &&
      ext.supportedChains.some(
        (x: { chainId?: unknown; type?: unknown }) =>
          x?.chainId === 'eip155:8453' && x?.type === 'eip191',
      );
    const headerHash = `0x${Array.from(await sha256(header), (b) => b.toString(16).padStart(2, '0')).join('')}`;
    const at = c ? Date.parse(c.issuedAt) / 1000 : Number.NaN;
    const until = c ? Date.parse(c.expirationTime) / 1000 : Number.NaN;
    if (
      !c ||
      !base ||
      c.domain !== url.host ||
      !sameResource(c.uri, o.url) ||
      c.version !== '1' ||
      !/^[0-9a-f]{32}$/.test(c.nonce) ||
      !Array.isArray(c.resources) ||
      c.resources.length !== 1 ||
      c.resources[0] !== fileUrn(o.contractId, o.fileId, headerHash) ||
      !(until > now() && at <= now() + 60 && until - at > 0 && until - at <= SIGN_IN_SECONDS)
    ) {
      return fail('bad_response', 'the 402 carries no sign-in challenge for this file');
    }
    live();
    let signature: string;
    try {
      signature = await o.wallet.signMessage(signInMessage(c, o.wallet.address));
    } catch (e) {
      return fail('wallet_refused', e instanceof Error ? e.message : String(e));
    }
    const r = await get({ [SIGN_IN_HEADER]: signInHeader(c, o.wallet.address, signature) });
    const token = r.headers.get('Annon-Session');
    if (token && /^[0-9a-f]{64}$/.test(token)) {
      session = token;
      o.onSession?.(token);
    }
    if (body(r)) return r;
    await r.body?.cancel().catch(() => {});
    return fail(
      'not_authorized',
      `the host answered ${r.status}: this wallet did not buy the file`,
    );
  }

  async function request(): Promise<{
    reader: ReadableStreamDefaultReader<Uint8Array>;
    rest: Uint8Array;
  }> {
    const r = await authorized();
    const reader = (r.body as ReadableStream<Uint8Array>).getReader();
    // A host without Range support sends everything: skip what was already checked.
    if (r.status === 200) {
      const length = Number(r.headers.get('content-length') ?? Number.NaN);
      end = Number.isSafeInteger(length) ? length : undefined;
      pos = offset;
      return { reader, rest: await skip(reader, offset) };
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
    pos = offset;
    return { reader, rest: new Uint8Array(0) };
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let pending: Uint8Array = new Uint8Array(0);
  async function read(n: number, eofOk: boolean): Promise<Bytes> {
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      if (pending.length === 0 && !reader) {
        const got = await request();
        reader = got.reader;
        pending = got.rest;
      }
      if (pending.length === 0) {
        const r = await (reader as ReadableStreamDefaultReader<Uint8Array>).read();
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
              controller.close();
              await reader?.cancel().catch(() => {});
            }
            return;
          } catch (e) {
            // Only a broken connection is retried: fetch's network TypeError, a stream error, or
            // an early end. A mismatch, a refusal or a cancellation ends the download.
            await reader?.cancel().catch(() => {});
            reader = undefined;
            pending = new Uint8Array(0);
            if (abort.signal.aborted) fail('cancelled');
            if (e instanceof DownloadError || retries-- <= 0) {
              // Final: abort every request of this download, including a response rejected
              // before its reader was kept.
              abort.abort();
              throw e;
            }
          }
        }
      },
      async cancel() {
        abort.abort();
        await reader?.cancel().catch(() => {});
      },
    },
    { highWaterMark: 0 },
  );
}

/** Drops the first `n` bytes; returns what came after them in the same read. */
async function skip(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  n: number,
): Promise<Uint8Array> {
  // ponytail: a host without Range costs bandwidth on a resume, not memory.
  let left = n;
  for (;;) {
    const r = await reader.read();
    if (r.done) throw new Error('the connection ended before the resume point');
    if (r.value.length >= left) return r.value.subarray(left);
    left -= r.value.length;
  }
}
