/** Relayer balance monitoring and sanitized webhook alert delivery. */

import { join } from 'node:path';
import { rpcReply, view } from '@defdone/annon/near/rpc';
import type { BudgetRecord } from '@defdone/annon/node';
import { fileStore } from '@defdone/annon/pay/store-node';
import type { KeepOptions } from '@defdone/annon/relay';
import { keeperBalance } from '@defdone/annon/relay';
import { type ServiceAlert, volumeUsage } from './alerts.ts';
import type { Config } from './config.ts';
import { relayerLow } from './server.ts';

type RelayerAlert = {
  type: 'low_balance' | 'storage_low';
  balance?: string;
  needed?: string;
  reserve?: string;
};

/** One finalized balance sample; repeated low conditions alert only on transition. */
export async function relayerAlerts(c: Config): Promise<RelayerAlert[]> {
  const block = await rpcReply(c.nearRpc, 'block', { finality: 'final' });
  const hash = (block.result as { header?: { hash?: string } })?.header?.hash;
  if (block.error || !hash) throw new Error('final relayer balance block unavailable');
  const price = await rpcReply(c.nearRpc, 'gas_price', { block_id: hash });
  const gasPrice = (price.result as { gas_price?: string })?.gas_price;
  if (price.error || typeof gasPrice !== 'string' || !/^[0-9]+$/.test(gasPrice))
    throw new Error('relayer gas price unavailable');
  const [funds, storage] = await Promise.all([
    keeperBalance({
      nearRpc: c.nearRpc,
      accountId: c.sender.accountId,
      contractId: c.contractId,
      block: hash,
      gasPrice: BigInt(gasPrice),
      method: 'unlock',
      args: {},
      gas: 300000000000000n,
    }),
    view(c.nearRpc, c.contractId, 'storage_balance_of', { account_id: c.sender.accountId }, hash),
  ]);
  if (typeof storage !== 'string' || !/^[0-9]+$/.test(storage))
    throw new Error('relayer storage balance unavailable');
  if (c.admissionFloor !== undefined) await c.monitor?.admissions(funds.balance < c.admissionFloor);
  const needed =
    funds.cost > (c.balanceLowWater ?? 3n * 10n ** 24n)
      ? funds.cost
      : (c.balanceLowWater ?? 3n * 10n ** 24n);
  const low: RelayerAlert[] = [];
  if (funds.balance < needed)
    low.push({ type: 'low_balance', balance: String(funds.balance), needed: String(needed) });
  if (BigInt(storage) < (c.storageLowWater ?? 5n * 10n ** 23n))
    low.push({ type: 'storage_low', reserve: storage });
  const old = relayerLow.get(c) ?? new Set<string>();
  relayerLow.set(c, new Set(low.map((a) => a.type)));
  return low.filter((a) => !old.has(a.type));
}

function monitorRelayer(c: Config): () => Promise<void> {
  if (c.balanceLowWater === undefined && c.storageLowWater === undefined && !c.alertWebhook)
    return async () => {};
  const monitorStarted = Date.now();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let running: Promise<void> = Promise.resolve();
  const pass = async () => {
    try {
      const now = Date.now(),
        state = await c.ledger?.read();
      const counters = state?.counters ?? {},
        day = Math.floor(now / 86400000);
      const global = Number(counters[`${day}|all`] ?? '0');
      const { diskPercent, inodePercent } = await volumeUsage(
        [c.stateDir, c.keeper?.stateDir].filter((path): path is string => path !== undefined),
      );
      let keeperBudgetPercent = 0;
      if (c.keeper) {
        const b = await fileStore<BudgetRecord>(join(c.keeper.stateDir, 'budgets')).load(
          `${c.network ?? 'near:mainnet'}|${c.keeper.sender.accountId}|keeper-spend`,
        );
        keeperBudgetPercent = c.keeper.dailyBudget
          ? Number((BigInt(b?.day === day ? b.daily : '0') * 100n) / c.keeper.dailyBudget)
          : 100;
      }
      await c.monitor?.sample({
        now,
        poolPercent: c.perDay ? (100 * global) / c.perDay : 100,
        diskPercent,
        inodePercent,
        keeperEnabled: !!c.keeper,
        keeperLastSuccess: c.keeperLastSuccess ?? monitorStarted,
        keeperBudgetPercent,
      });
      for (const alert of await relayerAlerts(c)) {
        console.log(JSON.stringify({ relayer: 'alert', ...alert }));
        if (c.alertWebhook) await deliverKeeperAlert(c.alertWebhook, alert, fetch, 'relayer');
      }
    } catch {
      /* Monitoring failure cannot interrupt admission or expose endpoint credentials. */
    }
    if (!stopped)
      timer = setTimeout(
        () => {
          running = pass();
        },
        (c.monitorSettings?.sampleSeconds ?? 60) * 1000,
      ).unref();
  };
  timer = setTimeout(
    () => {
      running = pass();
    },
    (c.monitorSettings?.sampleSeconds ?? 60) * 1000,
  ).unref();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}

function webhookUrl(value: string): string {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.hash) throw new Error();
    return u.href;
  } catch {
    throw new Error('KEEPER_ALERT_WEBHOOK must be an HTTPS URL without user info or fragment');
  }
}

/** Failures are deliberately contained; only public keeper alert fields are delivered. */
export async function deliverKeeperAlert(
  url: string,
  value: Parameters<NonNullable<KeepOptions['alert']>>[0] | RelayerAlert | ServiceAlert,
  fetcher: typeof fetch = fetch,
  source = 'keeper',
): Promise<void> {
  try {
    const alert: Record<string, string | number> = { type: value.type };
    for (const field of ['balance', 'needed', 'reserve'] as const) {
      const n = field in value ? (value as RelayerAlert)[field] : undefined;
      if (typeof n === 'string' && /^[0-9]+$/.test(n)) alert[field] = n;
    }
    if (
      'deliveryId' in value &&
      Number.isSafeInteger(value.deliveryId) &&
      (value.deliveryId ?? -1) >= 0
    )
      alert.deliveryId = value.deliveryId as number;
    for (const field of ['count', 'percent', 'seconds'] as const) {
      const n = field in value ? (value as ServiceAlert)[field] : undefined;
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) alert[field] = n;
    }
    const response = await fetcher(webhookUrl(url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `${source}: alert ${JSON.stringify(alert)}`, alert }),
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    });
    await response.body?.cancel();
  } catch {
    /* Alerts must never interrupt keeper work or log webhook credentials/errors. */
  }
}

export { monitorRelayer, webhookUrl };
