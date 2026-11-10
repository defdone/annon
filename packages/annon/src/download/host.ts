/**
 * An Annon file host (specs/download.md, profile v1.1 sections 7 and 10): one URL that sells the
 * file, returns it to the buyer with the payment, and serves it again to a wallet that bought it.
 * `serveFile` takes the request's headers and gives the status, headers and body to send; the HTTP
 * server around it adds CORS (profile section 9).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { getConfig, getFile, isBuyer } from '../near/rpc.js';
import { PayError } from '../pay/base.js';
import { toHex } from '../pay/eip3009.js';
import { paymentRequired } from '../pay/seller.js';
import {
  paymentResponse,
  type SellerPurchase,
  type SellerRecord,
  type Settlement,
  type SettleOptions,
  type SettleResponse,
  settle,
} from '../pay/settle.js';
import type { Store, Versioned } from '../pay/store.js';
import { BASE_NETWORK } from '../pay/x402.js';
import { BUYER_PROOF_HEADER, verifyBuyerProof } from './proof.js';
import {
  fileUrn,
  readSignIn,
  SIGN_IN_HEADER,
  SIGN_IN_WITH_X,
  type SignInChallenge,
  signInChallenge,
  signInExtension,
  verifySignIn,
} from './siwx.js';

/** A sign-in challenge this host issued, until it is used or expires. */
export interface ChallengeRecord extends Versioned {
  kind: 'challenge';
  challenge: SignInChallenge;
}
/** A session (download.md section 4), stored under the hash of its token, never the token. */
export interface SessionRecord extends Versioned {
  kind: 'session';
  wallet: string;
  origin: string;
  expiresAt: number;
}
/**
 * A wallet's purchases of the file on this host, by their `settle` record keys; written before
 * each record (`beforeRecord`), so a record of this wallet is never missing from it.
 */
export interface UnderwayRecord extends Versioned {
  kind: 'underway';
  purchases: string[];
}
export type HostRecord = SellerRecord | ChallengeRecord | SessionRecord | UnderwayRecord;

export interface FileHostOptions extends Omit<SettleOptions, 'store'> {
  /** One store for the host's records and the seller's (`settle`). */
  store: Store<HostRecord>;
  /** `SHA256` of the PAY2 header served at `header`, 0x and lowercase (profile section 7). */
  headerHash: string;
  /** The PAY2 file: its size, and its bytes from an offset to the end. */
  file: { size: number; read(start: number): ReadableStream<Uint8Array> };
  /** Default two hours, the most download.md section 4 allows. */
  sessionSeconds?: number;
}

export interface HostRequest {
  headers: { get(name: string): string | null };
}
export interface HostResponse {
  status: number;
  headers: Record<string, string>;
  body?: ReadableStream<Uint8Array>;
}

const SESSION_SECONDS = 7_200;
const b64json = (v: unknown) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(v))));
const hashOf = (s: string) => toHex(sha256(new TextEncoder().encode(s)));
const random = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

/** Handles one request to the file URL, in the order of download.md section 1. */
export async function serveFile(req: HostRequest, o: FileHostOptions): Promise<HostResponse> {
  const now = Math.floor(Date.now() / 1000);
  const origin = new URL(o.url).origin;
  const fileKey = `${o.contractId}/${o.fileId}`;
  const keys = {
    challenge: (nonce: string) => `annon/host/challenge/${nonce}`,
    session: (token: string) => `annon/host/session/${hashOf(token)}`,
    underway: (wallet: string) => `annon/host/underway/${fileKey}/${wallet}`,
  };
  const create = (key: string, r: HostRecord) => o.store.compareAndSet(key, null, r);

  // Every answer depends on who asks: never stored by a cache (profile section 9).
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  // 1. A takedown first.
  const file = await getFile(o.nearRpc, o.contractId, o.fileId);
  if (!file) return { status: 404, headers };
  if (file.takenDown !== null) return { status: 410, headers };
  const { usdc } = await getConfig(o.nearRpc, o.contractId);
  const settleOptions = {
    ...o,
    store: o.store as Store<SellerRecord>,
    // The wallet's index first, then the integrator's own hook (e.g. a payout to schedule).
    beforeRecord: async (key: string, payer: string) => {
      await remember(payer, key);
      await o.beforeRecord?.(key, payer);
    },
  };
  /** Adds a purchase to the wallet's index. */
  const remember = async (wallet: string, purchase: string) => {
    for (;;) {
      const u = (await o.store.load(keys.underway(wallet))) as UnderwayRecord | null;
      if (u?.purchases.includes(purchase)) return;
      const next: UnderwayRecord = {
        kind: 'underway',
        id: wallet,
        revision: u ? u.revision + 1 : 0,
        purchases: [...(u?.purchases ?? []), purchase],
      };
      if (await o.store.compareAndSet(keys.underway(wallet), u, next)) return;
    }
  };
  /** The wallet's purchases of the file on this host, as `settle` last recorded them. */
  const purchasesOf = async (wallet: string) => {
    const u = (await o.store.load(keys.underway(wallet))) as UnderwayRecord | null;
    const out: SellerPurchase[] = [];
    for (const k of u?.kind === 'underway' ? u.purchases : []) {
      const r = (await o.store.load(k)) as SellerPurchase | null;
      if (r?.kind === 'purchase') out.push(r);
    }
    return out;
  };

  /** The 402 with a fresh sign-in challenge (step 6). */
  const required = async (status = 402): Promise<HostResponse> => {
    const challenge = signInChallenge(o.url, { ...o, headerHash: o.headerHash }, now);
    await create(keys.challenge(challenge.nonce), {
      kind: 'challenge',
      id: challenge.nonce,
      revision: 0,
      challenge,
    });
    const pr = paymentRequired(o, file, usdc);
    pr.extensions = { ...pr.extensions, [SIGN_IN_WITH_X]: signInExtension(challenge) };
    return {
      status,
      headers: { ...headers, 'PAYMENT-REQUIRED': b64json(pr) },
    };
  };

  // 2. The payment, if any.
  let settlement: Settlement | undefined;
  let processing = false;
  const payload = req.headers.get('PAYMENT-SIGNATURE');
  if (payload !== null) {
    try {
      settlement = await settle(payload, settleOptions);
      headers['PAYMENT-RESPONSE'] = b64json(paymentResponse(settlement));
    } catch (e) {
      if (!(e instanceof PayError)) throw e;
      if (e.code === 'settlement_processing') processing = true;
      else if (e.code === 'taken_down') return { status: 410, headers };
      else if (e.code === 'bad_requirements' || e.code === 'bad_signature') {
        return { status: 400, headers };
      } else if (e.code === 'payment_id_conflict') return { status: 409, headers };
      else if (e.code === 'transport') return { status: 502, headers };
      else {
        // A refused payment (expired, a stop, a changed offer): x402's "payment failed".
        headers['PAYMENT-RESPONSE'] = b64json({
          success: false,
          errorReason: e.code,
          transaction: '',
          network: 'eip155:8453',
        });
        return required();
      }
    }
  }

  // 3. Who the request is.
  let entitled: boolean =
    settlement?.state === 'settled' &&
    verifyBuyerProof(settlement.buyerKey, o.url, req.headers.get(BUYER_PROOF_HEADER) ?? '');
  let wallet: string | undefined;
  // Each purchase still open is settled again from its recorded payload, as if the buyer had sent
  // it, so Base decides even when the buyer signs in instead of resending the payment.
  const standings = new Map<string, Promise<Standing>>();
  const standing = (w: string) => {
    let s = standings.get(w);
    if (!s) {
      s = (async () => {
        const out: Standing = { waiting: false };
        const rs = await purchasesOf(w);
        // A purchase recorded settled (at Base safe) is final: no new check can take it back.
        const done = rs.find((r) => r.state === 'settled');
        if (done) {
          return {
            ...out,
            settled: {
              success: true,
              transaction: done.transaction as string,
              network: BASE_NETWORK,
              payer: w,
            },
          };
        }
        for (const r of rs) {
          if (r.state === 'unpaid') continue;
          try {
            const got = await settle(r.header, settleOptions);
            if (got.state === 'settled') return { ...out, settled: paymentResponse(got) };
            out.pending ??= got;
          } catch (e) {
            // Base or the facilitator unreachable comes as a PayError: still open. A store
            // failure is not one, and is the host's error (500).
            if (!(e instanceof PayError)) throw e;
            if (e.code !== 'payment_expired') out.waiting = true;
          }
        }
        return out;
      })();
      standings.set(w, s);
    }
    return s;
  };
  // NEAR, or a purchase this host settled (at Base safe) that NEAR has not recorded yet.
  const bought = async (w: string) => {
    if (await isBuyer(o.nearRpc, o.contractId, o.fileId, w)) return true;
    const settled = (await standing(w)).settled;
    if (settled) headers['PAYMENT-RESPONSE'] ??= b64json(settled);
    return !!settled;
  };
  const bearer = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.get('Authorization') ?? '')?.[1];
  if (bearer) {
    const s = (await o.store.load(keys.session(bearer))) as SessionRecord | null;
    if (s?.kind === 'session' && s.origin === origin && s.expiresAt > now) wallet = s.wallet;
  }
  if (!entitled && wallet) entitled = await bought(wallet);
  // A session that does not get the file does not stop a sign-in that may.
  const proof = readSignIn(req.headers.get(SIGN_IN_HEADER));
  const urn = fileUrn(o.contractId, o.fileId, o.headerHash);
  if (!entitled && proof) {
    const key = keys.challenge(proof.nonce);
    const issued = (await o.store.load(key)) as ChallengeRecord | null;
    // Only a challenge this host issued for this URL and file: a store may be shared.
    const ours =
      issued?.kind === 'challenge' &&
      issued.challenge.uri === o.url &&
      issued.challenge.domain === new URL(o.url).host &&
      issued.challenge.resources.length === 1 &&
      issued.challenge.resources[0] === urn;
    // Single use: taken out whatever the outcome; only the request that took it goes on.
    if (ours && (await o.store.compareAndSet(key, issued, null))) {
      const signedIn = verifySignIn(proof, issued.challenge, now);
      if (signedIn) {
        wallet = signedIn;
        const token = random();
        await create(keys.session(token), {
          kind: 'session',
          id: hashOf(token),
          revision: 0,
          wallet,
          origin,
          expiresAt: now + Math.min(o.sessionSeconds ?? SESSION_SECONDS, SESSION_SECONDS),
        });
        headers['Annon-Session'] = token;
        entitled = await bought(wallet);
      }
    }
  }

  // 4. The file.
  if (entitled) return serve(req, o, headers);
  // 5. A purchase not settled yet.
  if (settlement?.state === 'pending') return { status: 402, headers };
  if (processing) return { status: 503, headers: { ...headers, 'Retry-After': '5' } };
  // 6. Nothing else: a sign-in, or a payment while sales are open.
  if (file.salesStoppedAt !== null && wallet) {
    // A purchase under way gets its answer (step 5); nothing under way, nothing to do.
    const st = await standing(wallet);
    if (st.pending) {
      headers['PAYMENT-RESPONSE'] = b64json(paymentResponse(st.pending));
      return { status: 402, headers };
    }
    if (st.waiting) return { status: 503, headers: { ...headers, 'Retry-After': '5' } };
    return { status: 403, headers };
  }
  return required();
}

/** A wallet's purchases on this host after settling the open ones again. */
interface Standing {
  settled?: SettleResponse;
  pending?: Settlement;
  /** A purchase still being settled, with no transaction known. */
  waiting: boolean;
}

/** `200` with the whole file, or `206` from a `Range: bytes=<start>-` offset. */
function serve(
  req: HostRequest,
  o: FileHostOptions,
  headers: Record<string, string>,
): HostResponse {
  const size = o.file.size;
  const range = /^bytes=(\d+)-$/.exec(req.headers.get('Range') ?? '');
  const start = range ? Number(range[1]) : 0;
  const base = {
    ...headers,
    'Cache-Control': 'private, no-store',
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
  };
  if (range && (!Number.isSafeInteger(start) || start >= size)) {
    return { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } };
  }
  return {
    status: range ? 206 : 200,
    headers: {
      ...base,
      'Content-Length': String(size - start),
      ...(range ? { 'Content-Range': `bytes ${start}-${size - 1}/${size}` } : {}),
    },
    body: o.file.read(start),
  };
}
