/**
 * The x402 sign-in-with-x extension as an Annon host uses it (specs/download.md section 2): a
 * single-use challenge in the 402, and the `SIGN-IN-WITH-X` proof a buyer's wallet signs for it.
 * EVM only (`eip155:8453`, `eip191`): the wallets that pay with EIP-3009 are plain accounts.
 * The message is exactly what x402's own `createSIWxMessage` builds, so its clients sign it too.
 */
import { hexBytes, signedBy } from '../envelope/pay2.js';
import { checksumAddress } from './download.js';

export const SIGN_IN_WITH_X = 'sign-in-with-x';
export const SIGN_IN_HEADER = 'SIGN-IN-WITH-X';
export const SIGN_IN_STATEMENT = 'Download an Annon file you bought.';
/** A challenge is good for this long after it is issued. */
export const SIGN_IN_SECONDS = 300;
const CHAIN = 'eip155:8453';

/** The challenge, as the 402 carries it in `extensions["sign-in-with-x"].info`. */
export interface SignInChallenge {
  domain: string;
  uri: string;
  version: '1';
  statement: string;
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  resources: string[];
}

/** The decoded `SIGN-IN-WITH-X` header: the challenge's fields, the wallet and its signature. */
export interface SignInProof extends SignInChallenge {
  address: string;
  chainId: string;
  type: string;
  signature: string;
}

/** x402's `buildSIWxSchema()`, as the extension declares it. */
export const SIGN_IN_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    domain: { type: 'string' },
    address: { type: 'string' },
    statement: { type: 'string' },
    uri: { type: 'string', format: 'uri' },
    version: { type: 'string' },
    chainId: { type: 'string' },
    type: { type: 'string' },
    nonce: { type: 'string' },
    issuedAt: { type: 'string', format: 'date-time' },
    expirationTime: { type: 'string', format: 'date-time' },
    notBefore: { type: 'string', format: 'date-time' },
    requestId: { type: 'string' },
    resources: { type: 'array', items: { type: 'string', format: 'uri' } },
    signature: { type: 'string' },
  },
  required: [
    'domain',
    'address',
    'uri',
    'version',
    'chainId',
    'type',
    'nonce',
    'issuedAt',
    'signature',
  ],
};

/** The resource a sign-in names: this file and the header the buyer checked. */
export const fileUrn = (contractId: string, fileId: string, headerHash: string) =>
  `urn:annon:v1:${contractId}:${fileId}:${headerHash}`;

/** A new challenge for `url` (the host's configured `resource.url`), issued at `now` (Unix s). */
export function signInChallenge(
  url: string,
  file: { contractId: string; fileId: string; headerHash: string },
  now = Math.floor(Date.now() / 1000),
): SignInChallenge {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  return {
    domain: new URL(url).host,
    uri: url,
    version: '1',
    statement: SIGN_IN_STATEMENT,
    nonce,
    issuedAt: new Date(now * 1000).toISOString(),
    expirationTime: new Date((now + SIGN_IN_SECONDS) * 1000).toISOString(),
    resources: [fileUrn(file.contractId, file.fileId, file.headerHash)],
  };
}

/** `extensions["sign-in-with-x"]` of the 402. */
export const signInExtension = (c: SignInChallenge) => ({
  info: c,
  supportedChains: [{ chainId: CHAIN, type: 'eip191' }],
  schema: SIGN_IN_SCHEMA,
});

/** The EIP-4361 message for a challenge and wallet, as x402's `createSIWxMessage` builds it. */
export function signInMessage(c: SignInChallenge, address: string): string {
  return [
    `${c.domain} wants you to sign in with your Ethereum account:`,
    checksumAddress(address),
    '',
    c.statement,
    '',
    `URI: ${c.uri}`,
    `Version: ${c.version}`,
    'Chain ID: 8453',
    `Nonce: ${c.nonce}`,
    `Issued At: ${c.issuedAt}`,
    `Expiration Time: ${c.expirationTime}`,
    'Resources:',
    ...c.resources.map((r) => `- ${r}`),
  ].join('\n');
}

const utf8 = new TextEncoder();

/** The `SIGN-IN-WITH-X` header value (base64 JSON, as x402's `encodeSIWxHeader`). */
export function signInHeader(c: SignInChallenge, address: string, signature: string): string {
  const proof: SignInProof = {
    ...c,
    address: checksumAddress(address),
    chainId: CHAIN,
    type: 'eip191',
    signature,
  };
  return btoa(
    String.fromCharCode(...utf8.encode(JSON.stringify({ ...proof, signatureScheme: 'eip191' }))),
  );
}

/** The decoded proof, or null for anything that is not one. */
export function readSignIn(header: string | null | undefined): SignInProof | null {
  if (!header) return null;
  try {
    const p = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(atob(header.trim()), (c) => c.charCodeAt(0)),
      ),
    ) as Record<string, unknown>;
    const str = (k: string) => typeof p[k] === 'string';
    if (
      ![
        'domain',
        'uri',
        'version',
        'statement',
        'nonce',
        'issuedAt',
        'expirationTime',
        'address',
        'chainId',
        'type',
        'signature',
      ].every(str) ||
      !Array.isArray(p.resources) ||
      !p.resources.every((r) => typeof r === 'string')
    ) {
      return null;
    }
    return p as unknown as SignInProof;
  } catch {
    return null;
  }
}

/**
 * The wallet a proof signs in, or null. `issued` is the challenge this host issued with that
 * nonce, already taken out of its store (single use); `now` in Unix seconds. Checks, as
 * download.md section 2: the proof echoes that challenge exactly, the time window, Base and EIP-191,
 * and the signature over the message rebuilt from the host's own challenge.
 */
export function verifySignIn(
  proof: SignInProof,
  issued: SignInChallenge,
  now = Math.floor(Date.now() / 1000),
): string | null {
  const same =
    proof.domain === issued.domain &&
    proof.uri === issued.uri &&
    proof.version === issued.version &&
    proof.statement === issued.statement &&
    proof.nonce === issued.nonce &&
    proof.issuedAt === issued.issuedAt &&
    proof.expirationTime === issued.expirationTime &&
    proof.resources.length === issued.resources.length &&
    proof.resources.every((r, i) => r === issued.resources[i]);
  if (!same || proof.chainId !== CHAIN || proof.type !== 'eip191') return null;
  const at = Date.parse(issued.issuedAt) / 1000;
  const until = Date.parse(issued.expirationTime) / 1000;
  if (!(at <= now && now < until && now - at <= SIGN_IN_SECONDS)) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(proof.address)) return null;
  const wallet = proof.address.toLowerCase();
  try {
    return signedBy(signInMessage(issued, wallet), hexBytes(proof.signature, 65), wallet)
      ? wallet
      : null;
  } catch {
    return null;
  }
}
