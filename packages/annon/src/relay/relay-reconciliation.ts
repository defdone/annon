/** Durable relay status refresh and storage reconciliation. */

import { sha256 } from '@noble/hashes/sha2.js';
import { AnnonError } from '../errors.js';
import { getFile, getGrant, getPurchase, readOutcome, rpcReply } from '../near/rpc.js';
import type { ReopenArgs, SellerArgs } from '../near/texts.js';
import { bytes } from '../settle-near/codec.js';
import { parsePurchaseMessage, purchaseId } from '../settle-near/purchase.js';
import type { RelayLedger } from './ledger.js';
import { requestHash } from './ledger.js';
import {
  enqueue,
  HOLD,
  identity,
  reconciliationCursor,
  requestBinding,
  signedByItsWallet,
  statusReads,
} from './relay.js';
import { lookUp, send, senderKey } from './relay-transactions.js';
import {
  type CheckOptions,
  fail,
  type RelayRequest,
  type RelayResult,
  type Sender,
} from './relay-types.js';

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

export { durableStatus };
