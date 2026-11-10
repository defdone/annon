/** Identity and authoritative-text authorization, near-settlement.md §2. */
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import { signedBy } from '../envelope/evm.js';
import { account, bytes, compare, concat, exactKeys, hex, str, utf8 } from './codec.js';

export type Identity =
  | { kind: 'evm'; id: string }
  | { kind: 'solana'; id: string }
  | { kind: 'near'; id: string };
export type Authorization = { kind: 'evm' | 'solana'; sig: string };
export const identityKind = (id: Identity): number => ({ evm: 0, solana: 1, near: 2 })[id.kind];

/** Accept base58 Solana keys at the API boundary; store/serialize lowercase hex. */
export function parseIdentity(input: unknown): Identity {
  exactKeys(input, ['kind', 'id']);
  const { kind, id } = input;
  if (typeof id !== 'string') throw new TypeError('invalid identity id');
  if (kind === 'near') return { kind, id: account(id) };
  if (kind === 'evm') {
    const normalized = id.toLowerCase();
    bytes(normalized, 20);
    return { kind, id: normalized };
  }
  if (kind === 'solana') {
    let raw: Uint8Array;
    if (/^[a-fA-F0-9]{64}$/.test(id)) raw = bytes(`0x${id.toLowerCase()}`, 32);
    else {
      if (id.length < 32 || id.length > 44) throw new TypeError('invalid Solana key');
      raw = base58.decode(id);
      if (raw.length !== 32 || base58.encode(raw) !== id) throw new TypeError('invalid Solana key');
    }
    return { kind, id: hex(raw).slice(2) };
  }
  throw new TypeError('unknown identity kind');
}
export function encodeIdentity(input: Identity): Uint8Array<ArrayBuffer> {
  const id = parseIdentity(input);
  return concat(
    new Uint8Array([identityKind(id)]),
    id.kind === 'near'
      ? str(id.id)
      : bytes(id.kind === 'evm' ? id.id : `0x${id.id}`, id.kind === 'evm' ? 20 : 32),
  );
}
export const identityJson = (id: Identity): string => JSON.stringify(parseIdentity(id));
export function identityText(input: Identity): string {
  const id = parseIdentity(input);
  return id.kind === 'near'
    ? `NEAR ${id.id}`
    : id.kind === 'evm'
      ? `EVM ${id.id}`
      : `Solana ${base58.encode(bytes(`0x${id.id}`, 32))}`;
}
export const intentsAccount = (id: Identity): string => parseIdentity(id).id;

/** Malformed signatures and auth of a different kind always fail closed. */
export function verifyAuthorization(
  input: Identity,
  text: string,
  auth?: Authorization,
  predecessor?: string,
): boolean {
  try {
    const id = parseIdentity(input);
    if (typeof text !== 'string' || text.includes('\r') || text.endsWith('\n')) return false;
    if (id.kind === 'near') return auth === undefined && predecessor === id.id;
    exactKeys(auth, ['kind', 'sig']);
    if (auth.kind !== id.kind) return false;
    const sig = bytes(auth.sig as string, id.kind === 'evm' ? 65 : 64);
    return id.kind === 'evm'
      ? signedBy(text, sig, id.id)
      : ed25519.verify(sig, utf8.encode(text), bytes(`0x${id.id}`, 32), { zip215: false });
  } catch {
    return false;
  }
}

/** Wallet Standard results must carry the very same message, before accepting their signature. */
export function solanaWalletAuth(
  id: Identity,
  text: string,
  result: { signature: Uint8Array; signedMessage: Uint8Array },
): Authorization {
  if (
    !(result.signedMessage instanceof Uint8Array) ||
    compare(result.signedMessage, utf8.encode(text)) !== 0
  )
    throw new Error('wallet returned different signed bytes');
  const auth: Authorization = { kind: 'solana', sig: hex(result.signature) };
  if (id.kind !== 'solana' || !verifyAuthorization(id, text, auth))
    throw new Error('the signature is not from the seller');
  return auth;
}
