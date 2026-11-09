/**
 * Download after payment (`specs/x402-annon.md`, section 7). The host serves a file only to a
 * wallet that bought it: it issues a single-use challenge, the wallet signs an EIP-4361 message
 * bound to the host, the contract, the file and the header the buyer checked before paying, and
 * the host checks the signature and `is_buyer` on the trusted contract at final state. The wire
 * format is in `specs/download.md`.
 *
 * The client checks every chunk against the hash list of that header before passing it on, and
 * resumes a broken download with a Range request from the last checked chunk.
 */
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  type Bytes,
  copy,
  equal,
  hexBytes,
  parseHeader,
  sha256,
  signedBy,
  TAG,
} from '../envelope/pay2.js';
import { isBuyer } from '../near/rpc.js';

export type DownloadErrorCode =
  /** No or malformed `Authorization`: answer 401 with a new challenge. */
  | 'no_authorization'
  /** The challenge is unknown, already used or expired: answer 401 with a new one. */
  | 'challenge_invalid'
  /** The signature is not from the wallet named: answer 401. */
  | 'bad_signature'
  /** The wallet did not buy this file on the trusted contract: answer 403. */
  | 'not_buyer'
  /** Client: the host answered something this protocol does not allow. */
  | 'bad_response'
  /** Client: the bytes are not the file whose header was checked before paying. */
  | 'file_mismatch'
  /** Client: the wallet did not sign; not retried. */
  | 'wallet_refused'
  /** Client: the caller cancelled the download. */
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

/** What the host issues and keeps until it is used once. Unix seconds. */
export interface Challenge {
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

/** A challenge lives this long: enough to sign, too short to keep. */
export const CHALLENGE_SECONDS = 120;
export const AUTH_SCHEME = 'Annon-SIWE';

export function newChallenge(now = Math.floor(Date.now() / 1000)): Challenge {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  return { nonce, issuedAt: now, expiresAt: now + CHALLENGE_SECONDS };
}

/** What the signature binds, besides the wallet and the challenge. */
export interface DownloadTerms {
  /** The host's own authority, from its configuration, never from the request (`files.example`). */
  domain: string;
  /** The download URL, as the offer's `info.download` names it. */
  uri: string;
  contractId: string;
  /** 0x and 32 bytes, lowercase. */
  fileId: string;
  /** `SHA256` of the complete header served at `info.header`, 0x and lowercase. */
  headerHash: string;
}

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

const iso = (secs: number) => new Date(secs * 1000).toISOString();
const validLifetime = (c: Challenge) =>
  Number.isSafeInteger(c.issuedAt) &&
  Number.isSafeInteger(c.expiresAt) &&
  c.expiresAt - c.issuedAt > 0 &&
  c.expiresAt - c.issuedAt <= CHALLENGE_SECONDS;

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
const isHash = (s: string) => /^0x[0-9a-f]{64}$/.test(s);

/** The EIP-4361 message the wallet signs for one download. */
export function downloadMessage(t: DownloadTerms, address: string, c: Challenge): string {
  if (!isHash(t.fileId) || !isHash(t.headerHash)) {
    throw new TypeError('fileId and headerHash must be 0x and 32 bytes of lowercase hex');
  }
  if (!/^[a-z0-9._-]{2,64}$/.test(t.contractId)) throw new TypeError('bad NEAR account id');
  if (!/^[a-zA-Z0-9]{8,64}$/.test(c.nonce))
    throw new TypeError('the nonce must be 8 to 64 alphanumerics');
  if (!validLifetime(c)) throw new TypeError(`a challenge lives 1 to ${CHALLENGE_SECONDS} s`);
  // The URI must be absolute and on the same host as the domain the wallet shows.
  if (new URL(t.uri).host !== t.domain) throw new TypeError('uri must be on domain');
  return [
    `${t.domain} wants you to sign in with your Ethereum account:`,
    checksumAddress(address),
    '',
    'Download an Annon file you bought.',
    '',
    `URI: ${t.uri}`,
    'Version: 1',
    'Chain ID: 8453',
    `Nonce: ${c.nonce}`,
    `Issued At: ${iso(c.issuedAt)}`,
    `Expiration Time: ${iso(c.expiresAt)}`,
    'Resources:',
    `- urn:annon:v1:${t.contractId}:${t.fileId}:${t.headerHash}`,
  ].join('\n');
}

const b64url = {
  encode: (s: string) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(s)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, ''),
  decode: (s: string) =>
    new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
    ),
};

/** The `Authorization` header value for a signed challenge. */
export const authorization = (address: string, nonce: string, signature: string) =>
  `${AUTH_SCHEME} ${b64url.encode(JSON.stringify({ address, nonce, signature }))}`;

export interface VerifyDownloadOptions extends DownloadTerms {
  nearRpc: string;
  /**
   * Returns the challenge with this nonce and deletes it in the same step (single use), or null.
   * The host's store; it must be atomic across instances.
   */
  take: (nonce: string) => Promise<Challenge | null>;
  /** Unix seconds; defaults to now. */
  now?: number;
}

/**
 * Host side: whether the request may get the file. Returns the buyer's wallet, or throws
 * `DownloadError` (`no_authorization`, `challenge_invalid`, `bad_signature`: answer 401 with a new
 * challenge; `not_buyer`: 403). Run it for every request, Range requests included.
 */
export async function verifyDownload(
  header: string | null | undefined,
  o: VerifyDownloadOptions,
): Promise<{ wallet: string }> {
  const [scheme, token, extra] = (header ?? '').trim().split(/\s+/);
  if (scheme !== AUTH_SCHEME || !token || extra !== undefined) return fail('no_authorization');
  let a: { address?: unknown; nonce?: unknown; signature?: unknown };
  try {
    a = JSON.parse(b64url.decode(token));
  } catch {
    return fail('no_authorization', 'the authorization is not base64url JSON');
  }
  if (
    typeof a?.address !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(a.address) ||
    typeof a.nonce !== 'string' ||
    typeof a.signature !== 'string'
  ) {
    return fail('no_authorization', 'the authorization lacks address, nonce or signature');
  }
  // Single use: the challenge is gone after this, whatever the outcome.
  const c = await o.take(a.nonce);
  const now = o.now ?? Math.floor(Date.now() / 1000);
  if (!c || c.nonce !== a.nonce || !validLifetime(c) || now >= c.expiresAt || now < c.issuedAt) {
    return fail('challenge_invalid', 'unknown, used or expired challenge');
  }
  const wallet = a.address.toLowerCase();
  let sig: Uint8Array;
  try {
    sig = hexBytes(a.signature, 65);
  } catch {
    return fail('bad_signature');
  }
  if (!signedBy(downloadMessage(o, wallet, c), sig, wallet)) return fail('bad_signature');
  if (!(await isBuyer(o.nearRpc, o.contractId, o.fileId, wallet))) {
    return fail('not_buyer', 'this wallet did not buy the file');
  }
  return { wallet };
}

export interface DownloadOptions {
  /** `info.download` from the offer. */
  url: string;
  contractId: string;
  fileId: string;
  /** The header the buyer checked before paying (`Quote.header`). */
  header: Uint8Array;
  wallet: { address: string; signMessage(text: string): Promise<string> };
  /** Attempts after a broken connection; each resumes from the last checked chunk. */
  retries?: number;
  fetch?: typeof fetch;
  /** Unix seconds; defaults to now. */
  now?: () => number;
}

/** The 401's challenge is small; a host sending more is cut off, not buffered. */
const MAX_CHALLENGE_BYTES = 1024;

async function readSmall(r: Response): Promise<string> {
  const reader = r.body?.getReader();
  if (!reader) return '';
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const x = await reader.read();
    if (x.done) break;
    size += x.value.length;
    if (size > MAX_CHALLENGE_BYTES) {
      await reader.cancel().catch(() => {});
      return fail('bad_response', 'the challenge is too large');
    }
    parts.push(x.value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return new TextDecoder().decode(all);
}

/**
 * Buyer side: the complete PAY2 file, header first, as a stream. Every body chunk is checked
 * against the header's hash list before it is passed on; on any mismatch the stream errors with
 * `file_mismatch` and the caller must discard what it got. The result goes to `openStream` or to
 * storage.
 *
 * In a browser the wallet checks that the message's domain is the page's (EIP-4361), so the
 * download URL must be on the page's own host; a host elsewhere is reached through a same-origin
 * route.
 */
export function download(o: DownloadOptions): ReadableStream<Uint8Array> {
  const url = secureUrl(o.url);
  const page = (globalThis as { location?: { host?: string } }).location?.host;
  if (page !== undefined && page !== url.host) {
    throw new TypeError(`in a browser the download must be on this page's host (${page})`);
  }
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
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

  // Where the current response ends, when the host says (Content-Range or Content-Length).
  let pos = 0;
  let end: number | undefined;

  async function request(): Promise<{
    reader: ReadableStreamDefaultReader<Uint8Array>;
    rest: Uint8Array;
  }> {
    // No redirects: one could move the signed request to plain HTTP or another host.
    live();
    const first = await fetcher(o.url, { redirect: 'error', signal: abort.signal });
    if (first.status !== 401) return fail('bad_response', `expected 401, got ${first.status}`);
    let c: Challenge | null = null;
    try {
      c = JSON.parse(await readSmall(first));
    } catch (e) {
      if (e instanceof DownloadError) throw e;
    }
    if (
      !c ||
      typeof c.nonce !== 'string' ||
      !/^[a-zA-Z0-9]{8,64}$/.test(c.nonce) ||
      !validLifetime(c) ||
      now() >= c.expiresAt ||
      // The host refuses a challenge before its issue time; 60 s allows for clock skew.
      c.issuedAt > now() + 60
    ) {
      return fail('bad_response', 'the 401 carries no valid challenge');
    }
    const terms: DownloadTerms = {
      domain: new URL(o.url).host,
      uri: o.url,
      contractId: o.contractId,
      fileId: o.fileId,
      headerHash: `0x${Array.from(await sha256(header), (b) => b.toString(16).padStart(2, '0')).join('')}`,
    };
    const message = downloadMessage(terms, o.wallet.address, c);
    live();
    let signature: string;
    try {
      signature = await o.wallet.signMessage(message);
    } catch (e) {
      return fail('wallet_refused', e instanceof Error ? e.message : String(e));
    }
    live();
    const r = await fetcher(o.url, {
      redirect: 'error',
      signal: abort.signal,
      headers: {
        authorization: authorization(o.wallet.address, c.nonce, signature),
        range: `bytes=${offset}-`,
      },
    });
    if (!r.body || (r.status !== 206 && r.status !== 200)) {
      return fail('bad_response', `the host answered ${r.status}`);
    }
    const reader = r.body.getReader();
    // A host without Range support sends everything: skip what was already checked.
    if (r.status === 200) {
      const length = Number(r.headers.get('content-length') ?? Number.NaN);
      end = Number.isSafeInteger(length) ? length : undefined;
      pos = offset;
      return { reader, rest: await skip(reader, offset) };
    }
    const range = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(r.headers.get('content-range') ?? '');
    if (!range || Number(range[1]) !== offset) {
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
