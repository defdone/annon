import { AnnonError } from '../errors.js';
import { account } from '../settle-near/codec.js';
/**
 * PAY2, the Annon file format: `specs/pay2.md`. WebCrypto only, so the same code runs in browsers
 * and Node. `open` runs the checks of spec section 6 in its order and fails with its error codes.
 *
 * These convenience functions buffer input and output. For bounded-memory file operations,
 * use stream.ts and replay.ts, which share this module's format and crypto primitives.
 */

import { hex as canonicalHex } from '../settle-near/codec.js';
import {
  type Identity,
  identityKind,
  parseIdentity,
  solanaWalletAuth,
  verifyAuthorization,
} from '../settle-near/identity.js';
import { publishTextV2 } from '../settle-near/terms.js';
import { signedBy } from './evm.js';

export type Bytes = Uint8Array<ArrayBuffer>;

export type Pay2ErrorCode =
  | 'bad_magic'
  | 'unsupported_version'
  | 'bad_chunk_size'
  | 'header_too_large'
  | 'bad_header'
  | 'bad_stanza'
  | 'file_id_mismatch'
  | 'cipher_hash_mismatch'
  | 'seller_signature_invalid'
  | 'bad_body_length'
  | 'chunk_hash_mismatch'
  | 'no_usable_stanza'
  | 'key_unwrap_failed'
  | 'header_mac_invalid'
  | 'chunk_invalid'
  | 'meta_invalid'
  | 'preview_invalid';

export class Pay2Error extends AnnonError {
  readonly code: Pay2ErrorCode;
  constructor(code: Pay2ErrorCode, message: string = code) {
    super(code, message);
    this.code = code;
    this.name = 'Pay2Error';
  }
}

const fail = (code: Pay2ErrorCode, message?: string): never => {
  throw new Pay2Error(code, message);
};

export interface FileMeta {
  name: string;
  mime: string;
  size: number;
}

/** What the contract holds for the file (`get_file`), which the bytes are checked against. */
export interface Listing {
  fileId: string | Uint8Array;
  cipherHash: string | Uint8Array;
  /** Registered seller; an EVM address is accepted as API shorthand. */
  seller: string | Identity;
  /** NEAR v2 only: SHA256(header without its 65-byte trailer), read at finality. */
  publishedHeaderHash?: string | Uint8Array;
  /** Registered version, always 2. */
  pay2Version?: 2;
}

export interface PreviewPackage {
  v: 1;
  header: string;
  chunks: { index: number; key: string; data: string }[];
}

export const MAGIC = [0x50, 0x41, 0x59, 0x32]; // "PAY2"
export const FIXED = 54;
export const TAG = 16;
export const MAX_HEADER = 65536;
export const MAX_CHUNKS = 1024;
const MAX_PREVIEW = 65536;
export const MAX_META = 4096;
export const MAC = 32;
export const SIG = 65;
export const NEAR_CKD = 'near-ckd/v1';

const subtle = globalThis.crypto.subtle;
const utf8 = new TextEncoder();

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function int(value: number, bytes: 1 | 2 | 4 | 8): Bytes {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  if (bytes === 1) view.setUint8(0, value);
  else if (bytes === 2) view.setUint16(0, value);
  else if (bytes === 4) view.setUint32(0, value);
  else view.setBigUint64(0, BigInt(value));
  return out;
}

export const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);
export const copy = (b: Uint8Array): Bytes => new Uint8Array(b);
/** The input itself, never a copy: a hostile file must not cost memory before the limits pass. */
function view(b: Uint8Array): Bytes {
  if (!(b.buffer instanceof ArrayBuffer)) throw new TypeError('pass bytes over an ArrayBuffer');
  return b as Bytes;
}

export async function sha256(...parts: Uint8Array[]): Promise<Bytes> {
  const data = parts.length === 1 ? view(parts[0] as Uint8Array) : concat(...parts);
  return new Uint8Array(await subtle.digest('SHA-256', data));
}

/** Derives 32 bytes. `ikm` is raw bytes or an HKDF key, so an unwrapped `K` never leaves WebCrypto. */
async function hkdf(ikm: Uint8Array | CryptoKey, salt: Uint8Array, info: Uint8Array | string) {
  const key =
    ikm instanceof Uint8Array
      ? await subtle.importKey('raw', copy(ikm), 'HKDF', false, ['deriveBits'])
      : ikm;
  const bits = await subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: copy(salt),
      info: typeof info === 'string' ? utf8.encode(info) : copy(info),
    },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export const chunkKey = (K: Uint8Array | CryptoKey, fileId: Uint8Array, i: number) =>
  hkdf(K, fileId, concat(utf8.encode('annon/pay2/chunk'), int(i, 4)));

/** Spec 2: binds a revealable chunk key, since AES-GCM alone doesn't commit to its key. */
export const commitment = (k: Uint8Array) => sha256(utf8.encode('annon/pay2/key'), k);

function nonce(last: boolean): Bytes {
  const n = new Uint8Array(12);
  n[11] = last ? 1 : 0;
  return n;
}

async function gcm(mode: 'encrypt' | 'decrypt', key: Uint8Array, last: boolean, data: Uint8Array) {
  const k = await subtle.importKey('raw', copy(key), 'AES-GCM', false, [mode]);
  const out = await subtle[mode]({ name: 'AES-GCM', iv: nonce(last) }, k, view(data));
  return new Uint8Array(out);
}

export { gcm, hkdf };

export const wrapKeyFor = async (ckdSecret: Uint8Array, fileId: Uint8Array, usage: KeyUsage) => {
  if (ckdSecret.length !== 48) throw new TypeError('ckdSecret must be the 48-byte G1 point');
  const raw = await hkdf(ckdSecret, fileId, 'annon/pay2/near-ckd/v1');
  return subtle.importKey('raw', raw, 'AES-KW', false, [usage]);
};

/** Spec 3: binds the layout fields known before `register`, the commitments and the hash list. */
export const bodyHash = (
  h: Pick<
    Header,
    'chunkLog2' | 'fileId' | 'metaLen' | 'previewLen' | 'n' | 'commits' | 'hashes'
  > & { version?: 2 },
) =>
  sha256(
    utf8.encode('annon/pay2/body'),
    new Uint8Array([h.version ?? 2, h.chunkLog2]),
    h.fileId,
    int(h.metaLen, 2),
    int(h.previewLen, 4),
    int(h.n, 4),
    ...h.commits,
    ...h.hashes,
  );

function toBase64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function hexBytes(hex: string | Uint8Array, bytes = 32): Uint8Array {
  const h = typeof hex === 'string' ? hex.replace(/^0x/, '') : '';
  if (
    typeof hex !== 'string'
      ? hex.length !== bytes
      : !new RegExp(`^[0-9a-f]{${2 * bytes}}$`, 'i').test(h)
  ) {
    throw new TypeError(`expected ${bytes} bytes`);
  }
  return typeof hex === 'string'
    ? Uint8Array.from(h.match(/../g) ?? [], (x) => Number.parseInt(x, 16))
    : hex;
}

export { signedBy } from './evm.js';

function sellerAddress(seller: string): string {
  if (!/^0x[0-9a-f]{40}$/i.test(seller)) throw new TypeError('seller must be a 0x EVM address');
  return seller.toLowerCase();
}

// ---------- header ----------

interface Header {
  version: 2;
  authKind: 0 | 1 | 2;
  chunkLog2: number;
  fileId: Bytes;
  metaLen: number;
  previewLen: number;
  n: number;
  commits: Bytes[];
  hashes: Bytes[];
  prefixLen: number;
  headerLen: number;
  stanzas: { type: string; body: Bytes }[];
}

/** Spec 6, step 1. With `prefixOnly`, stops after the hash list (a preview package). */
export function parseHeader(b: Bytes, prefixOnly = false): Header {
  if (b.length < 4 || !MAGIC.every((x, i) => b[i] === x)) fail('bad_magic');
  if (b.length < FIXED) fail('bad_header', 'shorter than the fixed header');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[4] !== 2) fail('unsupported_version');
  const version = b[4] as 2;
  const authKind = b[7] ?? 0;
  const chunkLog2 = b[5] ?? 0;
  if (chunkLog2 < 16 || chunkLog2 > 24) fail('bad_chunk_size');
  const headerLen = dv.getUint32(8);
  if (headerLen > MAX_HEADER) fail('header_too_large');
  const stanzaCount = b[6] ?? 0;
  const metaLen = dv.getUint16(44);
  const previewLen = dv.getUint32(46);
  const n = dv.getUint32(50);
  const kc = previewLen > 0 ? 2 : 1;
  const prefixLen = FIXED + 32 * (kc + n);
  // A preview package has no stanzas, so it carries 0 in both stanza fields (spec 7).
  const stanzasOk = prefixOnly
    ? stanzaCount === 0 && headerLen === 0
    : stanzaCount >= 1 && stanzaCount <= 8 && headerLen >= prefixLen + MAC + SIG;
  if (
    !stanzasOk ||
    authKind > 2 ||
    metaLen < 256 ||
    metaLen > MAX_META ||
    metaLen % 256 !== 0 ||
    previewLen > MAX_PREVIEW ||
    n < 2 ||
    n > MAX_CHUNKS ||
    (previewLen > 0 && n < 3) ||
    b.length < (prefixOnly ? prefixLen : headerLen)
  ) {
    fail('bad_header');
  }
  const at32 = (i: number) => b.slice(FIXED + 32 * i, FIXED + 32 * (i + 1));
  const header: Header = {
    version,
    authKind: authKind as 0 | 1 | 2,
    chunkLog2,
    fileId: b.slice(12, 44),
    metaLen,
    previewLen,
    n,
    commits: Array.from({ length: kc }, (_, i) => at32(i)),
    hashes: Array.from({ length: n }, (_, i) => at32(kc + i)),
    prefixLen,
    headerLen,
    stanzas: [],
  };
  if (prefixOnly) return header;

  const end = headerLen - MAC - SIG;
  let at = prefixLen;
  for (let s = 0; s < stanzaCount; s++) {
    const typeLen = b[at] ?? 0;
    if (typeLen < 1 || typeLen > 32 || at + 3 + typeLen > end) fail('bad_stanza');
    const type = String.fromCharCode(...b.subarray(at + 1, at + 1 + typeLen));
    const bodyLen = dv.getUint16(at + 1 + typeLen);
    const bodyAt = at + 3 + typeLen;
    if (
      !/^[a-z0-9/.-]+$/.test(type) ||
      bodyLen > 1024 ||
      bodyAt + bodyLen > end ||
      header.stanzas.some((x) => x.type === type)
    ) {
      fail('bad_stanza');
    }
    const body = b.slice(bodyAt, bodyAt + bodyLen);
    if (type === NEAR_CKD && !nearCkd(body)) fail('bad_stanza');
    header.stanzas.push({ type, body });
    at = bodyAt + bodyLen;
  }
  if (at !== end) fail('bad_header', 'stanzas do not end at the MAC');
  return header;
}

/** Spec 5.1: `u8 len ‖ contractId ‖ wrapped K (40)`. */
export function nearCkd(body: Bytes): { contractId: string; wrapped: Bytes } | undefined {
  const len = body[0] ?? 0;
  if (len < 2 || len > 64 || body.length !== 1 + len + 40) return undefined;
  const contractId = String.fromCharCode(...body.subarray(1, 1 + len));
  if (!/^[a-z0-9._-]+$/.test(contractId)) return undefined;
  return { contractId, wrapped: body.slice(1 + len) };
}

/** Wire lengths of chunks 0 to n - 2 (spec 6, step 3); the last one is the remainder. */
function fixedLengths(h: Header): number[] {
  return Array.from({ length: h.n - 1 }, (_, i) => {
    if (i === 0) return h.metaLen + TAG;
    if (i === 1 && h.previewLen > 0) return h.previewLen + TAG;
    return 2 ** h.chunkLog2 + TAG;
  });
}

/** Spec 3: the chunk count a file of `size` bytes must have. */
export const chunkCount = (size: number, previewLen: number, chunkLog2: number) =>
  1 + (previewLen > 0 ? 1 : 0) + Math.max(1, Math.ceil((size - previewLen) / 2 ** chunkLog2));

/** Spec 3.1, and the checks against the header that need only the metadata. */
export function parseMeta(piece: Bytes, h: Header): FileMeta {
  const bad = (why: string) => fail('meta_invalid', why);
  const dv = new DataView(piece.buffer, piece.byteOffset, piece.byteLength);
  const nameLen = dv.getUint16(0);
  const mimeAt = 2 + nameLen;
  if (mimeAt + 1 > piece.length) bad('name runs past the metadata');
  const mimeLen = piece[mimeAt] ?? 0;
  const sizeAt = mimeAt + 1 + mimeLen;
  const end = sizeAt + 8;
  if (end > piece.length) bad('mime runs past the metadata');
  if (Math.ceil(end / 256) * 256 !== piece.length) bad('padding is not minimal');
  if (piece.subarray(end).some((x) => x !== 0)) bad('padding is not zero');
  let name = '';
  try {
    name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      piece.subarray(2, mimeAt),
    );
  } catch {
    bad('name is not UTF-8');
  }
  const mimeBytes = piece.subarray(mimeAt + 1, sizeAt);
  if (mimeBytes.some((x) => x < 0x20 || x > 0x7e)) bad('mime is not printable ASCII');
  const big = dv.getBigUint64(sizeAt);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) bad('size too large');
  const size = Number(big);
  if (h.previewLen > previewLimit(size)) bad('preview over the limit');
  if (h.n !== chunkCount(size, h.previewLen, h.chunkLog2)) bad('chunk count does not fit the size');
  return { name, mime: String.fromCharCode(...mimeBytes), size };
}

// ---------- open ----------

export interface Inspected {
  fileId: Bytes;
  /** Whether a `near-ckd/v1` stanza names the trusted contract; `open` needs one. */
  usable: boolean;
  /** The header, signature included: the bytes `info.header` serves (x402-annon.md section 7). */
  header: Bytes;
  /** `SHA256(header)`, which the download challenge names. */
  headerHash: Bytes;
}

/**
 * Spec 6, steps 1 to 4: needs no key, so a client can run it before paying when the bytes are
 * public. Throws `Pay2Error`.
 */
export async function inspect(
  file: Uint8Array,
  listing: Listing,
  contractId: string,
): Promise<Inspected> {
  return inspected(await checkPublic(view(file), listing, contractId), view(file), contractId);
}

/**
 * Spec 6, steps 1 to 3, on the header alone: what a client checks before paying when only the
 * header is public (x402-annon.md section 7). `header` must be exactly the header, with no body bytes.
 * It proves which bytes the buyer pays for, not that a host holds them. Throws `Pay2Error`.
 */
export async function inspectHeader(
  header: Uint8Array,
  listing: Listing,
  contractId: string,
): Promise<Inspected> {
  const b = view(header);
  const h = await checkSigned(b, listing, contractId);
  if (b.length !== h.headerLen) fail('bad_header', 'expected the header alone');
  return inspected(h, b, contractId);
}

const inspected = async (h: Header, b: Bytes, contractId: string): Promise<Inspected> => {
  const header = copy(b.subarray(0, h.headerLen));
  return {
    fileId: h.fileId,
    usable: h.stanzas.some(
      (s) => s.type === NEAR_CKD && nearCkd(s.body)?.contractId === contractId,
    ),
    header,
    headerHash: await sha256(header),
  };
};

/** Spec 6, steps 1 to 3. */
export async function checkSigned(b: Bytes, listing: Listing, contractId: string): Promise<Header> {
  const parsed = parseHeader(b);
  const version = listing.pay2Version ?? 2;
  if (parsed.version !== version) fail('unsupported_version');
  const h = await checkRegistration(parsed, listing);
  const seller =
    typeof listing.seller === 'string'
      ? parseIdentity({ kind: 'evm', id: sellerAddress(listing.seller) })
      : parseIdentity(listing.seller);
  const hash = await sha256(b.subarray(0, h.headerLen - SIG));
  const trailer = b.subarray(h.headerLen - SIG, h.headerLen);
  if (identityKind(seller) !== h.authKind) fail('seller_signature_invalid');
  if (seller.kind === 'near') {
    if (
      trailer.some((x) => x !== 0) ||
      listing.publishedHeaderHash === undefined ||
      !equal(hash, hexBytes(listing.publishedHeaderHash))
    )
      fail('seller_signature_invalid');
  } else {
    if (seller.kind === 'solana' && trailer[64] !== 0) fail('seller_signature_invalid');
    const sig = seller.kind === 'solana' ? trailer.subarray(0, 64) : trailer;
    if (
      !verifyAuthorization(
        seller,
        publishTextV2(contractId, canonicalHex(h.fileId), canonicalHex(hash)),
        { kind: seller.kind, sig: canonicalHex(sig) },
      )
    )
      fail('seller_signature_invalid');
  }
  return h;
}

async function checkPublic(b: Bytes, listing: Listing, contractId: string): Promise<Header> {
  const h = await checkSigned(b, listing, contractId);
  const lengths = fixedLengths(h);
  const body = b.subarray(h.headerLen);
  const last = body.length - lengths.reduce((s, x) => s + x, 0);
  if (last < TAG || last > 2 ** h.chunkLog2 + TAG) fail('bad_body_length');
  let at = 0;
  for (const [i, len] of [...lengths, last].entries()) {
    if (!equal(await sha256(body.subarray(at, at + len)), h.hashes[i] as Bytes)) {
      fail('chunk_hash_mismatch', `chunk ${i}`);
    }
    at += len;
  }
  return h;
}

/** Spec 6, step 2. */
async function checkRegistration(
  h: Header,
  listing: Pick<Listing, 'fileId' | 'cipherHash'>,
): Promise<Header> {
  if (!equal(h.fileId, hexBytes(listing.fileId))) fail('file_id_mismatch');
  if (!equal(await bodyHash(h), hexBytes(listing.cipherHash))) fail('cipher_hash_mismatch');
  return h;
}

export interface OpenOptions {
  /** The contract's registration of this file. */
  listing: Listing;
  /** The Annon contract the client trusts. Never taken from the file or a link. */
  contractId: string;
  /** Returns the 48-byte CKD point for this file; called only after steps 1 to 5 pass. */
  ckdSecret: (fileId: Uint8Array) => Promise<Uint8Array>;
}

/** Spec 6, all steps. Returns nothing unless every check passes. */
export async function open(
  file: Uint8Array,
  opts: OpenOptions,
): Promise<{ meta: FileMeta; data: Bytes }> {
  const b = view(file);
  const h = await checkPublic(b, opts.listing, opts.contractId);
  const stanza = h.stanzas
    .map((s) => (s.type === NEAR_CKD ? nearCkd(s.body) : undefined))
    .find((s) => s?.contractId === opts.contractId);
  if (!stanza) return fail('no_usable_stanza');

  const wrapKey = await wrapKeyFor(await opts.ckdSecret(h.fileId), h.fileId, 'unwrapKey');
  let K: CryptoKey;
  try {
    K = await subtle.unwrapKey('raw', stanza.wrapped, wrapKey, 'AES-KW', 'HKDF', false, [
      'deriveBits',
    ]);
  } catch {
    return fail('key_unwrap_failed');
  }

  const macKey = await subtle.importKey(
    'raw',
    await hkdf(K, h.fileId, 'annon/pay2/header'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const macAt = h.headerLen - MAC - SIG;
  const mac = b.subarray(macAt, macAt + MAC);
  if (!(await subtle.verify('HMAC', macKey, mac, b.subarray(0, macAt)))) {
    fail('header_mac_invalid');
  }

  const lengths = fixedLengths(h);
  const body = b.subarray(h.headerLen);
  lengths.push(body.length - lengths.reduce((s, x) => s + x, 0));
  const wire: Bytes[] = [];
  let at = 0;
  for (const len of lengths) {
    wire.push(body.subarray(at, at + len));
    at += len;
  }
  const decrypt = async (i: number) => {
    const k = await chunkKey(K, h.fileId, i);
    const c = h.commits[i];
    if (c && !equal(await commitment(k), c)) fail('chunk_invalid', `chunk ${i} key commitment`);
    try {
      return await gcm('decrypt', k, i === h.n - 1, wire[i] as Bytes);
    } catch {
      return fail('chunk_invalid', `chunk ${i}`);
    }
  };

  const meta = parseMeta(await decrypt(0), h);
  if (lengths.slice(1).reduce((s, x) => s + x - TAG, 0) !== meta.size) {
    fail('meta_invalid', 'chunk lengths do not add up to the size');
  }
  const pieces: Bytes[] = [];
  for (let i = 1; i < h.n; i++) pieces.push(await decrypt(i));
  return { meta, data: concat(...pieces) };
}

// ---------- seal ----------

export interface SealOptions {
  /** Select the registered seller authentication kind before sealing. Version is always 2. */
  version?: 2;
  authKind?: 0 | 1 | 2;
  fileId: Uint8Array;
  name: string;
  mime: string;
  /** Bytes of the file shown as a verified preview; 0 (default) means none. Spec 3 caps it. */
  previewLen?: number;
  /** Spec 3: 22 (4 MiB) unless the file needs more than 1024 chunks. */
  chunkLog2?: number;
}

export interface FinishOptions {
  contractId: string;
  ckdSecret: Uint8Array;
  seller: string | Identity;
  /** EVM: EIP-191; Solana: Wallet Standard result including the exact signed message. */
  sign?: (
    text: string,
  ) => Promise<string | Uint8Array | { signature: Uint8Array; signedMessage: Uint8Array }>;
}

/** @internal Shared by buffered and streaming encoders. */
export function sealAuth(opts: SealOptions): { version: 2; authKind: 0 | 1 | 2 } {
  const version = opts.version ?? 2;
  const authKind = opts.authKind ?? 0;
  if (version !== 2 || ![0, 1, 2].includes(authKind))
    throw new TypeError('invalid PAY2 version/auth kind');
  return { version, authKind };
}

/** @internal Build and check the fixed-width authentication trailer. */
export async function finishTrailer(
  version: 2,
  authKind: 0 | 1 | 2,
  opts: FinishOptions,
  fileId: Uint8Array,
  headerHash: Uint8Array,
): Promise<Uint8Array> {
  const seller =
    typeof opts.seller === 'string'
      ? parseIdentity({ kind: 'evm', id: sellerAddress(opts.seller) })
      : parseIdentity(opts.seller);
  if (identityKind(seller) !== authKind)
    throw new TypeError('seller identity does not match auth kind');
  if (seller.kind === 'near') return new Uint8Array(SIG);
  if (!opts.sign) throw new TypeError('seller signature required');
  if (version !== 2) throw new TypeError('unsupported PAY2 version');
  const text = publishTextV2(opts.contractId, canonicalHex(fileId), canonicalHex(headerHash));
  const result = await opts.sign(text);
  if (seller.kind === 'solana') {
    if (typeof result === 'string' || result instanceof Uint8Array)
      throw new TypeError('Solana wallet must return signed bytes');
    const auth = solanaWalletAuth(seller, text, result);
    return concat(hexBytes(auth.sig, 64), new Uint8Array([0]));
  }
  if (typeof result !== 'string' && !(result instanceof Uint8Array))
    throw new TypeError('expected EVM signature bytes');
  const sig = hexBytes(result, SIG);
  if (!signedBy(text, sig, seller.id)) throw new Error('the signature is not from the seller');
  return sig;
}

export interface Sealed {
  fileId: Bytes;
  /** Goes into `register` as `cipher_hash`. */
  cipherHash: Bytes;
  /**
   * Once `register` has returned the CKD point: writes the `near-ckd/v1` stanza and the MAC, then
   * asks the seller's wallet to sign `publishText` (EIP-191) and checks the signature.
   */
  finish(opts: FinishOptions): Promise<Bytes>;
  /**
   * The preview package (spec 7), after `finish`. Publishes those chunks' keys: only when the
   * seller asks.
   */
  preview(show: { meta?: boolean; data?: boolean }): Promise<PreviewPackage>;
}

/** Encrypts a file under a fresh random key. */
export function seal(data: Uint8Array, opts: SealOptions): Promise<Sealed> {
  return sealWithKey(globalThis.crypto.getRandomValues(new Uint8Array(32)), data, opts);
}

/** Encrypts with a caller-supplied fresh key, including deterministic replay. Never reuse it for another file. */
export async function sealWithKey(
  K: Uint8Array,
  data: Uint8Array,
  opts: SealOptions,
): Promise<Sealed> {
  if (opts.fileId.length !== 32 || K.length !== 32)
    throw new TypeError('fileId and K are 32 bytes');
  const { version, authKind } = sealAuth(opts);
  const fileId = copy(opts.fileId);
  const previewLen = opts.previewLen ?? 0;
  if (
    !Number.isSafeInteger(previewLen) ||
    previewLen < 0 ||
    previewLen > previewLimit(data.length)
  ) {
    throw new RangeError(`previewLen must be 0 to ${previewLimit(data.length)}`);
  }
  let chunkLog2 = opts.chunkLog2 ?? 22;
  while (
    opts.chunkLog2 === undefined &&
    chunkLog2 < 24 &&
    chunkCount(data.length, previewLen, chunkLog2) > MAX_CHUNKS
  ) {
    chunkLog2++;
  }
  if (!Number.isInteger(chunkLog2) || chunkLog2 < 16 || chunkLog2 > 24) {
    throw new RangeError('chunkLog2 must be an integer from 16 to 24');
  }
  if (chunkCount(data.length, previewLen, chunkLog2) > MAX_CHUNKS) {
    throw new RangeError('file too large for PAY2');
  }
  const C = 2 ** chunkLog2;

  const name = utf8.encode(opts.name);
  if (!/^[\x20-\x7e]{0,255}$/.test(opts.mime)) throw new RangeError('mime must be printable ASCII');
  const fields = concat(
    int(name.length, 2),
    name,
    int(opts.mime.length, 1),
    utf8.encode(opts.mime),
    int(data.length, 8),
  );
  const metaLen = Math.ceil(fields.length / 256) * 256;
  if (metaLen > MAX_META) throw new RangeError('name too long');
  const pieces: Uint8Array[] = [concat(fields, new Uint8Array(metaLen - fields.length))];
  if (previewLen > 0) pieces.push(data.subarray(0, previewLen));
  const rest = data.subarray(previewLen);
  for (let at = 0; at < rest.length || at === 0; at += C) pieces.push(rest.subarray(at, at + C));

  const n = pieces.length;
  const keys = await Promise.all(pieces.map((_, i) => chunkKey(K, fileId, i)));
  const commits = await Promise.all(
    keys.slice(0, previewLen > 0 ? 2 : 1).map((k) => commitment(k)),
  );
  const wire = await Promise.all(
    pieces.map((p, i) => gcm('encrypt', keys[i] as Bytes, i === n - 1, p)),
  );
  const hashes = await Promise.all(wire.map((w) => sha256(w)));
  const prefix = concat(
    new Uint8Array(MAGIC),
    new Uint8Array([version, chunkLog2, 1, authKind]),
    new Uint8Array(4), // headerLen, set in finish
    fileId,
    int(metaLen, 2),
    int(previewLen, 4),
    int(n, 4),
    ...commits,
    ...hashes,
  );

  let finished: Bytes | undefined;
  return {
    fileId,
    cipherHash: await bodyHash({
      version,
      chunkLog2,
      fileId,
      metaLen,
      previewLen,
      n,
      commits,
      hashes,
    }),
    async finish(finishOpts) {
      const { contractId, ckdSecret } = finishOpts;
      account(contractId);
      const kw = await wrapKeyFor(ckdSecret, fileId, 'wrapKey');
      const fileKey = await subtle.importKey('raw', copy(K), 'AES-GCM', true, ['encrypt']);
      const wrapped = new Uint8Array(await subtle.wrapKey('raw', fileKey, kw, 'AES-KW'));
      const type = utf8.encode(NEAR_CKD);
      const body = concat(new Uint8Array([contractId.length]), utf8.encode(contractId), wrapped);
      const stanza = concat(new Uint8Array([type.length]), type, int(body.length, 2), body);
      const header = concat(prefix, stanza);
      new DataView(header.buffer).setUint32(8, header.length + MAC + SIG);
      const macKey = await subtle.importKey(
        'raw',
        await hkdf(K, fileId, 'annon/pay2/header'),
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
      finished = header;
      return concat(header, mac, sig, ...wire);
    },
    async preview(show) {
      if (!finished) throw new Error('call finish first: the preview carries the final header');
      if (show.data && previewLen === 0) throw new RangeError('sealed without a preview');
      const indexes = [...(show.meta ? [0] : []), ...(show.data ? [1] : [])];
      return {
        v: 1,
        header: toBase64(previewPrefix(finished.subarray(0, prefix.length))),
        chunks: indexes.map((i) => ({
          index: i,
          key: toBase64(keys[i] as Bytes),
          data: toBase64(wire[i] as Bytes),
        })),
      };
    },
  };
}

/** Spec 7: the header up to the hash list, with stanza count and `headerLen` set to 0. */
function previewPrefix(header: Uint8Array): Bytes {
  const p = copy(header);
  p[6] = 0;
  p.fill(0, 8, 12);
  return p;
}

/** Spec 3: at most 64 KiB and a tenth of the file. */
export const previewLimit = (size: number) => Math.min(MAX_PREVIEW, Math.floor(size / 10));
