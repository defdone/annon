import { expect, it } from 'vitest';
import { memoryStore } from '../../packages/annon/src/pay/store.ts';
import { type MonitorRecord, ServiceMonitor } from './alerts.ts';

it('persists alert transitions, rate limits duplicates, and warns on pools and disk/inodes', async () => {
  const store = memoryStore<MonitorRecord>();
  const messages: unknown[] = [];
  const m = new ServiceMonitor(store, (a) => {
    messages.push(a);
  });
  await m.boot(0);
  for (let i = 0; i < 21; i++) m.refused(1000);
  await m.sample({
    now: 1000,
    poolPercent: 70,
    diskPercent: 70,
    inodePercent: 71,
    keeperEnabled: true,
    keeperLastSuccess: 0,
    keeperBudgetPercent: 50,
    oldestDeliverySeconds: 1800,
  });
  const count = messages.length;
  await m.sample({
    now: 2000,
    poolPercent: 80,
    diskPercent: 80,
    inodePercent: 90,
    keeperEnabled: true,
    keeperLastSuccess: 0,
    keeperBudgetPercent: 80,
    oldestDeliverySeconds: 1900,
  });
  expect(messages).toContainEqual({ type: 'relayer_429', count: 21 });
  expect(messages).toContainEqual({ type: 'pool_high', percent: 70 });
  expect(messages).toContainEqual({ type: 'keeper_budget', percent: 50 });
  expect(messages).toContainEqual({ type: 'disk_high', percent: 70 });
  expect(messages).toContainEqual({ type: 'inodes_high', percent: 71 });
  expect(messages.length).toBe(count);
  const restart = new ServiceMonitor(store, (a) => {
    messages.push(a);
  });
  await restart.boot(3000);
  expect(messages).toContainEqual({ type: 'unclean_restart' });
  await restart.stop();
});
it('emits keeper stalls and store failures without upstream text', async () => {
  const messages: unknown[] = [];
  const m = new ServiceMonitor(memoryStore<MonitorRecord>(), (a) => {
    messages.push(a);
  });
  await m.boot(0);
  await m.sample({
    now: 301000,
    keeperEnabled: true,
    keeperLastSuccess: 0,
    oldestDeliverySeconds: 1801,
  });
  await m.failure('store_busy', 301000);
  await m.failure('store_busy', 302000);
  expect(messages).toContainEqual({ type: 'keeper_stalled', seconds: 301 });
  expect(messages).toContainEqual({ type: 'old_delivery', seconds: 1801 });
  expect(messages.filter((a) => (a as { type: string }).type === 'store_busy')).toHaveLength(1);
});

it('samples both mounted stores and reports the fullest disk and inode use', async () => {
  const { volumeUsage } = await import('./alerts.ts');
  const reads: string[] = [];
  const usage = await volumeUsage(['relayer', 'keeper'], async (path) => {
    reads.push(path);
    return {
      blocks: 100,
      bavail: path === 'keeper' ? 5 : 90,
      files: 100,
      ffree: path === 'keeper' ? 3 : 90,
    };
  });
  expect(reads.sort()).toEqual(['keeper', 'relayer']);
  expect(usage).toEqual({ diskPercent: 95, inodePercent: 97 });
});

it('deduplicates persistent failures for an hour without a write for every response', async () => {
  const store = memoryStore<MonitorRecord>();
  const { vi } = await import('vitest');
  const writes = vi.spyOn(store, 'compareAndSet');
  const reads = vi.spyOn(store, 'load');
  const deliver = vi.fn();
  const m = new ServiceMonitor(store, deliver);
  await m.failure('rpc', 0);
  for (let i = 1; i < 100; i++) await m.failure('rpc', i * 1000);
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(writes).toHaveBeenCalledTimes(1);
  expect(reads).toHaveBeenCalledTimes(2);
  await new ServiceMonitor(store, deliver).failure('rpc', 3599000);
  expect(deliver).toHaveBeenCalledTimes(1);
  expect(writes).toHaveBeenCalledTimes(1);
  await m.failure('rpc', 3600000);
  expect(deliver).toHaveBeenCalledTimes(2);
});

it.each(['reopen_seller', 'fund_file_storage'] as const)(
  'deduplicates held %s reconciliation alerts across passes and restart',
  async (method) => {
    const { vi } = await import('vitest');
    const rpc = await import('../../packages/annon/src/near/rpc.ts');
    const { RelayLedger } = await import('../../packages/annon/src/relay/ledger.ts');
    const { reconcileRelayStorage } = await import('../../packages/annon/src/relay/relay.ts');
    const { relayLimits } = await import('../../packages/annon/src/relay/sponsorship.ts');
    const ledger = new RelayLedger(memoryStore(), 'held');
    const monitorStore = memoryStore<MonitorRecord>();
    const deliver = vi.fn();
    let monitor = new ServiceMonitor(monitorStore, deliver);
    const pending: Promise<void>[] = [];
    const fileId = `0x${'22'.repeat(32)}`;
    await ledger.prepare({
      id: 'op',
      requestHash: 'h',
      method,
      fileId,
      termsHash: `0x${'33'.repeat(32)}`,
      seller: 'seller',
      listed: false,
      ip: '192.0.2.1',
      storage: '100',
      allocation: '100',
      fundingBalanceBefore: '7',
      limits: relayLimits({
        nearRpc: 'https://rpc.test',
        baseRpc: 'https://base.test',
        contractId: 'market.test',
        usdc: `0x${'11'.repeat(20)}`,
        policy: { minPrice: 1n, maxDeadlineSeconds: 600 },
      }),
    });
    await ledger.signed('op', {
      txHash: 'T',
      signed: 'original',
      signer: 'relay.test',
      args:
        method === 'reopen_seller'
          ? { args: { file_id: fileId, key: `0x${'55'.repeat(48)}` } }
          : { file_id: fileId, amount: '100' },
    });
    vi.spyOn(rpc, 'rpcReply').mockImplementation(async (_url, name) =>
      name === 'tx'
        ? { error: { cause: { name: 'UNKNOWN_TRANSACTION' } } }
        : name === 'query'
          ? { error: { cause: { name: 'AccountStateTooLarge' } } }
          : { error: { cause: { info: { InvalidTxError: 'Expired' } } } },
    );
    vi.spyOn(rpc, 'getFile').mockResolvedValue({ purchaseStorageBalance: 7n } as never);
    try {
      for (let pass = 0; pass < 3; pass++) {
        if (pass === 2) monitor = new ServiceMonitor(monitorStore, deliver);
        await reconcileRelayStorage({
          ledger,
          nearRpc: 'https://rpc.test',
          contractId: 'market.test',
          sender: { accountId: 'relay.test', key: 'test-double' },
          alert: (type) => {
            pending.push(monitor.failure(type, 1000 + pass));
          },
        });
        await Promise.all(pending);
      }
      expect(deliver).toHaveBeenCalledExactlyOnceWith({ type: 'reconcile_held' });
      expect(await ledger.pendingStorage()).toBe(100n);
      expect((await ledger.operation('op'))?.stage).toBe('submitted');
      expect((await ledger.operation('op'))?.storageFinalized).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
    }
  },
);
it('persists each admission floor transition across restart without duplicate alerts', async () => {
  const { vi } = await import('vitest');
  const store = memoryStore<MonitorRecord>();
  const deliver = vi.fn();
  const m = new ServiceMonitor(store, deliver);
  await m.admissions(true);
  await m.admissions(true);
  const restart = new ServiceMonitor(store, deliver);
  await restart.admissions(true);
  await restart.admissions(false);
  await restart.admissions(false);
  await restart.admissions(true);
  expect(deliver.mock.calls.map(([a]) => a.type)).toEqual([
    'admissions_paused',
    'admissions_resumed',
    'admissions_paused',
  ]);
});
