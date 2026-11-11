/** Durable keeper policy. All writes are reserved before signing; ambiguous work is monitored. */
import { base58, base64 } from '@scure/base';
import { decodeSignedTransaction } from 'near-api-js';
import { type AnnonEvent, getFile, getPurchase, readOutcome, rpcReply, view } from '../near/rpc.js';
import {
  BudgetError,
  type BudgetRecord,
  reconcileSpend,
  reserveSpend,
  type SpendReservation,
} from '../node/budget.js';
import type { Store, Versioned } from '../pay/store.js';
import { network } from '../settle-near/codec.js';
import {
  type DeliveryInfo,
  getDelivery,
  listOpenDeliveries,
  type MaterializeRefundArgs,
  materializeRefund,
  openDeliveryCount,
} from './keeper.js';
import { keeperBalance } from './keeper-balance.js';
import type { RelayResult, Sender } from './relay.js';
export interface KeeperRecord extends Versioned {
  handled?: string;
  tries?: number;
  nextAt?: number;
  observed?: { funded: string; paid: number[] };
  stage?: 'ready' | 'preparing' | 'finalizing' | 'submitted' | 'retired';
  active?: { id: string; deliveryId: number }[];
  tx?: {
    hash: string;
    signer: string;
    signed: string;
    method: 'settle' | 'materialize_refund';
    args: object;
    phases: string[];
    /** Persist before broadcast, so expiry remains provable after RPC block garbage collection. */
    reference?: { hash: string; height: number };
    reservation?: SpendReservation;
    storageReserved?: string;
  } | null;
  sweep?: { block: string; count: number; from: number };
  balanceLow?: boolean;
  reserveCheckedAt?: number;
  inFlightAlerted?: boolean;
}
export interface RefundSource {
  /** Supply current proofs from durable event history. No indexer is bundled. Retry stale proofs. */
  leaves(context: {
    nearRpc: string;
    contractId: string;
    limit: number;
  }): Promise<MaterializeRefundArgs[]>;
}
export interface KeepOptions {
  nearRpc: string;
  /** Stable chain identity, independent of the RPC provider. */
  network: string;
  contractId: string;
  sender: Sender;
  store: Store<KeeperRecord>;
  budgetStore: Store<BudgetRecord>;
  hourlyBudget: bigint;
  dailyBudget: bigint;
  /** Maximum yoctoNEAR per gas unit. Refuse if current finalized gas price exceeds this. */
  gasPrice: bigint;
  /** USDC base units; refunds bypass this minimum. */
  minPayout?: bigint;
  maxPages?: number;
  maxTransactions?: number;
  maxUnresolved?: number;
  storagePerRefund?: bigint;
  reserveLowWater?: bigint;
  /** Minimum liquid yoctoNEAR before signing; requires max(this, submission cost). */
  balanceLowWater?: bigint;
  alert?: (alert: {
    type: 'reserve_low' | 'in_flight' | 'uncertain' | 'breaker' | 'low_balance';
    balance?: string;
    needed?: string;
    reserve?: string;
    deliveryId?: number;
  }) => void;
  refunds?: RefundSource;
  now?: () => number;
  jitter?: () => number;
}
export interface KeepResult {
  sent: { method: 'settle' | 'materialize_refund'; args: object; result: RelayResult }[];
  errors: { from?: number; deliveryId?: number; error: unknown }[];
  incidents: {
    classification:
      | 'budget'
      | 'transport'
      | 'finalized_failure'
      | 'in_flight'
      | 'uncertain'
      | 'rejected';
    deliveryId?: number;
    reason?: string;
  }[];
}
export function retryDelay(tries: number, jitter = Math.random()): number {
  if (!Number.isFinite(jitter) || jitter < 0 || jitter > 1)
    throw new TypeError('invalid keeper jitter');
  return Math.round(
    ([1, 2, 4, 8, 16, 30][Math.min(Math.max(tries - 1, 0), 5)] ?? 30) *
      60000 *
      (0.9 + 0.2 * jitter),
  );
}

interface Transport {
  sign(method: string, args: object, gas: bigint): Promise<{ txHash: string; signed: string }>;
  send(hash: string, signed: string): Promise<RelayResult>;
}
const progress = (old: KeeperRecord['observed'], d: DeliveryInfo) =>
  old &&
  (BigInt(d.funded) > BigInt(old.funded) ||
    d.slots.some((s, i) => s.step.state === 2 && !old.paid.includes(i)));
const observation = (d: DeliveryInfo) => ({
  funded: d.funded,
  paid: d.slots.flatMap((s, i) => (s.step.state === 2 ? [i] : [])),
});
export async function runKeeper(o: KeepOptions, transport: Transport): Promise<KeepResult> {
  network(o.network);
  const now = o.now ?? Date.now;
  const scope = `${o.network}|${o.contractId}`;
  const out: KeepResult = { sent: [], errors: [], incidents: [] };
  const belowMinimum = async (d: DeliveryInfo): Promise<boolean> => {
    if (d.purchase === null || BigInt(d.amount) >= (o.minPayout ?? 10000n)) return false;
    const purchase = await getPurchase(o.nearRpc, o.contractId, d.purchase);
    if (!purchase) return true;
    const file = await getFile(o.nearRpc, o.contractId, purchase.file_id);
    return !file || BigInt(d.amount) <= BigInt(file.terms.near.price);
  };
  const maxPages = o.maxPages ?? 20,
    maxTx = o.maxTransactions ?? 20;
  if (
    !o.store ||
    !o.budgetStore ||
    !Number.isSafeInteger(maxPages) ||
    maxPages < 1 ||
    !Number.isSafeInteger(maxTx) ||
    maxTx < 1 ||
    o.gasPrice <= 0n ||
    (o.minPayout !== undefined && o.minPayout < 0n) ||
    (o.balanceLowWater !== undefined && o.balanceLowWater < 0n) ||
    (o.storagePerRefund !== undefined && o.storagePerRefund < 0n) ||
    !Number.isSafeInteger(o.maxUnresolved ?? 50) ||
    (o.maxUnresolved ?? 50) < 1
  )
    throw new TypeError('durable keeper stores, limits and gas price required');
  const update = async (id: string, patch: Partial<KeeperRecord>) => {
    for (;;) {
      const old = await o.store.load(id);
      const next = { ...old, ...patch, id, revision: (old?.revision ?? -1) + 1 };
      if (await o.store.compareAndSet(id, old, next)) return next;
    }
  };
  // A pause/lock is shared by every delivery under this contract and dependency sender.
  const breakerId = `${scope}|breaker`;
  let breaker = await o.store.load(breakerId);
  const failed = async (id: string, old: KeeperRecord | null, dependency = false) => {
    const tries = (old?.tries ?? 0) + 1;
    await update(id, { tries, nextAt: now() + retryDelay(tries, o.jitter?.() ?? Math.random()) });
    if (dependency) {
      breaker = await update(breakerId, {
        tries: (breaker?.tries ?? 0) + 1,
        nextAt: now() + retryDelay((breaker?.tries ?? 0) + 1, o.jitter?.() ?? Math.random()),
      });
      o.alert?.({ type: 'breaker' });
    }
  };
  const reserveId = `${scope}|reserve-monitor`;
  if (
    now() - ((await o.store.load(reserveId))?.reserveCheckedAt ?? Number.NEGATIVE_INFINITY) >=
    60000
  ) {
    try {
      const reserve = await view(o.nearRpc, o.contractId, 'receiver_reserve', {});
      if (typeof reserve !== 'string' || !/^\d+$/.test(reserve))
        throw new Error('invalid receiver reserve');
      await update(reserveId, { reserveCheckedAt: now() });
      if (o.reserveLowWater !== undefined && BigInt(reserve) < o.reserveLowWater)
        o.alert?.({ type: 'reserve_low', reserve });
    } catch (error) {
      out.errors.push({ error });
    }
  }
  const activeId = `${scope}|active:${o.sender.accountId}`;
  const untrack = async (id: string) => {
    for (;;) {
      const old = await o.store.load(activeId);
      if (!old) return;
      if (
        await o.store.compareAndSet(activeId, old, {
          ...old,
          revision: old.revision + 1,
          active: (old.active ?? []).filter((x) => x.id !== id),
        })
      )
        return;
    }
  };
  const track = async (id: string, deliveryId: number) => {
    for (;;) {
      const old = await o.store.load(activeId);
      const active = old?.active ?? [];
      if (active.some((x) => x.id === id)) return false;
      if (active.length >= (o.maxUnresolved ?? 50)) return false;
      if (
        await o.store.compareAndSet(activeId, old, {
          ...old,
          id: activeId,
          revision: (old?.revision ?? -1) + 1,
          active: [...active, { id, deliveryId }],
        })
      )
        return true;
    }
  };
  const sweepId = `${scope}|sweep`;
  let cursor = (await o.store.load(sweepId))?.sweep;
  if (!cursor || cursor.from >= cursor.count) {
    const block = await rpcReply(o.nearRpc, 'block', { finality: 'final' });
    const hash = (block.result as { header?: { hash?: unknown } })?.header?.hash;
    if (block.error || typeof hash !== 'string' || !hash)
      throw new Error('finalized block unavailable');
    cursor = {
      block: hash,
      from: 0,
      count: await openDeliveryCount(o.nearRpc, o.contractId, hash),
    };
    await update(sweepId, { sweep: cursor });
  }
  let attempts = 0;
  let pendingCost = 0n;
  let passBalance: { available: bigint; needed: bigint } | undefined;
  const balanceId = `${o.network}|${o.sender.accountId}|balance`;
  const balanceState = async (low: boolean, balance: bigint, needed: bigint) => {
    for (;;) {
      const old = await o.store.load(balanceId);
      if ((old?.balanceLow ?? false) === low) return;
      if (
        await o.store.compareAndSet(balanceId, old, {
          ...old,
          id: balanceId,
          revision: (old?.revision ?? -1) + 1,
          balanceLow: low,
        })
      ) {
        if (low)
          o.alert?.({
            type: 'low_balance',
            balance: balance.toString(),
            needed: needed.toString(),
          });
        return;
      }
    }
  };
  const rejected = async (
    id: string,
    job: KeeperRecord,
    deliveryId: number,
    result: RelayResult,
  ) => {
    if (
      !(await o.store.compareAndSet(id, job, {
        ...job,
        revision: job.revision + 1,
        stage: 'ready',
        tx: null,
        tries: (job.tries ?? 0) + 1,
        nextAt: now() + retryDelay((job.tries ?? 0) + 1, o.jitter?.() ?? Math.random()),
      }))
    )
      return;
    await untrack(id);
    out.incidents.push({
      classification: 'rejected',
      deliveryId,
      ...(result.reason ? { reason: result.reason } : {}),
    });
  };
  const execute = async (
    id: string,
    method: 'settle' | 'materialize_refund',
    args: object,
    gas: bigint,
    old: KeeperRecord | null,
    d?: DeliveryInfo,
    phases: string[] = [],
    deliveryId = d?.id ?? 0,
  ) => {
    if (
      attempts >= (method === 'settle' && o.refunds ? Math.ceil(maxTx / 2) : maxTx) ||
      (breaker?.nextAt ?? 0) > now()
    )
      return;
    // Cross-process claim. Only the winner of the durable signed-hash CAS may send.
    const finalBlock = await rpcReply(o.nearRpc, 'block', { finality: 'final' });
    const finalHash = (finalBlock.result as { header?: { hash?: string } })?.header?.hash;
    if (finalBlock.error || !finalHash) throw new Error('final gas price block unavailable');
    const price = await rpcReply(o.nearRpc, 'gas_price', { block_id: finalHash });
    const gasPrice = (price.result as { gas_price?: string })?.gas_price;
    if (
      price.error ||
      typeof gasPrice !== 'string' ||
      !/^[0-9]+$/.test(gasPrice) ||
      BigInt(gasPrice) > o.gasPrice
    )
      throw new Error('keeper gas price exceeds configured cap or is unavailable');
    const funds = await keeperBalance({
      nearRpc: o.nearRpc,
      accountId: o.sender.accountId,
      contractId: o.contractId,
      block: finalHash,
      gasPrice: BigInt(gasPrice),
      method,
      args,
      gas,
    });
    const needed = funds.cost > (o.balanceLowWater ?? 0n) ? funds.cost : (o.balanceLowWater ?? 0n);
    const available = funds.balance > pendingCost ? funds.balance - pendingCost : 0n;
    // Judge the alert once after the pass, so cheaper calls cannot clear a costly call's warning.
    passBalance = {
      available:
        passBalance && passBalance.available < available ? passBalance.available : available,
      needed: passBalance && passBalance.needed > needed ? passBalance.needed : needed,
    };
    if (available < needed) return;
    // Only affordable work consumes the half-open dependency's one probe.
    if ((breaker?.tries ?? 0) > 0) {
      const probe = {
        ...breaker,
        id: breakerId,
        revision: (breaker?.revision ?? -1) + 1,
        nextAt: now() + retryDelay(breaker?.tries ?? 1, o.jitter?.() ?? Math.random()),
      };
      if (!(await o.store.compareAndSet(breakerId, breaker, probe))) return;
      breaker = probe;
    }
    if (!(await track(id, deliveryId))) return;
    const claimed: KeeperRecord = {
      ...old,
      id,
      revision: (old?.revision ?? -1) + 1,
      stage: 'preparing',
      ...(d ? { observed: observation(d) } : {}),
    };
    if (!(await o.store.compareAndSet(id, old, claimed))) {
      await untrack(id);
      return;
    }
    attempts++;
    try {
      const storageReserved =
        method === 'materialize_refund' ? (o.storagePerRefund ?? 40960000000000000000000n) : 0n;
      const reservation: SpendReservation = {
        id: `${id}|${claimed.revision}`,
        at: now(),
        amount: String(gas * o.gasPrice * 2n + storageReserved),
      };
      await reserveSpend(
        o.budgetStore,
        `${o.network}|${o.sender.accountId}|keeper-spend`,
        BigInt(reservation.amount),
        { daily: o.dailyBudget, hourly: o.hourlyBudget },
        reservation.at,
        reservation.id,
      );
      const tx = await transport.sign(method, args, gas);
      const referenceHash = base58.encode(
        Uint8Array.from(decodeSignedTransaction(base64.decode(tx.signed)).transaction.blockHash),
      );
      const referenceBlock = await rpcReply(o.nearRpc, 'block', { block_id: referenceHash });
      const reference = (referenceBlock.result as { header?: { hash?: string; height?: number } })
        ?.header;
      if (
        referenceBlock.error ||
        reference?.hash !== referenceHash ||
        typeof reference.height !== 'number' ||
        !Number.isSafeInteger(reference.height) ||
        reference.height < 0
      )
        throw new Error('signed transaction reference block unavailable');
      if (
        !(await o.store.compareAndSet(id, claimed, {
          ...claimed,
          revision: claimed.revision + 1,
          stage: 'submitted',
          tx: {
            hash: tx.txHash,
            signer: o.sender.accountId,
            signed: tx.signed,
            method,
            args,
            phases,
            reference: { hash: referenceHash, height: reference.height },
            reservation,
            storageReserved: String(storageReserved),
          },
        }))
      )
        return;
      const result = await transport.send(tx.txHash, tx.signed);
      out.sent.push({ method, args, result });
      if (result.rejected) {
        const job = await o.store.load(id);
        if (job?.tx?.hash === tx.txHash) await rejected(id, job, deliveryId, result);
      } else pendingCost += funds.cost;
    } catch (error) {
      // Errors before a hash is persisted did not reach send. Preserve the reservation.
      const current = await o.store.load(id);
      if (!current?.tx) {
        await update(id, { stage: 'ready' });
        await failed(id, current);
        await untrack(id);
      }
      out.errors.push({ ...(d ? { deliveryId: d.id } : {}), error });
      out.incidents.push({
        classification:
          error instanceof BudgetError ? 'budget' : current?.tx ? 'uncertain' : 'transport',
        ...(d ? { deliveryId: d.id } : {}),
      });
    }
  };
  const monitor = async (id: string, job: KeeperRecord, deliveryId: number): Promise<boolean> => {
    const tx = job.tx;
    if (!tx) {
      if (job.stage === 'preparing') {
        // Send is reachable only after a signed hash is durable. Reclaiming this CAS invalidates
        // an older signer's claim; it must win the hash write before it can submit anything.
        if (
          !(await o.store.compareAndSet(id, job, {
            ...job,
            revision: job.revision + 1,
            stage: 'ready',
          }))
        )
          return false;
      }
      await untrack(id);
      return true;
    }
    try {
      const reply = await rpcReply(o.nearRpc, 'tx', {
        tx_hash: tx.hash,
        sender_account_id: tx.signer,
        wait_until: 'NONE',
      });
      if (reply.error?.cause?.name === 'UNKNOWN_TRANSACTION') {
        const signed = decodeSignedTransaction(base64.decode(tx.signed)).transaction;
        const final = await rpcReply(o.nearRpc, 'block', { finality: 'final' });
        const header = (final.result as { header?: { hash: string; height: number } })?.header;
        if (final.error || !header?.hash || !Number.isSafeInteger(header.height))
          throw new Error('final block unavailable');
        const key = await rpcReply(o.nearRpc, 'query', {
          request_type: 'view_access_key',
          block_id: header.hash,
          account_id: tx.signer,
          public_key: signed.publicKey.toString(),
        });
        const nonce = (key.result as { nonce?: number | string })?.nonce;
        const validNonce =
          nonce !== undefined &&
          /^(0|[1-9][0-9]*)$/.test(String(nonce)) &&
          (typeof nonce !== 'number' || Number.isSafeInteger(nonce));
        const consumed = !key.error && validNonce && BigInt(String(nonce)) >= signed.nonce;
        let expired = false;
        if (!consumed) {
          // near-api-js decodes the hash as a plain number[]; base58 needs a Uint8Array.
          const referenceHash = base58.encode(Uint8Array.from(signed.blockHash));
          // Older records can recover the height through RPC; new records already retain it.
          const reference =
            tx.reference?.hash === referenceHash
              ? { result: { header: tx.reference } }
              : await rpcReply(o.nearRpc, 'block', { block_id: referenceHash });
          const protocol = await rpcReply(o.nearRpc, 'EXPERIMENTAL_protocol_config', {
            block_id: header.hash,
          });
          const height = (reference.result as { header?: { height?: number } })?.header?.height;
          const period = (protocol.result as { transaction_validity_period?: number })
            ?.transaction_validity_period;
          if (
            reference.error ||
            protocol.error ||
            typeof height !== 'number' ||
            typeof period !== 'number' ||
            !Number.isSafeInteger(height) ||
            height < 0 ||
            !Number.isSafeInteger(period) ||
            period <= 0
          )
            throw new Error('transaction validity unavailable');
          expired = header.height - height > period + 2;
          if (!expired && (key.error || !validNonce))
            throw new Error('final keeper key unavailable');
        }
        if (consumed || expired) {
          // Final state can reveal execution even when the RPC has discarded the tx result.
          const d = await getDelivery(o.nearRpc, o.contractId, deliveryId);
          const tries = !d || progress(job.observed, d) ? 0 : (job.tries ?? 0) + 1;
          if (
            !(await o.store.compareAndSet(id, job, {
              ...job,
              revision: job.revision + 1,
              tx: null,
              stage: d || tx.method === 'materialize_refund' ? 'ready' : 'retired',
              tries,
              nextAt: now() + retryDelay(Math.max(1, tries), o.jitter?.() ?? Math.random()),
              ...(d ? { observed: observation(d) } : {}),
            }))
          )
            return false;
          await untrack(id);
          out.incidents.push({
            classification: 'finalized_failure',
            deliveryId,
            reason: consumed ? 'nonce consumed at finality' : 'block hash expired at finality',
          });
          return true;
        }
        if (attempts >= maxTx) return false;
        const d = await getDelivery(o.nearRpc, o.contractId, deliveryId);
        const uncertain = d?.fund.state === 1 || d?.slots.some((s) => s.step.state === 1);
        if (!uncertain && (d || tx.method === 'materialize_refund')) {
          attempts++;
          const result = await transport.send(tx.hash, tx.signed);
          out.sent.push({ method: tx.method, args: tx.args, result });
          if (result.rejected) {
            await rejected(id, job, deliveryId, result);
            return true;
          }
        }
      }
      if (
        reply.error ||
        (reply.result as { final_execution_status?: string })?.final_execution_status !== 'FINAL'
      ) {
        out.incidents.push({ classification: 'uncertain', deliveryId });
        return false;
      }
      const result = readOutcome(reply.result, o.contractId, {
        txHash: tx.hash,
        signer: tx.signer,
        method: tx.method,
        args: tx.args,
      });
      if (result.state === 'pending') return false;
      const events: AnnonEvent[] = result.events.filter(
        (e) =>
          ['funding_failed', 'payment_failed'].includes(e.event) &&
          e.data.delivery_id === deliveryId,
      );
      const d = await getDelivery(o.nearRpc, o.contractId, deliveryId);
      const advanced = !d || progress(job.observed, d);
      const receipts =
        (
          reply.result as {
            receipts_outcome?: {
              outcome?: { executor_id?: string; status?: { Failure?: unknown } };
            }[];
          }
        ).receipts_outcome ?? [];
      const trusted = new Set([o.contractId, ...(d ? [d.sender] : [])]);
      const dependency =
        receipts.some(
          (r) =>
            trusted.has(r.outcome?.executor_id ?? '') &&
            r.outcome?.status?.Failure !== undefined &&
            /\b(paus(?:e|ed|ing)|lock(?:ed|ing)?)\b/i.test(
              JSON.stringify(r.outcome.status.Failure),
            ),
        ) ||
        events.some((e) => /\b(paus(?:e|ed|ing)|lock(?:ed|ing)?)\b/i.test(String(e.data.reason)));
      const claimed = { ...job, revision: job.revision + 1, stage: 'finalizing' as const };
      if (!(await o.store.compareAndSet(id, job, claimed))) return false;
      // Refund only complete FINAL burn accounting. Missing data keeps the conservative hold.
      const final = reply.result as {
        transaction_outcome?: { outcome?: { tokens_burnt?: unknown } };
        receipts_outcome?: { outcome?: { tokens_burnt?: unknown } }[];
      };
      const burns = [final.transaction_outcome, ...(final.receipts_outcome ?? [])].map(
        (r) => r?.outcome?.tokens_burnt,
      );
      if (
        tx.reservation &&
        final.transaction_outcome &&
        Array.isArray(final.receipts_outcome) &&
        burns.every((v) => typeof v === 'string' && /^[0-9]+$/.test(v))
      ) {
        const actual = burns.reduce<bigint>((sum, v) => sum + BigInt(v as string), 0n);
        await reconcileSpend(
          o.budgetStore,
          `${o.network}|${o.sender.accountId}|keeper-spend`,
          tx.reservation,
          actual + BigInt(tx.storageReserved ?? '0'),
        );
      }
      // A successful entry may still have failed child receipts. State is authoritative.
      if (tx.method === 'settle') {
        const phases = new Set([
          ...tx.phases,
          ...events.flatMap((e) =>
            e.event === 'payment_failed' && Number.isSafeInteger(e.data.slot)
              ? [`slot:${e.data.slot}`]
              : [],
          ),
        ]);
        for (const phase of phases) {
          const phaseId = `${scope}|delivery:${deliveryId}|${phase}`;
          const old = await o.store.load(phaseId);
          if (old?.handled === tx.hash) continue;
          const slot = Number(phase.slice(5));
          const moved =
            !d ||
            (phase === 'fund'
              ? BigInt(d.funded) > BigInt(job.observed?.funded ?? '0')
              : d.slots[slot]?.step.state === 2);
          if (moved)
            await update(phaseId, {
              tries: 0,
              nextAt: 0,
              handled: tx.hash,
              ...(d ? { observed: observation(d) } : {}),
            });
          else if (d.fund.state !== 1 && (phase === 'fund' || d.slots[slot]?.step.state !== 1)) {
            const tries = (old?.tries ?? 0) + 1;
            await update(phaseId, {
              tries,
              nextAt: now() + retryDelay(tries, o.jitter?.() ?? Math.random()),
              handled: tx.hash,
              observed: observation(d),
            });
          }
        }
      }
      if (result.state === 'refused' || events.length || !advanced)
        out.incidents.push({
          classification: 'finalized_failure',
          deliveryId,
          reason:
            result.state === 'refused'
              ? result.reason
              : events.length
                ? events.map((e) => String(e.data.reason)).join(',')
                : 'no verified progress',
        });
      const terminalRefund =
        tx.method === 'materialize_refund' && result.state === 'done' && !events.length;
      const cleared: KeeperRecord = {
        ...claimed,
        revision: claimed.revision + 1,
        tx: null,
        stage: terminalRefund ? 'retired' : 'ready',
        ...(advanced ? { tries: 0, nextAt: 0 } : {}),
      };
      if (!(await o.store.compareAndSet(id, claimed, cleared))) return false;
      await untrack(id);
      if (dependency) {
        const tries = (breaker?.tries ?? 0) + 1;
        breaker = await update(breakerId, {
          tries,
          nextAt: now() + retryDelay(tries, o.jitter?.() ?? Math.random()),
        });
        o.alert?.({ type: 'breaker' });
      } else if (advanced && breaker) breaker = await update(breakerId, { tries: 0, nextAt: 0 });
      if (tx.method === 'materialize_refund' && !terminalRefund) await failed(id, cleared);
      return true;
    } catch (error) {
      out.errors.push({ deliveryId, error });
      out.incidents.push({ classification: 'transport', deliveryId });
      return false;
    }
  };
  // Monitor even if retirement removed a delivery from the open index, or a source stops returning a leaf.
  const monitored = new Set<string>();
  for (const work of (await o.store.load(activeId))?.active ?? []) {
    const job = await o.store.load(work.id);
    if (job) {
      await monitor(work.id, job, work.deliveryId);
      monitored.add(work.id);
    } else await untrack(work.id);
  }
  for (let page = 0; page < maxPages && cursor.from < cursor.count; page++) {
    const from: number = cursor.from;
    try {
      const deliveries = await listOpenDeliveries(o.nearRpc, o.contractId, from, 50, cursor.block);
      for (const snapshot of deliveries) {
        if (await belowMinimum(snapshot)) continue;
        try {
          const id = `${scope}|delivery:${snapshot.id}|submission`;
          const job = await o.store.load(id);
          if (job?.tx || job?.stage === 'preparing') {
            if (monitored.has(id) || !(await monitor(id, job, snapshot.id))) continue;
          }
          let current = await o.store.load(id);
          // The pinned page already has enough state to honor backoff without another RPC.
          // Observed progress in that snapshot may reset backoff; final state is read before sending.
          let snapshotDue = progress(current?.observed, snapshot) ? 0 : (current?.nextAt ?? 0);
          const snapshotPhases =
            snapshot.fund.state === 0
              ? ['fund']
              : snapshot.slots.flatMap((slot, i) => (slot.step.state === 0 ? [`slot:${i}`] : []));
          for (const phase of snapshotPhases) {
            const record = await o.store.load(`${scope}|delivery:${snapshot.id}|${phase}`);
            if (!progress(record?.observed, snapshot))
              snapshotDue = Math.max(snapshotDue, record?.nextAt ?? 0);
          }
          if (snapshotDue > now()) {
            if (
              snapshot.fund.state === 1 ||
              (snapshot.fund.state === 2 && snapshot.slots.some((slot) => slot.step.state === 1))
            ) {
              out.incidents.push({ classification: 'in_flight', deliveryId: snapshot.id });
              if (
                !current?.inFlightAlerted &&
                (await o.store.compareAndSet(id, current, {
                  ...current,
                  id,
                  revision: (current?.revision ?? -1) + 1,
                  inFlightAlerted: true,
                }))
              )
                o.alert?.({ type: 'in_flight', deliveryId: snapshot.id });
            }
            continue;
          }
          const d = await getDelivery(o.nearRpc, o.contractId, snapshot.id);
          if (d && (await belowMinimum(d))) continue;
          if (!d) {
            await update(id, { stage: 'retired', tries: 0, nextAt: 0, inFlightAlerted: false });
            continue;
          }
          const advanced = progress(current?.observed, d);
          if (advanced) {
            current = await update(id, { tries: 0, nextAt: 0, observed: observation(d) });
          }
          if (
            d.fund.state === 1 ||
            (d.fund.state === 2 && d.slots.some((s) => s.step.state === 1))
          ) {
            if (!current?.inFlightAlerted) {
              const alerted = {
                ...current,
                id,
                revision: (current?.revision ?? -1) + 1,
                inFlightAlerted: true,
              };
              if (await o.store.compareAndSet(id, current, alerted)) {
                current = alerted;
                o.alert?.({ type: 'in_flight', deliveryId: d.id });
              } else current = await o.store.load(id);
            }
            out.incidents.push({ classification: 'in_flight', deliveryId: d.id });
            if (d.fund.state === 1) continue;
          } else if (current?.inFlightAlerted) {
            current = await update(id, { inFlightAlerted: false });
          }
          const phases =
            d.fund.state === 0
              ? ['fund']
              : d.slots.flatMap((slot, index) => (slot.step.state === 0 ? [`slot:${index}`] : []));
          if (!phases.length) continue;
          let due = current?.nextAt ?? 0;
          // Persist a separate deadline and failure count for each funded slot / funding phase.
          for (const phase of phases) {
            const phaseId = `${scope}|delivery:${d.id}|${phase}`;
            let record = await o.store.load(phaseId);
            if (progress(record?.observed, d))
              record = await update(phaseId, { tries: 0, nextAt: 0, observed: observation(d) });
            due = Math.max(due, record?.nextAt ?? 0);
          }
          if (due > now()) continue;
          await execute(
            id,
            'settle',
            { delivery_id: d.id },
            d.fund.state === 2 ? 450000000000000n : 600000000000000n,
            current,
            d,
            phases,
          );
        } catch (error) {
          out.errors.push({ deliveryId: snapshot.id, error });
        }
      }
    } catch (error) {
      out.errors.push({ from, error });
    }
    cursor = { ...cursor, from: from + 50 };
    await update(sweepId, { sweep: cursor });
  }
  if (o.refunds && attempts < maxTx) {
    try {
      for (const leaf of (
        await o.refunds.leaves({
          nearRpc: o.nearRpc,
          contractId: o.contractId,
          limit: maxTx - attempts,
        })
      ).slice(0, maxTx - attempts)) {
        const id = `${scope}|refund:${leaf.index}`;
        const job = await o.store.load(id);
        if (job?.tx || job?.stage === 'preparing') {
          if (monitored.has(id) || !(await monitor(id, job, leaf.leaf.delivery_id))) continue;
        }
        const current = await o.store.load(id);
        if (
          current?.stage === 'retired' ||
          (current?.nextAt ?? 0) > now() ||
          (await getDelivery(o.nearRpc, o.contractId, leaf.leaf.delivery_id))
        )
          continue;
        // Validate through the same SDK binding and use prepaid storage (deposit zero).
        await materializeRefund(
          {
            call: async (call) =>
              execute(
                id,
                'materialize_refund',
                call.args,
                call.gas as bigint,
                current,
                undefined,
                [],
                leaf.leaf.delivery_id,
              ),
          },
          o.contractId,
          leaf,
          0n,
        );
      }
    } catch (error) {
      out.errors.push({ error });
    }
  }
  if (passBalance)
    await balanceState(
      passBalance.available < passBalance.needed,
      passBalance.available,
      passBalance.needed,
    );
  return out;
}
