import { buildPurchaseMessage, type Purchase, purchaseId } from '../settle-near/purchase.js';
/**
 * The x402 v2 envelope of an Annon purchase (`specs/x402-annon.md`): reading the `PAYMENT-REQUIRED`
 * header, finding the file it sells, and building the `PAYMENT-SIGNATURE` header. Nothing read here
 * is trusted: `preflight` compares it with the contract.
 */
import { fail } from './base.js';
import type { Authorization } from './eip3009.js';

/** CAIP-2 id of Base mainnet. */
export const BASE_NETWORK = 'eip155:8453';
/**
 * The scheme of an Annon offer: plain EIP-3009 `TransferWithAuthorization` to the file's `pay_to`,
 * under its own name so a client without Annon has no handler for it and signs nothing (checked
 * against the official x402 client: it signs any `exact` offer with a random nonce, which could
 * never release the key). The seller settles it through any standard facilitator as `exact`
 * (`forFacilitator`): the scheme label is not part of what the buyer signs.
 */
export const ANNON_EXACT = 'annon-exact';
export const ANNON_NEAR_USDC = 'annon-near-usdc';
/** The x402 idempotency extension (profile section 10). */
export const PAYMENT_IDENTIFIER = 'payment-identifier';

/** As the x402 extension declares it, optional: the official `declarePaymentIdentifierExtension`. */
export const paymentIdentifierDeclaration = () => ({
  info: { required: false },
  schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      required: { type: 'boolean' },
      id: { type: 'string', minLength: 16, maxLength: 128, pattern: '^[a-zA-Z0-9_-]+$' },
    },
    required: ['required'],
  },
});

/** x402 builder codes (ERC-8021 attribution); the Annon SDK's own service code. */
export const BUILDER_CODE = 'builder-code';
export const ANNON_SERVICE_CODE = 'bc_lq0mq0v9';
export const BUILDER_CODE_PATTERN = /^[a-z0-9_]{1,32}$/;
/** At most this many service codes echoed by a client: its 5 and the server's 5. */
export const MAX_ECHOED_SERVICE_CODES = 10;
/** Service codes as a list: the extension allows one code as a plain string. */
export const codes = (s: unknown): unknown[] => (s === undefined ? [] : Array.isArray(s) ? s : [s]);

/** x402 discovery (profile section 11); never sent to a facilitator. */
export const BAZAAR = 'bazaar';

/** A payment id the extension allows: 16 to 128 letters, digits, `-` and `_`. */
export const isPaymentId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(id);

/** Contracts the SDK trusts without being told: the one Annon deployment on NEAR mainnet. */
export const TRUSTED_CONTRACTS: readonly string[] = [];

export interface Offer {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

/** `extensions.annon` as a server advertises it. */
export interface AnnonExtension {
  info: {
    version?: unknown;
    network?: unknown;
    contract?: unknown;
    fileId?: unknown;
    header?: unknown;
    download?: unknown;
    public?: unknown;
  };
  schema?: unknown;
}

export interface PaymentRequired {
  x402Version: 2;
  resource?: unknown;
  accepts: Offer[];
  extensions?: { annon?: AnnonExtension } & Record<string, unknown>;
}

const utf8 = new TextEncoder();
const b64encode = (s: string) => {
  let bin = '';
  for (const b of utf8.encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
};
const b64decode = (s: string) =>
  new TextDecoder('utf-8', { fatal: true }).decode(
    Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
  );

/** The `PAYMENT-REQUIRED` header (base64 JSON), with only its shape checked. */
export function readPaymentRequired(header: string): PaymentRequired {
  let v: { x402Version?: unknown; accepts?: unknown };
  try {
    v = JSON.parse(b64decode(header.trim()));
  } catch {
    return fail('bad_requirements', 'PAYMENT-REQUIRED is not base64 JSON');
  }
  if (v?.x402Version !== 2 || !Array.isArray(v.accepts)) {
    return fail('bad_requirements', 'not an x402 v2 payment request');
  }
  return v as PaymentRequired;
}

/**
 * The Annon contract and file a payment request sells, from its `annon` extension. Only a
 * contract in `trusted` (by default `TRUSTED_CONTRACTS`) is ever returned.
 */
export function discover(
  pr: PaymentRequired,
  trusted: readonly string[] = TRUSTED_CONTRACTS,
): { contractId: string; fileId: string } {
  const info = pr.extensions?.annon?.info;
  if (!info) return fail('file_mismatch', 'the payment request names no Annon file');
  if (info.version !== 3 || info.network !== 'near:mainnet') {
    fail('file_mismatch', 'the Annon extension is not version 3 on NEAR mainnet');
  }
  if (typeof info.contract !== 'string' || !trusted.includes(info.contract)) {
    fail(
      'untrusted_contract',
      `the Annon contract ${String(info.contract)} is not one this client trusts`,
    );
  }
  if (typeof info.fileId !== 'string' || !/^0x[0-9a-f]{64}$/.test(info.fileId)) {
    fail('file_mismatch', 'the Annon extension has no valid fileId');
  }
  return { contractId: info.contract as string, fileId: info.fileId as string };
}

/**
 * The `PAYMENT-SIGNATURE` header: the chosen offer echoed, the EIP-3009 authorization, and the
 * `annon` extension echoed with the buyer's one-time key, from which the server recomputes the
 * nonce before it settles. With `paymentId`, the advertised `payment-identifier` gets its id.
 */
export function paymentSignature(
  pr: PaymentRequired,
  offer: Offer,
  a: Authorization,
  signature: string,
  purchase: Purchase,
  paymentId?: string,
): string {
  const pid = pr.extensions?.[PAYMENT_IDENTIFIER] as { info?: object } | undefined;
  // As x402's client merge: the Annon SDK's code first, then the declared codes, no duplicates.
  const bc = pr.extensions?.[BUILDER_CODE] as
    | ({ info?: { s?: unknown } } & Record<string, unknown>)
    | undefined;
  const declaredS = codes(bc?.info?.s);
  const builderCode = {
    ...(bc ?? {}),
    info: { ...(bc?.info ?? {}), s: [...new Set([ANNON_SERVICE_CODE, ...declaredS])] },
  };
  const advertised = pr.extensions?.annon;
  buildPurchaseMessage(purchase);
  const info = {
    ...(advertised?.info ?? {}),
    version: 3,
    network: 'near:mainnet',
    contract: purchase.contract,
    fileId: purchase.file_id,
    purchase,
    purchase_id: purchaseId(purchase),
  };
  return b64encode(
    JSON.stringify({
      x402Version: 2,
      ...(pr.resource === undefined ? {} : { resource: pr.resource }),
      accepted: offer,
      payload: {
        signature,
        authorization: {
          from: a.from,
          to: a.to,
          value: a.value.toString(),
          validAfter: a.validAfter.toString(),
          validBefore: a.validBefore.toString(),
          nonce: a.nonce,
        },
      },
      extensions: {
        ...(pr.extensions ?? {}),
        annon: { ...(advertised ?? {}), info },
        ...(pid && paymentId
          ? { [PAYMENT_IDENTIFIER]: { ...pid, info: { ...pid.info, id: paymentId } } }
          : {}),
        [BUILDER_CODE]: builderCode,
      },
    }),
  );
}
