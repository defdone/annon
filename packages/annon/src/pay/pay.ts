/**
 * Paying for an Annon file on Base: the checks before the buyer's wallet is asked anything, then
 * the EIP-3009 signature, checked and dry-run against USDC before it leaves the client.
 *
 * Every value the buyer signs comes from the Annon contract, never from the payment request: the
 * request is only compared against it. The host can make the purchase fail, not misdirect it.
 */
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { type FileInfo, getConfig, getFile, isBuyer } from '../near/rpc.js';
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
  annonNonce,
  digest,
  signer as recover,
  type TypedData,
  toHex,
  typedData,
} from './eip3009.js';
import {
  ANNON_EXACT,
  BASE_NETWORK,
  type Offer,
  type PaymentRequired,
  paymentSignature,
} from './x402.js';

/**
 * Signatures stay valid at most this long, whatever the request allows. With the clock margin
 * below it stays inside the contract's 300 s after a stop (`STOP_SETTLEMENT_SECONDS`), so an
 * authorization made while the file was on sale can't be settled into a payment without a key.
 */
export const MAX_VALIDITY_SECONDS = 180;
/** How far the Base RPC's clock may be from ours. */
export const MAX_CLOCK_SKEW_SECONDS = 60;

export interface PreflightOptions {
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
  /** USDC base units: refused above it. */
  maxPrice: bigint;
  /** Moderators the buyer trusts to take a file down. A file with any other is refused. */
  moderators?: readonly string[];
}

/** A purchase that passed every check, ready to sign. */
export interface Quote {
  nearRpc: string;
  baseRpc: string;
  contractId: string;
  fileId: string;
  buyer: string;
  seller: string;
  /** The registered `pay_to`. */
  to: string;
  usdc: string;
  price: bigint;
  /** What the request allows; capped at `MAX_VALIDITY_SECONDS`. */
  validity: number;
  file: FileInfo;
  paymentRequired: PaymentRequired;
  offer: Offer;
}

const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : undefined);
const isAddress = (v: unknown) => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);

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

  const to = file.payTo;
  // Facilitators take the EIP-712 domain from the offer, so it must be there and be USDC's.
  if (lower(req.asset) !== config.usdc || extra.name !== 'USD Coin' || extra.version !== '2') {
    fail('token_mismatch', 'the payment request is not for USDC on Base');
  }
  const method = extra.assetTransferMethod;
  if (method !== undefined && method !== 'eip3009') {
    fail('method_mismatch', `the offer is not a plain Annon transfer`);
  }
  // x402 v2 section 6.1: never sign for a payment flow the client doesn't know.
  if (extra.paymentFlow !== undefined && extra.paymentFlow !== 'authorization') {
    fail('method_mismatch', `unsupported payment flow ${String(extra.paymentFlow)}`);
  }
  if (lower(req.payTo) !== to) {
    fail('recipient_mismatch', 'the payment request pays an address the registration does not');
  }
  if (BigInt(req.amount) !== file.price) {
    fail('price_mismatch', 'the payment request asks a different price than the registration');
  }
  if (file.price > o.maxPrice) fail('price_above_max', 'the price is above your limit');
  if (await isBuyer(o.nearRpc, o.contractId, o.fileId, buyer)) {
    fail('already_bought', 'this wallet already bought the file; open it again instead');
  }

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
  };
}

/**
 * Saved before the wallet signs, holds nothing secret. Whatever happens to the client after the
 * signature, it finds the payment (`status`) and gets the key (`unlock` with `buyerKey`).
 */
export interface PaymentJob {
  contractId: string;
  fileId: string;
  buyer: string;
  seller: string;
  /** The registered `pay_to`. */
  to: string;
  usdc: string;
  price: string;
  /** The one-time key the nonce commits to, 0x and 48 bytes. */
  buyerKey: string;
  /** The nonce signed: `annonNonce(contractId, fileId, buyerKey)`. */
  nonce: string;
  validBefore: string;
  /** The Base head when it was signed. */
  block: number;
  signedAt: number;
}

export interface Wallet {
  address: string;
  /** EIP-712, as viem's `signTypedData`: returns the 65-byte signature as 0x hex. */
  signTypedData(t: TypedData): Promise<string>;
}

export interface AuthorizeOptions {
  /** The buyer's one-time G1 key (`OneTimeKey.publicKeyBytes`). */
  buyerKey: Uint8Array;
  wallet: Wallet;
  /** Must keep the job durably (and hand it to the relayer) before it resolves. */
  persist(job: PaymentJob): Promise<void>;
}

/** The authorization a job signs. */
export const authorizationOf = (j: PaymentJob): Authorization => ({
  from: j.buyer,
  to: j.to,
  value: BigInt(j.price),
  validAfter: 0n,
  validBefore: BigInt(j.validBefore),
  nonce: j.nonce,
});

/**
 * Asks the wallet to sign and returns the `PAYMENT-SIGNATURE` header. The job is saved first; the
 * signature is checked to be the buyer's, in the form USDC takes, and run against USDC before it
 * is returned.
 */
export async function authorize(
  q: Quote,
  o: AuthorizeOptions,
): Promise<{ header: string; job: PaymentJob }> {
  if (lower(o.wallet.address) !== q.buyer)
    throw new TypeError('the wallet is not the buyer the quote was made for');
  // Exactly the 48-byte compressed form `unlock` takes: the nonce hashes these bytes. The
  // identity would make NEAR's answer the key itself, readable by anyone in the transaction.
  let point: InstanceType<typeof bls.G1.Point> | undefined;
  try {
    if (o.buyerKey.length === 48) point = bls.G1.Point.fromBytes(o.buyerKey);
  } catch {}
  if (!point || point.is0()) {
    throw new TypeError('buyerKey must be a one-time G1 key, 48 bytes compressed');
  }
  // Both clocks are read, and checked against each other, before the registration: however long the
  // reads below stall, and even if a clock is corrected meanwhile, the deadline stays within 180 s
  // of a moment the file was still on sale (the contract allows 300 after a stop).
  const h = await head(q.baseRpc);
  const local = Math.floor(Date.now() / 1000);
  if (Math.abs(h.timestamp - local) > MAX_CLOCK_SKEW_SECONDS) {
    fail('transport', 'the Base RPC is not at the current time; its deadline would be wrong');
  }
  // The quote may be old: the file must still be for sale on the same terms.
  const now = await forSale(q.nearRpc, q.contractId, q.fileId);
  if (
    now.seller !== q.seller ||
    now.price !== q.price ||
    now.payTo !== q.file.payTo ||
    now.moderator !== q.file.moderator
  ) {
    fail('price_mismatch', 'the registration changed since the quote; check it again');
  }
  const annon = annonNonce(q.contractId, q.fileId, o.buyerKey);
  // The search for the payment starts at the finalized block: a reorg or a lying RPC can't put the
  // payment below it.
  const final = await block(q.baseRpc, 'finalized');
  const job: PaymentJob = {
    contractId: q.contractId,
    fileId: q.fileId,
    buyer: q.buyer,
    seller: q.seller,
    to: q.to,
    usdc: q.usdc,
    price: q.price.toString(),
    buyerKey: toHex(o.buyerKey),
    nonce: annon,
    // The earliest reading: no clock and no stall can stretch the window.
    validBefore: (Math.min(h.timestamp, local) + q.validity).toString(),
    block: Math.min(final.number, h.number),
    signedAt: Math.min(h.timestamp, local),
  };
  await o.persist(job);

  const a = authorizationOf(job);
  const signature = await o.wallet.signTypedData(typedData(q.usdc, a));
  if (typeof signature !== 'string' || recover(digest(q.usdc, a), signature) !== q.buyer) {
    fail('bad_signature', 'the wallet did not return a plain signature from the buyer');
  }
  try {
    await dryRun(q.baseRpc, q.usdc, a, signature);
  } catch (e) {
    // The RPC has seen a valid authorization: it can still land, so the caller keeps the job.
    if (e instanceof PayError) e.job = job;
    throw e;
  }
  return {
    header: paymentSignature(q.paymentRequired, q.offer, a, signature, {
      contractId: q.contractId,
      fileId: q.fileId,
      buyerKey: job.buyerKey,
    }),
    job,
  };
}

/** Where a saved job stands on Base. */
export const status = (baseRpc: string, j: PaymentJob): Promise<PaymentStatus> =>
  paymentStatus(baseRpc, {
    ...j,
    from: j.buyer,
    price: BigInt(j.price),
    validBefore: BigInt(j.validBefore),
  });
