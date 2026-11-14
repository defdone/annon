/**
 * Checking a failed purchase again reads only the deposit it was saved with, in order and under its
 * lease, and refuses before any NEAR or 1Click read when the saved records disagree.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setup, wallet } from '../../test/browser-purchase.js';
import { purchase as fixture, must } from '../../test/fixtures.js';
import type { OneClick } from '../oneclick/oneclick.js';
import { type EncryptedRecord, encryptedPurchaseStore } from '../pay/backup.js';
import { purchaseKey } from '../pay/purchase.js';
import type { AtomicStore } from '../pay/store.js';
import { BrowserPurchaseController } from './purchases.js';

const ID = 'synthetic-checkout';
const refunded = () => vi.fn<OneClick['status']>(async () => ({ status: 'REFUNDED' }));

/** A purchase 1Click reported FAILED, with a polling checkpoint that still holds a wait. */
async function failedPurchase() {
  const h = setup();
  const c = await h.create();
  await c.start({ recovery: wallet, refund: fixture.refund });
  const poll = vi.fn<OneClick['poll']>(async (address, o) => {
    await o?.onProgress?.({
      address,
      memo: 'synthetic-memo',
      attempts: 3,
      errors: 2,
      nextPollAt: 1900000000,
      lastStatus: { status: 'FAILED' },
    });
    return { status: 'FAILED' };
  });
  await c.poll({ oneClick: { poll }, maxPolls: 1 });
  return { h, c, before: must(await c.storage.load(ID)) };
}

/** Nothing was read and nothing changed: the purchase stays failed, so checkout stays blocked. */
async function untouched(
  h: Awaited<ReturnType<typeof failedPurchase>>['h'],
  c: BrowserPurchaseController,
  status: ReturnType<typeof refunded>,
  before: Awaited<ReturnType<typeof failedPurchase>>['before'],
) {
  expect(status).not.toHaveBeenCalled();
  expect(h.sdk.accept).not.toHaveBeenCalled();
  const after = must(await c.storage.load(ID));
  expect(after.state).toBe('failed');
  expect(after.purchase).toEqual(before.purchase);
  expect(after.lease).toBeUndefined();
  expect((await c.snapshot()).state).toBe('failed');
  expect(h.sdk.buy).toHaveBeenCalledTimes(1);
}

describe('reconcile keeps to the saved deposit', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['address', 'memo'] as const)(
    'refuses a newer saved commitment whose deposit %s differs, before any read',
    async (field) => {
      const { h, c, before } = await failedPurchase();
      const store = encryptedPurchaseStore(c.storage.rawStore, c.storage.backupSecret);
      const current = await c.storage.restorePurchase(must(before.purchase));
      const quote = must(current.quote);
      const changed = {
        ...current,
        revision: current.revision + 1,
        quote: { ...quote, deposit: { ...quote.deposit, [field]: `different-deposit-${field}` } },
      };
      expect(await store.compareAndSet(purchaseKey(current.id), current, changed)).toBe(true);
      const status = refunded();
      await expect(c.reconcile({ oneClick: { status } })).rejects.toThrow(/changed deposit/);
      await untouched(h, c, status, before);
      expect((await c.storage.load(ID))?.checkpoint).toEqual(before.checkpoint);
    },
  );

  it('refuses when the saved quote and its polling checkpoint name different deposits', async () => {
    const { h, c, before } = await failedPurchase();
    const disagreeing = {
      ...before,
      revision: before.revision + 1,
      checkpoint: { ...must(before.checkpoint), address: 'different-checkpoint-deposit' },
    };
    await c.storage.save(before, disagreeing);
    const status = refunded();
    await expect(c.reconcile({ oneClick: { status } })).rejects.toThrow(/changed deposit/);
    await untouched(h, c, status, before);
    expect((await c.storage.load(ID))?.checkpoint).toEqual(disagreeing.checkpoint);
  });

  it('still restores a newer revision of the same commitment and deposit', async () => {
    const { h, c, before } = await failedPurchase();
    const store = encryptedPurchaseStore(c.storage.rawStore, c.storage.backupSecret);
    const current = await c.storage.restorePurchase(must(before.purchase));
    const newer = { ...current, revision: current.revision + 1, recoveryProved: true };
    expect(await store.compareAndSet(purchaseKey(current.id), current, newer)).toBe(true);
    expect(await c.reconcile({ oneClick: { status: refunded() } })).toEqual({
      state: 'refunded',
      swapStatus: 'REFUNDED',
    });
    expect((await c.storage.load(ID))?.purchase?.revision).toBe(newer.revision);
    expect(h.sdk.accept).toHaveBeenCalledTimes(1);
  });
});

describe('a refused check writes nothing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['address', 'absent'],
    ['memo', 'absent'],
    ['address', 'older'],
    ['memo', 'older'],
  ] as const)(
    'a checkpoint %s conflict with %s canonical storage refuses before any restore or backup',
    async (field, canonicalCase) => {
      const { h, c, before } = await failedPurchase();
      const saved = {
        ...before,
        revision: before.revision + 1,
        checkpoint: { ...must(before.checkpoint), [field]: 'wrong-checkpoint' },
      };
      await c.storage.save(before, saved);
      const store = encryptedPurchaseStore(c.storage.rawStore, c.storage.backupSecret);
      const committed = must(before.purchase);
      const key = purchaseKey(committed.id);
      expect(await store.load(key)).toBeNull();
      if (canonicalCase === 'older')
        expect(await store.compareAndSet(key, null, { ...committed, revision: 0 })).toBe(true);
      const canonical = await store.load(key);
      const write = vi.spyOn(c.storage.rawStore, 'compareAndSet');
      const writeMany = vi.spyOn(
        c.storage.rawStore as AtomicStore<EncryptedRecord>,
        'compareAndSetMany',
      );
      const status = refunded();
      await expect(c.reconcile({ oneClick: { status } })).rejects.toThrow(/changed deposit/);
      expect(status).not.toHaveBeenCalled();
      expect(h.sdk.accept).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(writeMany).not.toHaveBeenCalled();
      expect(await store.load(key)).toEqual(canonical);
      expect(await c.storage.rawStore.load(`annon/browser/backup/${committed.id}`)).toBeNull();
      expect(await c.storage.load(ID)).toEqual(saved);
    },
  );

  it('a canonical copy with another deposit is refused before restore writes it or its backup', async () => {
    const { h, c, before } = await failedPurchase();
    const store = encryptedPurchaseStore(c.storage.rawStore, c.storage.backupSecret);
    const committed = must(before.purchase);
    const quote = must(committed.quote);
    const other = {
      ...committed,
      revision: 0,
      quote: { ...quote, deposit: { ...quote.deposit, address: 'different-deposit' } },
    };
    expect(await store.compareAndSet(purchaseKey(committed.id), null, other)).toBe(true);
    const restore = vi.spyOn(c.storage, 'restorePurchase');
    const write = vi.spyOn(c.storage.rawStore, 'compareAndSet');
    const status = refunded();
    await expect(c.reconcile({ oneClick: { status } })).rejects.toThrow(/changed deposit/);
    expect(restore).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(await store.load(purchaseKey(committed.id))).toEqual(other);
    await untouched(h, c, status, before);
  });
});

describe('reconcile order, refusals and routes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('checks NEAR before the single status read, both under the lease', async () => {
    const { h, c } = await failedPurchase();
    const calls: string[] = [];
    // Both gates exist before reconcile starts, so a slow lease read cannot lose the release.
    let entered = () => {};
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.sdk.accept = vi.fn(async () => {
      calls.push('accept');
      expect((await c.storage.load(ID))?.lease).toBeDefined();
      entered();
      await gate;
      return false;
    });
    const status = vi.fn<OneClick['status']>(async (address) => {
      calls.push('status');
      expect(address).toBe('synthetic-deposit');
      expect((await c.storage.load(ID))?.lease).toBeDefined();
      return { status: 'REFUNDED' };
    });
    const running = c.reconcile({ oneClick: { status } });
    await Promise.race([inside, running]);
    expect(h.sdk.accept).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
    release();
    await running;
    expect(calls).toEqual(['accept', 'status']);
  });

  it('refuses a failed record without a saved commitment before any read', async () => {
    const { h, c, before } = await failedPurchase();
    const { purchase: _purchase, checkpoint: _checkpoint, ...bare } = before;
    await c.storage.save(before, { ...bare, revision: before.revision + 1 });
    const status = refunded();
    await expect(c.reconcile({ oneClick: { status } })).rejects.toThrow(/failed saved purchase/);
    expect(h.sdk.accept).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it('refuses a restored purchase with another ID before any read', async () => {
    const { h, c } = await failedPurchase();
    const real = c.storage.restorePurchase.bind(c.storage);
    c.storage.restorePurchase = async (record) => ({
      ...(await real(record)),
      id: 'another-purchase',
    });
    const status = refunded();
    await expect(c.reconcile({ oneClick: { status } })).rejects.toThrow(/identity/);
    expect(h.sdk.accept).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
    expect((await c.snapshot()).state).toBe('failed');
  });

  it.each(['message', 'buyerSecret'] as const)(
    'the encrypted restore refuses a %s conflict before any read',
    async (field) => {
      const { h, c, before } = await failedPurchase();
      await c.storage.restorePurchase(must(before.purchase));
      const original = c.storage.restorePurchase.bind(c.storage);
      c.storage.restorePurchase = (record) =>
        original({
          ...record,
          [field]: field === 'message' ? 'mismatched-message' : `0x${'44'.repeat(32)}`,
        });
      const status = refunded();
      await expect(c.reconcile({ oneClick: { status } })).rejects.toThrow(
        /conflict|Invalid encrypted record/,
      );
      await untouched(h, c, status, before);
    },
  );

  it.each(['PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'FAILED'] as const)(
    '%s keeps failed and drops the stale polling wait',
    async (answer) => {
      const { h, c, before } = await failedPurchase();
      await c.reconcile({ oneClick: { status: vi.fn(async () => ({ status: answer })) } });
      const after = must(await c.storage.load(ID));
      expect(after.state).toBe('failed');
      expect(after.checkpoint?.nextPollAt).toBeUndefined();
      expect(after.checkpoint?.attempts).toBe((before.checkpoint?.attempts ?? 0) + 1);
      expect({ ...after.purchase, revision: 0 }).toEqual({ ...before.purchase, revision: 0 });
      expect(h.sdk.recover).not.toHaveBeenCalled();
      expect(h.sdk.proveRecovery).not.toHaveBeenCalled();
    },
  );

  it.each(['base', 'near'] as const)(
    'a failed %s purchase reads no 1Click status and stays failed without acceptance',
    async (route) => {
      const { h, c, before } = await failedPurchase();
      const record = { ...before, route };
      const storage = {
        ...c.storage,
        load: async () => structuredClone(record),
        save: async (_expected: unknown, next: typeof record) => {
          Object.assign(record, next);
        },
        restorePurchase: async (purchase: NonNullable<typeof before.purchase>) => purchase,
      };
      const controller = new BrowserPurchaseController({
        storage,
        sdk: h.sdk,
        id: ID,
        now: () => 1800000000,
      });
      const status = refunded();
      expect(await controller.reconcile({ oneClick: { status } })).toEqual({ state: 'failed' });
      expect(status).not.toHaveBeenCalled();
      expect(h.sdk.accept).toHaveBeenCalledTimes(1);
    },
  );
});
