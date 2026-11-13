import { AnnonError } from '../errors.js';
/**
 * Reading Base over JSON-RPC: what the buyer's checks need before signing (balance, code, the
 * head block), a dry run of the signed authorization against USDC itself, and, after the payment,
 * the logs `unlock` takes. The RPC is trusted to report the chain, as on the NEAR side; a payment
 * it misreports is caught by NEAR MPC, which reads Base itself.
 */

import { keccak_256 } from '@noble/hashes/sha3.js';
import { RPC_TIMEOUT_MS } from '../near/rpc.js';
import { type Authorization, addressWord, fromHex, toHex, word } from './eip3009.js';
import type { PurchaseRecord } from './purchase.js';

export type PayErrorCode =
  /** The RPC couldn't be reached or answered something malformed; safe to retry. */
  | 'transport'
  | 'base_rpc_rate_limited'
  | 'refused'
  /** The payment request or the registration don't allow this purchase; nothing was signed. */
  | 'storage_required'
  | 'unknown_file'
  | 'taken_down'
  | 'sales_stopped'
  | 'unknown_moderator'
  | 'price_mismatch'
  | 'price_above_max'
  | 'file_storage_low'
  | 'protocol_fee_above_max'
  | 'recipient_mismatch'
  | 'file_mismatch'
  | 'network_mismatch'
  | 'token_mismatch'
  /** The offer's transfer method isn't the one the registration needs. */
  | 'method_mismatch'
  /** The payment request names an Annon contract this client doesn't trust. */
  | 'untrusted_contract'
  /** The PAY2 header (or the public file) isn't the registered file signed by its seller. */
  | 'file_invalid'
  | 'route_unavailable'
  | 'bad_requirements'
  | 'insufficient_balance'
  | 'smart_wallet_unsupported'
  /** The wallet's answer isn't a signature USDC accepts from this buyer. */
  | 'bad_signature'
  /** USDC refused the signed authorization in a dry run (the RPC saw it; see `PayError.purchase`). */
  | 'payment_rejected'
  /** This wallet has an open purchase of this file: follow `nextStep` of the recorded one. */
  | 'purchase_open'
  /** The purchase record changed under this writer (another tab or process): load it again. */
  | 'store_conflict'
  /** A seller: this payment id came with another payload before (HTTP 409). */
  | 'payment_id_conflict'
  /** A seller: the settlement of this purchase is under way or unclear; send the same payload later. */
  | 'settlement_pending'
  | 'not_sponsored'
  | 'wrong_identity'
  | 'relayer_unavailable'
  | 'facilitator_busy'
  | 'unavailable'
  /** A seller: this purchase can no longer be paid (expired or canceled, finalized). */
  | 'payment_expired';

export class PayError extends AnnonError {
  readonly code: PayErrorCode;
  /**
   * Set when the wallet had already signed: the authorization may have reached an RPC and could
   * still be settled. The purchase stays open: follow `nextStep`.
   */
  purchase?: PurchaseRecord;
  retryAfterSeconds?: number;
  constructor(code: PayErrorCode, message: string = code) {
    super(code, message);
    this.code = code;
    this.name = 'PayError';
  }
}

/** A typed RPC rate limit; callers retry through isTransient. */
export class BaseRpcRateLimited extends PayError {
  constructor() {
    super('base_rpc_rate_limited', 'Base RPC rate limited (429)');
    this.name = 'BaseRpcRateLimited';
  }
}

export const fail = (code: PayErrorCode, message?: string): never => {
  throw new PayError(code, message);
};
const malformed = (what: string): never => fail('transport', `malformed Base RPC answer: ${what}`);

let nextId = 0;

type RpcError = { code?: unknown; message?: unknown; data?: unknown };

async function rpc(url: string, method: string, params: unknown[]) {
  const id = `annon-base-${++nextId}`;
  let body: { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: RpcError };
  try {
    const res = await fetch(url, {
      credentials: 'omit',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    const httpFailure = (): never => {
      if (res.status === 429) throw new BaseRpcRateLimited();
      return fail('transport', `Base RPC HTTP ${res.status}`);
    };
    try {
      body = await res.json();
    } catch (error) {
      if (!res.ok) return httpFailure();
      throw error;
    }
    if (res.status === 429) return httpFailure();
    // Preserve structured RPC replies on non-2xx responses, as on NEAR.
    if (
      !res.ok &&
      (!body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        (body.jsonrpc !== '2.0' && body.id !== id) ||
        (!('result' in body) && !('error' in body)))
    )
      return httpFailure();
  } catch (e) {
    if (e instanceof PayError) throw e;
    return fail('transport', `Base RPC unreachable: ${(e as Error).message}`);
  }
  if (body?.id !== id) return malformed('a reply to another request');
  return body;
}

async function ask(url: string, method: string, params: unknown[]): Promise<unknown> {
  const body = await rpc(url, method, params);
  if (body.error)
    fail(
      method === 'eth_call' && body.error.code === 3 ? 'refused' : 'transport',
      `Base RPC error: ${JSON.stringify(body.error)}`,
    );
  if (body.result === undefined) return malformed(`no result for ${method}`);
  return body.result;
}

const isHexData = (v: unknown): v is string =>
  typeof v === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(v);
const quantity = (v: unknown, what: string): number => {
  if (typeof v !== 'string' || !/^0x(0|[1-9a-f][0-9a-f]*)$/i.test(v)) return malformed(what);
  const n = Number.parseInt(v, 16);
  return Number.isSafeInteger(n) ? n : malformed(what);
};
const qty = (n: number) => `0x${n.toString(16)}`;
const selector = (signature: string) =>
  keccak_256(new TextEncoder().encode(signature)).subarray(0, 4);
const call = (...parts: Uint8Array[]) =>
  toHex(Uint8Array.from(parts.flatMap((p) => Array.from(p))));

export interface Head {
  number: number;
  timestamp: number;
  /** 0x and lowercase, when the RPC gave it. */
  hash?: string;
}

/** The latest block, after checking the RPC is on Base mainnet. */
export async function head(url: string): Promise<Head> {
  if ((await ask(url, 'eth_chainId', [])) !== '0x2105') {
    fail('network_mismatch', 'the Base RPC is not on Base mainnet (chain 8453)');
  }
  return block(url, 'latest');
}

/** A block by number or tag (`latest`, `safe`, `finalized`). */
export async function block(
  url: string,
  at: number | 'latest' | 'safe' | 'finalized',
): Promise<Head> {
  const b = (await ask(url, 'eth_getBlockByNumber', [
    typeof at === 'number' ? qty(at) : at,
    false,
  ])) as Record<string, unknown>;
  return {
    number: quantity(b?.number, 'block number'),
    timestamp: quantity(b?.timestamp, 'timestamp'),
    ...(typeof b?.hash === 'string' ? { hash: b.hash.toLowerCase() } : {}),
  };
}

/** A transaction's receipt as the RPC returns it; null while the transaction is unknown. */
export const getReceipt = (url: string, txHash: string): Promise<unknown> =>
  ask(url, 'eth_getTransactionReceipt', [txHash]);

/** A view call at `block` that returns one 32-byte word. */
export async function viewWord(url: string, to: string, data: string, block: number) {
  const r = await ask(url, 'eth_call', [{ to, data }, qty(block)]);
  if (!isHexData(r) || r.length !== 66) return malformed('eth_call result');
  return r.toLowerCase();
}

const uint = async (url: string, to: string, data: string, block: number) =>
  BigInt(await viewWord(url, to, data, block));

export const balanceOf = (url: string, usdc: string, owner: string, block: number) =>
  uint(url, usdc, call(selector('balanceOf(address)'), addressWord(owner)), block);

/** USDC's `authorizationState`: true once the nonce was used *or* canceled. A hint, not proof. */
export const authorizationState = async (
  url: string,
  usdc: string,
  authorizer: string,
  nonce: string,
  block: number,
) =>
  (await uint(
    url,
    usdc,
    call(
      selector('authorizationState(address,bytes32)'),
      addressWord(authorizer),
      fromHex(nonce, 32, 'nonce'),
    ),
    block,
  )) !== 0n;

/** Whether an address has code: a contract, or an EOA delegated with EIP-7702. */
/** The runtime code at `address`, lowercase hex; `0x` for none. */
export async function getCode(url: string, address: string, block: number): Promise<string> {
  const r = await ask(url, 'eth_getCode', [address, qty(block)]);
  if (!isHexData(r)) return malformed('eth_getCode result');
  return r.toLowerCase();
}

export const hasCode = async (url: string, address: string, block: number) =>
  (await getCode(url, address, block)) !== '0x';

/** `transferWithAuthorization(from, to, value, after, before, nonce, v, r, s)`. */
export function authorizationCall(a: Authorization, signature: string): string {
  const sig = fromHex(signature, 65, 'signature');
  return call(
    selector(
      'transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)',
    ),
    addressWord(a.from),
    addressWord(a.to),
    word(a.value),
    word(a.validAfter),
    word(a.validBefore),
    fromHex(a.nonce, 32, 'nonce'),
    word(BigInt(sig[64] ?? 0)),
    sig.subarray(0, 32),
    sig.subarray(32, 64),
  );
}

/**
 * Runs the signed authorization against USDC without sending it: signature, nonce, validity
 * window, balance and blacklist, all by USDC's own code.
 */
export async function dryRun(url: string, usdc: string, a: Authorization, signature: string) {
  const body = await rpc(url, 'eth_call', [
    { from: a.from, to: usdc, data: authorizationCall(a, signature) },
    'latest',
  ]);
  if (body.error) {
    const message = String(body.error.message ?? '');
    if (body.error.code === 3) {
      fail('payment_rejected', `USDC refused the authorization: ${message}`);
    }
    fail('transport', `Base RPC error: ${JSON.stringify(body.error)}`);
  }
  if (!isHexData(body.result)) malformed('eth_call result');
}

// ---------- the payment's block header ----------

/** Header fields in RLP order (London to Prague / Isthmus); integers are minimal big-endian. */
const HEADER_FIELDS: [string, 'bytes' | 'int'][] = [
  ['parentHash', 'bytes'],
  ['sha3Uncles', 'bytes'],
  ['miner', 'bytes'],
  ['stateRoot', 'bytes'],
  ['transactionsRoot', 'bytes'],
  ['receiptsRoot', 'bytes'],
  ['logsBloom', 'bytes'],
  ['difficulty', 'int'],
  ['number', 'int'],
  ['gasLimit', 'int'],
  ['gasUsed', 'int'],
  ['timestamp', 'int'],
  ['extraData', 'bytes'],
  ['mixHash', 'bytes'],
  ['nonce', 'bytes'],
  ['baseFeePerGas', 'int'],
  ['withdrawalsRoot', 'bytes'],
  ['blobGasUsed', 'int'],
  ['excessBlobGas', 'int'],
  ['parentBeaconBlockRoot', 'bytes'],
  ['requestsHash', 'bytes'],
];

const rlpLength = (n: number, offset: number): number[] => {
  if (n < 56) return [offset + n];
  const b: number[] = [];
  for (let x = n; x > 0; x = Math.floor(x / 256)) b.unshift(x % 256);
  return [offset + 55 + b.length, ...b];
};
const rlpString = (b: Uint8Array): number[] =>
  b.length === 1 && (b[0] ?? 0) < 0x80 ? [...b] : [...rlpLength(b.length, 0x80), ...b];
const minimal = (h: string): Uint8Array => {
  const n = BigInt(h);
  if (n === 0n) return new Uint8Array();
  const s = n.toString(16);
  return Uint8Array.from((s.length % 2 ? `0${s}` : s).match(/../g) ?? [], (x) =>
    Number.parseInt(x, 16),
  );
};
const bytesOf = (h: unknown, what: string): Uint8Array => {
  if (!isHexData(h)) return malformed(`header ${what}`);
  return Uint8Array.from(h.slice(2).match(/../g) ?? [], (x) => Number.parseInt(x, 16));
};

/**
 * The RLP header of the block `hash`, rebuilt from the RPC's fields and checked to hash to it.
 * `unlock` takes it for a file whose sales were stopped: the contract reads the payment's time
 * from it. A header with a field this SDK doesn't know fails here, never on NEAR.
 */
export async function blockHeader(url: string, hash: string): Promise<string> {
  const b = (await ask(url, 'eth_getBlockByHash', [hash, false])) as Record<string, unknown>;
  const present = HEADER_FIELDS.filter(([k]) => b?.[k] !== undefined);
  const body = present.flatMap(([k, kind]) =>
    rlpString(kind === 'int' ? minimal(String(b[k])) : bytesOf(b[k], k)),
  );
  const rlp = Uint8Array.from([...rlpLength(body.length, 0xc0), ...body]);
  if (toHex(keccak_256(rlp)) !== hash.toLowerCase()) {
    return fail('transport', `block ${hash}: the rebuilt header does not hash to it`);
  }
  return toHex(rlp);
}

// ---------- after the payment ----------

const topic = (signature: string) => toHex(keccak_256(new TextEncoder().encode(signature)));
export const TOPICS = {
  authorizationUsed: topic('AuthorizationUsed(address,bytes32)'),
  authorizationCanceled: topic('AuthorizationCanceled(address,bytes32)'),
  transfer: topic('Transfer(address,address,uint256)'),
};

/** A log as the contract's `unlock` takes it (NEAR MPC's `EvmLog`). */
export interface EvmLog {
  address: string;
  block_hash: string;
  block_number: number;
  data: string;
  log_index: number;
  removed: boolean;
  topics: string[];
  transaction_hash: string;
  transaction_index: number;
}

const hash = (v: unknown, what: string) =>
  typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v) ? v.toLowerCase() : malformed(what);

function evmLog(l: Record<string, unknown>): EvmLog {
  if (typeof l?.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(l.address)) {
    return malformed('log address');
  }
  if (!Array.isArray(l.topics) || !isHexData(l.data) || typeof l.removed !== 'boolean') {
    return malformed('log');
  }
  return {
    address: l.address.slice(2).toLowerCase(),
    block_hash: hash(l.blockHash, 'log blockHash').slice(2),
    block_number: quantity(l.blockNumber, 'log blockNumber'),
    data: l.data.toLowerCase(),
    log_index: quantity(l.logIndex, 'log logIndex'),
    removed: l.removed,
    topics: l.topics.map((t) => hash(t, 'log topic').slice(2)),
    transaction_hash: hash(l.transactionHash, 'log transactionHash').slice(2),
    transaction_index: quantity(l.transactionIndex, 'log transactionIndex'),
  };
}

/** What a purchase expects to find on Base: the job saved before the buyer signed. */
export interface Expected {
  usdc: string;
  /** The registered `pay_to`. */
  to: string;
  from: string;
  /** The signed nonce. */
  nonce: string;
  price: bigint;
}

const strip = (h: string) => h.slice(2).toLowerCase();
const topicOf = (address: string) => strip(toHex(addressWord(address)));

/**
 * The logs of this purchase in a transaction receipt, exactly as `unlock` checks them: USDC's
 * `AuthorizationUsed` for the nonce and the `Transfer` to `pay_to` right after it. Null when the
 * receipt holds no such payment.
 */
export function paymentLogs(receipt: unknown, e: Expected): EvmLog[] | null {
  const r = receipt as { status?: unknown; transactionHash?: unknown; logs?: unknown } | null;
  if (r?.status !== '0x1' || !Array.isArray(r.logs)) return null;
  const tx = hash(r.transactionHash, 'receipt transactionHash').slice(2);
  const logs = r.logs.map(evmLog);
  const at = (address: string, t0: string) => (l: EvmLog) =>
    l.transaction_hash === tx &&
    !l.removed &&
    l.address === strip(address) &&
    l.topics.length === 3 &&
    l.topics[0] === strip(t0);
  const amount = (data: string, offset: number) =>
    BigInt(`0x${data.slice(2 + offset * 64, 2 + (offset + 1) * 64) || '0'}`);

  // EIP-3009 nonces are per authorizer: another payer's log with the same nonce in the same
  // transaction must not hide this one.
  const i = logs.findIndex(
    (l) =>
      at(e.usdc, TOPICS.authorizationUsed)(l) &&
      l.topics[1] === topicOf(e.from) &&
      l.topics[2] === strip(e.nonce),
  );
  const [auth, transfer] = [logs[i], logs[i + 1]];
  if (i < 0 || !auth || !transfer || !at(e.usdc, TOPICS.transfer)(transfer)) return null;
  if (
    transfer.log_index !== auth.log_index + 1 ||
    transfer.topics[1] !== topicOf(e.from) ||
    transfer.topics[2] !== topicOf(e.to) ||
    transfer.data.length !== 2 + 64
  ) {
    return null;
  }
  return amount(transfer.data, 0) === e.price ? [auth, transfer] : null;
}

export type PaymentStatus =
  /** On Base: `logs` go to `unlock`; `logIndex` identifies its first proved log. */
  | { state: 'paid'; txHash: string; logIndex: number; logs: EvmLog[] }
  /** Not on Base yet and still valid: wait, or send the same header again. */
  | { state: 'pending' }
  /** Can never be paid: a new purchase with a new one-time key is safe. */
  | { state: 'expired' }
  | { state: 'canceled' };

/**
 * The last block the payment could be in: the first at or past `validBefore` (USDC refuses it
 * there and after), or the head. Searched forward, so it holds whatever Base's block time is.
 */
async function lastBlock(url: string, from: number, validBefore: bigint, now: Head) {
  // Note: a first guess of 5 blocks a second (Base since Denim, 5 Nov 2026), doubled on a miss.
  let step = Math.max(1, (Number(validBefore) - (await block(url, from)).timestamp) * 5);
  for (let at = from + step; ; at += step, step *= 2) {
    if (at >= now.number) return now.number;
    if (BigInt((await block(url, at)).timestamp) >= validBefore) return at;
  }
}

/** The block of an `AuthorizationCanceled` for this nonce in `[from, to]`, searched in chunks. */
async function canceledAfter(url: string, e: Expected, from: number, to: number) {
  // Note: 10,000 blocks per query, the common RPC limit; a long-expired purchase takes several.
  for (let at = from; at <= to; at += 10_000) {
    const end = Math.min(to, at + 9_999);
    const topics = [
      TOPICS.authorizationCanceled,
      toHex(addressWord(e.from)),
      e.nonce.toLowerCase(),
    ];
    const found = await ask(url, 'eth_getLogs', [
      { address: e.usdc, fromBlock: qty(at), toBlock: qty(end), topics },
    ]);
    if (!Array.isArray(found)) return malformed('eth_getLogs result');
    for (const l of found.map(evmLog).filter((l) => !l.removed)) {
      if (
        l.address !== strip(e.usdc) ||
        l.topics.join() !== topics.map(strip).join() ||
        l.block_number < at ||
        l.block_number > end
      ) {
        return malformed('eth_getLogs returned a log the query did not ask for');
      }
      return l.block_number;
    }
  }
  return null;
}

/**
 * Where a signed purchase stands, found by its nonce alone, so a lost transaction hash loses
 * nothing. `block` is the head when it was signed. A payment counts as soon as it is in a block;
 * `expired` and `canceled` only from the finalized chain, because a new purchase follows them and
 * a reorg must not turn that into a second payment. `authorizationState` is only read to catch an
 * RPC that misses logs.
 */
export async function paymentStatus(
  url: string,
  e: Expected & { block: number; validBefore: bigint },
): Promise<PaymentStatus> {
  // Finalized first: the head read after it is at least as far, so a payment in any block the
  // expiry below relies on is inside the search.
  const final = await block(url, 'finalized');
  const now = await head(url);
  const last = await lastBlock(url, e.block, e.validBefore, now);
  const query = {
    address: e.usdc,
    fromBlock: qty(e.block),
    toBlock: qty(last),
    topics: [
      [TOPICS.authorizationUsed, TOPICS.authorizationCanceled],
      toHex(addressWord(e.from)),
      e.nonce.toLowerCase(),
    ],
  };
  const found = await ask(url, 'eth_getLogs', [query]);
  if (!Array.isArray(found)) return malformed('eth_getLogs result');
  const logs = found.map(evmLog).filter((l) => !l.removed);
  // Every log must answer the query; anything else is an RPC that can't be believed.
  for (const l of logs) {
    if (
      l.address !== strip(e.usdc) ||
      l.topics.length !== 3 ||
      !(query.topics[0] as string[]).some((t) => strip(t) === l.topics[0]) ||
      l.topics[1] !== topicOf(e.from) ||
      l.topics[2] !== strip(e.nonce) ||
      l.block_number < e.block ||
      l.block_number > last
    ) {
      return malformed('eth_getLogs returned a log the query did not ask for');
    }
  }
  const used = logs.find((l) => l.topics[0] === strip(TOPICS.authorizationUsed));
  if (used) {
    const receipt = await ask(url, 'eth_getTransactionReceipt', [`0x${used.transaction_hash}`]);
    const paid = paymentLogs(receipt, e);
    if (!paid?.[0] || paid[0].transaction_hash !== used.transaction_hash) {
      return fail('transport', 'the authorization was used, but not for this purchase as expected');
    }
    return {
      state: 'paid',
      txHash: `0x${paid[0].transaction_hash}`,
      logIndex: paid[0].log_index,
      logs: paid,
    };
  }
  const canceled = logs.find((l) => l.topics[0] === strip(TOPICS.authorizationCanceled));
  if (canceled)
    return canceled.block_number <= final.number ? { state: 'canceled' } : { state: 'pending' };
  if (await authorizationState(url, e.usdc, e.from, e.nonce, now.number)) {
    // USDC takes a cancellation after the deadline too: look for one up to the head.
    const late = await canceledAfter(url, e, last + 1, now.number);
    if (late !== null) return late <= final.number ? { state: 'canceled' } : { state: 'pending' };
    return fail(
      'transport',
      'USDC marks the authorization used, but the RPC returned no log for it',
    );
  }
  // Blocks after the finalized one are later still, so none of them can take the payment.
  return BigInt(final.timestamp) >= e.validBefore ? { state: 'expired' } : { state: 'pending' };
}
