/** Purchase-based relay checks; RPC retry, budgets and nonce serialization are shared. */
import { sha256 } from '@noble/hashes/sha2.js';
import { base58, base64 } from '@scure/base';
import { Account, actions, encodeTransaction, JsonRpcProvider } from 'near-api-js';
import { AnnonError, isTransient } from '../errors.js';
import {
  type FileInfo,
  getFile,
  getGrant,
  getPurchase,
  RPC_TIMEOUT_MS,
  type RpcReply,
  readOutcome,
  rpcReply,
  view,
} from '../near/rpc.js';
import {
  type FileFundingArgs,
  fileFundingText,
  type RegisterArgs,
  type ReopenArgs,
  registerText,
  reopenSellerText,
  reopenText,
  type SellerArgs,
  stopSalesText,
} from '../near/texts.js';
import { sleep } from '../net/retry.js';
import { block, blockHeader, type EvmLog, getReceipt, paymentLogs } from '../pay/base.js';
import { createSplit, readSplitState } from '../pay/split.js';
import { bytes, exactKeys, uint } from '../settle-near/codec.js';
import { type Authorization, identityJson, verifyAuthorization } from '../settle-near/identity.js';
import {
  baseNonceV2,
  buyerKey,
  parsePurchaseMessage,
  purchaseId,
} from '../settle-near/purchase.js';
import { type SettlementAssets, termsHash } from '../settle-near/terms.js';
import { type AdmissionOptions, admissionBalance, checkAdmissionFloor } from './admission.js';
import { checkProtocolFee, type ProtocolFee } from './fees.js';
import { type KeepOptions, type KeepResult, runKeeper } from './keeper-runner.js';
import type { RelayLedger, RelayLimits, SponsorshipDecision } from './ledger.js';
import { requestHash } from './ledger.js';
import { type HostingReservation, parseReservation, verifyReservation } from './reservation.js';
import { admitTerms, checkedDecision, relayLimits, temporary } from './sponsorship.js';

export type { KeeperRecord, KeepOptions, KeepResult, RefundSource } from './keeper-runner.js';

export type RelayRequest =
  | { method: 'fund_file_storage'; args: FileFundingArgs; auth: Authorization }
  | {
      method: 'register';
      args: RegisterArgs;
      auth: Authorization;
      baseSplit?: { kind: 'push' | 'pull'; salt: string };
      hostingReservation?: HostingReservation;
    }
  | { method: 'reopen'; args: ReopenArgs; auth: Authorization }
  | { method: 'stop_sales' | 'reopen_seller'; args: SellerArgs; auth: Authorization }
  | { method: 'claim_key'; args: { purchase_id: string; grant?: number } }
  | { method: 'unlock'; args: { purchase: string; logs: EvmLog[]; header: string | null } };
export type RelayErrorCode =
  | 'budget'
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
  | 'settlement_pending'
  | 'relayer_unavailable'
  | 'payment_used'
  | 'bad_header'
  | 'transport';
export class RelayError extends AnnonError {
  // A plain field, not a parameter property: the relayer runs this file with Node's type
  // stripping, which has no parameter properties.
  readonly code: RelayErrorCode;
  retryAt?: number;
  constructor(code: RelayErrorCode, message: string = code) {
    super(code, message);
    this.code = code;
    this.name = 'RelayError';
  }
}
const fail = (code: RelayErrorCode, message?: string): never => {
  throw new RelayError(code, message);
};
export interface RelayPolicy {
  minPrice: bigint;
  baseSponsorship?: boolean;
  openPoolEnabled?: boolean;
  listedRegistrationsPerSeller?: number;
  unlocksPerFile?: number;
  unlocksPerSeller?: number;
  listedUnlocksPerFile?: number;
  listedUnlocksPerSeller?: number;
  listedTopupPerFile?: bigint;
  listedTopupPerFileDay?: bigint;
  topupListedReserved?: bigint;
  prepaidUnlockFloor?: bigint;
  storagePerWrite?: bigint;
  topupMaxDeadlineSeconds?: number;
  /** Listed sellers get a larger allocation; unlisted sellers remain eligible. */
  fileBudget?: bigint;
  listedFileBudget?: bigint;
  fee?: ProtocolFee;
  sponsoredFilesPerDay?: number;
  topupPerFile?: bigint;
  topupPerFileDay?: bigint;
  topupPerDay?: bigint;
  maxDeadlineSeconds: number;
  /** Listed-seller predicate for allocation tiers; does not deny unlisted sellers. */
  sellerAllowed?: (seller: string) => boolean | Promise<boolean>;
  registrationsPerSeller?: number;
  reopensPerWalletFile?: number;
  /** Daily limit per (purchase, grant). */
  claimsPerGrant?: number;
  holdMs?: number;
  maxWaiting?: number;
  maxChecking?: number;
}
export interface CheckOptions extends AdmissionOptions {
  nearRpc: string;
  baseRpc: string;
  contractId: string;
  usdc: string;
  nearUsdc?: string;
  policy: RelayPolicy;
  now?: number;
  network?: string;
  ledger?: RelayLedger;
  admissionLimits?: Partial<RelayLimits>;
  ip?: string;
  acceptingNewBasePayments?: boolean;
  historicalFile?: (fileId: string, blockHash: string) => Promise<FileInfo | null>;
  reservation?: {
    hostOrigin: string;
    publicKey: string;
    fetch?: typeof fetch;
    maxFileBytes?: number;
  };
  alert?: (type: string) => void;
}
export function canonicalRequest(input: unknown, assets?: SettlementAssets): RelayRequest {
  try {
    const r = structuredClone(input) as RelayRequest;
    if (!r || typeof r !== 'object') throw new Error('expected request');
    exactKeys(r, [
      'method',
      'args',
      ...('auth' in r ? ['auth'] : []),
      ...('baseSplit' in r ? ['baseSplit'] : []),
      ...('hostingReservation' in r ? ['hostingReservation'] : []),
    ]);
    if ('hostingReservation' in r) {
      if (r.method !== 'register') throw new Error('invalid hosting reservation');
      r.hostingReservation = parseReservation(r.hostingReservation);
    }
    if ('baseSplit' in r) {
      if (r.method !== 'register' || !r.baseSplit) throw new Error('invalid split provenance');
      exactKeys(r.baseSplit, ['kind', 'salt']);
      if (!['push', 'pull'].includes(r.baseSplit.kind)) throw new Error('invalid split kind');
      bytes(r.baseSplit.salt, 32);
    }
    if ('auth' in r) {
      if (
        !['register', 'reopen', 'reopen_seller', 'stop_sales', 'fund_file_storage'].includes(
          r.method,
        )
      )
        throw new Error('unexpected authorization');
      exactKeys(r.auth, ['kind', 'sig']);
      if (!['evm', 'solana'].includes(r.auth.kind)) throw new Error('invalid auth kind');
      bytes(r.auth.sig, r.auth.kind === 'evm' ? 65 : 64);
    }
    const a = r.args;
    switch (r.method) {
      case 'fund_file_storage':
        exactKeys(a, ['file_id', 'amount', 'nonce', 'deadline']);
        bytes(r.args.nonce, 32);
        bytes(r.args.file_id, 32);
        if (uint(r.args.amount, 128) <= 0n) throw new Error('positive topup required');
        break;
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
        r.args.grant = r.args.grant ?? 0;
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
    if (
      ['register', 'reopen', 'stop_sales', 'reopen_seller', 'fund_file_storage'].includes(
        r.method,
      ) &&
      !('auth' in r)
    )
      throw new Error('auth required; NEAR identities call directly');
    return r;
  } catch (e) {
    return fail('bad_request', (e as Error).message);
  }
}
/** Contract wire shape: unlock and identity calls wrap args; claim_key is flat. */
export const contractArgs = (r: RelayRequest): object =>
  r.method === 'fund_file_storage'
    ? { file_id: r.args.file_id, amount: r.args.amount }
    : 'auth' in r
      ? { args: r.args, auth: r.auth }
      : r.method === 'unlock'
        ? { args: r.args }
        : r.args;
const asRelayError = (e: unknown): never => {
  if (e instanceof RelayError) throw e;
  return fail(isTransient(e) ? 'transport' : 'bad_request', (e as Error).message);
};
export async function checkRelay(r: RelayRequest, o: CheckOptions): Promise<void> {
  try {
    if ('deadline' in r.args) {
      const now = o.now ?? Math.floor(Date.now() / 1000);
      if (
        (r.method === 'fund_file_storage' ? r.args.deadline <= now : r.args.deadline < now) ||
        r.args.deadline >
          now +
            (r.method === 'fund_file_storage'
              ? (o.policy.topupMaxDeadlineSeconds ?? 600)
              : o.policy.maxDeadlineSeconds)
      )
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
        BigInt(r.args.terms.near.price) < o.policy.minPrice ||
        (r.args.terms.base !== null && BigInt(r.args.terms.base.price) < o.policy.minPrice)
      )
        fail('not_sponsored');
      if (file) fail('already_registered');
      signedByItsWallet(r, o.contractId, {
        baseUsdc: o.usdc,
        ...(o.nearUsdc ? { nearUsdc: o.nearUsdc } : {}),
      });
      if (o.policy.fee) {
        try {
          checkProtocolFee(r.args.terms, o.policy.fee);
        } catch {
          fail('not_sponsored', 'required treasury share missing or invalid');
        }
      }
      if (r.args.terms.base) {
        const provenance = r.baseSplit;
        if (o.policy.baseSponsorship === false || !provenance) return fail('not_sponsored');
        try {
          if (r.args.terms.near.recipients.some((r) => r.identity.kind !== 'evm'))
            throw new Error();
          const split = createSplit(
            provenance.kind,
            {
              recipients: r.args.terms.near.recipients.map((r) => r.identity.id),
              allocations: r.args.terms.near.recipients.map((r) => BigInt(r.bps)),
              totalAllocation: 10000n,
              distributionIncentive: 0,
            },
            provenance.salt,
          );
          if (split.address !== r.args.terms.base.pay_to) throw new Error();
        } catch {
          fail('not_sponsored', 'Base split does not match recipients');
        }
      }
      if (o.ledger) {
        const listed = await o.policy.sellerAllowed?.(identityJson(r.args.terms.seller));
        if (!listed && o.policy.openPoolEnabled === false) temporary();
        await admitTerms(r.args.terms, o, listed ? 'listed' : 'pool');
        if (r.hostingReservation) {
          if (!o.reservation) return fail('not_sponsored');
          await verifyReservation(r.hostingReservation, r.args.terms, {
            ...o.reservation,
            now: o.now ?? Math.floor(Date.now() / 1000),
          }).catch(() => fail('not_sponsored'));
        } else if (!listed) fail('not_sponsored', 'A hosting reservation is required.');
      }
      return;
    }
    if (!file) return fail('unknown_file');
    if (file.takenDown) fail('taken_down');
    if (r.method === 'fund_file_storage') {
      if (
        !verifyAuthorization(
          file.seller,
          fileFundingText({
            ...r.args,
            network: file.terms.network,
            contract: o.contractId,
            seller: file.seller,
          }),
          r.auth,
        )
      )
        fail('bad_signature');
      if (file.salesStoppedAt !== null) fail('sales_stopped');
      if (!o.ledger || !(await o.ledger.decision(r.args.file_id, file.termsHash)))
        fail('not_sponsored');
      return;
    }
    if (r.method === 'claim_key') {
      const price = p?.route === 'base-usdc' ? file.terms.base?.price : file.terms.near.price;
      if (price === undefined || BigInt(price) < o.policy.minPrice) fail('not_sponsored');
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
    if (!o.ledger && o.policy.baseSponsorship === false) fail('not_sponsored');
    const a = r.args;
    const purchase = parsePurchaseMessage(a.purchase, { baseUsdc: o.usdc });
    if (!o.ledger && BigInt(purchase.price) < o.policy.minPrice) fail('not_sponsored');
    const id = purchaseId(purchase, { baseUsdc: o.usdc });
    if (
      purchase.route !== 'base-usdc' ||
      purchase.contract !== o.contractId ||
      !file.terms.base ||
      purchase.terms_hash !== file.termsHash ||
      purchase.price !== file.terms.base.price ||
      purchase.asset !== o.usdc
    )
      return fail('bad_request');
    if (o.ledger) await checkedDecision(file, o, true);
    else {
      try {
        if (file.terms.near.recipients.some((r) => r.identity.kind !== 'evm'))
          fail('not_sponsored', 'Base split recipients must be EVM identities');
        if (o.policy.fee) checkProtocolFee(file.terms, o.policy.fee);
      } catch {
        fail('not_sponsored', 'required treasury share missing or invalid');
      }
      const verifiedKey = JSON.stringify([
        o.baseRpc,
        o.nearRpc,
        o.contractId,
        termsHash(file.terms),
      ]);
      const now = Date.now();
      for (const [key, until] of refusedBaseTerms) {
        if (until <= now) refusedBaseTerms.delete(key);
      }
      if (refusedBaseTerms.has(verifiedKey))
        fail('not_sponsored', 'Base split code or state does not match registered recipients');
      if (!verifiedBaseTerms.has(verifiedKey)) {
        try {
          await readSplitState(o.baseRpc, file.terms.base.pay_to, {
            recipients: file.terms.near.recipients.map((r) => r.identity.id),
            allocations: file.terms.near.recipients.map((r) => BigInt(r.bps)),
            totalAllocation: 10000n,
            distributionIncentive: 0,
          });
        } catch (error) {
          if (isTransient(error))
            fail('unavailable', 'Base split verification unavailable; retry later');
          // Bound attacker-controlled refusals; transient RPC failures are never cached.
          if (refusedBaseTerms.size >= 1024) {
            const oldest = refusedBaseTerms.keys().next().value;
            if (oldest !== undefined) refusedBaseTerms.delete(oldest);
          }
          refusedBaseTerms.set(verifiedKey, Date.now() + 60000);
          fail('not_sponsored', 'Base split code or state does not match registered recipients');
        }
        verifiedBaseTerms.add(verifiedKey);
      }
    }
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
      fail('settlement_pending');
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
  /** Its function-call key for the relay methods, including file funding, `ed25519:…`. Only for this contract. */
  key: string;
}

/** Gas for every call: `unlock` needs 150 Tgas, MPC's callbacks use the rest; unused gas returns. */
const GAS = 300_000_000_000_000n;
/**
 * Prepaid storage counted per write (`register`, `unlock`, `reopen`): more than any of them takes
 * (an unlock reserves 0.005 NEAR, a reopen marker under 0.001).
 */
const STORAGE_PER_WRITE = 10n ** 22n; // 0.01 NEAR
/** An operation is held this long after it is sent, so a repeat doesn't burn gas on a refusal. */
const HOLD = 15 * 60_000;
/** How many more tries after the first send: the same bytes again, or after PENDING a lookup. */
const RESENDS = 2;
/** The first wait before trying again when NEAR says "later" or "pending"; it grows each try. */
const RETRY_WAIT = 1_000;
/** Requests waiting for their turn; past this the relayer answers busy. */
const MAX_WAITING = 32;

const accounts = new Map<string, Account>();
const verifiedBaseTerms = new Set<string>();
const refusedBaseTerms = new Map<string, number>();
const queues = new Map<string, Promise<unknown>>();
const statusReads = new WeakMap<
  RelayLedger,
  Map<string, Promise<RelayResult | 'pending' | null>>
>();
const reconciliationCursor = new WeakMap<RelayLedger, number>();
let waiting = 0;
let checking = 0;

/**
 * The provider near-api-js signs with: it reads the key's nonce and a recent block. Every reply
 * that sends a transaction or looks one up goes through `rpcReply` instead (its id checked, one
 * fetch, aborted at the deadline).
 */
// Note: the timer ends the wait, not the request (near-api-js 7.4 takes no AbortSignal).
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

/** Ask for FINAL evidence by hash; a lost reply never proves rejection. */
const lookUp = (url: string, tx: string, accountId: string) =>
  rpcReply(url, 'tx', { tx_hash: tx, sender_account_id: accountId, wait_until: 'FINAL' }).catch(
    () => null,
  );

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
 * can hold it: wallet signatures are checked against their authoritative identities before
 * anything is held, and an unlock
 * includes the buyer's key, which only the buyer knows before it is sent.
 */
const identity = (r: RelayRequest) => {
  if (r.method === 'unlock') return `unlock:${JSON.parse(r.args.purchase).purchase.purchase_id}`;
  if (r.method === 'claim_key') return `claim:${r.args.purchase_id}:${r.args.grant ?? 0}`;
  if (r.method === 'reopen')
    return `reopen:${r.args.purchase_id}:${r.args.fresh_key}:${r.args.nonce}`;
  if (r.method === 'register') return `register:${r.args.terms.file_id}`;
  if (r.method === 'fund_file_storage')
    return `fund_file_storage:${r.args.file_id}:${r.args.nonce}`;
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
    : r.method === 'claim_key'
      ? [`claim:${r.args.purchase_id}:${r.args.grant ?? 0}`, p.claimsPerGrant ?? 3]
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
export async function relayStatus(
  input: unknown,
  o: CheckOptions,
): Promise<RelayResult | 'pending' | null> {
  try {
    const r = canonicalRequest(input, {
      baseUsdc: o.usdc,
      ...(o.nearUsdc ? { nearUsdc: o.nearUsdc } : {}),
    });
    return o.ledger ? durableStatus(r, o) : null;
  } catch (e) {
    return asRelayError(e);
  }
}

/** Every sponsored send reserves durable admission before signing. */
export async function relay(
  input: unknown,
  o: CheckOptions & { sender: Sender },
): Promise<RelayResult> {
  const r = canonicalRequest(input, {
    baseUsdc: o.usdc,
    ...(o.nearUsdc ? { nearUsdc: o.nearUsdc } : {}),
  });
  if (!o.ledger) return temporary(r.method === 'unlock');
  try {
    return await durableRelay(r, o, o.ledger);
  } catch (e) {
    if (
      r.method === 'unlock' &&
      e instanceof RelayError &&
      (isTransient(e) ||
        ['settlement_pending', 'relayer_unavailable', 'unavailable'].includes(e.code))
    ) {
      await deferPaidUnlock(r, o, e.retryAt ?? Date.now() + 30000);
      if (e.code !== 'settlement_pending') return temporary(true, e.retryAt ?? Date.now() + 30000);
    }
    throw e;
  }
}

/** Retain bounded paid work while admission or the service is temporarily paused. */
export async function deferPaidUnlock(
  input: unknown,
  o: CheckOptions,
  nextAt: number,
): Promise<void> {
  if (!o.ledger) return;
  const r = canonicalRequest(input, {
    baseUsdc: o.usdc,
    ...(o.nearUsdc ? { nearUsdc: o.nearUsdc } : {}),
  });
  if (r.method !== 'unlock') return;
  try {
    await o.ledger.defer(
      identity(r),
      r,
      requestHash(requestBinding(r)),
      nextAt,
      o.policy.maxWaiting ?? 32,
    );
  } catch (e) {
    o.alert?.('paid_work_full');
    throw e;
  }
  o.alert?.('paid_unlock_delayed');
}

/** Reconcile final evidence and resume only previously signed transaction bytes. */
export async function reconcileRelayStorage(o: {
  ledger?: RelayLedger;
  nearRpc: string;
  contractId: string;
  sender?: Sender;
  disabled?: boolean;
  alert?: (type: string) => void;
}): Promise<void> {
  if (!o.ledger) return;
  const all = Object.values((await o.ledger.read()).operations).filter(
    (op) => op.stage === 'submitted' && op.tx && !op.storageFinalized,
  );
  const offset = (reconciliationCursor.get(o.ledger) ?? 0) % (all.length || 1);
  const pending = [...all.slice(offset), ...all.slice(0, offset)].slice(0, 32);
  reconciliationCursor.set(o.ledger, (offset + pending.length) % (all.length || 1));
  for (const op of pending) {
    const tx = op.tx;
    if (!tx) continue;
    const reply = await lookUp(o.nearRpc, tx.txHash, tx.signer);
    if (
      !o.disabled &&
      reply?.error?.cause?.name === 'UNKNOWN_TRANSACTION' &&
      o.sender?.accountId === tx.signer
    ) {
      const resumed = { ...o, sender: o.sender };
      let expired = false;
      if (tx.referenceHash) {
        try {
          const protocol = await rpcReply(o.nearRpc, 'EXPERIMENTAL_protocol_config', {
            finality: 'final',
          });
          const head = await rpcReply(o.nearRpc, 'block', { finality: 'final' });
          const reference = await rpcReply(o.nearRpc, 'block', { block_id: tx.referenceHash });
          const period = (protocol.result as { transaction_validity_period?: number })
            ?.transaction_validity_period;
          const height = (head.result as { header?: { height?: number } })?.header?.height;
          const from = (reference.result as { header?: { height?: number } })?.header?.height;
          expired =
            !protocol.error &&
            !head.error &&
            !reference.error &&
            Number.isSafeInteger(period) &&
            Number.isSafeInteger(height) &&
            Number.isSafeInteger(from) &&
            (period ?? 0) > 0 &&
            (from ?? -1) >= 0 &&
            (height ?? 0) - (from ?? 0) > (period ?? 0);
        } catch {
          /* Missing expiry evidence keeps the original hold. */
        }
      }
      const result = expired
        ? { txHash: tx.txHash, rejected: true as const, reason: 'Expired' }
        : await enqueue(
            () => send(resumed, senderKey(resumed), tx.txHash, tx.signed, false, true),
            senderKey(resumed),
          );
      if (result.rejected && ['Expired', 'InvalidNonce'].includes(result.reason ?? '')) {
        // Check again after the refusal: a landed transaction always wins over fresh signing.
        const final = await lookUp(o.nearRpc, tx.txHash, tx.signer);
        if (final?.error?.cause?.name === 'UNKNOWN_TRANSACTION') {
          try {
            let landed = false;
            if (op.method === 'register' || op.method === 'stop_sales') {
              const file = await getFile(o.nearRpc, o.contractId, op.fileId);
              if (op.method === 'register' && file?.termsHash === op.termsHash) {
                await o.ledger.registered(op.fileId, op.termsHash);
                landed = true;
              } else if (op.method === 'stop_sales') landed = file?.salesStoppedAt != null;
            } else if (op.method === 'unlock') {
              const args = (tx.args as { args: { purchase: string } }).args;
              const id = purchaseId(parsePurchaseMessage(args.purchase));
              landed = !!(await getPurchase(o.nearRpc, o.contractId, id));
            } else if (op.method === 'reopen') {
              const args = (tx.args as { args: ReopenArgs }).args;
              const purchase = await getPurchase(o.nearRpc, o.contractId, args.purchase_id);
              landed = purchase?.buyer_key === args.fresh_key;
              const grants = purchase?.grants ?? 0;
              for (let grant = grants - 1; !landed && grant >= Math.max(1, grants - 32); grant--)
                landed =
                  (await getGrant(o.nearRpc, o.contractId, args.purchase_id, grant))?.buyer_key ===
                  args.fresh_key;
              // A bounded pass cannot disprove an older grant outside this window.
              if (!landed && (purchase?.grants ?? 0) > 33) {
                o.alert?.('reconcile_held');
                continue;
              }
            }
            if (op.method === 'claim_key') {
              const args = tx.args as { purchase_id: string; grant?: number };
              // Claim has no persistent effect. An existing grant conservatively retains its quota.
              landed = !!(await getGrant(
                o.nearRpc,
                o.contractId,
                args.purchase_id,
                args.grant ?? 0,
              ));
            } else if (op.method === 'reopen_seller') {
              const args = (tx.args as { args: SellerArgs }).args;
              // The unchanged contract stores r || SHA256(domain || file_id || key) as a unit value.
              const marker = sha256(
                new Uint8Array([
                  ...new TextEncoder().encode('annon/reopen-seller/v2\0'),
                  ...bytes(args.file_id, 32),
                  ...bytes(args.key ?? '', 48),
                ]),
              );
              const prefix = btoa(String.fromCharCode(114, ...marker));
              const state = await rpcReply(o.nearRpc, 'query', {
                request_type: 'view_state',
                account_id: o.contractId,
                prefix_base64: prefix,
                finality: 'final',
              });
              const values = (state.result as { values?: { key: string; value: string }[] })
                ?.values;
              if (
                state.error ||
                !Array.isArray(values) ||
                values.length > 1 ||
                values.some((v) => v.key !== prefix || v.value !== '')
              ) {
                o.alert?.('reconcile_held');
                continue;
              }
              landed = values.length === 1;
            } else if (op.method === 'fund_file_storage') {
              const file = await getFile(o.nearRpc, o.contractId, op.fileId);
              // Balance can be consumed by subsequent purchases. Absence cannot release this hold.
              if (op.fundingBalanceBefore === undefined || !file) {
                o.alert?.('reconcile_held');
                continue;
              }
              landed =
                file.purchaseStorageBalance >=
                BigInt(op.fundingBalanceBefore) + BigInt(op.allocation);
              if (!landed) {
                o.alert?.('reconcile_held');
                continue;
              }
            }
            if (landed) {
              await o.ledger.finalizeStorage(op.id, tx.txHash, 'done');
              continue;
            }
            if (op.method === 'unlock')
              await o.ledger.defer(
                op.id,
                { method: 'unlock', args: (tx.args as { args: object }).args },
                op.requestHash,
                Date.now() + 30000,
              );
            await o.ledger.reject(op.id);
            if (op.method === 'unlock') o.alert?.('paid_unlock_delayed');
          } catch (error) {
            o.alert?.(
              error instanceof AnnonError && error.code === 'settlement_pending'
                ? 'paid_work_full'
                : 'reconcile_held',
            );
          }
          continue;
        }
      }
      await o.ledger.result(
        op.id,
        result.rejected ? { txHash: tx.txHash, uncertain: true } : result,
      );
      continue;
    }
    if ((reply?.result as { final_execution_status?: string })?.final_execution_status !== 'FINAL')
      continue;
    try {
      const result = readOutcome(reply?.result, o.contractId, {
        txHash: tx.txHash,
        signer: tx.signer,
        method: op.method,
        args: tx.args,
      });
      if (result.state !== 'pending') {
        if (op.method === 'register') {
          const file = await getFile(o.nearRpc, o.contractId, op.fileId);
          if (file?.termsHash === op.termsHash) await o.ledger.registered(op.fileId, op.termsHash);
          else {
            await o.ledger.reject(op.id, false);
            continue;
          }
        }
        await o.ledger.finalizeStorage(op.id, tx.txHash, result.state);
      }
    } catch {
      /* Unbound evidence cannot release a prepaid hold. */
    }
  }
}

/** Durable status never re-signs an unresolved operation. */
async function durableStatus(
  r: RelayRequest,
  o: CheckOptions,
): Promise<RelayResult | 'pending' | null> {
  const ledger = o.ledger;
  if (!ledger) return null;
  const op = await ledger.operation(identity(r));
  if (!op || op.stage === 'rejected') return null;
  if (op.requestHash !== requestHash(requestBinding(r))) return fail('bad_request');
  signedByItsWallet(r, o.contractId, {
    baseUsdc: o.usdc,
    ...(o.nearUsdc ? { nearUsdc: o.nearUsdc } : {}),
  });
  if (!op.tx) return 'pending';
  if (op.compact && op.stage === 'submitted') return op.result ?? { txHash: op.tx.txHash };
  if (r.method === 'register') {
    const file = await getFile(o.nearRpc, o.contractId, op.fileId).catch(() => null);
    if (file?.termsHash === op.termsHash) await ledger.registered(op.fileId, op.termsHash);
    else if (op.tx) {
      const reply = await lookUp(o.nearRpc, op.tx.txHash, op.tx.signer);
      if (
        (reply?.result as { final_execution_status?: string })?.final_execution_status === 'FINAL'
      ) {
        try {
          readOutcome(reply?.result, o.contractId, {
            txHash: op.tx.txHash,
            signer: op.tx.signer,
            method: r.method,
            args: op.tx.args,
          });
          // An unavailable file read does not prove rejection. Read final state again before releasing.
          const final = await getFile(o.nearRpc, o.contractId, op.fileId);
          if (final?.termsHash === op.termsHash) await ledger.registered(op.fileId, op.termsHash);
          else if (!final) {
            await ledger.reject(op.id, false);
            return null;
          }
        } catch {
          /* Preserve unresolved registration evidence. */
        }
      }
    }
  }
  if (!op.tx) return 'pending';
  if (
    r.method === 'unlock' &&
    op.storageFinalized &&
    op.at + (o.policy.holdMs ?? HOLD) <= Date.now() &&
    !(await getPurchase(o.nearRpc, o.contractId, identity(r).slice('unlock:'.length)))
  ) {
    await ledger.retire(op.id, op.tx.txHash);
    return null;
  }
  if (r.method === 'claim_key' && op.at + (o.policy.holdMs ?? HOLD) <= Date.now()) {
    const tx = op.tx;
    if (op.finalState === 'released') return op.result ?? { txHash: tx.txHash };
    let reads = statusReads.get(ledger);
    if (!reads) {
      reads = new Map();
      statusReads.set(ledger, reads);
    }
    const key = `${op.id}|${tx.txHash}`;
    const previous = reads.get(key);
    if (previous) return previous;
    const refresh = (async () => {
      const reply = await lookUp(o.nearRpc, tx.txHash, tx.signer);
      if (
        (reply?.result as { final_execution_status?: string })?.final_execution_status === 'FINAL'
      ) {
        try {
          const result = readOutcome(reply?.result, o.contractId, {
            txHash: tx.txHash,
            signer: tx.signer,
            method: r.method,
            args: tx.args,
          });
          if (result.state !== 'pending')
            await ledger.finalizeStorage(op.id, tx.txHash, result.state);
          if (result.state !== 'released' && result.state !== 'pending')
            await ledger.retire(op.id, tx.txHash);
        } catch {
          /* An unbound outcome cannot authorize a fresh send. */
        }
      }
      const current = await ledger.operation(op.id);
      if (!current || current.stage === 'rejected') return null;
      return (
        current.result ??
        (current.tx
          ? { txHash: current.tx.txHash, uncertain: true as const }
          : ('pending' as const))
      );
    })();
    reads.set(key, refresh);
    try {
      return await refresh;
    } finally {
      reads.delete(key);
    }
  }
  return op.result ?? { txHash: op.tx.txHash, uncertain: true };
}
const requestBinding = (r: RelayRequest) => {
  if (r.method !== 'register') return r;
  const { hostingReservation: _reservation, ...binding } = r;
  return binding;
};
async function durableRelay(
  r: RelayRequest,
  o: CheckOptions & { sender: Sender },
  ledger: RelayLedger,
): Promise<RelayResult> {
  if (!(await ledger.cutover())) {
    o.alert?.('cutover_unsealed');
    return temporary(true);
  }
  const previous = await durableStatus(r, o);
  if (previous === 'pending') return fail('in_flight');
  if (previous) return previous;
  const deferred = (await ledger.read()).work[identity(r)];
  if (deferred && deferred.nextAt > Date.now()) {
    if (deferred.requestHash !== requestHash(requestBinding(r))) return fail('bad_request');
    const e = new RelayError('settlement_pending');
    e.retryAt = deferred.nextAt;
    throw e;
  }
  if (
    waiting >= (o.policy.maxWaiting ?? MAX_WAITING) ||
    checking >= (o.policy.maxChecking ?? MAX_WAITING)
  )
    return temporary(r.method === 'unlock');
  checking++;
  try {
    await checkRelay(r, o);
    await checkAdmissionFloor(r.method, {
      ...o,
      admissionBalance:
        o.admissionBalance ?? (() => admissionBalance(o.nearRpc, o.sender.accountId)),
    });
  } catch (e) {
    if (
      r.method === 'unlock' &&
      e instanceof RelayError &&
      (isTransient(e) || ['unavailable', 'relayer_unavailable'].includes(e.code))
    )
      return temporary(true);
    throw e;
  } finally {
    checking--;
  }
  waiting++;
  try {
    return await enqueue(async () => {
      const previous = await durableStatus(r, o);
      if (previous === 'pending') return fail('in_flight');
      if (previous) return previous;
      if ('deadline' in r.args && r.args.deadline < (o.now ?? Math.floor(Date.now() / 1000)))
        return fail('bad_deadline');
      if (
        r.method === 'register' &&
        r.hostingReservation &&
        r.hostingReservation.expiresAt <= (o.now ?? Math.floor(Date.now() / 1000))
      )
        return fail('not_sponsored');
      const purchase =
        r.method === 'unlock'
          ? parsePurchaseMessage(r.args.purchase, { baseUsdc: o.usdc })
          : r.method === 'claim_key' || r.method === 'reopen'
            ? await getPurchase(o.nearRpc, o.contractId, r.args.purchase_id)
            : null;
      const fileId =
        r.method === 'register'
          ? r.args.terms.file_id
          : 'file_id' in r.args
            ? r.args.file_id
            : purchase?.file_id;
      if (!fileId) return fail('unknown_file');
      const file = r.method === 'register' ? null : await getFile(o.nearRpc, o.contractId, fileId);
      const terms = r.method === 'register' ? r.args.terms : file?.terms;
      if (!terms) return fail('unknown_file');
      const hash = termsHash(terms, {
        baseUsdc: o.usdc,
        ...(o.nearUsdc ? { nearUsdc: o.nearUsdc } : {}),
      });
      let decision: SponsorshipDecision | null = await ledger.decision(fileId, hash);
      if (r.method === 'register') {
        const listed = await o.policy.sellerAllowed?.(identityJson(terms.seller));
        decision = await admitTerms(terms, o, listed ? 'listed' : 'pool');
      }
      const listed = decision?.listed ?? false;
      const allocation =
        r.method === 'register'
          ? listed
            ? (o.policy.listedFileBudget ?? 5n * 10n ** 22n)
            : (o.policy.fileBudget ?? 41n * 10n ** 21n)
          : r.method === 'fund_file_storage'
            ? BigInt(r.args.amount)
            : 0n;
      if (r.method === 'register') {
        // Query the unchanged contract's current admission floor before making an offer usable.
        const protocol = await rpcReply(o.nearRpc, 'EXPERIMENTAL_protocol_config', {
          finality: 'final',
        });
        const byteCost = (
          protocol.result as { runtime_config?: { storage_amount_per_byte?: unknown } }
        )?.runtime_config?.storage_amount_per_byte;
        if (
          protocol.error ||
          typeof byteCost !== 'string' ||
          !/^[0-9]+$/.test(byteCost) ||
          BigInt(byteCost) <= 0n ||
          allocation < BigInt(byteCost) * 4096n
        )
          return temporary();
      }
      const write = ['register', 'unlock', 'reopen', 'reopen_seller', 'fund_file_storage'].includes(
        r.method,
      );
      const storage = write
        ? (r.method === 'fund_file_storage'
            ? 0n
            : (o.policy.storagePerWrite ?? STORAGE_PER_WRITE)) + allocation
        : 0n;
      if (write) {
        const balance = await view(o.nearRpc, o.contractId, 'storage_balance_of', {
          account_id: o.sender.accountId,
        });
        const floor = r.method === 'unlock' ? 0n : (o.policy.prepaidUnlockFloor ?? 10n ** 24n);
        if (
          typeof balance !== 'string' ||
          !/^[0-9]+$/.test(balance) ||
          BigInt(balance) < floor + storage + (await ledger.pendingStorage())
        )
          return temporary(r.method === 'unlock');
      }
      if (decision && r.method === 'register') decision.allocated = String(allocation);
      const id = identity(r),
        binding = requestHash(requestBinding(r));
      const q = quota(r, o.policy);
      try {
        const prepared = await ledger.prepare({
          id,
          requestHash: binding,
          method: r.method,
          fileId,
          termsHash: hash,
          seller: identityJson(terms.seller),
          listed,
          ip: o.ip ?? 'unknown',
          storage: String(storage),
          allocation: String(allocation),
          limits: relayLimits(o),
          ...(decision && r.method === 'register' ? { decision } : {}),
          ...(q && r.method !== 'register' ? { quota: { key: q[0], limit: q[1] } } : {}),
          ...(r.method === 'register' && r.hostingReservation
            ? {
                reservation: {
                  key: `${r.hostingReservation.hostOrigin}|${r.hostingReservation.uploadId}`,
                  binding,
                },
              }
            : {}),
          ...(r.method === 'fund_file_storage'
            ? {
                fundingBalanceBefore: String(file?.purchaseStorageBalance ?? 0n),
                nonce: `${identityJson(terms.seller)}|${r.args.nonce}`,
                nonceDeadline: r.args.deadline,
                topup: {
                  lifetime: String(
                    listed
                      ? (o.policy.listedTopupPerFile ?? 15n * 10n ** 22n)
                      : (o.policy.topupPerFile ?? 82n * 10n ** 21n),
                  ),
                  fileDay: String(
                    listed
                      ? (o.policy.listedTopupPerFileDay ?? 5n * 10n ** 22n)
                      : (o.policy.topupPerFileDay ?? 41n * 10n ** 21n),
                  ),
                  totalDay: String(o.policy.topupPerDay ?? 5n * 10n ** 23n),
                  listedReserved: String(o.policy.topupListedReserved ?? 25n * 10n ** 22n),
                },
              }
            : {}),
        });
        if (prepared.capacityReached) o.alert?.('ledger_capacity');
        if (!prepared.fresh)
          return (
            prepared.operation.result ??
            (prepared.operation.tx
              ? { txHash: prepared.operation.tx.txHash, uncertain: true }
              : fail('in_flight'))
          );
      } catch (e) {
        if (e instanceof RelayError && e.code === 'relayer_unavailable')
          o.alert?.('ledger_capacity');
        if (r.method === 'unlock' && e instanceof RelayError && e.code === 'limited') {
          const pending = new RelayError('settlement_pending');
          if (e.retryAt !== undefined) pending.retryAt = e.retryAt;
          throw pending;
        }
        throw e;
      }
      let signed = false;
      try {
        const args =
          r.method === 'register'
            ? {
                args: {
                  ...r.args,
                  ...(allocation > 0n ? { file_budget: String(allocation) } : {}),
                },
                auth: r.auth,
              }
            : contractArgs(r);
        const tx = await sign(o, senderKey(o), r.method, args);
        await ledger.signed(id, { ...tx, signer: o.sender.accountId, args });
        signed = true;
        const result = await send(o, senderKey(o), tx.txHash, tx.signed);
        if (result.rejected) {
          await ledger.reject(id);
          return temporary(r.method === 'unlock');
        }
        await ledger.result(id, result);
        if (r.method === 'register') {
          const final = await getFile(o.nearRpc, o.contractId, fileId).catch(() => null);
          if (final?.termsHash === hash) await ledger.registered(fileId, hash);
        }
        if (result.uncertain) o.alert?.('uncertain');
        return result;
      } catch (e) {
        if (!signed && !(await ledger.operation(id))?.tx) await ledger.reject(id);
        throw e;
      }
    }, senderKey(o));
  } finally {
    waiting--;
  }
}

/** Resume due paid work without creating a second purchase or losing its frozen policy. */
export async function retryPaidUnlocks(o: CheckOptions & { sender: Sender }): Promise<void> {
  if (!o.ledger) return;
  for (const [id, work] of Object.entries((await o.ledger.read()).work)) {
    if (work.nextAt > Date.now()) continue;
    try {
      await relay(work.request, o);
    } catch (e) {
      if (
        e instanceof RelayError &&
        [
          'taken_down',
          'sales_stopped',
          'payment_used',
          'payment_not_found',
          'bad_request',
          'not_sponsored',
          'unknown_file',
          'file_mismatch',
          'bad_signature',
        ].includes(e.code)
      )
        await o.ledger.finishWork(id);
    }
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
    .catch(() => fail('transport', 'NEAR signing is unavailable.'));
  return {
    txHash: base58.encode(sha256(tx.transaction.encode())),
    ...(tx.transaction.blockHash?.length === 32
      ? { referenceHash: base58.encode(Uint8Array.from(tx.transaction.blockHash)) }
      : {}),
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
 * bytes again (same hash). Only definite validation refusals are reported as not sent.
 */
async function send(
  o: { nearRpc: string; sender: Sender },
  key: string,
  txHash: string,
  signed: string,
  keeper = false,
  unknownFinal = false,
): Promise<RelayResult> {
  const unclear = (reason: string): RelayResult => ({ txHash, uncertain: true, reason });
  let reason = 'no clear answer from NEAR';
  // After NEAR said it has the transaction (a PENDING timeout), the relayer only looks it up.
  let look = false;
  let ambiguous = false;
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
      if (unknownFinal) definite.add('InvalidNonce');
      if (variant !== undefined && definite.has(variant)) {
        accounts.delete(key);
        if (ambiguous) {
          const status = await lookUp(o.nearRpc, txHash, o.sender.accountId);
          if (status && !status.error && inBlock(status.result)) return { txHash };
          return unclear('an earlier submission may have landed before this validation refusal');
        }
        // Only the variant name is public; RPC data may echo arbitrary transaction fields.
        return {
          txHash,
          rejected: true,
          reason: variant && /^[A-Za-z]+$/.test(variant) ? variant : 'InvalidTxError',
        };
      }
      ambiguous = true;
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
      // Note: sends wait in line meanwhile, at most 3 s per transaction.
      if (attempt < RESENDS && (later || look)) await sleep(RETRY_WAIT * (attempt + 1));
    }
    return unclear(reason);
  } catch {
    return unclear('NEAR submission is unresolved.');
  }
}

export {
  type DeliveryInfo,
  type DeliveryStep,
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
