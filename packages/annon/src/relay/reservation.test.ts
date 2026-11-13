import { ed25519 } from '@noble/curves/ed25519.js';
import { base64urlnopad } from '@scure/base';
import { expect, it } from 'vitest';
import { terms } from '../../test/fixtures.js';
import { hex } from '../settle-near/codec.js';
import { termsHash } from '../settle-near/terms.js';
import { parseReservation, reservationText, verifyReservation } from './reservation.js';

const seed = new Uint8Array(32).fill(7);
const fixture = (patch: Record<string, unknown> = {}) => {
  const data = {
    v: 1 as const,
    uploadId: '22'.repeat(32),
    network: terms.network,
    contract: terms.contract,
    fileId: terms.file_id,
    termsHash: termsHash(terms),
    seller: terms.seller,
    cipherHash: terms.cipher_hash,
    byteSize: 1635,
    plaintextSize: 1024,
    headerSize: 323,
    metadataHash: `0x${'55'.repeat(32)}`,
    hostOrigin: 'https://host.example',
    issuedAt: 1000,
    expiresAt: 1600,
    ...patch,
  };
  return {
    ...data,
    signature: base64urlnopad.encode(
      ed25519.sign(new TextEncoder().encode(reservationText(data)), seed),
    ),
  };
};
const options = {
  hostOrigin: 'https://host.example',
  publicKey: hex(ed25519.getPublicKey(seed)).slice(2),
  now: 1000,
};
const live = (reservation: ReturnType<typeof fixture>) => async () =>
  Response.json({
    state: 'reserved',
    fileId: reservation.fileId,
    termsHash: reservation.termsHash,
    expiresAt: reservation.expiresAt,
    reservation,
  });
it('verifies signed live fixed-origin reservations and refuses replay, tampering and redirects', async () => {
  const r = fixture();
  expect(await verifyReservation(r, terms, { ...options, fetch: live(r) })).toEqual(r);
  for (const changed of [
    { ...r, expiresAt: 1601 },
    { ...r, hostOrigin: 'https://other.example' },
    { ...r, termsHash: `0x${'33'.repeat(32)}` },
    { ...r, plaintextSize: 50000001 },
    { ...r, extra: true },
    { ...r, signature: `${r.signature}=` },
  ])
    await expect(
      verifyReservation(changed, terms, { ...options, fetch: live(r) }),
    ).rejects.toThrow();
  await expect(
    verifyReservation(r, terms, { ...options, now: 1600, fetch: live(r) }),
  ).rejects.toThrow();
  await expect(
    verifyReservation(r, terms, {
      ...options,
      fetch: async () => Response.json({ state: 'expired' }),
    }),
  ).rejects.toThrow();
  await expect(
    verifyReservation(r, terms, {
      ...options,
      fetch: async () =>
        new Response(null, { status: 302, headers: { location: 'https://other.example' } }),
    }),
  ).rejects.toThrow();
});

it.each([
  { network: 'near:testnet' },
  { contract: 'other.test' },
  { fileId: `0x${'77'.repeat(32)}` },
  { termsHash: `0x${'88'.repeat(32)}` },
  { cipherHash: `0x${'99'.repeat(32)}` },
  { seller: { kind: 'evm', id: `0x${'22'.repeat(20)}` } },
  { hostOrigin: 'https://other.test' },
  { issuedAt: 1001, expiresAt: 1601 },
  { issuedAt: 400, expiresAt: 1000 },
  { issuedAt: 1000, expiresAt: 1601 },
  { v: 2 },
  { uploadId: '11' },
  { byteSize: 50086017 },
  { byteSize: 0 },
  { byteSize: 323 },
  { byteSize: 1635.5 },
  { plaintextSize: 1024.5 },
  { headerSize: 323.5 },
  { plaintextSize: 50000001 },
  { plaintextSize: -1 },
  { headerSize: 65537, byteSize: 70000 },
  { headerSize: 0 },
  { metadataHash: '0x11' },
])(
  'refuses a valid host signature for a different binding or invalid bounds: %j',
  async (patch) => {
    const r = fixture(patch);
    await expect(verifyReservation(r, terms, { ...options, fetch: live(r) })).rejects.toThrow();
  },
);
it('bounds live JSON, checks its response type, and refuses an already consumed reservation', async () => {
  const r = fixture();
  const body = {
    state: 'reserved',
    fileId: r.fileId,
    termsHash: r.termsHash,
    expiresAt: r.expiresAt,
    reservation: r,
  };
  for (const response of [
    new Response(JSON.stringify(body).padEnd(20000, ' '), {
      headers: { 'content-type': 'application/json' },
    }),
    new Response(JSON.stringify(body), { headers: { 'content-type': 'text/plain' } }),
    Response.json({ ...body, state: 'published' }),
    Response.json({ ...body, fileId: `0x${'77'.repeat(32)}` }),
    Response.json({ ...body, termsHash: `0x${'88'.repeat(32)}` }),
    Response.json({ ...body, expiresAt: 1700 }),
    Response.json({ ...body, reservation: fixture({ metadataHash: `0x${'99'.repeat(32)}` }) }),
  ])
    await expect(
      verifyReservation(r, terms, { ...options, fetch: async () => response }),
    ).rejects.toThrow();
  await expect(
    verifyReservation(r, terms, { ...options, maxFileBytes: 1000, fetch: live(r) }),
  ).rejects.toThrow();
  const wrongKey = {
    ...options,
    publicKey: hex(ed25519.getPublicKey(new Uint8Array(32).fill(8))).slice(2),
  };
  await expect(verifyReservation(r, terms, { ...wrongKey, fetch: live(r) })).rejects.toThrow();
});

it('rejects validly signed attestations outside the pinned registration binding', async () => {
  const resign = (over: Partial<ReturnType<typeof fixture>>) => {
    const r = { ...fixture(), ...over };
    return {
      ...r,
      signature: base64urlnopad.encode(
        ed25519.sign(new TextEncoder().encode(reservationText(r)), seed),
      ),
    };
  };
  const correct = fixture();
  await expect(
    verifyReservation({ ...correct, signature: 'A'.repeat(86) }, terms, {
      ...options,
      fetch: live(correct),
    }),
  ).rejects.toThrow();
  for (const over of [
    { hostOrigin: 'https://other.example' },
    { network: 'near:testnet' },
    { contract: 'other.test' },
    { fileId: `0x${'33'.repeat(32)}` },
    { termsHash: `0x${'33'.repeat(32)}` },
    { cipherHash: `0x${'44'.repeat(32)}` },
    { seller: { kind: 'evm' as const, id: `0x${'22'.repeat(20)}` } },
    { issuedAt: 1001, expiresAt: 1601 },
    { expiresAt: 1601 },
  ]) {
    const r = resign(over);
    await expect(verifyReservation(r, terms, { ...options, fetch: live(r) })).rejects.toThrow();
  }
  const record = {
    state: 'reserved',
    fileId: correct.fileId,
    termsHash: correct.termsHash,
    expiresAt: correct.expiresAt,
    reservation: correct,
  };
  await expect(
    verifyReservation(correct, terms, {
      ...options,
      fetch: async () => Response.json({ ...record, state: 'expired' }),
    }),
  ).rejects.toThrow();
  await expect(
    verifyReservation(correct, terms, {
      ...options,
      fetch: async () =>
        new Response(' '.repeat(17000) + JSON.stringify(record), {
          headers: { 'content-type': 'application/json' },
        }),
    }),
  ).rejects.toThrow();
  const redirect = Response.json(record);
  Object.defineProperty(redirect, 'redirected', { value: true });
  await expect(
    verifyReservation(correct, terms, { ...options, fetch: async () => redirect }),
  ).rejects.toThrow();
});

it('uses the exact reservation signing domain, line order and UTF-8 text', () => {
  const r = fixture();
  expect(reservationText(r)).toBe(
    `Annon: hosting reservation v1\nupload: ${'22'.repeat(32)}\nnetwork: near:mainnet\ncontract: annon.near\nfile: ${terms.file_id}\nterms: ${termsHash(terms)}\nseller: EVM 0x${'11'.repeat(20)}\ncipher: ${terms.cipher_hash}\nbytes: 1635\nplaintext bytes: 1024\nheader bytes: 323\nmetadata: 0x${'55'.repeat(32)}\nhost: https://host.example\nissued: 1000\nexpires: 1600`,
  );
});

it('rejects oversized plaintext during envelope parsing before any live lookup', () => {
  expect(() => parseReservation(fixture({ plaintextSize: 50000001 }))).toThrow();
});
it('requires every live signed field to match even if the host repeats an old signature', async () => {
  const r = fixture();
  const response = Response.json({
    state: 'reserved',
    fileId: r.fileId,
    termsHash: r.termsHash,
    expiresAt: r.expiresAt,
    reservation: { ...r, metadataHash: `0x${'99'.repeat(32)}` },
  });
  await expect(
    verifyReservation(r, terms, { ...options, fetch: async () => response }),
  ).rejects.toThrow();
});
