/** Verify host attestations against a fixed pinned origin and Ed25519 key. */
import { ed25519 } from '@noble/curves/ed25519.js';
import { base64urlnopad } from '@scure/base';
import { bytes, exactKeys } from '../settle-near/codec.js';
import { type Identity, identityJson, identityText } from '../settle-near/identity.js';
import { type Terms, termsHash } from '../settle-near/terms.js';

export interface HostingReservation {
  v: 1;
  uploadId: string;
  network: string;
  contract: string;
  fileId: string;
  termsHash: string;
  seller: Identity;
  cipherHash: string;
  byteSize: number;
  plaintextSize: number;
  headerSize: number;
  metadataHash: string;
  hostOrigin: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}
export const reservationText = (r: Omit<HostingReservation, 'signature'>): string =>
  [
    'Annon: hosting reservation v1',
    `upload: ${r.uploadId}`,
    `network: ${r.network}`,
    `contract: ${r.contract}`,
    `file: ${r.fileId}`,
    `terms: ${r.termsHash}`,
    `seller: ${identityText(r.seller)}`,
    `cipher: ${r.cipherHash}`,
    `bytes: ${r.byteSize}`,
    `plaintext bytes: ${r.plaintextSize}`,
    `header bytes: ${r.headerSize}`,
    `metadata: ${r.metadataHash}`,
    `host: ${r.hostOrigin}`,
    `issued: ${r.issuedAt}`,
    `expires: ${r.expiresAt}`,
  ].join('\n');

export function parseReservation(input: unknown): HostingReservation {
  exactKeys(input, [
    'v',
    'uploadId',
    'network',
    'contract',
    'fileId',
    'termsHash',
    'seller',
    'cipherHash',
    'byteSize',
    'plaintextSize',
    'headerSize',
    'metadataHash',
    'hostOrigin',
    'issuedAt',
    'expiresAt',
    'signature',
  ]);
  const r = input as unknown as HostingReservation;
  if (
    r.v !== 1 ||
    !/^[0-9a-f]{64}$/.test(r.uploadId) ||
    typeof r.signature !== 'string' ||
    !/^[A-Za-z0-9_-]{86}$/.test(r.signature)
  )
    throw new TypeError('Invalid hosting reservation.');
  for (const k of ['fileId', 'termsHash', 'cipherHash', 'metadataHash'] as const) bytes(r[k], 32);
  for (const k of ['byteSize', 'plaintextSize', 'headerSize', 'issuedAt', 'expiresAt'] as const)
    if (!Number.isSafeInteger(r[k]) || r[k] < 0)
      throw new TypeError('Invalid hosting reservation.');
  const origin = new URL(r.hostOrigin);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== r.hostOrigin ||
    r.byteSize < 1 ||
    r.byteSize > 50086016 ||
    r.plaintextSize > 50000000 ||
    r.headerSize < 1 ||
    r.headerSize > 65536 ||
    r.byteSize <= r.headerSize ||
    r.expiresAt !== r.issuedAt + 600
  )
    throw new TypeError('Invalid hosting reservation.');
  identityText(r.seller);
  return r;
}
export async function verifyReservation(
  input: unknown,
  terms: Terms,
  o: {
    hostOrigin: string;
    publicKey: string;
    now: number;
    fetch?: typeof fetch;
    maxFileBytes?: number;
  },
): Promise<HostingReservation> {
  const r = parseReservation(input);
  if (
    r.plaintextSize > (o.maxFileBytes ?? 50000000) ||
    r.hostOrigin !== o.hostOrigin ||
    r.network !== terms.network ||
    r.contract !== terms.contract ||
    r.fileId !== terms.file_id ||
    r.cipherHash !== terms.cipher_hash ||
    r.termsHash !==
      termsHash(terms, {
        nearUsdc: terms.near.token,
        ...(terms.base ? { baseUsdc: terms.base.usdc } : {}),
      }) ||
    identityJson(r.seller) !== identityJson(terms.seller) ||
    r.issuedAt > o.now ||
    r.expiresAt <= o.now ||
    !/^[0-9a-f]{64}$/.test(o.publicKey) ||
    !ed25519.verify(
      base64urlnopad.decode(r.signature),
      new TextEncoder().encode(reservationText(r)),
      bytes(`0x${o.publicKey}`, 32),
      { zip215: false },
    )
  )
    throw new TypeError('Invalid hosting reservation.');
  const response = await (o.fetch ?? fetch)(
    `${o.hostOrigin}/v1/upload-reservations/${r.uploadId}`,
    {
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    },
  );
  if (
    !response.ok ||
    response.redirected ||
    response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
  )
    throw new TypeError('Hosting reservation unavailable.');
  const reader = response.body?.getReader();
  if (!reader) throw new TypeError('Hosting reservation unavailable.');
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16384) throw new TypeError('Hosting reservation unavailable.');
      parts.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const raw = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    raw.set(part, at);
    at += part.length;
  }
  const live = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  exactKeys(live, ['state', 'fileId', 'termsHash', 'expiresAt', 'reservation']);
  const liveReservation = parseReservation(live.reservation);
  if (
    live.state !== 'reserved' ||
    live.fileId !== r.fileId ||
    live.termsHash !== r.termsHash ||
    live.expiresAt !== r.expiresAt ||
    reservationText(liveReservation) !== reservationText(r) ||
    liveReservation.signature !== r.signature
  )
    throw new TypeError('Hosting reservation is not live.');
  return r;
}
