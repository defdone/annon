/**
 * The seller's side of `specs/x402-annon.md`: the 402 for an Annon file, built from its
 * registration, and the check a server runs on `PAYMENT-SIGNATURE` before it settles. Settlement
 * itself stays with the server's facilitator: any standard x402 one, through `forFacilitator`.
 */
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { getConfig, getFile } from '../near/rpc.js';
import { fail, head } from './base.js';
import { annonNonce, digest, fromHex, signer } from './eip3009.js';
import { MAX_CLOCK_SKEW_SECONDS, MAX_VALIDITY_SECONDS } from './pay.js';
import { ANNON_EXACT, BASE_NETWORK, type Offer, type PaymentRequired } from './x402.js';

export interface OfferOptions {
  nearRpc: string;
  contractId: string;
  fileId: string;
  /** The URL being paid for (x402 `resource.url`). */
  url: string;
  /** URL of the complete PAY2 header, public (profile section 7). */
  header?: string;
  /** URL of the PAY2 file for buyers: entitlement on NEAR plus a wallet-signed challenge. */
  download?: string;
  /** The seller publishes the body too: the client then checks the whole file before signing. */
  public?: boolean;
  /** At most this long for the buyer's authorization; the Annon client signs for at most 180. */
  maxTimeoutSeconds?: number;
}

/**
 * The `PaymentRequired` for a registered file, every value from the contract. Throws `PayError`
 * `sales_stopped` or `taken_down` for a file that must not be offered (answer 410), and
 * `unknown_file` for one that isn't registered.
 */
export async function offerFor(o: OfferOptions): Promise<PaymentRequired> {
  const file = await getFile(o.nearRpc, o.contractId, o.fileId);
  if (!file) return fail('unknown_file', 'the file is not registered on the Annon contract');
  if (file.takenDown) fail('taken_down', `the file was taken down (${file.takenDown})`);
  if (file.salesStoppedAt !== null) fail('sales_stopped', 'the seller stopped selling this file');
  const config = await getConfig(o.nearRpc, o.contractId);
  const offer: Offer = {
    scheme: ANNON_EXACT,
    network: BASE_NETWORK,
    amount: file.price.toString(),
    asset: config.usdc,
    payTo: file.payTo,
    maxTimeoutSeconds: o.maxTimeoutSeconds ?? 300,
    extra: { name: 'USD Coin', version: '2' },
  };
  const info = {
    version: 1,
    network: 'near:mainnet',
    contract: o.contractId,
    fileId: o.fileId,
    ...(o.header ? { header: o.header } : {}),
    ...(o.download ? { download: o.download } : {}),
    ...(o.public ? { public: true } : {}),
  };
  return {
    x402Version: 2,
    resource: { url: o.url },
    accepts: [offer],
    extensions: { annon: { info, schema: ANNON_SCHEMA } },
  };
}

/** JSON Schema of `extensions.annon.info` (the buyer adds `buyerKey`). */
export const ANNON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['version', 'network', 'contract', 'fileId'],
  properties: {
    version: { const: 1 },
    network: { const: 'near:mainnet' },
    contract: { type: 'string' },
    fileId: { type: 'string', pattern: '^0x[0-9a-f]{64}$' },
    header: { type: 'string' },
    download: { type: 'string' },
    public: { type: 'boolean' },
    buyerKey: { type: 'string', pattern: '^0x[0-9a-f]{96}$' },
  },
} as const;

/** A payment that may be settled, and what settlement needs. */
export interface CheckedPayment {
  payer: string;
  /** The buyer's one-time key: `unlock` needs it. */
  buyerKey: string;
  /** The nonce the buyer signed: `annonNonce(contract, fileId, buyerKey)`. */
  nonce: string;
  offer: Offer;
}

const b64json = (s: string): unknown => {
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0)),
      ),
    );
  } catch {
    return null;
  }
};
/** Structural equality of JSON values: key order doesn't matter, as in any JSON parser. */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter((k) => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => (b as Record<string, unknown>)[k] !== undefined);
  return (
    ka.length === kb.length &&
    ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

/**
 * What a server runs before it settles: the registration read again now (a file stopped or taken
 * down since the 402 is refused), then `checkPayment` against the offer it gives, with "now" taken
 * from the earlier of this server's clock and Base's (USDC compares `validBefore` with Base time).
 * Only with both does the validity bound keep the payment inside the contract's 300 s after a
 * stop: the file was on sale at this moment, and the authorization expires within 240 s of it.
 */
export async function verifyPayment(
  header: string,
  o: OfferOptions & { baseRpc: string },
): Promise<CheckedPayment> {
  // Time first, registration second: "now" must not be later than the moment the file was seen on
  // sale, or a slow read would stretch the window.
  const local = Math.floor(Date.now() / 1000);
  const base = (await head(o.baseRpc)).timestamp;
  if (Math.abs(base - local) > MAX_CLOCK_SKEW_SECONDS) {
    fail('transport', 'this server and Base disagree on the time; refusing to settle');
  }
  const pr = await offerFor(o);
  return checkPayment(header, pr, Math.min(base, local));
}

/**
 * @internal Use `verifyPayment`: this checks against a `PaymentRequired` that may be stale.
 * Checks `PAYMENT-SIGNATURE` against the `PaymentRequired` this server sent (profile section 3):
 * the offer echoed unchanged, the `annon` extension echoed with a valid buyer key, and the nonce
 * the one that key gives. Run it before settling: a payment with any other nonce would move the
 * buyer's money and never release the key. Throws `PayError` `bad_signature` or `bad_requirements`.
 */
export function checkPayment(
  header: string,
  pr: PaymentRequired,
  now: number = Math.floor(Date.now() / 1000),
): CheckedPayment {
  const p = b64json(header) as {
    x402Version?: unknown;
    accepted?: Offer;
    payload?: { signature?: unknown; authorization?: Record<string, unknown> };
    extensions?: { annon?: { info?: Record<string, unknown> } };
  } | null;
  if (p?.x402Version !== 2) return fail('bad_requirements', 'not an x402 v2 payment');
  const offer = pr.accepts.find((o) => same(o, p.accepted));
  if (!offer)
    return fail('bad_requirements', 'the payment is for an offer this server did not make');
  const sent = p.extensions?.annon?.info ?? {};
  const advertised = pr.extensions?.annon?.info ?? {};
  for (const [k, v] of Object.entries(advertised)) {
    if (!same(sent[k], v)) fail('bad_requirements', `the annon extension changed ${k}`);
  }
  const buyerKey = sent.buyerKey;
  if (typeof buyerKey !== 'string')
    return fail('bad_requirements', 'the payment carries no buyer key');
  try {
    if (bls.G1.Point.fromBytes(fromHex(buyerKey, 48, 'buyerKey')).is0()) throw new Error('zero');
  } catch {
    fail('bad_requirements', 'the buyer key is not a one-time G1 key');
  }
  const contract = String(advertised.contract);
  const fileId = String(advertised.fileId);
  const nonce = annonNonce(contract, fileId, fromHex(buyerKey, 48, 'buyerKey'));

  const a = p.payload?.authorization ?? {};
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(str('from')) || !/^\d{1,78}$/.test(str('validBefore'))) {
    fail('bad_requirements', 'malformed authorization');
  }
  if (str('nonce').toLowerCase() !== nonce) {
    fail('bad_requirements', 'the nonce is not the Annon nonce of this file and buyer key');
  }
  if (str('to').toLowerCase() !== offer.payTo.toLowerCase() || str('value') !== offer.amount) {
    fail('bad_requirements', 'the authorization pays another amount or recipient');
  }
  if (str('validAfter') !== '0') fail('bad_requirements', 'validAfter must be 0');
  // The contract counts a payment up to 300 s after a stop. A buyer's client could sign for longer;
  // this server settles only authorizations short enough to stay inside that, whoever made them.
  if (BigInt(str('validBefore')) > BigInt(now + MAX_VALIDITY_SECONDS + MAX_CLOCK_SKEW_SECONDS)) {
    fail('bad_requirements', 'the authorization is valid for too long');
  }
  const from = str('from').toLowerCase();
  const auth = {
    from,
    to: offer.payTo.toLowerCase(),
    value: BigInt(offer.amount),
    validAfter: 0n,
    validBefore: BigInt(str('validBefore')),
    nonce,
  };
  const sig = p.payload?.signature;
  if (typeof sig !== 'string' || signer(digest(offer.asset.toLowerCase(), auth), sig) !== from) {
    fail('bad_signature', "the signature is not the payer's, or not in the form USDC takes");
  }
  return { payer: from, buyerKey, nonce, offer };
}

/**
 * A checked `annon-exact` payment as a standard x402 facilitator takes it: the same signed
 * authorization with the scheme named `exact` in both the payload and the requirements (the
 * official facilitator checks both). Run `verifyPayment` first.
 */
export function forFacilitator(header: string, offer: Offer) {
  if (offer.scheme !== ANNON_EXACT) {
    return fail(
      'method_mismatch',
      'only annon-exact payments settle through a standard facilitator',
    );
  }
  const p = b64json(header) as Record<string, unknown> | null;
  if (!p) return fail('bad_requirements', 'PAYMENT-SIGNATURE is not base64 JSON');
  const paymentRequirements = { ...offer, scheme: 'exact' };
  return { paymentPayload: { ...p, accepted: paymentRequirements }, paymentRequirements };
}
