/** Contract calls for the SDK: a selected NEAR wallet signs, otherwise the relayer submits. */
import { Annon, type AnnonOptions } from '../api/annon.js';
import { secureUrl } from '../download/download.js';
import { AnnonError, isAnnonErrorCode, isTransient } from '../errors.js';
import { isStorageRequired, txOutcome } from '../near/rpc.js';
import { parseRetryAfterMs } from '../net/retry.js';
import type { EncryptedRecord } from '../pay/backup.js';
import type { Store } from '../pay/store.js';
import { type ProtocolFee, protocolFeeAboveMax } from '../relay/fees.js';
import { TransactionUncertain } from '../wallet/uncertain.js';
import type { NearWallet } from '../wallet/wallet.js';
import { backupPath, fail } from './adapter-checks.js';
import { amount } from './amounts.js';
import type { AdapterSdk, RequestContext } from './command-context.js';
import { AdapterError, publicError } from './errors.js';
import { writeBackup } from './io.js';
import { requestOptions, response } from './offers.js';

type Send = NonNullable<AnnonOptions['send']>;

/**
 * Sends one contract call and waits for its final outcome. Relayer refusals keep their public
 * code; admission limits, Base settlement and pending key releases are retried with fixed waits.
 */
async function relaySend(
  ctx: RequestContext,
  method: string,
  args: object,
  owner?: NearWallet,
): Promise<unknown> {
  const { c, d, fetcher, o, wait } = ctx;
  if (method === 'unlock' && !c.baseRpc)
    return fail('base_rpc_required', 'Configure baseRpc before resuming a Base purchase.', 2);
  // The relayer gets the full request; the contract call, and so the outcome check, never
  // carries the relayer-only fields.
  const {
    baseSplit: _baseSplit,
    hostingReservation: _hostingReservation,
    ...envelope
  } = args as Record<string, unknown>;
  const funding = envelope.args as { file_id: string; amount: string };
  const wireArgs =
    method === 'fund_file_storage'
      ? { file_id: funding.file_id, amount: funding.amount }
      : envelope;
  const signer =
    owner ?? (ctx.selected?.identity.kind === 'near' ? (ctx.selected as NearWallet) : undefined);
  let submitted: { txHash: string; signer: string } | undefined;
  const call = async () => {
    if (signer) return signer.call({ receiverId: c.contractId, method, args: wireArgs });
    if (!c.relayer)
      return fail(
        'transport_required',
        'Configure a relayer URL or select a NEAR wallet for transaction calls.',
        2,
      );
    if (!submitted) {
      const r = await fetcher(new URL('/v1/relay', secureUrl(c.relayer)), {
        ...requestOptions,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(method === 'claim_key' ? { method, args } : { method, ...args }),
        signal: AbortSignal.timeout(60000),
      });
      if (![200, 202].includes(r.status)) {
        const body = (await r.json().catch(() => null)) as Record<string, unknown> | null;
        const fallback =
          r.status === 425
            ? 'settlement_pending'
            : r.status === 429
              ? 'relayer_rate_limited'
              : r.status === 503
                ? 'relayer_unavailable'
                : 'operation_failed';
        const code = isAnnonErrorCode(body?.error) ? body.error : fallback;
        const delay = parseRetryAfterMs(r.headers.get('Retry-After'));
        const safe = publicError({
          ...(body && isAnnonErrorCode(body.error) ? body : {}),
          code,
          ...(delay !== undefined ? { retryAfterSeconds: Math.ceil(delay / 1000) } : {}),
        });
        const error = Object.assign(new AdapterError(safe.code, safe.message, safe.exitCode), safe);
        if (code === 'budget') throw error;
        if (code === 'settlement_pending')
          throw Object.assign(error, { safetyDelayMs: (safe.retryAfterSeconds ?? 30) * 1000 });
        const waitMs =
          delay ?? (safe.retryAfterSeconds === undefined ? 5000 : safe.retryAfterSeconds * 1000);
        if ([429, 503].includes(r.status) && waitMs <= 60000)
          throw Object.assign(error, { retryAfterMs: waitMs });
        throw error;
      }
      const body = (await r.json()) as { txHash?: string; signer?: string; pending?: boolean };
      if (r.status === 202 && body.pending === true)
        throw new AdapterError('in_flight', 'Relayer operation is pending.', 4);
      if (
        typeof body.txHash !== 'string' ||
        !body.txHash ||
        typeof body.signer !== 'string' ||
        !body.signer
      )
        throw new Error('invalid relayer transaction response');
      submitted = { txHash: body.txHash, signer: body.signer };
    }
    const tx = submitted;
    const result = await txOutcome(c.nearRpc, tx.txHash, tx.signer, c.contractId, 'FINAL', {
      method,
      args: wireArgs,
    });
    if (result.state === 'released') return result.answer;
    if (result.state === 'done') return result.value;
    if ('reason' in result && isStorageRequired(result.reason))
      throw new AdapterError(
        'storage_required',
        'Prepay Annon storage with the SDK storageDeposit helper, then resume the saved operation.',
      );
    throw new Error(`transaction ${result.state}`);
  };
  // Timeouts repeat only idempotent releases; explicit admission refusals have their own cap.
  let timeouts = 0;
  let pending = 0;
  let admissions = 0;
  let safetyWaits = 0;
  for (;;) {
    try {
      return await call();
    } catch (error) {
      if (o.command === 'share' && submitted) {
        if (error instanceof AnnonError && !isTransient(error))
          throw Object.assign(error, { txHash: submitted.txHash });
        throw new TransactionUncertain(submitted.txHash);
      }
      if (error instanceof AdapterError && 'retryAfterMs' in error) {
        if (admissions++ >= 3) throw error;
        await wait((error as AdapterError & { retryAfterMs: number }).retryAfterMs);
        continue;
      }
      if (
        method === 'unlock' &&
        error instanceof AdapterError &&
        error.code === 'settlement_pending'
      ) {
        if (o.command === 'status') throw error;
        if (o.command !== 'open' || d.agent || o.json) throw error;
        const planned = [10000, 20000, 30000, 40000, 60000][safetyWaits++];
        const minimum = (error as AdapterError & { safetyDelayMs?: number }).safetyDelayMs ?? 0;
        if (planned === undefined || minimum > 60000) throw error;
        const delay = Math.max(planned, Number.isFinite(minimum) ? minimum : 0);
        d.notify?.(`Base settlement pending; retrying unlock in ${delay / 1000} seconds.`);
        await wait(delay);
        continue;
      }
      const inFlight =
        error instanceof AdapterError && ['in_flight', 'duplicate'].includes(error.code);
      const timeout =
        isTransient(error) || (error instanceof Error && error.name === 'TimeoutError');
      if (
        !['unlock', 'reopen', 'claim_key'].includes(method) ||
        (!inFlight && !timeout) ||
        (inFlight ? pending++ >= 36 : timeouts++ >= 2)
      )
        throw error;
      if (!o.json) d.notify?.('Key release pending; retrying the saved request.');
      await wait(inFlight ? 5000 : 1000 * 2 ** (timeouts - 1));
    }
  }
}

/** The SDK for this run, wired to the relay transport and the relayer's sponsorship policy. */
function createSdk(
  ctx: RequestContext,
  rawStore: Store<EncryptedRecord>,
  secret: Uint8Array,
): AdapterSdk {
  const { c, d, fetcher, o } = ctx;
  const send: Send = (method, args, owner) => relaySend(ctx, method, args, owner);
  const sdk = (d.sdk ?? ((options) => new Annon(options)))({
    ...c,
    rawStore,
    fetch: fetcher,
    backupSecret: secret,
    send,
    ...(c.relayer
      ? {
          sponsorship: async () => {
            const reply = await response(new URL('/v1/capabilities', c.relayer).href, fetcher);
            if (!reply.ok) throw new Error('relayer capabilities unavailable');
            const cap = (await reply.json()) as {
              contract?: string;
              disabled?: boolean;
              fee?: ProtocolFee;
            };
            if (cap.contract !== c.contractId || cap.disabled || !cap.fee)
              throw new Error('invalid relayer sponsorship policy');
            if (
              (d.agent || o.json) &&
              o.price &&
              protocolFeeAboveMax(amount(o.price), cap.fee, c.maxProtocolFee)
            )
              return fail(
                'protocol_fee_above_max',
                'The advertised protocol fee exceeds maxProtocolFee. Review the fee in human configuration.',
                2,
              );
            return { fee: cap.fee };
          },
        }
      : {}),
    writeBackup: (id, encrypted) => writeBackup(backupPath(c, id), encrypted),
  });
  return sdk;
}

export { createSdk };
