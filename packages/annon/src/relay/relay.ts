/** Relay entry points, admission serialization and module-load state. */
import type { Account } from 'near-api-js';
import { isTransient } from '../errors.js';
import { getFile, getPurchase, rpcReply, view } from '../near/rpc.js';
import { registerText } from '../near/texts.js';
// Preserve dependency evaluation order before the split modules enter the relay cycle.
import '../net/retry.js';
import '../pay/base.js';
import '../pay/split.js';
import { identityJson, verifyAuthorization } from '../settle-near/identity.js';
import { parsePurchaseMessage } from '../settle-near/purchase.js';
import { type SettlementAssets, termsHash } from '../settle-near/terms.js';
import { admissionBalance, checkAdmissionFloor } from './admission.js';
import './fees.js';
import { type KeepOptions, type KeepResult, runKeeper } from './keeper-runner.js';
import type { RelayLedger, SponsorshipDecision } from './ledger.js';
import { requestHash } from './ledger.js';
import './reservation.js';
import './sponsorship.js';
import { checkRelay } from './relay-checks.js';
import { durableStatus } from './relay-reconciliation.js';
import { canonicalRequest, contractArgs } from './relay-request.js';
import { send, sign } from './relay-transactions.js';
import {
  type CheckOptions,
  fail,
  RelayError,
  type RelayPolicy,
  type RelayRequest,
  type RelayResult,
  type Sender,
} from './relay-types.js';
import { admitTerms, relayLimits, temporary } from './sponsorship.js';

export type { KeeperRecord, KeepOptions, KeepResult, RefundSource } from './keeper-runner.js';
export { checkRelay } from './relay-checks.js';
export { reconcileRelayStorage } from './relay-reconciliation.js';
export { canonicalRequest, contractArgs } from './relay-request.js';
export type {
  CheckOptions,
  RelayErrorCode,
  RelayPolicy,
  RelayRequest,
  RelayResult,
  Sender,
} from './relay-types.js';
export { RelayError } from './relay-types.js';

const asRelayError = (e: unknown): never => {
  if (e instanceof RelayError) throw e;
  return fail(isTransient(e) ? 'transport' : 'bad_request', (e as Error).message);
};

/** Gas for every call: `unlock` needs 150 Tgas, MPC's callbacks use the rest; unused gas returns. */
const GAS = 300_000_000_000_000n;

/**
 * Prepaid storage counted per write (`register`, `unlock`, `reopen`): more than any of them takes
 * (an unlock reserves 0.005 NEAR, a reopen marker under 0.001).
 */
const STORAGE_PER_WRITE = 10n ** 22n;

// 0.01 NEAR
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

/** Ask for FINAL evidence by hash; a lost reply never proves rejection. */
const lookUp = (url: string, tx: string, accountId: string) =>
  rpcReply(url, 'tx', { tx_hash: tx, sender_account_id: accountId, wait_until: 'FINAL' }).catch(
    () => null,
  );

const senderKey = (o: { nearRpc: string; sender: Sender }) =>
  `${o.nearRpc}|${o.sender.accountId}|${o.sender.key}`;

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

const requestBinding = (r: RelayRequest) => {
  if (r.method !== 'register') return r;
  const { hostingReservation: _reservation, ...binding } = r;
  return binding;
};

/** Runs jobs one at a time, in order: checks and nonces never interleave. */
function enqueue<T>(job: () => Promise<T>, scope = 'relay'): Promise<T> {
  const next = (queues.get(scope) ?? Promise.resolve()).then(job, job);
  queues.set(
    scope,
    next.catch(() => {}),
  );
  return next;
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

// Load-time declarations stay together in their original evaluation order.
export {
  accounts,
  asRelayError,
  enqueue,
  fail,
  GAS,
  HOLD,
  IN_BLOCK,
  identity,
  inBlock,
  isObject,
  lookUp,
  quota,
  RESENDS,
  RETRY_WAIT,
  reconciliationCursor,
  refusedBaseTerms,
  requestBinding,
  senderKey,
  signedByItsWallet,
  statusReads,
  verifiedBaseTerms,
};
