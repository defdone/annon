/**
 * The seller's side of `specs/x402-annon.md`: the 402 for an Annon file, built from its
 * registration, and the check a server runs on `PAYMENT-SIGNATURE` before it settles. Settlement
 * itself stays with the server's facilitator: any standard x402 one, through `forFacilitator`.
 */
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { secureUrl } from '../download/download.js';
import { type FileInfo, getConfig, getFile } from '../near/rpc.js';
import { fail, head } from './base.js';
import { annonNonce, digest, fromHex, signer } from './eip3009.js';
import { MAX_CLOCK_SKEW_SECONDS, MAX_VALIDITY_SECONDS } from './pay.js';
import {
  ANNON_EXACT,
  BASE_NETWORK,
  BAZAAR,
  BUILDER_CODE,
  BUILDER_CODE_PATTERN,
  codes,
  isPaymentId,
  MAX_ECHOED_SERVICE_CODES,
  type Offer,
  PAYMENT_IDENTIFIER,
  type PaymentRequired,
  paymentIdentifierDeclaration,
} from './x402.js';

export interface OfferOptions {
  nearRpc: string;
  contractId: string;
  fileId: string;
  /**
   * The PAY2 file (x402 `resource.url`): the paid request returns it, and buyers sign in there to
   * get it again (specs/download.md). https only.
   */
  url: string;
  /** URL of the complete PAY2 header, public (profile section 7): the client checks it first. */
  header: string;
  /** The seller publishes the body too: the client then checks the whole file before signing. */
  public?: boolean;
  /** At most this long for the buyer's authorization; the Annon client signs for at most 180. */
  maxTimeoutSeconds?: number;
  /** The seller app's x402 builder code (`^[a-z0-9_]{1,32}$`), declared as `builder-code`. */
  appCode?: string;
  /** Describes the file for x402 discovery (`bazaar`, profile section 11). */
  discovery?: {
    description?: string;
    mimeType?: string;
    serviceName?: string;
    tags?: string[];
    iconUrl?: string;
  };
}

/**
 * An icon URL bazaar keeps (its `isValidIconUrl`), https only: at most 2048 characters, no
 * credentials, and a host name, not an IP address or loopback.
 */
function iconUrl(v: string): boolean {
  if (v.length > 2048 || /\p{Cc}/u.test(v) || !URL.canParse(v)) return false;
  const u = new URL(v);
  const h = u.hostname.toLowerCase();
  return (
    u.protocol === 'https:' &&
    !u.username &&
    !u.password &&
    !h.startsWith('[') &&
    !['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback'].includes(h) &&
    // WHATWG parses an all-digit or 0x host as IPv4, so this covers bazaar's digit and hex rules.
    !/^\d{1,3}(\.\d{1,3}){3}$/.test(h)
  );
}

/** x402's `declareBuilderCodeExtension(appCode)`. */
const builderCodeDeclaration = (a: string) => {
  if (!BUILDER_CODE_PATTERN.test(a)) throw new TypeError('appCode must match ^[a-z0-9_]{1,32}$');
  const code = { type: 'string', pattern: '^[a-z0-9_]{1,32}$' };
  return {
    info: { a },
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        a: { ...code, description: 'App builder code' },
        w: { ...code, description: 'Wallet builder code' },
        s: { type: 'array', maxItems: 11, items: code, description: 'Service builder codes' },
      },
      additionalProperties: false,
    },
  };
};

/** x402's `declareDiscoveryExtension` for a file: a GET that returns PAY2 bytes. */
const discoveryDeclaration = () => ({
  info: {
    input: { type: 'http', method: 'GET' },
    output: { type: 'binary', format: 'application/vnd.annon.pay2' },
  },
  schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      input: {
        type: 'object',
        properties: {
          type: { type: 'string', const: 'http' },
          method: { type: 'string', enum: ['GET', 'HEAD', 'DELETE'] },
        },
        required: ['type', 'method'],
        additionalProperties: false,
      },
      output: {
        type: 'object',
        properties: { type: { type: 'string' }, format: { type: 'string' } },
        required: ['type'],
      },
    },
    required: ['input'],
  },
});

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
  return paymentRequired(o, file, (await getConfig(o.nearRpc, o.contractId)).usdc);
}

/**
 * The `PaymentRequired` for a registration already read: the offer while sales are open, none once
 * they are stopped (profile section 2: buyers still sign in to download).
 */
export function paymentRequired(o: OfferOptions, file: FileInfo, usdc: string): PaymentRequired {
  // An Annon client won't sign without the header, and the file itself goes over https only
  // (specs/download.md).
  if (typeof o.header !== 'string' || !URL.canParse(o.header)) {
    throw new TypeError('header must be an absolute URL');
  }
  if (typeof o.url !== 'string') throw new TypeError('url must be an https URL');
  secureUrl(o.url);
  const offer: Offer = {
    scheme: ANNON_EXACT,
    network: BASE_NETWORK,
    amount: file.price.toString(),
    asset: usdc,
    payTo: file.payTo,
    maxTimeoutSeconds: o.maxTimeoutSeconds ?? 300,
    // Profile v1.1: settled before the file is served (x402 v2 section 6.1).
    extra: { name: 'USD Coin', version: '2', paymentFlow: 'upfront' },
  };
  const info = {
    version: 2,
    network: 'near:mainnet',
    contract: o.contractId,
    fileId: o.fileId,
    header: o.header,
    ...(o.public ? { public: true } : {}),
  };
  const d = o.discovery;
  // Bazaar's service metadata rules: a name and up to five distinct tags (case aside) of 1 to 32
  // printable ASCII, and an icon an https URL a catalog would keep. Refused, not trimmed.
  const label = (v: unknown) => typeof v === 'string' && /^[\x20-\x7e]{1,32}$/.test(v);
  const tags = d?.tags;
  if (
    (d?.serviceName !== undefined && !label(d.serviceName)) ||
    (tags !== undefined &&
      !(
        tags.length <= 5 &&
        tags.every(label) &&
        new Set(tags.map((t) => t.toLowerCase())).size === tags.length
      )) ||
    (d?.iconUrl !== undefined && !iconUrl(d.iconUrl))
  ) {
    throw new TypeError(
      'discovery: serviceName and up to 5 distinct tags of 1-32 printable ASCII, iconUrl a public https URL',
    );
  }
  return {
    x402Version: 2,
    resource: {
      url: o.url,
      ...(d?.description ? { description: d.description } : {}),
      ...(d?.mimeType ? { mimeType: d.mimeType } : {}),
      ...(d?.serviceName ? { serviceName: d.serviceName } : {}),
      ...(d?.tags ? { tags: d.tags } : {}),
      ...(d?.iconUrl ? { iconUrl: d.iconUrl } : {}),
    },
    accepts: file.salesStoppedAt === null ? [offer] : [],
    extensions: {
      annon: { info, schema: ANNON_SCHEMA },
      [PAYMENT_IDENTIFIER]: paymentIdentifierDeclaration(),
      ...(o.appCode ? { [BUILDER_CODE]: builderCodeDeclaration(o.appCode) } : {}),
      ...(d ? { [BAZAAR]: discoveryDeclaration() } : {}),
    },
  };
}

/** JSON Schema of `extensions.annon.info` (the buyer adds `buyerKey`). */
export const ANNON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['version', 'network', 'contract', 'fileId'],
  properties: {
    version: { const: 2 },
    network: { const: 'near:mainnet' },
    contract: { type: 'string' },
    fileId: { type: 'string', pattern: '^0x[0-9a-f]{64}$' },
    header: { type: 'string' },
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
  validBefore: bigint;
  /** The payload's `payment-identifier` id, if it has one. */
  paymentId?: string;
  offer: Offer;
}

type Payload = {
  x402Version?: unknown;
  accepted?: Offer;
  payload?: { signature?: unknown; authorization?: Record<string, unknown> };
  extensions?: Record<string, { info?: Record<string, unknown> } & Record<string, unknown>>;
};

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

/** The base64 JSON of `PAYMENT-SIGNATURE`, as an x402 v2 payload. */
export function readPayload(header: string): Payload {
  const p = b64json(header) as Payload | null;
  if (p?.x402Version !== 2) return fail('bad_requirements', 'not an x402 v2 payment');
  return p;
}

/** The payload's `payment-identifier` id, checked when it is there. */
function paymentIdOf(p: Payload): string | undefined {
  const ext = p.extensions?.[PAYMENT_IDENTIFIER];
  if (ext === undefined) return undefined;
  // Optional: an echo without an id is a payment without one.
  const id = ext?.info?.id;
  if (id === undefined) return undefined;
  if (!isPaymentId(id))
    fail('bad_requirements', 'the payment id is not a valid payment-identifier');
  return id as string;
}

/**
 * What never changes for a purchase (profile section 10): the authorization signed by `from`, for
 * the Annon nonce of this file and the buyer key, paying `offer` exactly. Shared by a new payment
 * (`checkPayment`) and by a retry of one already settling (`settle`).
 */
function checkSigned(p: Payload, contract: string, fileId: string, offer: Offer) {
  const buyerKey = p.extensions?.annon?.info?.buyerKey;
  if (typeof buyerKey !== 'string')
    return fail('bad_requirements', 'the payment carries no buyer key');
  try {
    if (bls.G1.Point.fromBytes(fromHex(buyerKey, 48, 'buyerKey')).is0()) throw new Error('zero');
  } catch {
    fail('bad_requirements', 'the buyer key is not a one-time G1 key');
  }
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
  const from = str('from').toLowerCase();
  const validBefore = BigInt(str('validBefore'));
  const auth = {
    from,
    to: offer.payTo.toLowerCase(),
    value: BigInt(offer.amount),
    validAfter: 0n,
    validBefore,
    nonce,
  };
  const sig = p.payload?.signature;
  if (typeof sig !== 'string' || signer(digest(offer.asset.toLowerCase(), auth), sig) !== from) {
    fail('bad_signature', "the signature is not the payer's, or not in the form USDC takes");
  }
  return { payer: from, buyerKey, nonce, validBefore, offer };
}

/**
 * The purchase terms of a payload against the registration and the contract's configuration,
 * without the seller's settings, the sale status or the deadline (profile section 10, order of
 * checks): what a retry of a payment already settling must still pass.
 */
export function checkTerms(
  header: string,
  t: { contractId: string; fileId: string; usdc: string; price: bigint; payTo: string },
): CheckedPayment {
  const p = readPayload(header);
  const o = p.accepted;
  const extra = (o?.extra ?? {}) as Record<string, unknown>;
  if (
    o?.scheme !== ANNON_EXACT ||
    o.network !== BASE_NETWORK ||
    typeof o.asset !== 'string' ||
    o.asset.toLowerCase() !== t.usdc ||
    o.amount !== t.price.toString() ||
    typeof o.payTo !== 'string' ||
    o.payTo.toLowerCase() !== t.payTo ||
    extra.name !== 'USD Coin' ||
    extra.version !== '2'
  ) {
    fail('bad_requirements', 'the payment is not for this file on its registered terms');
  }
  const info = p.extensions?.annon?.info ?? {};
  if (info.contract !== t.contractId || info.fileId !== t.fileId) {
    fail('bad_requirements', 'the payment is for another Annon contract or file');
  }
  const paymentId = paymentIdOf(p);
  return {
    ...checkSigned(p, t.contractId, t.fileId, o as Offer),
    ...(paymentId ? { paymentId } : {}),
  };
}

/**
 * @internal Use `verifyPayment`: this checks against a `PaymentRequired` that may be stale.
 * Checks `PAYMENT-SIGNATURE` against the `PaymentRequired` this server sent (profile section 3):
 * the offer echoed unchanged, the `annon` extension echoed with a valid buyer key, an advertised
 * `payment-identifier` echoed with a valid id, and the nonce the one that key gives. Run it before
 * settling: a payment with any other nonce would move the buyer's money and never release the key.
 * Throws `PayError` `bad_signature` or `bad_requirements`.
 */
export function checkPayment(
  header: string,
  pr: PaymentRequired,
  now: number = Math.floor(Date.now() / 1000),
): CheckedPayment {
  const p = readPayload(header);
  const offer = pr.accepts.find((o) => same(o, p.accepted));
  if (!offer)
    return fail('bad_requirements', 'the payment is for an offer this server did not make');
  const sent = p.extensions?.annon?.info ?? {};
  const advertised = pr.extensions?.annon?.info ?? {};
  for (const [k, v] of Object.entries(advertised)) {
    if (!same(sent[k], v)) fail('bad_requirements', `the annon extension changed ${k}`);
  }
  // payment-identifier: optional; when sent, the advertised object with only `info.id` added.
  const declared = pr.extensions?.[PAYMENT_IDENTIFIER] as
    | ({ info?: Record<string, unknown> } & Record<string, unknown>)
    | undefined;
  const echoed = p.extensions?.[PAYMENT_IDENTIFIER];
  if (echoed !== undefined) {
    const { id: _, ...info } = echoed?.info ?? {};
    if (!declared || !same({ ...echoed, info }, declared)) {
      fail('bad_requirements', 'the payment-identifier extension is not the one advertised');
    }
  }
  const paymentId = paymentIdOf(p);
  if (declared?.info?.required === true && !paymentId) {
    fail('bad_requirements', 'this server requires a payment id');
  }
  checkBuilderCode(pr, p);
  const c = checkSigned(p, String(advertised.contract), String(advertised.fileId), offer);
  // The contract counts a payment up to 300 s after a stop. A buyer's client could sign for longer;
  // this server settles only authorizations short enough to stay inside that, whoever made them.
  if (c.validBefore > BigInt(now + MAX_VALIDITY_SECONDS + MAX_CLOCK_SKEW_SECONDS)) {
    fail('bad_requirements', 'the authorization is valid for too long');
  }
  return { ...c, ...(paymentId ? { paymentId } : {}) };
}

/** builder-code (profile section 11): the declared app code and every declared service code echoed. */
function checkBuilderCode(pr: PaymentRequired, p: Payload) {
  const declared = (pr.extensions?.[BUILDER_CODE] as { info?: { a?: unknown; s?: unknown } })?.info;
  const sent = p.extensions?.[BUILDER_CODE];
  const echo = () => fail('bad_requirements', 'extension_echo_mismatch: builder-code');
  if (sent === undefined) {
    if (pr.extensions?.[BUILDER_CODE] !== undefined) echo();
    return;
  }
  const info = (sent?.info ?? {}) as { a?: unknown; s?: unknown; w?: unknown };
  if (info.a !== undefined && info.a !== declared?.a) echo();
  if (declared?.a !== undefined && info.a !== declared.a) echo();
  if (info.w !== undefined) echo();
  const s = codes(info.s);
  const mine = codes(declared?.s);
  if (
    s.length > MAX_ECHOED_SERVICE_CODES ||
    !s.every((c) => typeof c === 'string' && BUILDER_CODE_PATTERN.test(c)) ||
    !mine.every((c) => s.includes(c))
  ) {
    echo();
  }
}

/**
 * A checked `annon-exact` payment as a standard x402 facilitator's `/verify` and `/settle` take it:
 * the same signed authorization, every extension kept, with the scheme named `exact` in both the
 * payload and the requirements (the official facilitator checks both). Run `verifyPayment` first.
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
  // bazaar stays out: a facilitator would catalog the offer renamed `exact`, which an ordinary x402
  // client cannot pay (profile section 11).
  const { [BAZAAR]: _, ...extensions } = (p.extensions ?? {}) as Record<string, unknown>;
  return {
    x402Version: 2 as const,
    paymentPayload: {
      ...p,
      accepted: paymentRequirements,
      ...(p.extensions ? { extensions } : {}),
    },
    paymentRequirements,
  };
}
