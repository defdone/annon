import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { SellerRecord } from '../../packages/annon/src/pay/settle.ts';
import { fileStore } from '../../packages/annon/src/pay/store-node.ts';
import { sweepSellerRecords } from './maintenance.ts';

it('sweeps expired unpaid records and bindings but retains attempted and submitted evidence', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-sweep-'));
  try {
    const store = fileStore<SellerRecord>(dir);
    const purchase = (id: string, over = {}) =>
      ({
        id,
        kind: 'purchase',
        revision: 0,
        state: 'processing',
        header: 'signed',
        validBefore: '1',
        searchFromBlock: 0,
        leaseUntil: 0,
        submissionAttempted: false,
        ...over,
      }) as SellerRecord;
    for (const r of [
      purchase('unpaid', { state: 'unpaid' }),
      purchase('never'),
      purchase('unpaid-hash', { state: 'unpaid', transaction: 'hash' }),
      purchase('unattempted-hash', { submissionAttempted: false, transaction: 'hash' }),
      purchase('ambiguous', { submissionAttempted: true }),
      purchase('submitted', { state: 'submitted', transaction: 'hash', submissionAttempted: true }),
      {
        id: 'binding',
        kind: 'id',
        revision: 0,
        fingerprint: 'fp',
        keepUntil: '1',
        purchaseKey: 'never',
      } as SellerRecord,
    ])
      await store.compareAndSet(r.id, null, r);
    expect(await sweepSellerRecords(dir, store, 86_402_000)).toBe(3);
    expect(await store.load('ambiguous')).not.toBeNull();
    expect(await store.load('submitted')).not.toBeNull();
    expect(await readdir(dir)).toHaveLength(4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
