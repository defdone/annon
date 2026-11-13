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
