import { expect, it } from 'vitest';
import { memoryStore } from '../pay/store.js';
import { claimPurchase, type PurchaseGuard } from './purchase-guard.js';

it('blocks concurrent buyers and persists saved purchase IDs across new callers', async () => {
  const store = memoryStore<PurchaseGuard>();
  const options = { now: () => 1000, live: async () => true };
  const first = await claimPurchase(store, 'file', options);
  await expect(claimPurchase(store, 'file', options)).rejects.toMatchObject({
    code: 'purchase_open',
  });
  await first.saved('purchase');
  await first.release();
  await expect(claimPurchase(store, 'file', options)).rejects.toMatchObject({
    code: 'purchase_open',
  });
  const forced = await claimPurchase(store, 'file', { ...options, force: true });
  await forced.release();
  await expect(claimPurchase(store, 'file', options)).rejects.toMatchObject({
    code: 'purchase_open',
  });
});
it('releases an unsigned attempt, permits expired unpaid purchases, and retains uncertain evidence', async () => {
  const store = memoryStore<PurchaseGuard>();
  const options = { now: () => 1000, live: async () => false };
  const first = await claimPurchase(store, 'file', options);
  await first.release();
  const next = await claimPurchase(store, 'file', options);
  await next.saved('expired');
  await next.release();
  const last = await claimPurchase(store, 'file', options);
  await last.release();
  await expect(
    claimPurchase(store, 'file', { ...options, live: async () => true }),
  ).rejects.toMatchObject({ code: 'purchase_open' });
});
it('includes existing saved purchases when creating the local guard', async () => {
  const store = memoryStore<PurchaseGuard>();
  await expect(
    claimPurchase(store, 'file', { known: ['existing'], live: async () => true }),
  ).rejects.toMatchObject({ code: 'purchase_open' });
});

it('renews a slow purchase claim and gives unsaved ids only the claim window', async () => {
  const store = memoryStore<PurchaseGuard>();
  let now = 1000;
  const live = async (_id: string, until: number) => now < until;
  const options = { now: () => now, live };
  const first = await claimPurchase(store, 'file', options);
  now = 1100;
  await first.renew();
  now = 1121;
  await expect(claimPurchase(store, 'file', options)).rejects.toMatchObject({
    code: 'purchase_open',
  });
  await first.saved('not-yet-saved');
  await first.release();
  now = 1240;
  await expect(claimPurchase(store, 'file', options)).rejects.toMatchObject({
    code: 'purchase_open',
  });
  now = 1241;
  const next = await claimPurchase(store, 'file', options);
  await next.release();
});

it('keeps checkpoints and release usable after a transient renewal failure', async () => {
  const store = memoryStore<PurchaseGuard>();
  const guard = await claimPurchase(store, 'file', { live: async () => false });
  const compareAndSet = store.compareAndSet;
  store.compareAndSet = async () => false;
  await expect(guard.renew()).rejects.toMatchObject({ code: 'store_conflict' });
  store.compareAndSet = compareAndSet;
  await guard.saved('signed-purchase');
  await guard.release();
  expect(await store.load('file')).toMatchObject({ owner: null, purchases: ['signed-purchase'] });
});
