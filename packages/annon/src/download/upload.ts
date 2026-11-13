/** Seller-authorized encrypted hosting. No plaintext or file key is sent to the host. */
import { base64urlnopad } from '@scure/base';
import { bodyHash, chunkCount, previewLimit, sha256 } from '../envelope/pay2.js';
import { AnnonError, type AnnonErrorCode, isAnnonErrorCode, toPublicError } from '../errors.js';
import type { NearSignedMessage } from '../near/nep413.js';
import { verifyNearMessage } from '../near/nep413.js';
import { type HostingReservation, parseReservation } from '../relay/reservation.js';
import { account, bytes, exactKeys, hex, network } from '../settle-near/codec.js';
import {
  type Authorization,
  type Identity,
  identityJson,
  identityText,
  parseIdentity,
  verifyAuthorization,
} from '../settle-near/identity.js';
import { type SettlementAssets, type Terms, termsHash } from '../settle-near/terms.js';

export interface UploadIntent {
  network: string;
  contract: string;
  seller: Identity;
  fileId: string;
  cipherHash: string;
  termsHash: string;
  byteSize: number;
  plaintextSize: number;
  headerSize: number;
  hostOrigin: string;
  metadataHash: string;
  nonce: string;
  expiresAt: number;
}
export interface UploadManifest {
  version: 2;
  chunkLog2: number;
  metaLen: number;
  previewLen: number;
  n: number;
  keyCommitments: string[];
  chunkHashes: string[];
}
export interface UploadMetadata {
  filename: string;
  title: string;
  description: string;
}
export type UploadAuth = Authorization | (NearSignedMessage & { kind: 'near' });
export interface UploadAuthorization {
  intent: UploadIntent;
  auth: UploadAuth;
}
export interface UploadRequest extends UploadAuthorization {
  terms: Terms;
  manifest: UploadManifest;
  metadata: UploadMetadata;
}
export interface UploadCreated {
  uploadId: string;
  state: 'receiving';
  expiresAt: number;
  bodyUrl: string;
  headerUrl: string;
}
export interface UploadReserved {
  uploadId: string;
  state: 'reserved';
  reservation: HostingReservation;
}
export interface UploadPublished {
  fileId: string;
  url: string;
  header: string;
  expiresAt: number | null;
}
export interface UploadBaseSplit {
  state: 'pending' | 'ready';
  address: string;
  kind: 'push';
  salt: string;
  txHash: string | null;
}
export interface UploadBaseSplitRequest {
  kind: 'push';
  salt: string;
}
export interface UploadBaseSplitResult {
  baseSplit: UploadBaseSplit | null;
}
export type UploadStatus = (
  | UploadCreated
  | UploadReserved
  | { uploadId: string; state: 'published'; result: UploadPublished }
) &
  UploadBaseSplitResult;
export const uploadText = (i: UploadIntent): string =>
  [
    'Annon: reserve encrypted file hosting',
    `network: ${i.network}`,
    `contract: ${i.contract}`,
    `seller: ${identityText(i.seller)}`,
    `file: ${i.fileId}`,
    `cipher: ${i.cipherHash}`,
    `terms: ${i.termsHash}`,
    `bytes: ${i.byteSize}`,
    `plaintext bytes: ${i.plaintextSize}`,
    `header bytes: ${i.headerSize}`,
    `host: ${i.hostOrigin}`,
    `metadata: ${i.metadataHash}`,
    `nonce: ${i.nonce}`,
    `expires: ${i.expiresAt}`,
  ].join('\n');
const utf8 = new TextEncoder();
export function uploadOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password)
    throw new AnnonError('bad_request', 'Invalid upload origin.');
  return value;
}
export function normalizeMetadata(input: unknown): UploadMetadata {
  exactKeys(input, ['filename', 'title', 'description']);
  const out = {} as UploadMetadata;
  for (const [key, max] of [
    ['filename', 255],
    ['title', 120],
    ['description', 500],
  ] as const) {
    const raw = input[key];
    if (typeof raw !== 'string') throw new AnnonError('bad_request', 'Invalid upload metadata.');
    const value = raw.normalize('NFC');
    if (
      /[\p{Cc}\p{Cs}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) ||
      utf8.encode(value).length > max ||
      (key !== 'description' && !value)
    )
      throw new AnnonError('bad_request', 'Invalid upload metadata.');
    out[key] = value;
  }
  if (/[\\/]/.test(out.filename) || out.filename === '.' || out.filename === '..')
    throw new AnnonError('bad_request', 'Invalid upload filename.');
  return out;
}
export async function metadataHash(metadata: UploadMetadata): Promise<string> {
  const m = normalizeMetadata(metadata);
  return hex(await sha256(utf8.encode(JSON.stringify([m.filename, m.title, m.description]))));
}
export function parseUploadIntent(input: unknown): UploadIntent {
  exactKeys(input, [
    'network',
    'contract',
    'seller',
    'fileId',
    'cipherHash',
    'termsHash',
    'byteSize',
    'plaintextSize',
    'headerSize',
    'hostOrigin',
    'metadataHash',
    'nonce',
    'expiresAt',
  ]);
  const i = input as unknown as UploadIntent;
  network(i.network);
  account(i.contract);
  uploadOrigin(i.hostOrigin);
  const seller = parseIdentity(i.seller);
  if (seller.kind !== i.seller.kind || seller.id !== i.seller.id)
    throw new AnnonError('bad_request', 'Noncanonical seller.');
  for (const k of ['fileId', 'cipherHash', 'termsHash', 'metadataHash', 'nonce'] as const)
    bytes(i[k], 32);
  for (const k of ['byteSize', 'plaintextSize', 'headerSize', 'expiresAt'] as const)
    if (!Number.isSafeInteger(i[k]) || i[k] < 0)
      throw new AnnonError('bad_request', 'Invalid upload size or time.');
  if (
    i.byteSize <= i.headerSize ||
    i.headerSize < 1 ||
    i.headerSize > 65536 ||
    i.plaintextSize > 50_000_000 ||
    i.byteSize > 50_086_016
  )
    throw new AnnonError('bad_request', 'Invalid upload size.');
  return { ...structuredClone(i), seller };
}
export function parseUploadAuth(input: unknown): UploadAuth {
  if (!input || typeof input !== 'object')
    throw new AnnonError('bad_request', 'Invalid upload authorization.');
  if ('kind' in input && input.kind === 'near') {
    exactKeys(input, ['kind', 'accountId', 'publicKey', 'signature']);
    const near = input as unknown as NearSignedMessage;
    if (
      typeof near.accountId !== 'string' ||
      typeof near.publicKey !== 'string' ||
      typeof near.signature !== 'string'
    )
      throw new AnnonError('bad_request', 'Invalid upload authorization.');
  } else {
    exactKeys(input, ['kind', 'sig']);
    if (input.kind !== 'evm' && input.kind !== 'solana')
      throw new AnnonError('bad_request', 'Invalid upload authorization.');
    bytes(input.sig as string, input.kind === 'evm' ? 65 : 64);
  }
  return structuredClone(input) as UploadAuth;
}
export function parseUpload(input: unknown): UploadRequest {
  exactKeys(input, ['intent', 'terms', 'manifest', 'metadata', 'auth']);
  const intent = parseUploadIntent(input.intent);
  exactKeys(input.manifest, [
    'version',
    'chunkLog2',
    'metaLen',
    'previewLen',
    'n',
    'keyCommitments',
    'chunkHashes',
  ]);
  const m = input.manifest as unknown as UploadManifest;
  if (
    ![m.chunkLog2, m.metaLen, m.previewLen, m.n].every(Number.isSafeInteger) ||
    m.version !== 2 ||
    m.chunkLog2 < 16 ||
    m.chunkLog2 > 24 ||
    m.metaLen < 256 ||
    m.metaLen > 4096 ||
    m.metaLen % 256 !== 0 ||
    m.previewLen < 0 ||
    m.previewLen > previewLimit(intent.plaintextSize) ||
    m.n < 2 ||
    m.n > 1024 ||
    m.n !== chunkCount(intent.plaintextSize, m.previewLen, m.chunkLog2) ||
    !Array.isArray(m.keyCommitments) ||
    m.keyCommitments.length !== (m.previewLen > 0 ? 2 : 1) ||
    !Array.isArray(m.chunkHashes) ||
    m.chunkHashes.length !== m.n
  )
    throw new AnnonError('bad_request', 'Invalid upload manifest.');
  for (const h of [...m.keyCommitments, ...m.chunkHashes]) bytes(h, 32);
  if (
    intent.headerSize !==
      206 + utf8.encode(intent.contract).length + 32 * (m.keyCommitments.length + m.n) ||
    intent.byteSize - intent.headerSize !== intent.plaintextSize + m.metaLen + 16 * m.n
  )
    throw new AnnonError('bad_request', 'Invalid upload framing.');
  return {
    intent,
    terms: structuredClone(input.terms) as Terms,
    manifest: structuredClone(m),
    metadata: normalizeMetadata(input.metadata),
    auth: parseUploadAuth(input.auth),
  };
}
export async function verifyUploadAuthorization(
  a: UploadAuthorization,
  o: {
    network: string;
    contract: string;
    hostOrigin: string;
    now: number;
    nearRpc: string;
    authSeconds?: number;
  },
): Promise<void> {
  const i = parseUploadIntent(a.intent),
    auth = parseUploadAuth(a.auth);
  if (
    i.network !== o.network ||
    i.contract !== o.contract ||
    i.hostOrigin !== o.hostOrigin ||
    i.expiresAt <= o.now ||
    i.expiresAt > o.now + (o.authSeconds ?? 600) ||
    auth.kind !== i.seller.kind
  )
    throw new AnnonError('bad_request', 'Invalid upload authorization.');
  if (auth.kind === 'near') {
    await verifyNearMessage(
      i.seller.id,
      { message: uploadText(i), recipient: i.hostOrigin, nonce: bytes(i.nonce, 32) },
      auth,
      o.nearRpc,
    );
  } else if (!verifyAuthorization(i.seller, uploadText(i), auth))
    throw new AnnonError('bad_request', 'Invalid upload signature.');
}
export async function verifyUpload(
  input: UploadRequest,
  o: Parameters<typeof verifyUploadAuthorization>[1] & { assets?: SettlementAssets },
): Promise<void> {
  const r = parseUpload(input),
    i = r.intent,
    t = r.terms;
  if (
    t.network !== i.network ||
    t.contract !== i.contract ||
    t.file_id !== i.fileId ||
    t.cipher_hash !== i.cipherHash ||
    t.pay2_version !== 2 ||
    identityJson(t.seller) !== identityJson(i.seller) ||
    termsHash(t, o.assets) !== i.termsHash ||
    (await metadataHash(r.metadata)) !== i.metadataHash ||
    hex(
      await bodyHash({
        ...r.manifest,
        fileId: bytes(i.fileId, 32),
        commits: r.manifest.keyCommitments.map((h) => bytes(h, 32)),
        hashes: r.manifest.chunkHashes.map((h) => bytes(h, 32)),
      }),
    ) !== i.cipherHash
  )
    throw new AnnonError('bad_request', 'Invalid upload binding.');
  await verifyUploadAuthorization(r, o);
}
export function encodeUploadAuthorization(input: UploadAuthorization): string {
  const value = base64urlnopad.encode(
    utf8.encode(
      JSON.stringify({
        intent: parseUploadIntent(input.intent),
        auth: parseUploadAuth(input.auth),
      }),
    ),
  );
  if (value.length > 8192)
    throw new AnnonError('bad_request', 'Upload authorization is too large.');
  return value;
}
export function decodeUploadAuthorization(value: string, max = 8192): UploadAuthorization {
  if (value.length > max || !/^[A-Za-z0-9_-]+$/.test(value))
    throw new AnnonError('bad_request', 'Invalid upload authorization.');
  const a = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(base64urlnopad.decode(value)),
  );
  exactKeys(a, ['intent', 'auth']);
  return { intent: parseUploadIntent(a.intent), auth: parseUploadAuth(a.auth) };
}

export type UploadErrorCode =
  | 'budget'
  | 'disabled'
  | 'settlement_pending'
  | 'route_unavailable'
  | 'bad_request'
  | 'bad_signature'
  | 'too_large'
  | 'upload_expired'
  | 'upload_conflict'
  | 'upload_incomplete'
  | 'host_capacity'
  | 'cipher_hash_mismatch'
  | 'unknown_file'
  | 'file_invalid'
  | 'taken_down'
  | 'sales_stopped'
  | 'rate_limited'
  | 'unavailable'
  | 'operation_failed';
/** HTTP failures use the shared error model and retain only checked retry evidence. */
export type UploadResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: AnnonError & { retryAfterSeconds?: number } };
const failure = (code: AnnonErrorCode, retryAfterSeconds?: number) => {
  const safe = toPublicError({ code, retryAfterSeconds });
  return {
    ok: false as const,
    error: Object.assign(
      new AnnonError(code),
      safe.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: safe.retryAfterSeconds },
    ),
  };
};
function createdResponse(value: unknown, origin: string, expectedId?: string): UploadCreated {
  exactKeys(value, ['uploadId', 'state', 'expiresAt', 'bodyUrl', 'headerUrl']);
  const v = value as unknown as UploadCreated;
  if (
    !/^[a-f0-9]{64}$/.test(v.uploadId) ||
    (expectedId !== undefined && v.uploadId !== expectedId) ||
    v.state !== 'receiving' ||
    !Number.isSafeInteger(v.expiresAt) ||
    v.expiresAt < 0 ||
    v.bodyUrl !== `${origin}/v1/uploads/${v.uploadId}/body` ||
    v.headerUrl !== `${origin}/v1/uploads/${v.uploadId}/header`
  )
    throw new AnnonError('bad_request', 'Invalid upload response.');
  return v;
}
function reservedResponse(value: unknown, id: string, intent: UploadIntent): UploadReserved {
  exactKeys(value, ['uploadId', 'state', 'reservation']);
  const v = value as unknown as UploadReserved;
  const r = parseReservation(v.reservation);
  if (
    v.uploadId !== id ||
    v.state !== 'reserved' ||
    r.uploadId !== id ||
    identityJson(r.seller) !== identityJson(intent.seller)
  )
    throw new AnnonError('bad_request', 'Invalid upload response.');
  for (const key of [
    'network',
    'contract',
    'fileId',
    'termsHash',
    'cipherHash',
    'byteSize',
    'plaintextSize',
    'headerSize',
    'metadataHash',
    'hostOrigin',
  ] as const)
    if (r[key] !== intent[key]) throw new AnnonError('bad_request', 'Invalid upload response.');
  return { ...v, reservation: r };
}
function publishedResponse(value: unknown, intent: UploadIntent): UploadPublished {
  exactKeys(value, ['fileId', 'url', 'header', 'expiresAt']);
  const v = value as unknown as UploadPublished;
  const url = `${intent.hostOrigin}/f/${intent.fileId.slice(2)}`;
  if (
    v.fileId !== intent.fileId ||
    v.url !== url ||
    v.header !== `${url}/header` ||
    (v.expiresAt !== null && (!Number.isSafeInteger(v.expiresAt) || v.expiresAt < 0))
  )
    throw new AnnonError('bad_request', 'Invalid upload response.');
  return v;
}
function splitResponse(value: unknown): UploadBaseSplit | null {
  if (value === null) return null;
  exactKeys(value, ['state', 'address', 'kind', 'salt', 'txHash']);
  if (
    (value.state !== 'pending' && value.state !== 'ready') ||
    typeof value.address !== 'string' ||
    !/^0x[0-9a-fA-F]{40}$/.test(value.address) ||
    value.kind !== 'push' ||
    value.salt !== `0x${'00'.repeat(32)}` ||
    (value.txHash !== null && (typeof value.txHash !== 'string' || !value.txHash))
  )
    throw new AnnonError('bad_request');
  return value as unknown as UploadBaseSplit;
}
function statusResponse(value: unknown, id: string, intent: UploadIntent): UploadStatus {
  if (!value || typeof value !== 'object' || !('baseSplit' in value))
    throw new AnnonError('bad_request');
  const { baseSplit, ...state } = value;
  const split = splitResponse(baseSplit);
  if ('state' in state && state.state === 'receiving')
    return { ...createdResponse(state, intent.hostOrigin, id), baseSplit: split };
  if ('state' in state && state.state === 'reserved')
    return { ...reservedResponse(state, id, intent), baseSplit: split };
  exactKeys(state, ['uploadId', 'state', 'result']);
  if (state.uploadId !== id || state.state !== 'published') throw new AnnonError('bad_request');
  return {
    uploadId: id,
    state: 'published',
    result: publishedResponse(state.result, intent),
    baseSplit: split,
  };
}
export class UploadClient {
  readonly origin: string;
  private readonly fetcher: typeof fetch;
  constructor(origin: string, options: { fetch?: typeof fetch } = {}) {
    this.origin = uploadOrigin(origin);
    this.fetcher = options.fetch ?? fetch;
  }
  private async request<T>(
    path: string,
    method: string,
    body?: BodyInit,
    authorization?: UploadAuthorization,
    validate?: (value: unknown, status: number) => T,
  ): Promise<UploadResult<T>> {
    try {
      return await this.requestJson(path, method, body, authorization, validate);
    } catch {
      return failure('operation_failed');
    }
  }
  private async requestJson<T>(
    path: string,
    method: string,
    body?: BodyInit,
    authorization?: UploadAuthorization,
    validate?: (value: unknown, status: number) => T,
  ): Promise<UploadResult<T>> {
    const response = await this.fetcher(`${this.origin}${path}`, {
      method,
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(method === 'PUT' ? 1800000 : 5000),
      headers: {
        ...(body === undefined
          ? {}
          : { 'Content-Type': method === 'PUT' ? 'application/octet-stream' : 'application/json' }),
        ...(authorization
          ? { 'Annon-Upload-Authorization': encodeUploadAuthorization(authorization) }
          : {}),
      },
      ...(body === undefined ? {} : { body }),
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    });
    if (
      response.redirected ||
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
        'application/json'
    ) {
      await response.body?.cancel();
      return failure('operation_failed');
    }
    const reader = response.body?.getReader();
    if (!reader) return failure('operation_failed');
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 131072) throw new AnnonError('bad_request', 'Upload response is too large.');
        parts.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      bytes.set(p, at);
      at += p.length;
    }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (response.ok) {
      try {
        if (!validate) throw new AnnonError('bad_request');
        return { ok: true, value: validate(value, response.status) };
      } catch {
        return failure('operation_failed');
      }
    }
    const code = isAnnonErrorCode(value?.error) ? value.error : 'operation_failed';
    return failure(code, code === 'operation_failed' ? undefined : value.retryAfterSeconds);
  }

  private path(id: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new AnnonError('bad_request', 'Invalid upload ID.');
    return `/v1/uploads/${id}`;
  }
  create(request: UploadRequest): Promise<UploadResult<UploadCreated | UploadStatus>> {
    return this.request(
      '/v1/uploads',
      'POST',
      JSON.stringify(parseUpload(request)),
      undefined,
      (value) =>
        value && typeof value === 'object' && 'baseSplit' in value
          ? statusResponse(value, (value as UploadStatus).uploadId, request.intent)
          : createdResponse(value, this.origin),
    );
  }
  async body(
    id: string,
    auth: UploadAuthorization,
    body: ReadableStream<Uint8Array> | Blob,
  ): Promise<UploadResult<UploadReserved>> {
    return this.request(`${this.path(id)}/body`, 'PUT', body, auth, (value) =>
      reservedResponse(value, id, auth.intent),
    );
  }
  async header(
    id: string,
    auth: UploadAuthorization,
    header: Uint8Array<ArrayBuffer>,
  ): Promise<UploadResult<UploadPublished>> {
    return this.request(`${this.path(id)}/header`, 'PUT', header, auth, (value) =>
      publishedResponse(value, auth.intent),
    );
  }
  async status(id: string, auth: UploadAuthorization): Promise<UploadResult<UploadStatus>> {
    return this.request(this.path(id), 'GET', undefined, auth, (value) =>
      statusResponse(value, id, auth.intent),
    );
  }
  async baseSplit(
    id: string,
    auth: UploadAuthorization,
    input: UploadBaseSplitRequest,
  ): Promise<UploadResult<UploadBaseSplitResult>> {
    exactKeys(input, ['kind', 'salt']);
    if (input.kind !== 'push' || input.salt !== `0x${'00'.repeat(32)}`)
      throw new AnnonError('bad_request');
    return this.request(
      `${this.path(id)}/base-split`,
      'POST',
      JSON.stringify(input),
      auth,
      (value, status) => {
        exactKeys(value, ['baseSplit']);
        const baseSplit = splitResponse(value.baseSplit);
        if (baseSplit && status !== (baseSplit.state === 'pending' ? 202 : 200))
          throw new AnnonError('bad_request');
        return { baseSplit };
      },
    );
  }
}
