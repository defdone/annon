import type { OneClickQuote } from '../oneclick/oneclick.js';
import type { BuyRoute } from '../routes.js';
import type { Identity } from '../settle-near/identity.js';
import type { Purchase } from '../settle-near/purchase.js';
/**
 * A purchase on the buyer's side (x402-annon.md section 5): what is recorded before the wallet signs,
 * and the signed payload recorded before anything else sees it. Records are addressed by purchase commitment; the original grant secret remains available after acceptance.
 */

import type { Versioned } from './store.js';
import type { PaymentRequired } from './x402.js';

/** What the purchase pays for; fixed when it is created. */
interface PurchaseTerms {
  network: string;
  contractId: string;
  fileId: string;
  buyer: string;
  seller: Identity;
  /** The registered `pay_to`. */
  to: string;
  usdc: string;
  price: string;
  /** The one-time key the nonce commits to, 0x and 48 bytes. */
  buyerKey: string;
  /** base_nonce for the purchase commitment. */
  nonce: string;
  /** `SHA256` of the PAY2 header checked before signing (x402-annon.md section 7), 0x and lowercase. */
  headerHash: string;
  cipherHash: string;
  moderator: string | null;
}

/** A saved Base payment authorization attempt. */
export interface PaymentAttempt {
  attemptId: string;
  /** The `payment-identifier` id of its payload, when the server advertised the extension. */
  paymentId?: string;
  /** Unix seconds, before the wallet was asked. */
  preparedAt: number;
  /** The Base block its payment is searched from: finalized when it was prepared. */
  searchFromBlock: number;
  validBefore: string;
  /** The 402 it answers. */
  paymentRequired: PaymentRequired;
  /**
   * The `PAYMENT-SIGNATURE` header: a signed authorization anyone can submit until `validBefore`.
   * Missing when the client stopped between the wallet and this record: then it may be signed.
   */
  payload?: string;
}

export interface SourceAsset {
  chain: string;
  asset: string;
  symbol?: string;
  decimals?: number;
  contractAddress?: string;
}
export interface SourcePayment extends SourceAsset {
  amount: string;
  amountFormatted?: string;
  depositBefore: string;
}
/** Public payment facts, without authorization payloads or deposit destinations. */
export interface PaymentSummary {
  amountUsdc: string;
  amountBaseUnits: string;
  asset: { symbol: 'USDC'; id: string };
  network: string;
  route: BuyRoute;
  source?: SourcePayment;
}

export interface PurchaseRecord extends Versioned {
  schemaVersion: 2;
  /** Durable ownership proof checkpoint. */
  recoveryProved: boolean;
  /** Source details are the reviewed 1Click quote. */
  payment: PaymentSummary;
  nearSubmission?: { state: 'uncertain'; txHash: string };
  paymentState?: 'expired' | 'canceled';
  purchase: Purchase;
  message: string;
  buyerSecret: string;
  quote: OneClickQuote | null;
  recovery: Identity;
  checkedHeaderHash: string;
  terms: PurchaseTerms;
  attempts: PaymentAttempt[];
}

/** Records are addressed by the commitment, independent of the paying wallet. */
export const purchaseKey = (purchaseId: string) => `annon/purchase/${purchaseId}`;

/** What a search over every attempt covers: the earliest start, the latest deadline. */
export function bounds(r: PurchaseRecord): { block: number; validBefore: bigint } {
  if (!r.attempts.length) throw new TypeError('a purchase record has at least one attempt');
  return {
    block: Math.min(...r.attempts.map((a) => a.searchFromBlock)),
    validBefore: r.attempts.reduce(
      (m, a) => (BigInt(a.validBefore) > m ? BigInt(a.validBefore) : m),
      0n,
    ),
  };
}

/** The recorded payload that can still settle by `now`, latest first; null if none can. */
export function resendable(r: PurchaseRecord, now: number): string | null {
  for (const a of [...r.attempts].reverse()) {
    if (a.payload && BigInt(a.validBefore) > BigInt(now)) return a.payload;
  }
  return null;
}

export const randomHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
