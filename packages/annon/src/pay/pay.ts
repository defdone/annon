import { usdc } from '../settle-near/codec.js';
/**
 * Paying for an Annon file on Base: the checks before the buyer's wallet is asked anything, then
 * the EIP-3009 signature, checked and dry-run against USDC before it leaves the client.
 *
 * Every value the buyer signs comes from the Annon contract, never from the payment request: the
 * request is only compared against it. The host can make the purchase fail, not misdirect it.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { sameResource } from '../download/proof.js';
import { type Inspected, inspect, inspectHeader, Pay2Error } from '../envelope/pay2.js';
import { keyFromSecret } from '../keys/near-ckd.js';
import { type FileInfo, getConfig, getFile } from '../near/rpc.js';
import type { Identity } from '../settle-near/identity.js';
import {
  baseNonceV2,
  buildPurchaseMessage,
  type Purchase,
  purchaseId,
} from '../settle-near/purchase.js';
import {
  balanceOf,
  block,
  dryRun,
  fail,
  hasCode,
  head,
  PayError,
  type PaymentStatus,
  paymentStatus,
} from './base.js';
import {
  type Authorization,
  digest,
  signer as recover,
  type TypedData,
  toHex,
  typedData,
} from './eip3009.js';
import {
  bounds,
  type PaymentAttempt,
  type PurchaseRecord,
  purchaseKey,
  randomHex,
} from './purchase.js';
import type { Store } from './store.js';
import {
  ANNON_EXACT,
  BASE_NETWORK,
  type Offer,
  PAYMENT_IDENTIFIER,
  type PaymentRequired,
  paymentSignature,
} from './x402.js';

/** Bound the lifetime of an outstanding payment authorization. */
export const MAX_VALIDITY_SECONDS = 180;
/** How far the Base RPC's clock may be from ours. */
export const MAX_CLOCK_SKEW_SECONDS = 60;

interface PreflightOptions {
  nearRpc: string;
  baseRpc: string;
  /** The Annon contract the client trusts. */
  contractId: string;
  /** The file being bought, 0x and 32 bytes, from the link, not from the payment request. */
  fileId: string;
  /** The wallet that pays and later opens the file. */
  buyer: string;
  /** The 402's `PAYMENT-REQUIRED`, read with `readPaymentRequired`. */
  paymentRequired: PaymentRequired;
  /**
   * The URL of the request that got that 402. Its `resource.url` must be this URL, so the buyer
   * proof is never made for a URL another endpoint advertised (download.md section 3).
   */
  url: string;
  /**
   * The PAY2 header served at `extensions.annon.info.header`; the whole file when the offer says
   * `public`. Checked against the registration before anything is signed (x402-annon.md section 7).
   */
  pay2: Uint8Array;
  /** USDC base units: refused above it. */
  maxPrice: bigint;
  /** Moderators the buyer trusts to take a file down. A file with any other is refused. */
  moderators?: readonly string[];
}

/** A purchase that passed every check, ready to sign. */
interface Quote {
  nearRpc: string;
  baseRpc: string;
  contractId: string;
  fileId: string;
  buyer: string;
  seller: Identity;
  /** The registered `pay_to`. */
  to: string;
  usdc: string;
  price: bigint;
  /** What the request allows; capped at `MAX_VALIDITY_SECONDS`. */
  validity: number;
  file: FileInfo;
  paymentRequired: PaymentRequired;
  offer: Offer;
  /** The checked PAY2 header; `authorize` checks it again and the download names its hash. */
  header: Uint8Array;
}

const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : undefined);
const isAddress = (v: unknown) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);

/**
 * Profile section 7: the header (or, for a public body, the whole file) is the registered file,
 * signed by its seller, with a key stanza for this contract. Before any signature.
 */
async function checkPay2(
  pay2: Uint8Array,
  wholeFile: boolean,
  contractId: string,
  fileId: string,
  file: FileInfo,
): Promise<Inspected> {
  const listing = {
    fileId,
    cipherHash: file.cipherHash,
    seller: file.seller,
    ...(file.headerHash ? { publishedHeaderHash: file.headerHash } : {}),
  };
  let r: Inspected;
  try {
    r = await (wholeFile ? inspect : inspectHeader)(pay2, listing, contractId);
  } catch (e) {
    if (e instanceof Pay2Error)
      return fail('file_invalid', `the PAY2 file failed its check: ${e.code}`);
    throw e;
  }
  if (!r.usable) fail('file_invalid', 'the PAY2 header has no key for this contract');
  return r;
}

/** The registration, if the file can still be bought. */
async function forSale(nearRpc: string, contractId: string, fileId: string): Promise<FileInfo> {
  const file = await getFile(nearRpc, contractId, fileId);
  if (!file) return fail('unknown_file', 'the file is not registered on the Annon contract');
  if (file.takenDown) fail('taken_down', `the file was taken down (${file.takenDown})`);
  if (file.salesStoppedAt !== null) fail('sales_stopped', 'the seller stopped selling this file');
  return file;
}

/** Every check that can refuse a purchase before the wallet is asked to sign. */
export async function preflight(o: PreflightOptions): Promise<Quote> {
  if (!/^0x[0-9a-f]{64}$/.test(o.fileId))
    throw new TypeError('fileId must be 0x and 32 bytes of lowercase hex');
  if (!isAddress(o.buyer)) throw new TypeError('buyer must be a 0x EVM address');
  const buyer = o.buyer.toLowerCase();

  // The payment request: only its own shape here; its values are compared with the contract below.
  const pr = o.paymentRequired;
  const named = (pr?.resource as { url?: unknown } | undefined)?.url;
  if (typeof named !== 'string' || !sameResource(named, o.url)) {
    fail('bad_requirements', 'resource.url is not the URL that answered with this 402');
  }
  const offers = (Array.isArray(pr?.accepts) ? pr.accepts : []).filter(
    (a) => a?.scheme === ANNON_EXACT && a?.network === BASE_NETWORK,
  );
  const [req] = offers;
  if (offers.length !== 1 || !req) return fail('network_mismatch', 'no single Annon offer on Base');
  const extra = (req.extra ?? {}) as {
    name?: unknown;
    version?: unknown;
    assetTransferMethod?: unknown;
    paymentFlow?: unknown;
    splits?: unknown;
  };
  // The extension is optional; when present it must name the file being bought.
  const info = pr.extensions?.annon?.info;
  if (info && (info.contract !== o.contractId || lower(info.fileId) !== o.fileId)) {
    fail('file_mismatch', 'the payment request is for another Annon contract or file');
  }
  const timeout = req.maxTimeoutSeconds;
  if (!Number.isSafeInteger(timeout) || (timeout as number) < 1) {
    fail('bad_requirements', 'maxTimeoutSeconds must be a positive integer');
  }
  if (typeof req.amount !== 'string' || !/^\d{1,78}$/.test(req.amount)) {
    fail('bad_requirements', 'amount must be a decimal string');
  }

  // The registration.
  const file = await forSale(o.nearRpc, o.contractId, o.fileId);
  if (file.moderator !== null && !(o.moderators ?? []).includes(file.moderator)) {
    fail('unknown_moderator', `the file's moderator ${file.moderator} is not one you trust`);
  }
  const config = await getConfig(o.nearRpc, o.contractId);
  if (
    file.terms.network !== config.network ||
    file.terms.near.token !== config.nearUsdc ||
    (file.terms.base && file.terms.base.usdc !== config.usdc)
  )
    fail('network_mismatch');
  if (!(o.pay2 instanceof Uint8Array)) throw new TypeError('pay2 must be the PAY2 header bytes');
  const checked = await checkPay2(o.pay2, info?.public === true, o.contractId, o.fileId, file);

  if (!file.terms.base) fail('method_mismatch', 'the file has no Base route');
  const to = file.payTo;
  // Facilitators take the EIP-712 domain from the offer, so it must be there and be USDC's.
  if (lower(req.asset) !== config.usdc || extra.name !== 'USD Coin' || extra.version !== '2') {
    fail('token_mismatch', 'the payment request is not for USDC on Base');
  }
  const method = extra.assetTransferMethod;
  if (method !== undefined && method !== 'eip3009') {
    fail('method_mismatch', `the offer is not a plain Annon transfer`);
  }
  // Extension v3 settles before serving and accepts only the commitment nonce.
  const flow = extra.paymentFlow;
  if (info?.version !== 3 || req.extra?.nonceVersion !== 2 || flow !== 'upfront') {
    fail('method_mismatch', `unsupported payment flow ${String(extra.paymentFlow)}`);
  }
  // A split in the payment itself would take part of it away from the registered pay_to.
  if (extra.splits !== undefined && !(Array.isArray(extra.splits) && extra.splits.length === 0)) {
    fail('method_mismatch', 'the offer splits the payment; Annon pays the registered pay_to only');
  }
  if (lower(req.payTo) !== to) {
    fail('recipient_mismatch', 'the payment request pays an address the registration does not');
  }
  if (BigInt(req.amount) !== file.price) {
    fail('price_mismatch', 'the payment request asks a different price than the registration');
  }
  if (file.price > o.maxPrice) fail('price_above_max', 'the price is above your limit');
  // The buyer's wallet on Base.
  const h = await head(o.baseRpc);
  if (await hasCode(o.baseRpc, buyer, h.number)) {
    fail(
      'smart_wallet_unsupported',
      'the wallet is a contract or delegated (EIP-7702); pay from a plain account',
    );
  }
  if ((await balanceOf(o.baseRpc, config.usdc, buyer, h.number)) < file.price) {
    fail('insufficient_balance', 'not enough USDC on Base');
  }

  return {
    nearRpc: o.nearRpc,
    baseRpc: o.baseRpc,
    contractId: o.contractId,
    fileId: o.fileId,
    buyer,
    seller: file.seller,
    to,
    usdc: config.usdc,
    price: file.price,
    validity: Math.min(timeout as number, MAX_VALIDITY_SECONDS),
    file,
    paymentRequired: pr,
    offer: req,
    header: checked.header,
  };
}

interface Wallet {
  address: string;
  /** EIP-712, as viem's `signTypedData`: returns the 65-byte signature as 0x hex. */
  signTypedData(t: TypedData): Promise<string>;
}

interface AuthorizeOptions {
  /** The canonical purchase binding its terms, buyer key, refund and recovery identities. */
  purchase: Purchase;
  buyerSecret: Uint8Array;
  wallet: Wallet;
  /** Where the purchase is recorded by purchase_id (x402-annon.md section 5). */
  store: Store<PurchaseRecord>;
}

/** The authorization an attempt signs. */
const authorizationOf = (
  r: PurchaseRecord,
  attempt: PaymentAttempt = r.attempts[0] as PaymentAttempt,
): Authorization => ({
  from: r.terms.buyer,
  to: r.terms.to,
  value: BigInt(r.terms.price),
  validAfter: 0n,
  validBefore: BigInt(attempt.validBefore),
  nonce: r.terms.nonce,
});

/**
 * Asks the wallet to sign and returns the `PAYMENT-SIGNATURE` header. The purchase is recorded
 * first (refused if this purchase_id already has a record); the signature is checked
 * to be the buyer's, in the form USDC takes; the payload is recorded, and only then run against
 * USDC and returned.
 */
export async function authorize(
  q: Quote,
  o: AuthorizeOptions,
): Promise<{ header: string; purchase: PurchaseRecord }> {
  if (lower(o.wallet.address) !== q.buyer)
    throw new TypeError('the wallet is not the buyer the quote was made for');
  const p = o.purchase;
  const id = purchaseId(p, { baseUsdc: q.usdc });
  const message = buildPurchaseMessage(p, { baseUsdc: q.usdc });
  if (
    p.route !== 'base-usdc' ||
    p.contract !== q.contractId ||
    p.file_id !== q.fileId ||
    p.terms_hash !== q.file.termsHash ||
    p.price !== q.price.toString() ||
    p.asset !== q.usdc ||
    toHex(keyFromSecret(o.buyerSecret).publicKeyBytes) !== p.buyer_key ||
    BigInt(p.expires_at) <= BigInt(Math.floor(Date.now() / 1000))
  )
    throw new TypeError('purchase does not match the checked quote/key');
  // Both clocks are read, and checked against each other, before the registration: however long the
  // reads below stall, and even if a clock is corrected meanwhile, the deadline stays within 180 s
  // of a moment the file was still on sale (a stop must be checked again before settlement).
  const h = await head(q.baseRpc);
  const local = Math.floor(Date.now() / 1000);
  if (Math.abs(h.timestamp - local) > MAX_CLOCK_SKEW_SECONDS) {
    fail('transport', 'the Base RPC is not at the current time; its deadline would be wrong');
  }
  // The quote may be old: the file must still be for sale on the same terms.
  const now = await forSale(q.nearRpc, q.contractId, q.fileId);
  if (
    now.termsHash !== q.file.termsHash ||
    now.price !== q.price ||
    now.payTo !== q.file.payTo ||
    now.moderator !== q.file.moderator ||
    now.cipherHash !== q.file.cipherHash
  ) {
    fail('price_mismatch', 'the registration changed since the quote; check it again');
  }
  // Never sign without a checked header, even for a quote not made by `preflight`.
  await checkPay2(q.header, false, q.contractId, q.fileId, now);
  // The search for the payment starts at the finalized block: a reorg or a lying RPC can't put the
  // payment below it.
  const final = await block(q.baseRpc, 'finalized');
  const start = Math.min(h.timestamp, local);
  const created: PurchaseRecord = {
    schemaVersion: 2,
    recoveryProved: false,
    payment: {
      route: 'base',
      amountUsdc: usdc(q.price),
      amountBaseUnits: q.price.toString(),
      asset: { symbol: 'USDC', id: q.usdc },
      network: BASE_NETWORK,
    },
    id,
    purchase: p,
    message,
    buyerSecret: toHex(o.buyerSecret),
    quote: null,
    recovery: p.recovery,
    checkedHeaderHash: toHex(sha256(q.header)),
    revision: 0,
    terms: {
      network: BASE_NETWORK,
      contractId: q.contractId,
      fileId: q.fileId,
      buyer: q.buyer,
      seller: q.seller,
      to: q.to,
      usdc: q.usdc,
      price: q.price.toString(),
      buyerKey: p.buyer_key,
      nonce: baseNonceV2(id),
      headerHash: toHex(sha256(q.header)),
      cipherHash: q.file.cipherHash,
      moderator: q.file.moderator,
    },
    attempts: [
      {
        attemptId: randomHex(16),
        ...(q.paymentRequired.extensions?.[PAYMENT_IDENTIFIER]
          ? { paymentId: `pay_${randomHex(16)}` }
          : {}),
        preparedAt: start,
        searchFromBlock: Math.min(final.number, h.number),
        // The earliest reading: no clock and no stall can stretch the window.
        validBefore: Math.min(start + q.validity, Number(p.expires_at)).toString(),
        paymentRequired: q.paymentRequired,
      },
    ],
  };
  const key = purchaseKey(id);
  if (!(await o.store.compareAndSet(key, null, created))) {
    fail('purchase_open', 'this wallet has an open purchase of this file: follow its nextStep');
  }
  const attempt = created.attempts[0] as PaymentAttempt;
  const a = authorizationOf(created);
  const signature = await o.wallet.signTypedData(typedData(q.usdc, a));
  if (typeof signature !== 'string' || recover(digest(q.usdc, a), signature) !== q.buyer) {
    fail('bad_signature', 'the wallet did not return a plain signature from the buyer');
  }
  const header = paymentSignature(q.paymentRequired, q.offer, a, signature, p, attempt.paymentId);
  // Recorded before any RPC sees it: a crash from here on can only resend this payload.
  const purchase: PurchaseRecord = {
    ...created,
    revision: 1,
    attempts: [{ ...attempt, payload: header }],
  };
  if (!(await o.store.compareAndSet(key, created, purchase))) {
    const e = new PayError('store_conflict', 'the purchase changed while the wallet signed');
    e.purchase = created;
    throw e;
  }
  try {
    await dryRun(q.baseRpc, q.usdc, a, signature);
  } catch (e) {
    // The RPC has seen a valid authorization: it can still land, so the purchase stays open.
    if (e instanceof PayError) e.purchase = purchase;
    throw e;
  }
  return { header, purchase };
}

/** Where a recorded purchase stands on Base, over all its attempts. */
export const status = (baseRpc: string, r: PurchaseRecord): Promise<PaymentStatus> =>
  paymentStatus(baseRpc, {
    usdc: r.terms.usdc,
    to: r.terms.to,
    from: r.terms.buyer,
    nonce: r.terms.nonce,
    price: BigInt(r.terms.price),
    ...bounds(r),
  });
