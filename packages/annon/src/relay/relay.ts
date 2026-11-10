/**
 * The relayer: sends `register`, `unlock`, `reopen` and `stop_sales` to the Annon contract for
 * people and agents without a NEAR account, and pays the NEAR gas. Like an x402 facilitator it is
 * a role, not a service: a platform calls `relay` from its own backend with its own NEAR key, and
 * defdone runs one public instance. It keeps no database: the contract refuses a payment used
 * twice, and the client keeps its purchase job (`nextStep`).
 *
 * Nothing the relayer does can change who gets a key: the contract checks every wallet signature
 * and MPC checks the payment. The checks here exist so that junk costs only RPC reads, never gas,
 * and the limits so that valid but worthless calls can't drain the operator.
 */
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58, base64 } from '@scure/base';
import { Account, actions, encodeTransaction, JsonRpcProvider } from 'near-api-js';
import { signedBy, signerOf } from '../envelope/pay2.js';
import {
  getFile,
  isBuyer,
  isPaymentUsed,
  RPC_TIMEOUT_MS,
  type RpcReply,
  rpcReply,
  view,
} from '../near/rpc.js';
import {
  type RegisterArgs,
  type ReopenArgs,
  registerText,
  reopenText,
  type StopSalesArgs,
  stopSalesText,
} from '../near/texts.js';
import { block, blockHeader, type EvmLog, getReceipt, paymentLogs } from '../pay/base.js';
import { annonNonce, fromHex } from '../pay/eip3009.js';

export type RelayRequest =
  | { method: 'register'; args: RegisterArgs; sig: string }
  | { method: 'reopen'; args: ReopenArgs; sig: string }
  | { method: 'stop_sales'; args: StopSalesArgs; sig: string }
  | {
      method: 'unlock';
      args: { file_id: string; buyer_key: string; logs: EvmLog[]; header?: string };
    };

export type RelayErrorCode =
  /** The request is malformed or not one the relayer sends. */
  | 'bad_request'
  /** The wallet signature is not over the contract's text by the right wallet. */
  | 'bad_signature'
  /** The signature has expired, or is valid for longer than the relayer allows. */
  | 'bad_deadline'
  /** The operator does not sponsor this (price, seller). */
  | 'not_sponsored'
  /** A per-seller or per-wallet daily limit is reached. */
  | 'limited'
  /** The same operation is already on its way (or was just sent). */
  | 'duplicate'
  /** The relayer can't pay for it now (its prepaid storage is low). */
  | 'unavailable'
  | 'unknown_file'
  | 'already_registered'
  | 'sales_stopped'
  | 'taken_down'
  /** `reopen` from a wallet that is neither the seller nor a buyer. */
  | 'not_buyer'
  /** No matching payment on Base, or not yet at Base `safe`. */
  | 'payment_not_found'
  | 'payment_not_safe'
  | 'payment_used'
  | 'bad_header'
  /** An RPC failed; safe to retry. */
  | 'transport';

export class RelayError extends Error {
  readonly code: RelayErrorCode;
  constructor(code: RelayErrorCode, message: string = code) {
    super(message);
    this.code = code;
    this.name = 'RelayError';
  }
}
const fail = (code: RelayErrorCode, message?: string): never => {
  throw new RelayError(code, message);
};

/** What the operator sponsors. */
export interface RelayPolicy {
  /** USDC base units: listings below it are not registered (6 decimals; 10000 = 0.01 USDC). */
  minPrice: bigint;
  /** A wallet signature may be valid for at most this long ahead (the SDK uses 10 minutes). */
  maxDeadlineSeconds: number;
  /** Whose files this relayer serves, for every method; omit to serve any seller. */
  sellerAllowed?: (seller: string) => boolean | Promise<boolean>;
  /** Per day: listings per seller (default 20), reopens per wallet and file (default 10). */
  registrationsPerSeller?: number;
  reopensPerWalletFile?: number;
}

export interface CheckOptions {
  nearRpc: string;
  baseRpc: string;
  contractId: string;
  usdc: string;
  policy: RelayPolicy;
  /** Unix seconds; defaults to now. */
  now?: number;
}

// ---------- the request, rebuilt from checked fields ----------

const ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const bad = (what: string): never => fail('bad_request', what);
const hex = (v: unknown, bytes: number, name: string) =>
  typeof v === 'string' && new RegExp(`^0x[0-9a-fA-F]{${2 * bytes}}$`).test(v)
    ? v.toLowerCase()
    : bad(`${name} must be 0x and ${bytes} bytes of hex`);
/** A one-time key MPC accepts: a compressed G1 point in the group, not the identity. */
function g1(v: unknown, name: string) {
  const h = hex(v, 48, name);
  try {
    if (!bls.G1.Point.fromBytes(fromHex(h, 48, name)).is0()) return h;
  } catch {}
  return bad(`${name} is not a valid one-time key`);
}
const seconds = (v: unknown) =>
  Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 253_402_300_799
    ? (v as number)
    : bad('deadline must be unix seconds, at most the year 9999');
const price = (v: unknown) =>
  typeof v === 'string' && /^[1-9]\d{0,38}$/.test(v) && BigInt(v) < 2n ** 128n
    ? v
    : bad('price must be a decimal string of USDC base units');
const moderator = (v: unknown) =>
  v === null
    ? null
    : typeof v === 'string' && ACCOUNT.test(v)
      ? v
      : bad('moderator must be a NEAR account or null');

const LOG_FIELDS = [
  'address',
  'block_hash',
  'block_number',
  'data',
  'log_index',
  'removed',
  'topics',
  'transaction_hash',
  'transaction_index',
] as const;

/**
 * The request rebuilt from its checked fields only, hex in lowercase: what is checked, signed for
 * and sent is the same object, in the form the contract parses.
 */
export function canonicalRequest(input: unknown): RelayRequest {
  const r = input as { method?: unknown; args?: Record<string, unknown>; sig?: unknown } | null;
  const a = r?.args;
  if (!a || typeof a !== 'object') return bad('args must be an object');
  const file_id = hex(a.file_id, 32, 'args.file_id');
  switch (r.method) {
    case 'register':
      return {
        method: 'register',
        args: {
          file_id,
          seller: hex(a.seller, 20, 'seller'),
          price: price(a.price),
          pay_to: hex(a.pay_to, 20, 'pay_to'),
          cipher_hash: hex(a.cipher_hash, 32, 'cipher_hash'),
          moderator: moderator(a.moderator),
          seller_key: g1(a.seller_key, 'seller_key'),
          deadline: seconds(a.deadline),
        },
        sig: hex(r.sig, 65, 'sig'),
      };
    case 'reopen':
      return {
        method: 'reopen',
        args: {
          file_id,
          wallet: hex(a.wallet, 20, 'wallet'),
          key: g1(a.key, 'key'),
          deadline: seconds(a.deadline),
        },
        sig: hex(r.sig, 65, 'sig'),
      };
    case 'stop_sales':
      return {
        method: 'stop_sales',
        args: { file_id, deadline: seconds(a.deadline) },
        sig: hex(r.sig, 65, 'sig'),
      };
    case 'unlock': {
      if (
        !Array.isArray(a.logs) ||
        a.logs.length !== 2 ||
        !a.logs.every((l) => l && typeof l === 'object')
      ) {
        return bad('logs must be the AuthorizationUsed and Transfer of the payment');
      }
      const header = a.header;
      if (
        header !== undefined &&
        (typeof header !== 'string' || !/^0x([0-9a-f]{2})+$/.test(header))
      ) {
        return bad('header must be the block header as 0x lowercase hex');
      }
      return {
        method: 'unlock',
        args: {
          file_id,
          buyer_key: g1(a.buyer_key, 'buyer_key'),
          // Field order as `paymentLogs` builds them, so the comparison with Base is by value.
          logs: a.logs.map((l) => Object.fromEntries(LOG_FIELDS.map((k) => [k, l[k]]))) as EvmLog[],
          ...(header === undefined ? {} : { header }),
        },
      };
    }
    default:
      return bad('method must be register, unlock, reopen or stop_sales');
  }
}

// ---------- checks against the chains ----------

function deadline(d: number, o: CheckOptions) {
  const now = o.now ?? Math.floor(Date.now() / 1000);
  if (d < now) fail('bad_deadline', 'the signature has expired');
  if (d > now + o.policy.maxDeadlineSeconds) {
    fail('bad_deadline', 'the signature is valid for longer than this relayer allows');
  }
}

/** The registration, if the file can still be acted on and this relayer serves its seller. */
async function liveFile(o: CheckOptions, fileId: string) {
  const file = await getFile(o.nearRpc, o.contractId, fileId);
  if (!file) return fail('unknown_file');
  if (file.takenDown) fail('taken_down', `the file was taken down (${file.takenDown})`);
  await sponsored(o, file.seller);
  return file;
}

async function sponsored(o: CheckOptions, seller: string) {
  if (o.policy.sellerAllowed && !(await o.policy.sellerAllowed(seller))) {
    fail('not_sponsored', "this relayer does not serve this seller's files");
  }
}

/**
 * Everything the contract and MPC will check that can be checked before sending, read from the
 * operator's own RPCs, on a request from `canonicalRequest`. Throws `RelayError`.
 */
export async function checkRelay(r: RelayRequest, o: CheckOptions): Promise<void> {
  try {
    switch (r.method) {
      case 'register': {
        const a = r.args;
        deadline(a.deadline, o);
        if (BigInt(a.price) < o.policy.minPrice) {
          fail('not_sponsored', 'the price is below what this relayer sponsors');
        }
        signedByItsWallet(r, o.contractId);
        await sponsored(o, a.seller);
        if (await getFile(o.nearRpc, o.contractId, a.file_id)) fail('already_registered');
        return;
      }
      case 'reopen': {
        const a = r.args;
        deadline(a.deadline, o);
        signedByItsWallet(r, o.contractId);
        const file = await liveFile(o, a.file_id);
        if (
          file.seller !== a.wallet &&
          !(await isBuyer(o.nearRpc, o.contractId, a.file_id, a.wallet))
        ) {
          fail('not_buyer', 'only the seller or a buyer can open the file again');
        }
        return;
      }
      case 'stop_sales': {
        const a = r.args;
        deadline(a.deadline, o);
        const file = await liveFile(o, a.file_id);
        if (!signedBy(stopSalesText(o.contractId, a), fromHex(r.sig, 65, 'sig'), file.seller)) {
          fail('bad_signature', 'the stop is not signed by the seller');
        }
        if (file.salesStoppedAt !== null) fail('sales_stopped', 'sales are already stopped');
        return;
      }
      case 'unlock':
        return await checkUnlock(r.args, o);
    }
  } catch (e) {
    asRelayError(e);
  }
}

/** An RPC failure as `transport`, anything else unexpected as `bad_request`. */
function asRelayError(e: unknown): never {
  if (e instanceof RelayError) throw e;
  const transport = (e as { code?: unknown })?.code === 'transport';
  throw new RelayError(transport ? 'transport' : 'bad_request', (e as Error).message);
}

/** The payment exactly as `unlock` and MPC will check it, from the operator's own Base RPC. */
async function checkUnlock(
  a: Extract<RelayRequest, { method: 'unlock' }>['args'],
  o: CheckOptions,
) {
  const file = await liveFile(o, a.file_id);
  const [auth] = a.logs as [EvmLog, EvmLog];
  const from = `0x${String(auth.topics?.[1]).slice(-40)}`;
  const receipt = await getReceipt(o.baseRpc, `0x${String(auth.transaction_hash)}`);
  const found = receipt
    ? paymentLogs(receipt, {
        usdc: o.usdc,
        to: file.payTo,
        from,
        nonce: annonNonce(o.contractId, a.file_id, fromHex(a.buyer_key, 48, 'buyer_key')),
        price: file.price,
      })
    : null;
  // The logs sent must be the receipt's, field for field: MPC compares them with Base.
  if (!found || JSON.stringify(found) !== JSON.stringify(a.logs)) {
    return fail('payment_not_found', 'no payment for this file and key in that transaction');
  }
  if ((await block(o.baseRpc, 'safe')).number < auth.block_number) {
    fail('payment_not_safe', 'the payment is not at Base safe yet; retry shortly');
  }
  if (await isPaymentUsed(o.nearRpc, o.contractId, `0x${auth.transaction_hash}`, auth.log_index)) {
    fail('payment_used', 'this payment already unlocked the file');
  }
  if (
    a.header !== undefined &&
    (await blockHeader(o.baseRpc, `0x${auth.block_hash}`)) !== a.header
  ) {
    fail('bad_header', 'the header is not the payment block');
  }
  if (file.salesStoppedAt !== null) {
    if (a.header === undefined)
      fail('bad_header', 'sales are stopped: send the payment block header');
    // The contract's rule (moderation.rs, payment_allowed): paid at most 300 s after the stop.
    if ((await block(o.baseRpc, auth.block_number)).timestamp > file.salesStoppedAt + 300) {
      fail('sales_stopped', 'the payment came more than 300 s after sales were stopped');
    }
  }
}

// ---------- sending ----------

export interface Sender {
  /** The NEAR account that sends and pays, e.g. `relayer.annon.defdone.near`. */
  accountId: string;
  /** Its function-call key for the four methods, `ed25519:…`. Only for this contract. */
  key: string;
}

/** Gas for every call: `unlock` needs 150 Tgas, MPC's callbacks use the rest; unused gas returns. */
const GAS = 300_000_000_000_000n;
/**
 * Prepaid storage counted per write (`register`, `unlock`, `reopen`): more than any of them takes
 * (an unlock reserves 0.005 NEAR, a reopen marker under 0.001).
 */
const STORAGE_PER_WRITE = 10n ** 22n; // 0.01 NEAR
/** How long a sent write is counted against the balance read; an estimate of when its storage shows there. */
const WRITE_SETTLES = 2 * 60_000;
const DAY = 86_400_000;
/** An operation is held this long after it is sent, so a repeat doesn't burn gas on a refusal. */
const HOLD = 15 * 60_000;
/** How many more tries after the first send: the same bytes again, or after PENDING a lookup. */
const RESENDS = 2;
/** The first wait before trying again when NEAR says "later" or "pending"; it grows each try. */
const RETRY_WAIT = 1_000;
/** Requests waiting for their turn; past this the relayer answers busy. */
const MAX_WAITING = 32;

// ponytail: state in memory, one process; a restart forgets limits and holds, bounded by the key's
// allowance and the sender's prepaid balance. The contract refuses an operation done twice.
const accounts = new Map<string, Account>();
const held = new Map<string, number>();
const counts = new Map<string, { n: number; until: number }>();
/** When each recent write was sent, per payer and contract (see `enoughStorage`). */
const writes = new Map<string, number[]>();
let queue: Promise<unknown> = Promise.resolve();
let waiting = 0;

/** How many operations and limit counters are kept; for tests. */
export const relayCounters = () => counts.size + held.size;

/** Clears the in-memory limits; for tests. */
export function resetRelayState() {
  held.clear();
  counts.clear();
  accounts.clear();
  writes.clear();
}

/**
 * The provider near-api-js signs with: it reads the key's nonce and a recent block. Every reply
 * that sends a transaction or looks one up goes through `rpcReply` instead (its id checked, one
 * fetch, aborted at the deadline).
 */
// ponytail: the timer ends the wait, not the request (near-api-js 7.4 takes no AbortSignal).
function signingProvider(url: string) {
  const p = new JsonRpcProvider({ url });
  const send = p.sendJsonRpc.bind(p);
  p.sendJsonRpc = ((method: string, params: unknown) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, no) => {
      timer = setTimeout(() => no(new Error(`NEAR RPC ${method} timed out`)), RPC_TIMEOUT_MS);
    });
    return Promise.race([send(method as never, params as never), late]).finally(() =>
      clearTimeout(timer),
    );
  }) as typeof p.sendJsonRpc;
  return p;
}

const isObject = (v: unknown): v is object => typeof v === 'object' && v !== null;

/** The statuses of a transaction in a block (`NONE`: known, not yet in one). */
const IN_BLOCK = new Set([
  'INCLUDED',
  'EXECUTED_OPTIMISTIC',
  'INCLUDED_FINAL',
  'EXECUTED',
  'FINAL',
]);
const inBlock = (result: unknown) => {
  const s = (result as { final_execution_status?: unknown } | null | undefined)
    ?.final_execution_status;
  return typeof s === 'string' && IN_BLOCK.has(s);
};

/**
 * What NEAR's error guide (docs.near.org/api/rpc/transactions#error-handling) says to do after an
 * error: send the same bytes again now or `later`, only look it up (`pending`), ask a node that
 * tracks its shard (`elsewhere`), or `stop`: the same node would give the same answer.
 */
function advice(e: NonNullable<RpcReply['error']>) {
  const refused = (e.data as { TxExecutionError?: { InvalidTxError?: unknown } } | undefined)
    ?.TxExecutionError?.InvalidTxError;
  // Nodes before nearcore 2.14 send no `cause.info`: the same as NOT_OBSERVED.
  const timeout =
    e.cause?.name === 'TIMEOUT_ERROR'
      ? ((e.cause.info as { cause?: string } | undefined)?.cause ?? 'NOT_OBSERVED')
      : undefined;
  if (e.cause?.name === 'DOES_NOT_TRACK_SHARD' || timeout === 'DOES_NOT_TRACK_SHARD')
    return 'elsewhere';
  if (timeout === 'PENDING') return 'pending';
  if (timeout === 'NOT_OBSERVED') return 'again';
  const busy = isObject(refused) && ('ShardCongested' in refused || 'ShardStuck' in refused);
  if (busy || e.name === 'INTERNAL_ERROR' || timeout === 'ERROR') return 'later';
  return 'stop';
}

/** NEAR's own words for an error: the transaction's refusal, or the whole error. */
function describe(e: NonNullable<RpcReply['error']>) {
  const { name, cause, data, message } = e;
  const refused = (data as { TxExecutionError?: { InvalidTxError?: unknown } } | undefined)
    ?.TxExecutionError?.InvalidTxError;
  return JSON.stringify(refused ?? { name, cause, data, message });
}

/** The transaction's status now (`wait_until: NONE` waits for nothing); a lost reply is no answer. */
const lookUp = (url: string, tx: string, accountId: string) =>
  rpcReply(url, 'tx', { tx_hash: tx, sender_account_id: accountId, wait_until: 'NONE' }).catch(
    () => null,
  );

/**
 * An estimate, not a promise: the prepaid balance read now covers this write and the writes sent
 * in the last couple of minutes, which a balance read may not show yet. The contract decides; a
 * write it refuses for storage costs gas, within the key's allowance.
 */
async function enoughStorage(o: CheckOptions & { sender: Sender }, scope: string) {
  const since = Date.now() - WRITE_SETTLES;
  const recent = (writes.get(scope) ?? []).filter((t) => t > since);
  writes.set(scope, recent);
  const balance = await view(o.nearRpc, o.contractId, 'storage_balance_of', {
    account_id: o.sender.accountId,
  });
  if (
    typeof balance !== 'string' ||
    !/^\d+$/.test(balance) ||
    BigInt(balance) < STORAGE_PER_WRITE * BigInt(recent.length + 1)
  ) {
    fail('unavailable', "the relayer's prepaid storage is low; try later or send it yourself");
  }
}

const senderKey = (o: { nearRpc: string; sender: Sender }) =>
  `${o.nearRpc}|${o.sender.accountId}|${o.sender.key}`;

/** Runs jobs one at a time, in order: checks and nonces never interleave. */
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job);
  queue = next.catch(() => {});
  return next;
}

/**
 * What makes two requests the same operation. Only a party that could make the request succeed
 * can hold it: wallet signatures are checked or recovered before anything is held (`stop_sales`
 * by the address that signed, since the seller is known only from the chain), and an unlock
 * includes the buyer's key, which only the buyer knows before it is sent.
 */
const identity = (r: RelayRequest, contractId: string) =>
  r.method === 'unlock'
    ? `unlock:${r.args.logs[0]?.transaction_hash}:${r.args.logs[0]?.log_index}:${r.args.buyer_key}`
    : r.method === 'reopen'
      ? `reopen:${r.args.file_id}:${r.args.wallet}:${r.args.key}`
      : r.method === 'stop_sales'
        ? `stop_sales:${r.args.file_id}:${signerOf(stopSalesText(contractId, r.args), fromHex(r.sig, 65, 'sig'))}`
        : `register:${r.args.file_id}`;

/** The wallet signatures that need no chain read, checked before any limit or hold is taken. */
function signedByItsWallet(r: RelayRequest, contractId: string) {
  if (
    r.method === 'register' &&
    !signedBy(registerText(contractId, r.args), fromHex(r.sig, 65, 'sig'), r.args.seller)
  ) {
    fail('bad_signature', 'the listing is not signed by its seller');
  }
  if (
    r.method === 'reopen' &&
    !signedBy(reopenText(contractId, r.args), fromHex(r.sig, 65, 'sig'), r.args.wallet)
  ) {
    fail('bad_signature', 'the reopen is not signed by its wallet');
  }
}

const quota = (r: RelayRequest, p: RelayPolicy): [string, number] | null =>
  r.method === 'register'
    ? [`register:${r.args.seller}`, p.registrationsPerSeller ?? 20]
    : r.method === 'reopen'
      ? [`reopen:${r.args.wallet}:${r.args.file_id}`, p.reopensPerWalletFile ?? 10]
      : null;

export interface RelayResult {
  txHash: string;
  /**
   * NEAR's answer was lost or unclear (a timeout, a gateway error, a refusal): the transaction may
   * or may not be in a block. Read its outcome by hash before asking again. Sending the same
   * operation again is safe: the contract refuses it if the first one landed.
   */
  uncertain?: true;
  /** With `uncertain`: what NEAR answered, for the operator. */
  reason?: string;
}

/**
 * Checks the request and sends it with the sender's key, no deposit (storage comes from the
 * sender's prepaid balance on the contract). The checks run again right before signing, one
 * request at a time. The operation's hold and limits are taken on admission and given back only
 * if the request fails before its transaction is sent. Returns the transaction hash once it is in
 * a block (or `uncertain`); the caller reads the outcome itself through its own NEAR RPC
 * (`txOutcome` with the method and args it asked for).
 *
 * The relayer doesn't track what happened to a transaction: no RPC answer proves one didn't land.
 * That an operation runs once is the contract's job (a file is registered once, a payment unlocks
 * once, a one-time key is reopened once, sales stop once); the relayer only avoids sending the
 * same operation twice in a row.
 */
export async function relay(
  input: unknown,
  o: CheckOptions & { sender: Sender },
): Promise<RelayResult> {
  const r = canonicalRequest(input);
  // A forged request must not take another wallet's limit or hold its operation.
  signedByItsWallet(r, o.contractId);
  const now = Date.now();
  for (const [k, v] of held) if (v <= now) held.delete(k);
  for (const [k, v] of counts) if (v.until <= now) counts.delete(k);
  if (waiting >= MAX_WAITING) fail('unavailable', 'the relayer is busy; try again shortly');
  // Per contract: relayers for other contracts in the same process don't share operations.
  const id = `${o.contractId}|${identity(r, o.contractId)}`;
  if ((held.get(id) ?? 0) > now) fail('duplicate', 'this operation was just sent or is on its way');
  const quotaOf = quota(r, o.policy);
  const q: [string, number] | null = quotaOf && [`${o.contractId}|${quotaOf[0]}`, quotaOf[1]];
  // The window this request was charged to: a refund made after midnight goes back to it, never
  // to the new day's.
  let charged: { n: number; until: number } | undefined;
  if (q) {
    // Charged now: concurrent requests can't all pass a check made before any of them is sent.
    const c = counts.get(q[0]);
    charged = c && c.until > now ? c : { n: 0, until: now + DAY };
    if (charged.n >= q[1]) fail('limited', 'the daily limit for this is reached');
    charged.n++;
    counts.set(q[0], charged);
  }
  // Held without end while it waits and is sent; the hold period starts once it is sent.
  held.set(id, Number.POSITIVE_INFINITY);
  const refund = () => {
    held.delete(id);
    if (q && charged && counts.get(q[0]) === charged) {
      charged.n--;
      if (charged.n <= 0) counts.delete(q[0]);
    }
  };
  let sent = false;
  waiting++;
  try {
    const out = await enqueue(async () => {
      await checkRelay(r, o);
      const key = senderKey(o);
      // Storage is the payer's balance on the contract, whichever of its keys signs.
      const scope = `${o.nearRpc}|${o.contractId}|${o.sender.accountId}`;
      const write = r.method !== 'stop_sales';
      if (write) await enoughStorage(o, scope).catch(asRelayError);
      let account = accounts.get(key);
      if (!account) {
        // One account per key, kept: near-api-js numbers its nonces locally across calls.
        account = new Account(
          o.sender.accountId,
          signingProvider(o.nearRpc),
          o.sender.key as `ed25519:${string}`,
        );
        accounts.set(key, account);
      }
      const args = 'sig' in r ? { args: r.args, sig: r.sig } : { args: r.args };
      const tx = await account
        .createSignedTransaction({
          receiverId: o.contractId,
          actions: [actions.functionCall(r.method, args, GAS, 0n)],
        })
        .catch((e: Error) => fail('transport', `NEAR RPC: ${e.message}`));
      const txHash = base58.encode(sha256(tx.transaction.encode()));
      const signed = base64.encode(encodeTransaction(tx));
      sent = true;
      if (write) writes.get(scope)?.push(Date.now()) ?? writes.set(scope, [Date.now()]);
      return send(o, key, txHash, signed);
    });
    held.set(id, Date.now() + HOLD);
    return out;
  } catch (e) {
    // Given back only when nothing was sent; once a transaction may be on its way, the hold and
    // limits stay, whatever its outcome.
    if (sent) {
      held.set(id, Date.now() + HOLD);
      throw e;
    }
    refund();
    throw e;
  } finally {
    waiting--;
  }
}

/**
 * Sends signed bytes; after a lost or unclear answer, looks the transaction up and sends the same
 * bytes again (same hash: NEAR never runs it twice). Never throws: any doubt is `uncertain`.
 */
async function send(
  o: { nearRpc: string; sender: Sender },
  key: string,
  txHash: string,
  signed: string,
): Promise<RelayResult> {
  const unclear = (reason: string): RelayResult => ({ txHash, uncertain: true, reason });
  let reason = 'no clear answer from NEAR';
  // After NEAR said it has the transaction (a PENDING timeout), the relayer only looks it up.
  let look = false;
  try {
    for (let attempt = 0; attempt <= RESENDS; attempt++) {
      const reply = look
        ? undefined
        : await rpcReply(o.nearRpc, 'send_tx', {
            signed_tx_base64: signed,
            wait_until: 'INCLUDED',
          }).catch(() => null);
      if (reply && !reply.error && inBlock(reply.result)) return { txHash };
      const refused = (
        reply?.error?.data as { TxExecutionError?: { InvalidTxError?: unknown } } | undefined
      )?.TxExecutionError?.InvalidTxError;
      // The chain is past the nonces given out here: later operations read it afresh, whether or
      // not this one landed.
      if (isObject(refused) && 'InvalidNonce' in refused) accounts.delete(key);
      const status = await lookUp(o.nearRpc, txHash, o.sender.accountId);
      if (status && !status.error && inBlock(status.result)) return { txHash };
      // A refusal doesn't prove nothing landed (a node may accept a transaction and refuse it on
      // a later check in the same call), so it is unclear too. Errors of the send and of the
      // lookup are taken as NEAR's guide says; an unknown transaction is only "not seen yet".
      let later = false;
      for (const [what, e] of [
        ['send', reply?.error],
        [
          'lookup',
          status?.error?.cause?.name === 'UNKNOWN_TRANSACTION' ? undefined : status?.error,
        ],
      ] as const) {
        if (!e) continue;
        const next = advice(e);
        reason = `NEAR answered the ${what}: ${describe(e)}`;
        if (next === 'elsewhere') return unclear(`${reason}; ask a NEAR RPC that tracks its shard`);
        if (next === 'stop' && what === 'send') return unclear(reason);
        if (next === 'pending') look = true;
        if (next === 'later') later = true;
      }
      // ponytail: sends wait in line meanwhile, at most 3 s per transaction.
      if (attempt < RESENDS && (later || look))
        await new Promise((r) => setTimeout(r, RETRY_WAIT * (attempt + 1)));
    }
    return unclear(reason);
  } catch (e) {
    return unclear(`unexpected: ${(e as Error).message}`);
  }
}
