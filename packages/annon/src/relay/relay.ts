/** Purchase-based relay checks; RPC retry, budgets and nonce serialization are shared. */
import { sha256 } from '@noble/hashes/sha2.js';
import { base58, base64 } from '@scure/base';
import { Account, actions, encodeTransaction, JsonRpcProvider } from 'near-api-js';
import {
  getFile,
  getGrant,
  getPurchase,
  RPC_TIMEOUT_MS,
  type RpcReply,
  rpcReply,
  view,
} from '../near/rpc.js';
import {
  type RegisterArgs,
  type ReopenArgs,
  registerText,
  reopenSellerText,
  reopenText,
  type SellerArgs,
  stopSalesText,
} from '../near/texts.js';
import { block, blockHeader, type EvmLog, getReceipt, paymentLogs } from '../pay/base.js';
import { bytes, exactKeys, uint } from '../settle-near/codec.js';
import { type Authorization, identityJson, verifyAuthorization } from '../settle-near/identity.js';
import {
  baseNonceV2,
  buyerKey,
  parsePurchaseMessage,
  purchaseId,
} from '../settle-near/purchase.js';
import { type SettlementAssets, termsHash } from '../settle-near/terms.js';
import { type KeepOptions, type KeepResult, runKeeper } from './keeper-runner.js';

export type { KeeperRecord, KeepOptions, KeepResult, RefundSource } from './keeper-runner.js';

export type RelayRequest =
  | { method: 'register'; args: RegisterArgs; auth: Authorization }
  | { method: 'reopen'; args: ReopenArgs; auth: Authorization }
  | { method: 'stop_sales' | 'reopen_seller'; args: SellerArgs; auth: Authorization }
  | { method: 'claim_key'; args: { purchase_id: string; grant?: number } }
  | { method: 'unlock'; args: { purchase: string; logs: EvmLog[]; header: string | null } };
export type RelayErrorCode =
  | 'bad_request'
  | 'bad_signature'
  | 'bad_deadline'
  | 'not_sponsored'
  | 'limited'
  | 'duplicate'
  | 'in_flight'
  | 'unavailable'
  | 'unknown_file'
  | 'already_registered'
  | 'sales_stopped'
  | 'taken_down'
  | 'not_buyer'
  | 'payment_not_found'
  | 'payment_not_safe'
  | 'payment_used'
  | 'bad_header'
  | 'transport';
export class RelayError extends Error {
  // A plain field, not a parameter property: the relayer runs this file with Node's type
  // stripping, which has no parameter properties.
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
export interface RelayPolicy {
  minPrice: bigint;
  maxDeadlineSeconds: number;
  sellerAllowed?: (seller: string) => boolean | Promise<boolean>;
  registrationsPerSeller?: number;
  reopensPerWalletFile?: number;
}
export interface CheckOptions {
  nearRpc: string;
  baseRpc: string;
  contractId: string;
  usdc: string;
  nearUsdc?: string;
  policy: RelayPolicy;
  now?: number;
}
export function canonicalRequest(input: unknown, assets?: SettlementAssets): RelayRequest {
  try {
    const r = structuredClone(input) as RelayRequest;
    if (!r || typeof r !== 'object') throw new Error('expected request');
    exactKeys(r, ['method', 'args', ...('auth' in r ? ['auth'] : [])]);
    if ('auth' in r) {
      exactKeys(r.auth, ['kind', 'sig']);
      if (!['evm', 'solana'].includes(r.auth.kind)) throw new Error('invalid auth kind');
      bytes(r.auth.sig, r.auth.kind === 'evm' ? 65 : 64);
    }
    const a = r.args;
    switch (r.method) {
      case 'register':
        exactKeys(a, ['terms', 'seller_key', 'deadline']);
        termsHash(r.args.terms, assets);
        buyerKey(r.args.seller_key);
        break;
      case 'reopen':
        exactKeys(a, ['purchase_id', 'fresh_key', 'nonce', 'deadline']);
        bytes(r.args.purchase_id, 32);
        buyerKey(r.args.fresh_key);
        bytes(r.args.nonce, 32);
        break;
      case 'reopen_seller':
      case 'stop_sales':
        exactKeys(a, ['file_id', 'key', 'deadline']);
        bytes(r.args.file_id, 32);
        if (r.method === 'reopen_seller') buyerKey(r.args.key ?? '');
        else if (r.args.key !== null) throw new Error('stop key must be null');
        break;
      case 'claim_key':
        exactKeys(a, ['purchase_id', ...('grant' in a ? ['grant'] : [])]);
        bytes(r.args.purchase_id, 32);
        if (
          r.args.grant !== undefined &&
          (!Number.isInteger(r.args.grant) || r.args.grant < 0 || r.args.grant > 0xffffffff)
        )
          throw new Error('invalid grant');
        break;
      case 'unlock':
        exactKeys(a, ['purchase', 'logs', 'header']);
        if (parsePurchaseMessage(r.args.purchase, assets).route !== 'base-usdc')
          throw new Error('not a Base purchase');
        if (
          !Array.isArray(r.args.logs) ||
          r.args.logs.length !== 2 ||
          (r.args.header !== null && !/^0x([0-9a-f]{2})+$/.test(r.args.header))
        )
          throw new Error('invalid logs/header');
        r.args.logs = r.args.logs.map((input) => {
          const fields = [
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
          exactKeys(input, [...fields]);
          for (const key of ['address', 'block_hash', 'transaction_hash'] as const)
            bytes(`0x${input[key]}`, key === 'address' ? 20 : 32);
          if (!Array.isArray(input.topics) || input.topics.length !== 3)
            throw new Error('invalid log topics');
          for (const topic of input.topics) bytes(`0x${topic}`, 32);
          for (const key of ['block_number', 'log_index', 'transaction_index'] as const)
            if (!Number.isSafeInteger(input[key]) || (input[key] as number) < 0)
              throw new Error('invalid log index');
          if (
            input.removed !== false ||
            typeof input.data !== 'string' ||
            input.data.length > 256 ||
            !/^0x(?:[0-9a-f]{2})*$/.test(input.data)
          )
            throw new Error('invalid log data');
          return Object.fromEntries(fields.map((k) => [k, input[k]])) as unknown as EvmLog;
        });
        break;
      default:
        throw new Error('unknown method');
    }
    if ('deadline' in a) {
      if (!Number.isSafeInteger(a.deadline)) throw new Error('invalid deadline');
      uint(String(a.deadline), 64);
    }
    if (['register', 'reopen', 'stop_sales', 'reopen_seller'].includes(r.method) && !('auth' in r))
      throw new Error('auth required; NEAR identities call directly');
    return r;
  } catch (e) {
    return fail('bad_request', (e as Error).message);
  }
}
/** Contract wire shape: unlock and identity calls wrap args; claim_key is flat. */
export const contractArgs = (r: RelayRequest): object =>
  'auth' in r ? { args: r.args, auth: r.auth } : r.method === 'unlock' ? { args: r.args } : r.args;
const asRelayError = (e: unknown): never => {
  if (e instanceof RelayError) throw e;
  return fail(
    (e as { code?: string })?.code === 'transport' ? 'transport' : 'bad_request',
    (e as Error).message,
  );
};
export async function checkRelay(r: RelayRequest, o: CheckOptions): Promise<void> {
  try {
    if ('deadline' in r.args) {
      const now = o.now ?? Math.floor(Date.now() / 1000);
      if (r.args.deadline < now || r.args.deadline > now + o.policy.maxDeadlineSeconds)
        fail('bad_deadline');
    }
    const fileId =
      r.method === 'register'
        ? r.args.terms.file_id
        : r.method === 'unlock'
          ? parsePurchaseMessage(r.args.purchase, { baseUsdc: o.usdc }).file_id
          : 'file_id' in r.args
            ? r.args.file_id
            : undefined;
    const p =
      r.method === 'reopen' || r.method === 'claim_key'
        ? await getPurchase(o.nearRpc, o.contractId, r.args.purchase_id)
        : null;
    if ((r.method === 'reopen' || r.method === 'claim_key') && !p) fail('not_buyer');
    const target = fileId ?? p?.file_id;
    if (!target) return fail('not_buyer');
    const file = await getFile(o.nearRpc, o.contractId, target);
    if (r.method === 'register') {
      if (
        r.args.terms.contract !== o.contractId ||
        BigInt(r.args.terms.near.price) < o.policy.minPrice
      )
        fail('not_sponsored');
      if (file) fail('already_registered');
      signedByItsWallet(r, o.contractId, {
        baseUsdc: o.usdc,
        ...(o.nearUsdc ? { nearUsdc: o.nearUsdc } : {}),
      });
      if (
        o.policy.sellerAllowed &&
        !(await o.policy.sellerAllowed(identityJson(r.args.terms.seller)))
      )
        fail('not_sponsored');
      return;
    }
    if (!file) return fail('unknown_file');
    if (file.takenDown) fail('taken_down');
    if (o.policy.sellerAllowed && !(await o.policy.sellerAllowed(identityJson(file.seller))))
      fail('not_sponsored');
    if (r.method === 'claim_key') {
      if (!(await getGrant(o.nearRpc, o.contractId, r.args.purchase_id, r.args.grant)))
        fail('not_buyer');
      return;
    }
    if (r.method === 'reopen') {
      if (!p) return fail('not_buyer');
      if (
        !verifyAuthorization(
          p.recovery,
          reopenText({
            ...r.args,
            contract: o.contractId,
            file_id: p.file_id,
            recovery: p.recovery,
          }),
          r.auth,
        )
      )
        fail('bad_signature');
      return;
    }
    if (r.method === 'reopen_seller' || r.method === 'stop_sales') {
      const text =
        r.method === 'stop_sales'
          ? stopSalesText(o.contractId, r.args, file.seller)
          : reopenSellerText(o.contractId, r.args, file.seller);
      if (!verifyAuthorization(file.seller, text, r.auth)) fail('bad_signature');
      if (r.method === 'stop_sales' && file.salesStoppedAt !== null) fail('sales_stopped');
      return;
    }
    if (r.method !== 'unlock') return;
    const a = r.args;
    const purchase = parsePurchaseMessage(a.purchase, { baseUsdc: o.usdc });
    const id = purchaseId(purchase, { baseUsdc: o.usdc });
    if (
      purchase.route !== 'base-usdc' ||
      purchase.contract !== o.contractId ||
      !file.terms.base ||
      purchase.terms_hash !== file.termsHash ||
      purchase.price !== file.terms.base.price ||
      purchase.asset !== o.usdc
    )
      fail('bad_request');
    if (await getPurchase(o.nearRpc, o.contractId, id)) fail('payment_used');
    const auth = a.logs[0];
    if (!auth) return fail('bad_request');
    const found = paymentLogs(await getReceipt(o.baseRpc, `0x${auth.transaction_hash}`), {
      usdc: o.usdc,
      to: file.payTo,
      from: `0x${auth.topics[1]?.slice(-40)}`,
      nonce: baseNonceV2(id),
      price: BigInt(purchase.price),
    });
    if (!found || JSON.stringify(found) !== JSON.stringify(a.logs)) fail('payment_not_found');
    const safe = await block(o.baseRpc, 'safe');
    if (
      safe.number < auth.block_number ||
      (await block(o.baseRpc, auth.block_number)).hash !== `0x${auth.block_hash}`
    )
      fail('payment_not_safe');
    if (a.header !== null && (await blockHeader(o.baseRpc, `0x${auth.block_hash}`)) !== a.header)
      fail('bad_header');
    if (file.salesStoppedAt !== null) {
      if (a.header === null) fail('bad_header');
      const paidAt = (await block(o.baseRpc, auth.block_number)).timestamp;
      if (BigInt(paidAt) > BigInt(file.salesStoppedAt) + 300n) fail('sales_stopped');
    }
  } catch (e) {
    asRelayError(e);
  }
}

// ---------- sending ----------

export interface Sender {
  /** The NEAR account that sends and pays, e.g. `relayer.annon.defdone.near`. */
  accountId: string;
  /** Its function-call key for the six methods, `ed25519:…`. Only for this contract. */
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
const submitted = new Map<string, RelayResult>();
const counts = new Map<string, { n: number; until: number }>();
/** When each recent write was sent, per payer and contract (see `enoughStorage`). */
const writes = new Map<string, number[]>();
const queues = new Map<string, Promise<unknown>>();
let waiting = 0;

/** How many operations and limit counters are kept; for tests. */
export const relayCounters = () => counts.size + held.size;

/** Clears the in-memory limits; for tests. */
export function resetRelayState() {
  held.clear();
  submitted.clear();
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
function enqueue<T>(job: () => Promise<T>, scope = 'relay'): Promise<T> {
  const next = (queues.get(scope) ?? Promise.resolve()).then(job, job);
  queues.set(
    scope,
    next.catch(() => {}),
  );
  return next;
}

/**
 * What makes two requests the same operation. Only a party that could make the request succeed
 * can hold it: wallet signatures are checked or recovered before anything is held (`stop_sales`
 * by the address that signed, since the seller is known only from the chain), and an unlock
 * includes the buyer's key, which only the buyer knows before it is sent.
 */
const identity = (r: RelayRequest, _contract: string) => {
  if (r.method === 'unlock') return `unlock:${JSON.parse(r.args.purchase).purchase.purchase_id}`;
  if (r.method === 'claim_key') return `claim:${r.args.purchase_id}:${r.args.grant ?? 0}`;
  if (r.method === 'reopen')
    return `reopen:${r.args.purchase_id}:${r.args.fresh_key}:${r.args.nonce}`;
  if (r.method === 'register') return `register:${r.args.terms.file_id}`;
  return `${r.method}:${r.args.file_id}:${r.args.key ?? ''}`;
};
const signedByItsWallet = (r: RelayRequest, contract: string, assets?: SettlementAssets) => {
  if (
    r.method === 'register' &&
    !verifyAuthorization(r.args.terms.seller, registerText(contract, r.args, assets), r.auth)
  )
    fail('bad_signature');
};
const quota = (r: RelayRequest, p: RelayPolicy): [string, number] | null =>
  r.method === 'register'
    ? [`register:${identityJson(r.args.terms.seller)}`, p.registrationsPerSeller ?? 20]
    : r.method === 'reopen'
      ? [`reopen:${r.args.purchase_id}`, p.reopensPerWalletFile ?? 10]
      : null;

export interface RelayResult {
  txHash: string;
  /**
   * NEAR's answer was lost or unclear (a timeout, a gateway error, a refusal): the transaction may
   * or may not be in a block. Read its outcome by hash before asking again. Sending the same
   * operation again is safe: the contract refuses it if the first one landed.
   */
  uncertain?: true;
  /** RPC validation refused this submission before execution. */
  rejected?: true;
  /** With `uncertain` or `rejected`: what NEAR answered, for the operator. */
  reason?: string;
}

/** Read an already admitted operation without charging admission limits or sending anything. */
export function relayStatus(input: unknown, o: CheckOptions): RelayResult | 'pending' | null {
  try {
    const assets = { baseUsdc: o.usdc, ...(o.nearUsdc ? { nearUsdc: o.nearUsdc } : {}) };
    const r = canonicalRequest(input, assets);
    const operation = `${o.nearRpc}|${o.contractId}|${identity(r, o.contractId)}`;
    // Cheap miss first: this runs before the IP limiter, so unknown requests never reach a signature check.
    if ((held.get(operation) ?? 0) <= Date.now()) return null;
    signedByItsWallet(r, o.contractId, assets);
    return submitted.get(operation) ?? 'pending';
  } catch (e) {
    return asRelayError(e);
  }
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
  const r = canonicalRequest(input, {
    baseUsdc: o.usdc,
    ...(o.nearUsdc ? { nearUsdc: o.nearUsdc } : {}),
  });
  // A forged request must not take another wallet's limit or hold its operation.
  signedByItsWallet(r, o.contractId, {
    baseUsdc: o.usdc,
    ...(o.nearUsdc ? { nearUsdc: o.nearUsdc } : {}),
  });
  const operation = `${o.nearRpc}|${o.contractId}|${identity(r, o.contractId)}`;
  const previous = submitted.get(operation);
  if (previous && (held.get(operation) ?? 0) > Date.now()) return previous;
  const now = Date.now();
  for (const [k, v] of held)
    if (v <= now) {
      held.delete(k);
      submitted.delete(k);
    }
  for (const [k, v] of counts) if (v.until <= now) counts.delete(k);
  if ((held.get(operation) ?? 0) > now)
    fail('in_flight', 'this operation is in flight; retry shortly');
  if (waiting >= MAX_WAITING) fail('unavailable', 'the relayer is busy; try again shortly');
  // Per contract: relayers for other contracts in the same process don't share operations.
  const id = `${o.nearRpc}|${o.contractId}|${identity(r, o.contractId)}`;
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
      const { txHash, signed } = await sign(o, key, r.method, contractArgs(r));
      sent = true;
      submitted.set(id, { txHash, uncertain: true });
      if (write) writes.get(scope)?.push(Date.now()) ?? writes.set(scope, [Date.now()]);
      return send(o, key, txHash, signed);
    }, senderKey(o));
    held.set(id, Date.now() + HOLD);
    submitted.set(id, out);
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

/** Signs one function call, no deposit, with the sender's key (one account per key, so near-api-js
 * numbers its nonces locally across calls). */
async function sign(
  o: { nearRpc: string; contractId: string; sender: Sender },
  key: string,
  method: string,
  args: object,
  gas = GAS,
) {
  let account = accounts.get(key);
  if (!account) {
    account = new Account(
      o.sender.accountId,
      signingProvider(o.nearRpc),
      o.sender.key as `ed25519:${string}`,
    );
    accounts.set(key, account);
  }
  const tx = await account
    .createSignedTransaction({
      receiverId: o.contractId,
      actions: [actions.functionCall(method, args, gas, 0n)],
    })
    .catch((e: Error) => fail('transport', `NEAR RPC: ${e.message}`));
  return {
    txHash: base58.encode(sha256(tx.transaction.encode())),
    signed: base64.encode(encodeTransaction(tx)),
  };
}

/** A dedicated account/key has its own nonce queue, independent from relay traffic. */
export async function keep(o: KeepOptions): Promise<KeepResult> {
  const key = senderKey(o);
  return enqueue(
    () =>
      runKeeper(o, {
        sign: (method, args, gas) => sign(o, key, method, args, gas),
        send: (hash, signed) => send(o, key, hash, signed, true),
      }),
    key,
  );
}

/**
 * Sends signed bytes; after a lost or unclear answer, looks the transaction up and sends the same
 * bytes again (same hash). Keepers retire only definite validation refusals.
 */
async function send(
  o: { nearRpc: string; sender: Sender },
  key: string,
  txHash: string,
  signed: string,
  keeper = false,
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
      const legacy = reply?.error?.data as
        | { TxExecutionError?: { InvalidTxError?: unknown } }
        | undefined;
      const info = reply?.error?.cause?.info as { InvalidTxError?: unknown } | undefined;
      const refused = legacy?.TxExecutionError?.InvalidTxError ?? info?.InvalidTxError;
      const variant =
        typeof refused === 'string'
          ? refused
          : isObject(refused)
            ? Object.keys(refused)[0]
            : undefined;
      // InvalidNonce can mean these very bytes already landed. Unknown variants are ambiguous too.
      const definite = new Set([
        'NotEnoughBalance',
        'NotEnoughAllowance',
        'InvalidAccessKeyError',
        'InvalidSignerId',
        'SignerDoesNotExist',
        'InvalidReceiverId',
        'InvalidSignature',
        'CostOverflow',
        'InvalidChain',
        'Expired',
        'ActionsValidation',
        'TransactionSizeExceeded',
      ]);
      if (keeper && variant !== undefined && definite.has(variant)) {
        accounts.delete(key);
        // Only the variant name is public; RPC data may echo arbitrary transaction fields.
        return {
          txHash,
          rejected: true,
          reason: variant && /^[A-Za-z]+$/.test(variant) ? variant : 'InvalidTxError',
        };
      }
      // The chain is past the nonces given out here: later operations read it afresh, whether or
      // not this one landed.
      if (variant === 'InvalidNonce') accounts.delete(key);
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
        if (what === 'send' && (next === 'stop' || (keeper && next !== 'pending')))
          return unclear(reason);
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

export {
  type DeliveryInfo,
  type DeliveryStep,
  deliveryCount,
  fundDelivery,
  getDelivery,
  listDeliveries,
  listOpenDeliveries,
  type MaterializeRefundArgs,
  materializeRefund,
  openDeliveryCount,
  paySlot,
  type RefundRoot,
  refundRoot,
  settle,
} from './keeper.js';
