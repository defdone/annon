import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { memoryStore } from '../pay/store.js';
import { fileStore } from '../pay/store-node.js';
import { type BudgetRecord, reserveSpend } from './budget.js';

it('refunds only its reservation under concurrency and leaves later UTC windows intact', async () => {
  const store = memoryStore<BudgetRecord>();
  const now = Date.parse('2026-11-11T23:30:00Z');
  const release = await reserveSpend(store, 's', 4n, { daily: 20n }, now);
  await reserveSpend(store, 's', 6n, { daily: 20n }, now);
  await Promise.all([release(), release()]);
  expect(await store.load('s')).toMatchObject({ daily: '6', hourly: '6' });
  const late = await reserveSpend(store, 's', 3n, { daily: 20n }, now);
  await reserveSpend(store, 's', 7n, { daily: 20n }, now + 3600000);
  await late();
  expect(await store.load('s')).toMatchObject({ daily: '7', hourly: '7' });
});

it('keeps daily/hourly reservations across restarts, concurrency and UTC rollover', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-budget-'));
  const now = Date.parse('2026-11-11T12:00:00Z');
  try {
    await reserveSpend(fileStore<BudgetRecord>(dir), 'scope', 6n, { daily: 10n, hourly: 9n }, now);
    await expect(
      reserveSpend(fileStore<BudgetRecord>(dir), 'scope', 4n, { daily: 10n, hourly: 9n }, now),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    await reserveSpend(
      fileStore<BudgetRecord>(dir),
      'scope',
      4n,
      { daily: 10n, hourly: 9n },
      now + 3600000,
    );
    await expect(
      reserveSpend(fileStore<BudgetRecord>(dir), 'scope', 1n, { daily: 10n }, now + 3600000),
    ).rejects.toMatchObject({ code: 'budget_exceeded' });
    const out = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        reserveSpend(fileStore<BudgetRecord>(dir), 'scope', 7n, { daily: 10n }, now + 86400000),
      ),
    );
    expect(out.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
