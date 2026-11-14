/** Relayer paid-work retries and periodic keeper execution. */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getConfig } from '@defdone/annon/near/rpc';
import type { BudgetRecord } from '@defdone/annon/node';
import { fileStore } from '@defdone/annon/pay/store-node';
import type { KeeperRecord, KeepOptions } from '@defdone/annon/relay';
import { keep, reconcileRelayStorage, retryPaidUnlocks } from '@defdone/annon/relay';
import type { Config } from './config.ts';
import { deliverKeeperAlert } from './monitoring.ts';

function paidWork(c: Config): () => Promise<void> {
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout>;
  const pass = async () => {
    try {
      await reconcileRelayStorage(c);
      if (!c.disabled) await retryPaidUnlocks(c);
    } catch {
      void c.monitor?.failure('paid_work_unavailable');
    }
    if (!stopped)
      timer = setTimeout(
        () => {
          running = pass();
        },
        (c.retrySeconds ?? 5) * 1000,
      ).unref();
  };
  running = pass();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}

/** Keeper passes every `seconds`, one at a time, each over every delivery. */
export function keeper(c: Config, seconds: number) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cachedConfig: Awaited<ReturnType<typeof getConfig>> | undefined;
  const pass = async () => {
    if (stopped) return;
    if (!c.disabled) {
      try {
        const k = c.keeper;
        if (!k) throw new Error('separate keeper configuration required');
        const jobs = join(k.stateDir, 'jobs'),
          budgets = join(k.stateDir, 'budgets');
        await mkdir(jobs, { recursive: true, mode: 0o700 });
        await mkdir(budgets, { recursive: true, mode: 0o700 });
        const deliveries: Promise<void>[] = [];
        cachedConfig ??= await getConfig(c.nearRpc, c.contractId);
        const options: KeepOptions = {
          network: cachedConfig.network,
          nearRpc: c.nearRpc,
          contractId: c.contractId,
          sender: k.sender,
          store: fileStore<KeeperRecord>(jobs, { recoverDeadLocks: true }),
          budgetStore: fileStore<BudgetRecord>(budgets, { recoverDeadLocks: true }),
          hourlyBudget: k.hourlyBudget,
          dailyBudget: k.dailyBudget,
          gasPrice: k.gasPrice,
          reserveLowWater: k.reserveLowWater,
          oldestDeliverySeconds: c.monitorSettings?.oldestSeconds ?? 1800,
          ...(k.minPayout === undefined ? {} : { minPayout: k.minPayout }),
          ...(k.balanceLowWater === undefined ? {} : { balanceLowWater: k.balanceLowWater }),
          ...(k.refunds ? { refunds: k.refunds } : {}),
          alert: (alert) => {
            console.log(JSON.stringify({ keeper: 'alert', ...alert }));
            if (k.alertWebhook) deliveries.push(deliverKeeperAlert(k.alertWebhook, alert));
          },
        };
        const result = await keep(options);
        if (!result.errors.length) c.keeperLastSuccess = Date.now();
        else void c.monitor?.failure('keeper_store_or_rpc');
        await Promise.all(deliveries);
        for (const incident of result.incidents)
          console.log(
            JSON.stringify({
              keeper: 'incident',
              classification: incident.classification,
              deliveryId: incident.deliveryId,
            }),
          );
        // Keep upstream diagnostics out of public logs.
        for (const { deliveryId } of result.errors)
          console.log(
            JSON.stringify({
              keeper: 'error',
              deliveryId,
              message: 'Keeper work is unavailable.',
            }),
          );
        for (const s of result.sent)
          console.log(
            JSON.stringify({
              at: new Date().toISOString(),
              keeper: s.method,
              ...s.args,
              txHash: s.result.txHash,
              uncertain: s.result.uncertain === true,
            }),
          );
      } catch {
        void c.monitor?.failure('keeper_store_or_rpc');
        console.log(
          JSON.stringify({
            at: new Date().toISOString(),
            keeper: 'error',
            message: 'Keeper pass failed.',
          }),
        );
      }
    }
    if (!stopped)
      timer = setTimeout(() => {
        running = pass();
      }, seconds * 1000).unref();
  };
  let running = pass();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}

export { paidWork };
