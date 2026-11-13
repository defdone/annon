/**
 * NEAR CKD on the client (`specs/pay2.md`, section 5.1): the one-time key a seller or buyer sends
 * with `register`, `unlock` or `reopen`, and the checks that the secret NEAR MPC sends back is the
 * right one before the envelope uses it. Same scheme as NEAR's own test vectors
 * (`specs/vectors/ckd-near-mpc.json`).
 */
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import { base58 } from '@scure/base';
import { AnnonError } from '../errors.js';

const G1 = bls.G1.Point;
const G2 = bls.G2.Point;
const Fr = bls.fields.Fr;
const DST = 'NEAR BLS12381G1_XMD:SHA-256_SSWU_RO_';

export type CkdErrorCode =
  /** MPC didn't answer; the purchase stands and `reopen` gets the key. */
  | 'ckd_failed'
  /** An answer that isn't a valid key for this file and this one-time key. */
  | 'ckd_invalid';

export class CkdError extends AnnonError {
  readonly code: CkdErrorCode;
  constructor(code: CkdErrorCode, message: string = code) {
    super(code, message);
    this.code = code;
    this.name = 'CkdError';
  }
}

const fail = (code: CkdErrorCode, message?: string): never => {
  throw new CkdError(code, message);
};

export interface OneTimeKey {
  /** The scalar `a`, 32 bytes big-endian. Persist only in an encrypted purchase or recovery record. */
  secret: Uint8Array;
  /** `A = a·G1` as the contract takes it: `bls12381g1:<base58 of 48 bytes>`. */
  publicKey: string;
  /** The same 48 bytes, for the payment nonce. */
  publicKeyBytes: Uint8Array;
}

/** A fresh one-time key pair. */
export function oneTimeKey(): OneTimeKey {
  const a = toScalar(bls.utils.randomSecretKey()) % Fr.ORDER;
  return keyFromSecret(fromScalar(a === 0n ? 1n : a));
}

/** @internal The key pair for a known scalar (tests, recovery from a stored job). */
export function keyFromSecret(secret: Uint8Array): OneTimeKey {
  const A = G1.BASE.multiply(scalar(secret)).toBytes(true);
  return { secret, publicKey: `bls12381g1:${base58.encode(A)}`, publicKeyBytes: A };
}

/** NEAR's `derive_app_id`: sha3-256 of `"near-mpc v0.1.0 app_id derivation:" + account + "," + path`. */
export const appId = (account: string, path: string) =>
  sha3_256(new TextEncoder().encode(`near-mpc v0.1.0 app_id derivation:${account},${path}`));

/** The app id of a file: the contract asks CKD for `file/<fileId, lowercase hex>`. */
export const fileAppId = (contractId: string, fileId: Uint8Array) =>
  appId(contractId, `file/${Array.from(fileId, (x) => x.toString(16).padStart(2, '0')).join('')}`);

export interface OpenAnswerOptions {
  /** The one-time secret whose public key went with the request. */
  secret: Uint8Array;
  /** `fileAppId(contractId, fileId)` for an Annon file. */
  appId: Uint8Array;
  /** `bls12381g2:…` read from the trusted contract's MPC account and CKD domain. */
  mpcKey: string;
}

/**
 * Turns the contract's return value into the file's CKD secret: the 48-byte G1 point the envelope
 * takes as `ckdSecret`. Decrypts `big_c − a·big_y`, then checks it is MPC's BLS signature on this
 * app id, `e(H(pk ‖ appId), pk) = e(sig, G2)`, so a wrong or forged answer never reaches the file.
 */
export function openAnswer(answer: unknown, opts: OpenAnswerOptions): Uint8Array {
  const a = answer as { big_y?: unknown; big_c?: unknown; error?: unknown } | null;
  if (a && typeof a.error === 'string') fail('ckd_failed', a.error);
  const Y = point(G1, a?.big_y, 'bls12381g1:', 48);
  const C = point(G1, a?.big_c, 'bls12381g1:', 48);
  const pk = point(G2, opts.mpcKey, 'bls12381g2:', 96);
  return decrypt(scalar(opts.secret), Y, C, pk, opts.appId).toBytes(true);
}

/** @internal The scheme on decoded points, as NEAR's vectors state it. */
export function decrypt(
  a: bigint,
  Y: InstanceType<typeof G1>,
  C: InstanceType<typeof G1>,
  pk: InstanceType<typeof G2>,
  id: Uint8Array,
) {
  const sig = C.subtract(Y.multiply(a));
  const H = hashPoint(pk, id);
  let ok = false;
  try {
    // noble refuses to pair the identity point; that answer is invalid all the same.
    ok = !sig.is0() && bls.fields.Fp12.eql(bls.pairing(H, pk), bls.pairing(sig, G2.BASE));
  } catch {}
  if (!ok) fail('ckd_invalid', 'the answer is not the key for this file and this one-time key');
  return sig;
}

/** @internal `H(pk, app_id)`: RFC 9380 hash to G1 over `pk_compressed (96 B) ‖ app_id`. */
export const hashPoint = (pk: InstanceType<typeof G2>, id: Uint8Array) =>
  bls.shortSignatures.hash(new Uint8Array([...pk.toBytes(true), ...id]), DST);

// Scalars are 32 bytes big-endian, as in NEAR's vectors.
const toScalar = (b: Uint8Array) =>
  BigInt(`0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('') || '0'}`);
const fromScalar = (a: bigint) =>
  Uint8Array.from(a.toString(16).padStart(64, '0').match(/../g) ?? [], (x) =>
    Number.parseInt(x, 16),
  );

function scalar(secret: Uint8Array): bigint {
  if (secret.length !== 32) throw new TypeError('the one-time secret is 32 bytes');
  const a = toScalar(secret);
  if (a === 0n || a >= Fr.ORDER) throw new TypeError('the one-time secret is not a valid scalar');
  return a;
}

/** Decodes `prefix` + base58 into a point of the prime subgroup. */
function point<P extends typeof G1 | typeof G2>(
  group: P,
  s: unknown,
  prefix: string,
  len: number,
): InstanceType<P> {
  if (typeof s !== 'string' || !s.startsWith(prefix)) return fail('ckd_invalid', 'bad point');
  try {
    const bytes = base58.decode(s.slice(prefix.length));
    if (bytes.length !== len) throw new Error('length');
    // fromBytes rejects points off the curve or outside the prime subgroup (tested); a zero or
    // otherwise wrong point fails the pairing check.
    return group.fromBytes(bytes) as InstanceType<P>;
  } catch {
    return fail('ckd_invalid', 'bad point');
  }
}
