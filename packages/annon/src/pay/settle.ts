/**
 * A seller settles each purchase once (profile section 10). Two records in the seller's store: the
 * payment id bound to the payload it first came with, and the purchase `(network, asset, from,
 * nonce)` with its state. The answer always follows the purchase's state now; a purchase the store
 * doesn't know, or whose settlement is unclear, is read from Base by its nonce before anything is
 * decided. Settlement itself goes through the server's facilitator, any standard x402 one.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { getConfig, getFile } from '../near/rpc.js';
import { block, fail, head, PayError, type PaymentStatus, paymentStatus } from './base.js';
import { toHex } from './eip3009.js';
import {
  type CheckedPayment,
  checkTerms,
  forFacilitator,
  type OfferOptions,
  readPayload,
  verifyPayment,
} from './seller.js';
import type { Store, Versioned } from './store.js';
import { BASE_NETWORK, type Offer } from './x402.js';

/** A payment id, bound to the payload it first came with. Kept at least until `keepUntil`. */
export interface IdBinding extends Versioned {
  kind: 'id';
  fingerprint: string;
  /** The payload's `validBefore`: after it, at a finalized block, the payload can't settle. */
  keepUntil: string;
}

/** A purchase and its settlement. */
export interface SellerPurchase extends Versioned {
  kind: 'purchase';
  state: 'processing' | 'submitted' | 'settled' | 'unpaid';
  /** The payload settled, or to settle again. */
  header: string;
  validBefore: string;
  searchFromBlock: number;
  transaction?: string;
  /** Unix seconds: until then a facilitator call may be in flight and nobody calls again. */
  leaseUntil: number;
}

export type SellerRecord = IdBinding | SellerPurchase;

/** What a facilitator's `/settle` answers (x402 v2 `SettleResponse`). */
export interface SettleResponse {
  success: boolean;
  transaction?: string;
  network?: string;
  errorReason?: string;
  payer?: string;
}

/**
 * Posts the body to the facilitator's `/settle` and returns its answer. It must stop when `signal`
 * aborts (pass it to `fetch`): `settle` gives up on the call then, and a later request may call
 * again. A second call of the same payload settles nothing twice (the nonce settles once), but
 * it is a call the facilitator did not need.
 */
export type Facilitator = (
  body: ReturnType<typeof forFacilitator>,
  o: { signal: AbortSignal },
) => Promise<SettleResponse>;

export interface SettleOptions extends OfferOptions {
  baseRpc: string;
  store: Store<SellerRecord>;
  facilitator: Facilitator;
  /**
   * Where payment ids are unique (x402 payment-identifier: the seller and the route). Default:
   * the contract, the file and `url`.
   */
  scope?: string;
  /** How long a facilitator call may take before it is aborted; default 50 s. */
  facilitatorTimeoutMs?: number;
  /**
   * Called with a purchase's record key and payer before its record is first written (after the
   * new-payment checks, or once Base shows the payment), so an index of it is never behind the
   * record. May run more than once for one purchase.
   */
  beforeRecord?: (key: string, payer: string) => Promise<void>;
}

/** The answer to a payload; `paymentResponse` turns it into the `PAYMENT-RESPONSE` a server sends. */
export type Settlement =
  | {
      state: 'settled';
      transaction: string;
      network: typeof BASE_NETWORK;
      payer: string;
      buyerKey: string;
      nonce: string;
    }
  /** `errorReason: "settlement_pending"`: broadcast, not yet at Base safe. Send it again later. */
  | { state: 'pending'; transaction: string; network: typeof BASE_NETWORK };

/** A facilitator call is aborted after this; the lease outlasts it, so no two overlap. */
const FACILITATOR_TIMEOUT_MS = 50_000;
const LEASE_MARGIN_SECONDS = 10;
/** After a facilitator call that did not settle, the next one waits this long. */
export const RETRY_SECONDS = 5;
/** The longest window a payload this seller accepts can have (profile section 4). */
const MAX_WINDOW_SECONDS = 240;

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
        )
      : v;
/** The payload as data, key order aside: the same payload always gives the same fingerprint. */
const fingerprint = (header: string) => {
  const json = new TextDecoder().decode(
    Uint8Array.from(atob(header.trim()), (c) => c.charCodeAt(0)),
  );
  return toHex(sha256(new TextEncoder().encode(JSON.stringify(canonical(JSON.parse(json))))));
};

const now = () => Math.floor(Date.now() / 1000);

/** The first block at or before Unix time `t`, from the head back at about five blocks a second. */
async function blockAt(url: string, t: number): Promise<number> {
  const h = await head(url);
  let n = Math.max(0, h.number - Math.max(0, h.timestamp - t) * 5);
  for (;;) {
    const b = await block(url, n);
    if (b.timestamp <= t || n === 0) return n;
    n = Math.max(0, n - (b.timestamp - t) * 5 - 1);
  }
}

/**
 * Settles a payload, or answers it from the state of its purchase. Throws `PayError`:
 * `taken_down` (410) first, whatever the state; `bad_requirements`, `bad_signature` for a payload
 * whose purchase terms are wrong; `payment_id_conflict` (409); the refusals of `verifyPayment` for
 * a new payment (`sales_stopped`, a deadline too long, a changed offer); `payment_expired` for a
 * purchase that can no longer be paid; `settlement_processing` when it is under way or unclear: send
 * the same payload again later.
 */
/** Where `settle` keeps a purchase: its identity (profile section 10). */
export const purchaseRecordKey = (usdc: string, payer: string, nonce: string) =>
  `annon/seller/purchase/${BASE_NETWORK}/${usdc}/${payer}/${nonce}`;

export async function settle(header: string, o: SettleOptions): Promise<Settlement> {
  const file = await getFile(o.nearRpc, o.contractId, o.fileId);
  if (!file) return fail('unknown_file', 'the file is not registered on the Annon contract');
  if (file.takenDown) fail('taken_down', `the file was taken down (${file.takenDown})`);
  const { usdc } = await getConfig(o.nearRpc, o.contractId);
  const c = checkTerms(header, {
    contractId: o.contractId,
    fileId: o.fileId,
    usdc,
    price: file.price,
    payTo: file.payTo,
    termsHash: file.termsHash,
  });
  const scope = o.scope ?? `${o.contractId}/${o.fileId}/${o.url}`;
  if (c.paymentId) await bind(o, `annon/seller/id/${scope}/${c.paymentId}`, header, c);
  const timeout = o.facilitatorTimeoutMs ?? FACILITATOR_TIMEOUT_MS;
  const lease = Math.ceil(timeout / 1000) + LEASE_MARGIN_SECONDS;
  const key = purchaseRecordKey(usdc, c.payer, c.nonce);
  const payTo = file.payTo;
  const price = file.price;
  const onBase = (r: SellerPurchase) =>
    paymentStatus(o.baseRpc, {
      usdc,
      to: payTo,
      from: c.payer,
      nonce: c.nonce,
      price,
      block: r.searchFromBlock,
      validBefore: BigInt(r.validBefore),
    });
  const answerOf = (r: SellerPurchase): Settlement =>
    r.state === 'settled'
      ? {
          state: 'settled',
          transaction: r.transaction as string,
          network: BASE_NETWORK,
          payer: c.payer,
          buyerKey: c.buyerKey,
          nonce: c.nonce,
        }
      : { state: 'pending', transaction: r.transaction as string, network: BASE_NETWORK };

  /**
   * The answer a record gives without another facilitator call: settled, pending with its hash, or
   * expired; anything else is still being settled.
   */
  const answerFrom = (
    r: SellerPurchase | null,
    why = 'this purchase is being settled',
  ): Settlement => {
    if (r?.state === 'settled' || (r?.state === 'submitted' && r.transaction)) return answerOf(r);
    if (r?.state === 'unpaid')
      return fail('payment_expired', 'this purchase can no longer be paid');
    return fail('settlement_processing', `${why}; send it again shortly`);
  };
  /** After a write that lost: the record that won decides the answer. */
  const winner = async () => answerFrom((await o.store.load(key)) as SellerPurchase | null);

  /** The purchase as Base shows it, written to the store; null if another writer came first. */
  const fromChain = async (r: SellerPurchase | null, s: PaymentStatus, base: SellerPurchase) => {
    let next: SellerPurchase;
    if (s.state === 'paid') {
      // Settled only if the payment's own block is on the chain at or below Base safe: its height
      // alone could belong to a block a reorg replaced.
      const safe = await block(o.baseRpc, 'safe');
      const log = s.logs[0];
      const canonical =
        log && log.block_number <= safe.number ? await block(o.baseRpc, log.block_number) : null;
      const onSafe = !!log && canonical?.hash === `0x${log.block_hash}`;
      next = { ...base, state: onSafe ? 'settled' : 'submitted', transaction: s.txHash };
    } else {
      next = { ...base, state: 'unpaid' };
    }
    next = { ...next, revision: r ? r.revision + 1 : 0, leaseUntil: base.leaseUntil };
    // A purchase first seen already on Base is recorded here: indexed first, as in the loop.
    if (!r) await o.beforeRecord?.(key, c.payer);
    if (!(await o.store.compareAndSet(key, r, next))) return null;
    if (next.state === 'unpaid') fail('payment_expired', 'this purchase can no longer be paid');
    return answerOf(next);
  };

  for (let tries = 0; tries < 4; tries++) {
    const r = (await o.store.load(key)) as SellerPurchase | null;
    if (r?.state === 'settled') return answerOf(r);
    if (r?.state === 'unpaid')
      return fail('payment_expired', 'this purchase can no longer be paid');
    // A purchase already recorded is settled with its recorded payload, never another one: another
    // payload of the same nonce has not passed the checks of a new payment (profile section 10).
    const base: SellerPurchase = {
      kind: 'purchase',
      id: key,
      revision: 0,
      state: 'processing',
      header: r ? r.header : header,
      validBefore: r ? r.validBefore : c.validBefore.toString(),
      searchFromBlock:
        r?.searchFromBlock ??
        (await blockAt(o.baseRpc, Number(c.validBefore) - MAX_WINDOW_SECONDS)),
      leaseUntil: 0,
      ...(r?.transaction ? { transaction: r.transaction } : {}),
    };
    const s = await onBase(base);
    if (s.state !== 'pending') {
      const answer = await fromChain(r, s, { ...base, leaseUntil: r?.leaseUntil ?? 0 });
      if (answer) return answer;
      continue;
    }
    // Another request's facilitator call may be running: not a second one now.
    if (r && r.leaseUntil > now()) return answerFrom(r);
    // A purchase never seen before is a new payment: every check of section 4.
    if (!r) {
      await verifyPayment(header, o);
      await o.beforeRecord?.(key, c.payer);
    }
    const claimed: SellerPurchase = {
      ...base,
      revision: r ? r.revision + 1 : 0,
      state: r?.state ?? 'processing',
      leaseUntil: now() + lease,
    };
    if (!(await o.store.compareAndSet(key, r, claimed))) continue;
    // The lease started before the write: what is left of it, less the margin, bounds the call.
    const left = (claimed.leaseUntil - LEASE_MARGIN_SECONDS - now()) * 1000;
    if (left <= 0) return answerFrom(claimed);
    return submit(claimed, Math.min(timeout, left));
  }
  // Every write lost to another request: its record decides the answer.
  return winner();

  async function submit(r: SellerPurchase, budget: number): Promise<Settlement> {
    let res: SettleResponse | undefined;
    // The recorded payload with its own offer, exactly as it was accepted.
    const offer = readPayload(r.header).accepted as Offer;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('facilitator timed out')), budget);
    try {
      res = await Promise.race([
        o.facilitator(forFacilitator(r.header, offer), { signal: abort.signal }),
        new Promise<never>((_, no) =>
          abort.signal.addEventListener('abort', () => no(abort.signal.reason)),
        ),
      ]);
    } catch {
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
    const hash = res?.transaction;
    if (hash && (res?.success || res?.errorReason === 'settlement_pending')) {
      const submitted: SellerPurchase = {
        ...r,
        revision: r.revision + 1,
        state: 'submitted',
        transaction: hash,
      };
      if (!(await o.store.compareAndSet(key, r, submitted))) return winner();
      const s = await onBase(submitted);
      if (s.state === 'pending') return answerOf(submitted);
      return (await fromChain(submitted, s, submitted)) ?? winner();
    }
    // Unclear or refused: Base is still read on every request, but the facilitator is called
    // again only after RETRY_SECONDS, the Retry-After a host sends, so retries and repeated downloads can't
    // turn one purchase into a call per request. A purchase already broadcast keeps its answer:
    // pending, with its hash.
    const released = { ...r, revision: r.revision + 1, leaseUntil: now() + RETRY_SECONDS };
    if (!(await o.store.compareAndSet(key, r, released))) return winner();
    return answerFrom(
      released,
      `the facilitator did not settle it${res?.errorReason ? ` (${res.errorReason})` : ''}`,
    );
  }
}

/** The payment id bound to this payload, or `payment_id_conflict` if it came with another. */
async function bind(o: SettleOptions, key: string, header: string, c: CheckedPayment) {
  const fp = fingerprint(header);
  for (;;) {
    const b = (await o.store.load(key)) as IdBinding | null;
    if (b) {
      if (b.fingerprint !== fp) {
        throw new PayError('payment_id_conflict', 'this payment id came with another payload');
      }
      return;
    }
    const created: IdBinding = {
      kind: 'id',
      id: key,
      revision: 0,
      fingerprint: fp,
      keepUntil: c.validBefore.toString(),
    };
    if (await o.store.compareAndSet(key, null, created)) return;
  }
}

/** The x402 v2 `SettleResponse` for a settlement: the `PAYMENT-RESPONSE` header's content. */
export function paymentResponse(s: Settlement): SettleResponse {
  return s.state === 'settled'
    ? { success: true, transaction: s.transaction, network: s.network, payer: s.payer }
    : {
        success: false,
        errorReason: 'settlement_pending',
        transaction: s.transaction,
        network: s.network,
      };
}
