import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { purchase as fixture } from '../../test/fixtures.js';
import { keyFromSecret } from '../keys/near-ckd.js';
import type { OneClick, PollCheckpoint, SwapStatus } from '../oneclick/oneclick.js';
import { newBackupSecret } from '../pay/backup.js';
import type { PurchaseRecord } from '../pay/purchase.js';
import { hex } from '../settle-near/codec.js';
import { baseNonceV2, buildPurchaseMessage, purchaseId } from '../settle-near/purchase.js';
import { NEAR_USDC } from '../settle-near/terms.js';
import type { IdentityWallet } from '../wallet/wallet.js';
import {
  BrowserPurchaseController,
  browserPurchaseStorage,
  type PurchaseSdk,
} from './purchases.js';

const now = 1800000000;
const secret = new Uint8Array(32);
secret[31] = 1;
function record(): PurchaseRecord {
  const purchase = {
    ...fixture,
    route: 'near-usdc' as const,
    network: 'near:mainnet',
    asset: NEAR_USDC,
    expires_at: String(now + 3600),
  };
  const id = purchaseId(purchase);
  return {
    schemaVersion: 2,
    id,
    revision: 0,
    purchase,
    message: buildPurchaseMessage(purchase),
    buyerSecret: hex(secret),
    recovery: purchase.recovery,
    checkedHeaderHash: `0x${'55'.repeat(32)}`,
    quote: {
      deposit: {
        address: 'synthetic-deposit',
        memo: 'synthetic-memo',
        amount: '250000',
        asset: 'nep141:synthetic',
        chain: 'evm',
        qrData: '{}',
        depositBefore: new Date((now + 3000) * 1000).toISOString(),
        purchaseExpiresAt: new Date((now + 3600) * 1000).toISOString(),
      },
    },
    terms: {
      network: purchase.network,
      contractId: purchase.contract,
      fileId: purchase.file_id,
      buyer: purchase.refund.id,
      seller: purchase.recovery,
      to: purchase.refund.id,
      usdc: purchase.asset,
      price: purchase.price,
      buyerKey: hex(keyFromSecret(secret).publicKeyBytes),
      nonce: purchase.nonce,
      headerHash: `0x${'55'.repeat(32)}`,
      cipherHash: `0x${'66'.repeat(32)}`,
      moderator: null,
    },
    attempts: [],
  };
}
const wallet = { identity: fixture.recovery, authorize: vi.fn() } as IdentityWallet;
function setup(clock: () => number = () => now) {
  const factory = new IDBFactory();
  const options = { factory, name: 'browser-purchases' };
  const storage = () => browserPurchaseStorage(options);
  const r = record();
  const sdk: PurchaseSdk = {
    buy: vi.fn(async (o) => {
      await o.onSaved?.(r);
      const proved = { ...r, revision: 1, recoveryProved: true };
      await o.onSaved?.(proved);
      await o.beforePayment?.(proved);
      return {
        route: r.purchase.route,
        record: proved,
        instructions: (r.quote as { deposit: never }).deposit,
      };
    }),
    accept: vi.fn(async () => false),
    proveRecovery: vi.fn(async (r) => ({ ...r, revision: r.revision + 1, recoveryProved: true })),
    recover: vi.fn(async () => []),
    open: vi.fn(async () => ({
      meta: { name: 'f', mime: '', size: 1, previewLen: 0 },
      data: new Uint8Array([1]),
    })),
  };
  const make = async (id: string) =>
    new BrowserPurchaseController({ storage: await storage(), sdk, id, now: clock });
  const create = async () =>
    BrowserPurchaseController.create(
      { storage: await storage(), sdk, now: clock },
      {
        id: 'synthetic-checkout',
        fileId: fixture.file_id,
        header: new Uint8Array([1, 2, 3]),
        resourceUrl: 'https://files.example/synthetic',
        route: 'oneclick',
        maxPrice: 200000n,
      },
    );
  return { storage, sdk, make, create, r };
}
describe('durable browser purchases', () => {
  it('persists the local secret, encrypted index, header and resource across storage instances', async () => {
    const h = setup();
    const [a, b] = await Promise.all([h.storage(), h.storage()]);
    expect(a.backupSecret).toEqual(b.backupSecret);
    await h.create();
    expect(await b.list()).toEqual([
      {
        id: 'synthetic-checkout',
        fileId: fixture.file_id,
        state: 'terms_review',
        route: 'oneclick',
      },
    ]);
    const saved = await b.load('synthetic-checkout');
    expect(saved?.header).toBe('0x010203');
    expect(saved?.resourceUrl).toBe('https://files.example/synthetic');
    const raw = await b.rawStore.load('annon/browser/index');
    expect(JSON.stringify(raw)).not.toContain('files.example');
    expect(JSON.stringify(raw)).not.toContain('terms_review');
  });
  it('only one tab can leave terms review and a reload never buys again', async () => {
    const h = setup();
    await h.create();
    const [a, b] = await Promise.all([h.make('synthetic-checkout'), h.make('synthetic-checkout')]);
    const results = await Promise.allSettled([
      a.start({ recovery: wallet, refund: fixture.refund }),
      b.start({ recovery: wallet, refund: fixture.refund }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(h.sdk.buy).toHaveBeenCalledTimes(1);
    const reload = await h.make('synthetic-checkout');
    expect((await reload.snapshot()).state).toBe('awaiting_deposit');
    await expect(reload.start({ recovery: wallet, refund: fixture.refund })).rejects.toThrow();
    await reload.resume();
    expect(h.sdk.buy).toHaveBeenCalledTimes(1);
  });
  it('emits only durable public progress and releases instructions after saved proof', async () => {
    const h = setup();
    const c = await h.create();
    const events: unknown[] = [];
    c.subscribe((event) => {
      events.push(event);
    });
    expect(await c.instructions()).toBeNull();
    await c.start({ recovery: wallet, refund: fixture.refund });
    expect(await c.instructions()).toMatchObject({
      address: 'synthetic-deposit',
      memo: 'synthetic-memo',
    });
    expect(events).toMatchObject([
      { state: 'preparing' },
      { state: 'preparing' },
      { state: 'preparing' },
      { state: 'awaiting_deposit' },
    ]);
    expect(JSON.stringify(events)).not.toContain('synthetic-deposit');
    expect(JSON.stringify(events)).not.toContain(h.r.buyerSecret);
  });
  it.each(['before-record', 'after-record', 'after-proof'] as const)(
    'reloads uncertainty at %s without creating another payment',
    async (point) => {
      const h = setup();
      const c = await h.create();
      h.sdk.buy = vi.fn(async (o) => {
        if (point === 'before-record') throw new Error('offline');
        await o.onSaved?.(h.r);
        if (point === 'after-record') throw new Error('offline');
        await o.onSaved?.({ ...h.r, recoveryProved: true });
        throw new Error('offline');
      });
      await expect(c.start({ recovery: wallet, refund: fixture.refund })).rejects.toThrow(
        'offline',
      );
      const reload = await h.make('synthetic-checkout');
      expect((await reload.snapshot()).state).toBe(
        point === 'before-record' ? 'terms_review' : 'payment_uncertain',
      );
      await reload.resume(point === 'after-record' ? { recovery: wallet } : {});
      expect(h.sdk.buy).toHaveBeenCalledTimes(1);
      expect(await reload.instructions()).toEqual(
        point === 'before-record'
          ? null
          : expect.objectContaining({ address: 'synthetic-deposit' }),
      );
    },
  );
  it.each([
    'PENDING_DEPOSIT',
    'KNOWN_DEPOSIT_TX',
    'INCOMPLETE_DEPOSIT',
    'PROCESSING',
    'REFUNDED',
    'FAILED',
    'SUCCESS',
  ] as const)(
    'saves %s before progress returns and resumes from its checkpoint',
    async (status) => {
      const h = setup();
      const c = await h.create();
      await c.start({ recovery: wallet, refund: fixture.refund });
      const oneClick: Pick<OneClick, 'poll'> = {
        poll: vi.fn<OneClick['poll']>(async (_a, o) => {
          const checkpoint = {
            address: 'synthetic-deposit',
            memo: 'synthetic-memo',
            attempts: 1,
            errors: 0,
            lastStatus: { status },
          };
          await o?.onProgress?.(checkpoint);
          const reload = await h.make('synthetic-checkout');
          expect((await reload.storage.load('synthetic-checkout'))?.checkpoint).toEqual(checkpoint);
          return { status };
        }),
      } as Pick<OneClick, 'poll'>;
      await c.poll({ oneClick, maxPolls: 1 });
      const expected = {
        PENDING_DEPOSIT: 'awaiting_deposit',
        KNOWN_DEPOSIT_TX: 'processing',
        INCOMPLETE_DEPOSIT: 'incomplete_deposit',
        PROCESSING: 'processing',
        REFUNDED: 'refunded',
        FAILED: 'failed',
        SUCCESS: 'accepting',
      }[status];
      expect((await (await h.make('synthetic-checkout')).snapshot()).state).toBe(expected);
      expect(h.sdk.accept).toHaveBeenCalledTimes(status === 'SUCCESS' ? 1 : 0);
    },
  );
  it('keeps an expired purchase trackable and hides late deposit instructions', async () => {
    const h = setup();
    const c = await h.create();
    await c.start({ recovery: wallet, refund: fixture.refund });
    const reload = new BrowserPurchaseController({
      storage: await h.storage(),
      sdk: h.sdk,
      id: 'synthetic-checkout',
      now: () => now + 3001,
    });
    await reload.resume();
    expect((await reload.snapshot()).state).toBe('expired');
    expect(await reload.instructions()).toBeNull();
    const oneClick = {
      poll: async (_a: string, o?: { onProgress?: (c: PollCheckpoint) => unknown }) => {
        await o?.onProgress?.({
          address: 'synthetic-deposit',
          memo: 'synthetic-memo',
          attempts: 1,
          errors: 0,
          lastStatus: { status: 'REFUNDED' },
        });
        return { status: 'REFUNDED' } as SwapStatus;
      },
    };
    await reload.poll({ oneClick: oneClick as never });
    expect((await reload.snapshot()).state).toBe('refunded');
  });
  it('checks contract acceptance after delivery and delegates open and recovery with the saved purchase', async () => {
    const h = setup();
    const c = await h.create();
    await c.start({ recovery: wallet, refund: fixture.refund });
    h.sdk.accept = vi.fn(async () => true);
    await c.resume();
    expect((await c.snapshot()).state).toBe('accepted');
    const recovered = {
      kind: 'recovery' as const,
      id: `recovery:${h.r.id}`,
      revision: 0,
      purchase_id: h.r.id,
      file_id: fixture.file_id,
      recovery: fixture.recovery,
      buyerSecret: h.r.buyerSecret,
      fresh_key: h.r.purchase.buyer_key,
      nonce: h.r.purchase.nonce,
      deadline: now + 500,
      grant: 1,
    };
    h.sdk.recover = vi.fn(async () => [recovered]);
    await c.recover(wallet);
    expect(h.sdk.recover).toHaveBeenCalledWith({ wallet, purchaseId: h.r.id });
    const reload = await h.make('synthetic-checkout');
    const result = await reload.open(new Uint8Array([7]));
    expect(result.data).toEqual(new Uint8Array([1]));
    expect((await (await h.make('synthetic-checkout')).snapshot()).state).toBe('file_ready');
    expect(h.sdk.open).toHaveBeenCalledWith(expect.objectContaining({ recovery: recovered }));
  });
  it('exports and imports the portable receipt with the separate backup secret', async () => {
    const h = setup();
    const c = await h.create();
    await c.start({ recovery: wallet, refund: fixture.refund });
    const portableSecret = newBackupSecret();
    const receipt = await c.exportReceipt(portableSecret);
    expect(receipt).not.toContain('files.example');
    const fresh = setup();
    const storage = await fresh.storage();
    await expect(storage.importReceipt(receipt, newBackupSecret())).rejects.toThrow();
    expect(await storage.list()).toEqual([]);
    await storage.importReceipt(receipt, portableSecret);
    const restored = await storage.load('synthetic-checkout');
    expect(restored?.purchase?.id).toBe(h.r.id);
    expect(restored?.resourceUrl).toBe('https://files.example/synthetic');
    await expect(storage.importReceipt(receipt, portableSecret)).rejects.toThrow(/conflict/);
    const reload = new BrowserPurchaseController({
      storage,
      sdk: fresh.sdk,
      id: 'synthetic-checkout',
      now: () => now,
    });
    expect(await reload.instructions()).toBeNull();
    await reload.resume({ recovery: wallet });
    expect(await reload.instructions()).not.toBeNull();
    expect(fresh.sdk.proveRecovery).toHaveBeenCalledTimes(1);
  });
  it('fails closed on quota and stale writes before buy, and on failed proof persistence before instructions', async () => {
    const h = setup();
    const c = await h.create();
    const s = await h.storage();
    const before = await s.load('synthetic-checkout');
    if (!before) throw new Error('missing fixture');
    await s.save(before, { ...before, revision: before.revision + 1 });
    await expect(s.save(before, { ...before, revision: before.revision + 1 })).rejects.toThrow(
      /conflict/,
    );
    const save = vi
      .spyOn(c.storage, 'save')
      .mockRejectedValue(new DOMException('quota', 'QuotaExceededError'));
    await expect(c.start({ recovery: wallet, refund: fixture.refund })).rejects.toThrow('quota');
    expect(h.sdk.buy).not.toHaveBeenCalled();
    save.mockRestore();
    h.sdk.buy = vi.fn(async (o) => {
      await o.onSaved?.(h.r);
      vi.spyOn(c.storage, 'save').mockRejectedValue(
        new DOMException('quota', 'QuotaExceededError'),
      );
      await o.onSaved?.({ ...h.r, recoveryProved: true });
      throw new Error('unreachable');
    });
    await expect(c.start({ recovery: wallet, refund: fixture.refund })).rejects.toThrow('quota');
    expect(await c.instructions()).toBeNull();
  });
});

it('keeps a live in-flight lease when another tab resumes before the record exists', async () => {
  const h = setup();
  const c = await h.create();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const buy = h.sdk.buy;
  h.sdk.buy = vi.fn(async (o) => {
    await held;
    return buy(o);
  });
  const pending = c.start({ recovery: wallet, refund: fixture.refund });
  while ((await c.snapshot()).state === 'terms_review') await Promise.resolve();
  const other = await h.make('synthetic-checkout');
  await other.resume();
  expect((await other.snapshot()).state).toBe('preparing');
  release();
  await expect(pending).resolves.toBeUndefined();
  expect(h.sdk.buy).toHaveBeenCalledTimes(1);
  expect((await other.snapshot()).state).toBe('awaiting_deposit');
});
it('can resume a pending recovery after a reload without replacing the purchase', async () => {
  const h = setup();
  const c = await h.create();
  await c.start({ recovery: wallet, refund: fixture.refund });
  h.sdk.recover = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce([
      {
        kind: 'recovery',
        id: `recovery:${h.r.id}`,
        revision: 0,
        purchase_id: h.r.id,
        file_id: fixture.file_id,
        recovery: fixture.recovery,
        buyerSecret: h.r.buyerSecret,
        fresh_key: h.r.purchase.buyer_key,
        nonce: h.r.purchase.nonce,
        deadline: now + 500,
        grant: 1,
      },
    ]);
  await expect(c.recover(wallet)).rejects.toThrow('offline');
  const reload = await h.make('synthetic-checkout');
  expect((await reload.snapshot()).state).toBe('recovering');
  await reload.resume({ recovery: wallet });
  expect((await reload.snapshot()).state).toBe('accepted');
  expect(h.sdk.buy).toHaveBeenCalledTimes(1);
});
it('never resurrects accepted, refunded or failed purchases when polling is requested again', async () => {
  const h = setup();
  const c = await h.create();
  await c.start({ recovery: wallet, refund: fixture.refund });
  h.sdk.accept = vi.fn(async () => true);
  await c.resume();
  const poll = vi.fn();
  await expect(c.poll({ oneClick: { poll } })).rejects.toThrow(/state/);
  expect(poll).not.toHaveBeenCalled();
});

it('keeps raw quotes and private recovery material out of public snapshots before proof', async () => {
  const h = setup();
  const c = await h.create();
  h.sdk.buy = vi.fn(async (o) => {
    await o.onSaved?.(h.r);
    throw new Error('offline');
  });
  await expect(c.start({ recovery: wallet, refund: fixture.refund })).rejects.toThrow('offline');
  const snapshot = await c.snapshot();
  expect(JSON.stringify(snapshot)).not.toContain('synthetic-deposit');
  expect(JSON.stringify(snapshot)).not.toContain(h.r.buyerSecret);
  expect(snapshot).not.toHaveProperty('purchase');
  expect(await c.instructions()).toBeNull();
});

it('recovers the exact staged purchase when the SDK backup write fails after its durable record write', async () => {
  const h = setup();
  const c = await h.create();
  h.sdk.buy = vi.fn(async (o) => {
    await o.beforeSave?.(h.r);
    throw new Error('backup quota');
  });
  await expect(c.start({ recovery: wallet, refund: fixture.refund })).rejects.toThrow(
    'backup quota',
  );
  const reload = await h.make('synthetic-checkout');
  expect((await reload.storage.load('synthetic-checkout'))?.purchase?.id).toBe(h.r.id);
  await reload.resume({ recovery: wallet });
  expect(await reload.instructions()).toMatchObject({ address: 'synthetic-deposit' });
  expect(h.sdk.buy).toHaveBeenCalledTimes(1);
});
it('rechecks the release margin after a slow durable instruction checkpoint', async () => {
  const h = setup();
  const storage = await h.storage();
  let clock = now;
  const c = await BrowserPurchaseController.create(
    { storage, sdk: h.sdk, now: () => clock },
    {
      id: 'synthetic-checkout',
      fileId: fixture.file_id,
      header: new Uint8Array([1]),
      resourceUrl: 'https://files.example/synthetic',
      route: 'oneclick',
      maxPrice: 200000n,
    },
  );
  const save = storage.save.bind(storage);
  vi.spyOn(storage, 'save').mockImplementation(async (expected, next) => {
    await save(expected, next);
    if (next.state === 'awaiting_deposit') clock = now + 2401;
  });
  await c.start({ recovery: wallet, refund: fixture.refund });
  expect(await c.instructions()).toBeNull();
});

it.each([
  'terms_review',
  'preparing',
  'payment_uncertain',
  'awaiting_deposit',
  'incomplete_deposit',
  'processing',
  'accepting',
  'accepted',
  'recovering',
  'file_ready',
  'refunded',
  'failed',
  'expired',
] as const)('reconstructs %s from storage without buying again', async (state) => {
  const h = setup();
  await h.create();
  const storage = await h.storage();
  const before = await storage.load('synthetic-checkout');
  if (!before) throw new Error('missing fixture');
  const status =
    state === 'processing'
      ? 'PROCESSING'
      : state === 'incomplete_deposit'
        ? 'INCOMPLETE_DEPOSIT'
        : state === 'accepting'
          ? 'SUCCESS'
          : undefined;
  await storage.save(before, {
    ...before,
    revision: before.revision + 1,
    state,
    ...(state === 'terms_review' ? {} : { purchase: { ...h.r, recoveryProved: true } }),
    ...(status
      ? {
          checkpoint: {
            address: 'synthetic-deposit',
            memo: 'synthetic-memo',
            attempts: 1,
            errors: 0,
            lastStatus: { status },
          },
        }
      : {}),
  });
  const reload = await h.make('synthetic-checkout');
  expect((await reload.snapshot()).state).toBe(state);
  await reload.resume();
  expect(h.sdk.buy).not.toHaveBeenCalled();
  if (
    [
      'accepted',
      'file_ready',
      'expired',
      'refunded',
      'failed',
      'terms_review',
      'recovering',
      'processing',
      'accepting',
      'incomplete_deposit',
    ].includes(state)
  )
    expect((await reload.snapshot()).state).toBe(state);
});

it.each(['unproved', 'imported'] as const)(
  'withholds instructions from an %s saved deposit state',
  async (mode) => {
    const h = setup();
    await h.create();
    const storage = await h.storage();
    const before = await storage.load('synthetic-checkout');
    if (!before) throw new Error('missing fixture');
    await storage.save(before, {
      ...before,
      revision: before.revision + 1,
      state: 'awaiting_deposit',
      purchase: { ...h.r, recoveryProved: mode === 'imported' },
      needsProof: mode === 'imported',
    });
    expect(await (await h.make('synthetic-checkout')).instructions()).toBeNull();
  },
);

it('merges concurrent saves to different entries and backup writes without losing updates', async () => {
  const h = setup();
  const a = await h.create();
  const storage = a.storage;
  const initial = await storage.load('synthetic-checkout');
  if (!initial) throw new Error('missing fixture');
  await storage.save(null, { ...initial, id: 'second', revision: 0 });
  const second = await storage.load('second');
  if (!second) throw new Error('missing fixture');
  await Promise.all([
    storage.save(initial, { ...initial, revision: 1, state: 'preparing' }),
    storage.save(second, { ...second, revision: 1, state: 'preparing' }),
  ]);
  expect((await storage.load(initial.id))?.revision).toBe(1);
  expect((await storage.load(second.id))?.revision).toBe(1);
  const current = await storage.load(initial.id);
  if (!current) throw new Error('missing fixture');
  const { exportPurchase } = await import('../pay/backup.js');
  await Promise.all([
    storage.writeBackup(h.r.id, await exportPurchase(h.r, storage.backupSecret)),
    storage.save(current, { ...current, revision: 2 }),
  ]);
  const raw = storage.rawStore as import('../pay/store.js').AtomicStore<
    import('../pay/backup.js').EncryptedRecord
  >;
  const staleWrite = vi.spyOn(raw, 'compareAndSetMany');
  await expect(storage.save(initial, { ...initial, revision: 1 })).rejects.toThrow(/conflict/);
  expect(staleWrite).not.toHaveBeenCalled();
});
it('lets controllers in two tabs start different purchases concurrently', async () => {
  const h = setup();
  const a = await h.create();
  const storage = await h.storage();
  const initial = await storage.load('synthetic-checkout');
  if (!initial) throw new Error('missing fixture');
  await storage.save(null, { ...initial, id: 'second', revision: 0 });
  const b = await h.make('second');
  await expect(
    Promise.all([
      a.start({ recovery: wallet, refund: fixture.refund }),
      b.start({ recovery: wallet, refund: fixture.refund }),
    ]),
  ).resolves.toEqual([undefined, undefined]);
  expect((await a.snapshot()).state).toBe('awaiting_deposit');
  expect((await b.snapshot()).state).toBe('awaiting_deposit');
});
it.each(['PROCESSING', 'KNOWN_DEPOSIT_TX', 'SUCCESS'] as const)(
  'resumes %s after cutoff as deposit progress, not expired',
  async (status) => {
    const h = setup();
    const c = await h.create();
    await c.start({ recovery: wallet, refund: fixture.refund });
    const before = await c.storage.load('synthetic-checkout');
    if (!before) throw new Error('missing fixture');
    await c.storage.save(before, {
      ...before,
      revision: before.revision + 1,
      checkpoint: {
        address: 'synthetic-deposit',
        memo: 'synthetic-memo',
        attempts: 1,
        errors: 0,
        lastStatus: { status },
      },
      state: status === 'SUCCESS' ? 'accepting' : 'processing',
    });
    const reload = new BrowserPurchaseController({
      storage: await h.storage(),
      sdk: h.sdk,
      id: before.id,
      now: () => now + 4000,
    });
    await reload.resume();
    expect((await reload.snapshot()).state).toBe(status === 'SUCCESS' ? 'accepting' : 'processing');
    expect(await reload.instructions()).toBeNull();
  },
);
it('returns an unstaged failure to terms review and allows an explicit retry', async () => {
  const h = setup();
  const c = await h.create();
  const buy = h.sdk.buy;
  h.sdk.buy = vi
    .fn()
    .mockRejectedValueOnce(new Error('price_above_max'))
    .mockImplementationOnce(buy);
  await expect(c.start({ recovery: wallet, refund: fixture.refund })).rejects.toThrow(
    'price_above_max',
  );
  expect((await c.snapshot()).state).toBe('terms_review');
  await c.start({ recovery: wallet, refund: fixture.refund });
  expect((await c.snapshot()).state).toBe('awaiting_deposit');
});
it.each(['near-usdc', 'base-usdc'] as const)(
  'does not accept or submit an unsubmitted %s purchase on resume',
  async (route) => {
    const h = setup();
    await h.create();
    const storage = await h.storage();
    const before = await storage.load('synthetic-checkout');
    if (!before) throw new Error('missing fixture');
    // A durable pre-submit workflow marker must prevent accept(), which can drive Base unlock.
    const purchase = route === 'near-usdc' ? h.r : recordForBase();
    await storage.save(before, {
      ...before,
      revision: 1,
      route,
      purchase,
      state: 'payment_uncertain',
      submission: 'not_submitted',
    });
    const c = await h.make(before.id);
    await c.resume();
    expect((await c.snapshot()).state).toBe('abandoned');
    expect(h.sdk.accept).not.toHaveBeenCalled();
    expect(h.sdk.buy).not.toHaveBeenCalled();
  },
);
function recordForBase(): PurchaseRecord {
  const r = record();
  const purchase = { ...fixture, expires_at: String(now + 3600) };
  const id = purchaseId(purchase);
  return {
    ...r,
    id,
    purchase,
    message: buildPurchaseMessage(purchase),
    recovery: purchase.recovery,
    terms: { ...r.terms, network: purchase.network, usdc: purchase.asset, nonce: baseNonceV2(id) },
  };
}
it('blocks the controller payment checkpoint when recovery has not been proved', async () => {
  const h = setup();
  const c = await h.create();
  const effect = vi.fn();
  h.sdk.buy = vi.fn(async (o) => {
    await o.beforeSave?.(h.r);
    await o.onSaved?.(h.r);
    await o.beforePayment?.(h.r);
    effect();
    return { route: h.r.purchase.route, record: h.r };
  });
  await expect(c.start({ recovery: wallet, refund: fixture.refund })).rejects.toThrow(/proof/);
  expect(effect).not.toHaveBeenCalled();
  expect(await c.instructions()).toBeNull();
});
it.each(['message', 'buyerSecret'] as const)(
  'rejects restorePurchase %s substitution',
  async (field) => {
    const h = setup();
    const storage = await h.storage();
    await storage.restorePurchase(h.r);
    await expect(
      storage.restorePurchase({ ...h.r, [field]: 'synthetic-substitution' }),
    ).rejects.toThrow(/conflict/);
  },
);
it.each(['PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT'] as const)(
  'keeps %s expired when polling after cutoff',
  async (status) => {
    const h = setup();
    const c = await h.create();
    await c.start({ recovery: wallet, refund: fixture.refund });
    const late = new BrowserPurchaseController({
      storage: await h.storage(),
      sdk: h.sdk,
      id: 'synthetic-checkout',
      now: () => now + 4000,
    });
    await late.poll({
      oneClick: {
        poll: async (_address, options) => {
          await options?.onProgress?.({
            address: 'synthetic-deposit',
            memo: 'synthetic-memo',
            attempts: 1,
            errors: 0,
            lastStatus: { status },
          });
          return { status };
        },
      },
    });
    expect((await late.snapshot()).state).toBe('expired');
    expect(await late.instructions()).toBeNull();
  },
);
it('keeps 350 purchases in separate encrypted records with a small index and latest backups', async () => {
  const h = setup();
  await h.create();
  const storage = await h.storage();
  const initial = await storage.load('synthetic-checkout');
  if (!initial) throw new Error('missing fixture');
  for (let i = 0; i < 350; i++)
    await storage.save(null, {
      ...initial,
      id: `synthetic-${i}`,
      revision: 0,
      header: `0x${'ab'.repeat(4096)}`,
    });
  expect(await storage.list()).toHaveLength(351);
  expect((await storage.load('synthetic-349'))?.header.length).toBe(8194);
  const { encryptedBrowserIndexStore } = await import('../pay/backup.js');
  const index = await encryptedBrowserIndexStore(storage.rawStore, storage.backupSecret).load(
    'annon/browser/index',
  );
  expect(index?.entries).toHaveLength(351);
  expect(JSON.stringify(index).length).toBeLessThan(150000);
  expect(JSON.stringify(index)).not.toMatch(/header|buyerSecret|backups|ciphertext/);
  const raw = await storage.rawStore.load('annon/browser/entry/synthetic-349');
  expect(raw).not.toBeNull();
  expect(JSON.stringify(raw)).not.toContain('abababab');
}, 20000);

it('retries index contention with fresh metadata and bounds repeated CAS misses', async () => {
  const h = setup();
  const controller = await h.create();
  const storage = controller.storage;
  const raw = storage.rawStore as import('../pay/store.js').AtomicStore<
    import('../pay/backup.js').EncryptedRecord
  >;
  const compare = raw.compareAndSetMany.bind(raw);
  const cas = vi
    .spyOn(raw, 'compareAndSetMany')
    .mockResolvedValueOnce(false)
    .mockImplementation(compare);
  const before = await storage.load('synthetic-checkout');
  if (!before) throw new Error('missing fixture');
  await storage.save(before, { ...before, revision: 1 });
  expect(cas).toHaveBeenCalledTimes(2);
  cas.mockClear().mockResolvedValue(false);
  const current = await storage.load('synthetic-checkout');
  if (!current) throw new Error('missing fixture');
  await expect(storage.save(current, { ...current, revision: 2 })).rejects.toThrow(/conflict/);
  expect(cas).toHaveBeenCalledTimes(32);
  expect((await storage.load(current.id))?.revision).toBe(1);
});
it('rejects concurrent portable imports that alias the same purchase under different checkout ids', async () => {
  const h = setup();
  const c = await h.create();
  await c.start({ recovery: wallet, refund: fixture.refund });
  const secret = newBackupSecret();
  const receipt = await c.exportReceipt(secret);
  const { importBrowserIndex, exportBrowserIndex } = await import('../pay/backup.js');
  const alias = await importBrowserIndex(receipt, secret);
  const entry = alias.entries[0];
  if (!entry) throw new Error('missing receipt');
  entry.id = 'alias';
  const other = await exportBrowserIndex(alias, secret);
  const fresh = await setup().storage();
  const results = await Promise.allSettled([
    fresh.importReceipt(receipt, secret),
    fresh.importReceipt(other, secret),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(await fresh.list()).toHaveLength(1);
});

it('N10 resumes a record-free checkout with an expired lease to terms_review', async () => {
  let clock = now;
  const h = setup(() => clock);
  const c = await h.create();
  const before = await c.storage.load('synthetic-checkout');
  if (!before) throw new Error('missing fixture');
  await c.storage.save(before, {
    ...before,
    revision: 1,
    state: 'preparing',
    lease: { owner: 'old-owner', expiresAt: now + 120 },
  });
  clock += 121;
  const reload = await h.make(before.id);
  await reload.resume();
  expect((await reload.snapshot()).state).toBe('terms_review');
  expect((await reload.storage.load(before.id))?.lease).toBeUndefined();
  expect(h.sdk.buy).not.toHaveBeenCalled();
});
it.each(['near-usdc', 'base-usdc'] as const)(
  'abandons an unsigned %s preparation after its lease expires',
  async (route) => {
    let clock = now;
    const h = setup(() => clock);
    const c = await h.create();
    const before = await c.storage.load('synthetic-checkout');
    if (!before) throw new Error('missing fixture');
    await c.storage.save(before, {
      ...before,
      revision: 1,
      route,
      purchase: route === 'base-usdc' ? recordForBase() : h.r,
      state: 'preparing',
      submission: 'not_submitted',
      lease: { owner: 'old-owner', expiresAt: now + 120 },
    });
    clock += 121;
    const reload = await h.make(before.id);
    await reload.resume();
    expect((await reload.snapshot()).state).toBe('abandoned');
    expect(h.sdk.accept).not.toHaveBeenCalled();
    expect(h.sdk.buy).not.toHaveBeenCalled();
    await expect(
      reload.start({ recovery: wallet, refund: fixture.refund, submitBase: async () => {} }),
    ).rejects.toThrow(/resume|abandoned|started/);
    const fresh = await BrowserPurchaseController.create(
      { storage: c.storage, sdk: h.sdk, now: () => clock },
      {
        id: 'new-checkout',
        fileId: before.fileId,
        header: new Uint8Array([1]),
        resourceUrl: before.resourceUrl,
        route: 'oneclick',
        maxPrice: 200000n,
      },
    );
    await fresh.start({ recovery: wallet, refund: fixture.refund });
    expect(h.sdk.buy).toHaveBeenCalledTimes(1);
  },
);
it.each(['signed', 'before-payment', 'uncertain'] as const)(
  'never abandons a %s preparation after lease expiry',
  async (evidence) => {
    const h = setup();
    const c = await h.create();
    const before = await c.storage.load('synthetic-checkout');
    if (!before) throw new Error('missing fixture');
    const purchase = evidence === 'signed' ? recordForBase() : h.r;
    if (evidence === 'signed')
      purchase.attempts = [
        {
          attemptId: 'synthetic-attempt',
          preparedAt: now,
          searchFromBlock: 1,
          validBefore: String(now + 100),
          paymentRequired: {} as never,
          payload: 'synthetic-signed-payload',
        },
      ];
    await c.storage.save(before, {
      ...before,
      revision: 1,
      route: evidence === 'signed' ? 'base-usdc' : 'near-usdc',
      purchase,
      state: 'preparing',
      submission: evidence === 'uncertain' ? 'uncertain' : 'not_submitted',
      paymentStarted: evidence === 'before-payment',
      lease: { owner: 'old-owner', expiresAt: now - 1 },
    });
    await c.resume();
    expect((await c.snapshot()).state).toBe('payment_uncertain');
    expect(h.sdk.accept).toHaveBeenCalledTimes(1);
    expect(h.sdk.buy).not.toHaveBeenCalled();
  },
);
it('requires a Base submit callback before claiming the checkout or buying', async () => {
  const h = setup();
  const c = await h.create();
  const before = await c.storage.load('synthetic-checkout');
  if (!before) throw new Error('missing fixture');
  await c.storage.save(before, { ...before, revision: 1, route: 'base-usdc' });
  await expect(c.start({ recovery: wallet, refund: fixture.refund })).rejects.toThrow(/submitBase/);
  expect((await c.snapshot()).state).toBe('terms_review');
  expect(h.sdk.buy).not.toHaveBeenCalled();
});
it('renews a lease while proof is pending and releases it after completion', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    let clock = now;
    const h = setup(() => clock);
    const c = await h.create();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const buy = h.sdk.buy;
    h.sdk.buy = vi.fn(async (o) => {
      await held;
      return buy(o);
    });
    const pending = c.start({ recovery: wallet, refund: fixture.refund });
    while ((await c.snapshot()).state === 'terms_review') await Promise.resolve();
    const initial = (await c.storage.load('synthetic-checkout'))?.lease;
    expect(initial?.expiresAt).toBe(now + 120);
    expect(initial?.owner).toBeTruthy();
    for (let i = 0; i < 5; i++) {
      clock += 30;
      await vi.advanceTimersByTimeAsync(30000);
      await vi.waitFor(async () => {
        expect((await c.storage.load('synthetic-checkout'))?.lease?.expiresAt).toBe(clock + 120);
      });
    }
    const renewed = (await c.storage.load('synthetic-checkout'))?.lease;
    expect(renewed?.owner).toBe(initial?.owner);
    expect(renewed?.expiresAt).toBe(clock + 120);
    await (await h.make('synthetic-checkout')).resume();
    expect((await c.snapshot()).state).toBe('preparing');
    release();
    await pending;
    expect((await c.storage.load('synthetic-checkout'))?.lease).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
it('a stale lease owner cannot write or pay after a different tab reclaimed the checkout', async () => {
  let clock = now;
  const h = setup(() => clock);
  const c = await h.create();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const effect = vi.fn();
  h.sdk.buy = vi.fn(async (o) => {
    await held;
    await o.beforeSave?.(h.r);
    await o.beforePayment?.({ ...h.r, recoveryProved: true });
    effect();
    return { route: h.r.purchase.route, record: h.r };
  });
  const pending = c.start({ recovery: wallet, refund: fixture.refund });
  while ((await c.snapshot()).state === 'terms_review') await Promise.resolve();
  clock += 121;
  await (await h.make('synthetic-checkout')).resume();
  expect((await c.snapshot()).state).toBe('terms_review');
  release();
  await expect(pending).rejects.toThrow(/lease|conflict/);
  expect(effect).not.toHaveBeenCalled();
});
it('preserves recovery archives and carries them through a portable receipt', async () => {
  const h = setup();
  const c = await h.create();
  await c.start({ recovery: wallet, refund: fixture.refund });
  const { exportRecovery, importRecovery } = await import('../pay/backup.js');
  const r0 = {
    kind: 'recovery' as const,
    id: `recovery:${h.r.id}`,
    revision: 0,
    purchase_id: h.r.id,
    file_id: fixture.file_id,
    recovery: fixture.recovery,
    buyerSecret: h.r.buyerSecret,
    fresh_key: h.r.purchase.buyer_key,
    nonce: h.r.purchase.nonce,
    deadline: now - 1,
    grant: null,
  };
  const secret = new Uint8Array(32).fill(3);
  const r1 = {
    ...r0,
    revision: 1,
    buyerSecret: hex(secret),
    fresh_key: hex(keyFromSecret(secret).publicKeyBytes),
    deadline: now + 500,
  };
  await c.storage.writeBackup(
    `${r0.id}:revision:0`,
    await exportRecovery(r0, c.storage.backupSecret),
  );
  await c.storage.writeBackup(r1.id, await exportRecovery(r1, c.storage.backupSecret));
  await c.storage.writeBackup(r0.id, await exportRecovery(r0, c.storage.backupSecret));
  const primary = await c.storage.rawStore.load(`annon/browser/backup/${r1.id}`);
  if (!primary) throw new Error('primary backup missing');
  expect((await importRecovery(primary.backup, c.storage.backupSecret)).buyerSecret).toBe(
    r1.buyerSecret,
  );
  const raw = await c.storage.rawStore.load(`annon/browser/backup/${r0.id}:revision:0`);
  if (!raw) throw new Error('archive missing');
  expect((await importRecovery(raw.backup, c.storage.backupSecret)).buyerSecret).toBe(
    r0.buyerSecret,
  );
  const portableSecret = newBackupSecret();
  const receipt = await c.exportReceipt(portableSecret);
  const fresh = await setup().storage();
  await fresh.importReceipt(receipt, portableSecret);
  const restored = await fresh.rawStore.load(`annon/browser/backup/${r0.id}:revision:0`);
  if (!restored) throw new Error('portable archive missing');
  expect((await importRecovery(restored.backup, fresh.backupSecret)).buyerSecret).toBe(
    r0.buyerSecret,
  );
});

it('initializes only the local secret until purchase storage is requested', async () => {
  const factory = new IDBFactory();
  const open = vi.spyOn(factory, 'open');
  const storage = await browserPurchaseStorage({ factory, name: 'synthetic-lazy-storage' });
  expect(open).toHaveBeenCalledTimes(1);
  expect(await storage.list()).toEqual([]);
  expect(open).toHaveBeenCalledTimes(2);
});

it('rejects payment effects when its working lease expires before any other tab intervenes', async () => {
  let clock = now;
  const h = setup(() => clock);
  const c = await h.create();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const effect = vi.fn();
  h.sdk.buy = vi.fn(async (o) => {
    await held;
    await o.beforeSave?.(h.r);
    await o.beforePayment?.({ ...h.r, recoveryProved: true });
    effect();
    return { route: h.r.purchase.route, record: h.r };
  });
  const pending = c.start({ recovery: wallet, refund: fixture.refund });
  while ((await c.snapshot()).state === 'terms_review') await Promise.resolve();
  clock += 121;
  release();
  await expect(pending).rejects.toThrow(/lease/);
  expect(effect).not.toHaveBeenCalled();
});

it('saves the payment boundary marker before direct NEAR effects', async () => {
  const h = setup();
  const c = await h.create();
  const before = await c.storage.load('synthetic-checkout');
  if (!before) throw new Error('missing fixture');
  await c.storage.save(before, { ...before, revision: 1, route: 'near-usdc' });
  h.sdk.buy = vi.fn(async (o) => {
    const purchase = { ...h.r, recoveryProved: true };
    await o.beforeSave?.(purchase);
    await o.beforePayment?.(purchase);
    const saved = await c.storage.load('synthetic-checkout');
    expect(saved?.paymentStarted).toBe(true);
    expect(saved?.submission).toBe('uncertain');
    return { route: h.r.purchase.route, record: purchase };
  });
  await c.start({ recovery: wallet, refund: fixture.refund });
});

it.each(['recover', 'open', 'poll'] as const)(
  '%s respects another tab lease and exposes its expiry',
  async (operation) => {
    const h = setup();
    const c = await h.create();
    const before = await c.storage.load('synthetic-checkout');
    if (!before) throw new Error('missing fixture');
    const held = {
      ...before,
      revision: 1,
      purchase: h.r,
      state: 'accepted' as const,
      lease: { owner: 'another-tab', expiresAt: now + 120 },
    };
    await c.storage.save(before, held);
    const events: unknown[] = [];
    c.subscribe((event) => events.push(event));
    const poll = vi.fn();
    const action =
      operation === 'recover'
        ? c.recover(wallet)
        : operation === 'open'
          ? c.open(new Uint8Array([1]))
          : c.poll({ oneClick: { poll } });
    await expect(action).rejects.toMatchObject({ code: 'lease_busy', waitUntil: now + 120 });
    expect((await c.snapshot()).leaseWaitUntil).toBe(now + 120);
    expect(events).toContainEqual(expect.objectContaining({ leaseWaitUntil: now + 120 }));
    expect(await c.storage.load(before.id)).toEqual(held);
    expect(h.sdk.recover).not.toHaveBeenCalled();
    expect(h.sdk.open).not.toHaveBeenCalled();
    expect(poll).not.toHaveBeenCalled();
  },
);
it('resume exposes the wait after a crash without rewriting the live lease', async () => {
  const h = setup();
  const c = await h.create();
  const before = await c.storage.load('synthetic-checkout');
  if (!before) throw new Error('missing fixture');
  await c.storage.save(before, {
    ...before,
    revision: 1,
    state: 'preparing',
    lease: { owner: 'crashed-tab', expiresAt: now + 120 },
  });
  const events: unknown[] = [];
  c.subscribe((event) => events.push(event));
  await c.resume();
  expect(events).toContainEqual(expect.objectContaining({ leaseWaitUntil: now + 120 }));
  expect((await c.snapshot()).revision).toBe(1);
});
it('requires recoveryProved at the controller payment boundary even for the saved identity', async () => {
  const h = setup();
  const c = await h.create();
  const effect = vi.fn();
  h.sdk.buy = vi.fn(async (o) => {
    await o.beforeSave?.(h.r);
    await o.beforePayment?.(h.r);
    effect();
    return { route: h.r.purchase.route, record: h.r };
  });
  await expect(c.start({ recovery: wallet, refund: fixture.refund })).rejects.toThrow(/proof/);
  expect(effect).not.toHaveBeenCalled();
});
it.each(['message', 'buyerSecret'] as const)(
  'restorePurchase refuses a mismatched %s',
  async (field) => {
    const h = setup();
    const storage = await h.storage();
    await storage.restorePurchase(h.r);
    await expect(
      storage.restorePurchase({
        ...h.r,
        [field]: field === 'message' ? 'wrong' : `0x${'03'.repeat(32)}`,
      }),
    ).rejects.toThrow(/conflict/);
  },
);
it('poll keeps an expired checkout expired even when its deposit cutoff is in the future', async () => {
  const h = setup();
  const c = await h.create();
  await c.start({ recovery: wallet, refund: fixture.refund });
  const before = await c.storage.load('synthetic-checkout');
  if (!before) throw new Error('missing fixture');
  await c.storage.save(before, { ...before, revision: before.revision + 1, state: 'expired' });
  await c.poll({
    oneClick: {
      poll: vi.fn(async (_address, options) => {
        await options?.onProgress?.({
          attempts: 1,
          errors: 0,
          lastStatus: { status: 'PENDING_DEPOSIT' },
        } as PollCheckpoint);
        return { status: 'PENDING_DEPOSIT' } as SwapStatus;
      }),
    },
  });
  expect((await c.snapshot()).state).toBe('expired');
});
it.each([true, false])(
  'Base submission uncertain=%s has an explicit durable label',
  async (uncertain) => {
    const h = setup();
    const c = await h.create();
    const before = await c.storage.load('synthetic-checkout');
    if (!before) throw new Error('missing fixture');
    await c.storage.save(before, { ...before, revision: 1, route: 'base-usdc' });
    h.sdk.buy = vi.fn(async (o) => {
      const purchase = { ...recordForBase(), recoveryProved: true };
      await o.beforeSave?.(purchase);
      await o.beforePayment?.(purchase);
      return {
        route: 'base-usdc' as const,
        record: purchase,
        ...(uncertain ? { uncertain: { purchaseId: purchase.id, txHash: 'synthetic-hash' } } : {}),
      };
    });
    await c.start({ recovery: wallet, refund: fixture.refund, submitBase: vi.fn() });
    expect((await c.storage.load(before.id))?.submission).toBe(
      uncertain ? 'uncertain' : 'submitted',
    );
  },
);

it('open downloads from the saved URL, retries after abort, and persists only workflow state', async () => {
  const { seal, open, sha256 } = await import('../envelope/pay2.js');
  const { bls12_381: bls } = await import('@noble/curves/bls12-381.js');
  const { bytes } = await import('../settle-near/codec.js');
  const ckdSecret = bls.G1.Point.BASE.multiply(5n).toBytes(true);
  const data = new TextEncoder().encode('synthetic download plaintext');
  const h = setup();
  const seller = { kind: 'near' as const, id: 'seller.synthetic.near' };
  const sealed = await seal(data, {
    fileId: bytes(fixture.file_id, 32),
    name: 'synthetic.txt',
    mime: 'text/plain',
    authKind: 2,
  });
  const wire = await sealed.finish({ contractId: fixture.contract, ckdSecret, seller });
  const header = wire.slice(0, new DataView(wire.buffer).getUint32(8));
  const listing = {
    fileId: fixture.file_id,
    cipherHash: hex(sealed.cipherHash),
    seller,
    publishedHeaderHash: hex(await sha256(header.subarray(0, -65))),
  };
  const c = await h.create();
  const before = await c.storage.load('synthetic-checkout');
  if (!before) throw new Error('missing fixture');
  const purchase = {
    ...h.r,
    checkedHeaderHash: hex(await sha256(header)),
    terms: {
      ...h.r.terms,
      seller,
      cipherHash: listing.cipherHash,
      headerHash: hex(await sha256(header)),
    },
  };
  await c.storage.save(before, {
    ...before,
    revision: 1,
    state: 'accepted',
    header: hex(header),
    purchase,
  });
  h.sdk.open = vi.fn(async (o) =>
    open(o.file, { listing, contractId: fixture.contract, ckdSecret: async () => ckdSecret }),
  );
  const abort = new AbortController();
  const pending = c.open({
    signal: abort.signal,
    fetch: vi.fn(async () => {
      abort.abort();
      return new Response(wire);
    }),
  });
  await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  expect((await c.snapshot()).state).toBe('accepted');
  expect(h.sdk.open).not.toHaveBeenCalled();
  const progress: unknown[] = [];
  const result = await c.open({
    fetch: vi.fn(async (url) => {
      expect(url).toBe(before.resourceUrl);
      return new Response(wire);
    }),
    onProgress: (event) => progress.push(event),
  });
  expect(result.data).toEqual(data);
  expect(result.meta).toMatchObject({ name: 'synthetic.txt', mime: 'text/plain' });
  expect(progress).toContainEqual(expect.objectContaining({ phase: 'decrypting' }));
  expect(progress).toContainEqual(expect.objectContaining({ phase: 'ready' }));
  expect((await c.snapshot()).state).toBe('file_ready');
  const stored = JSON.stringify(await c.storage.load(before.id));
  expect(stored).not.toContain('synthetic download plaintext');
  expect(stored).not.toContain(hex(ckdSecret));
  expect(stored).not.toContain('"data"');
  expect(h.sdk.buy).not.toHaveBeenCalled();
});

it.each(['recover', 'open', 'poll'] as const)(
  'an active %s holds its lease through completion and releases it after failure',
  async (operation) => {
    const h = setup();
    const c = await h.create();
    await c.start({ recovery: wallet, refund: fixture.refund });
    if (operation !== 'poll') {
      const before = await c.storage.load('synthetic-checkout');
      if (!before) throw new Error('missing fixture');
      await c.storage.save(before, { ...before, revision: before.revision + 1, state: 'accepted' });
    }
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const failure = async () => {
      started();
      await held;
      throw new Error('synthetic retryable failure');
    };
    h.sdk.open = vi.fn(failure);
    h.sdk.recover = vi.fn(failure);
    const other = await h.make('synthetic-checkout');
    const pending =
      operation === 'recover'
        ? c.recover(wallet)
        : operation === 'open'
          ? c.open(new Uint8Array([1]))
          : c.poll({ oneClick: { poll: vi.fn(failure) } });
    const rejected = expect(pending).rejects.toThrow('synthetic retryable failure');
    await entered;
    const before = await c.storage.load('synthetic-checkout');
    await expect(other.recover(wallet)).rejects.toMatchObject({ code: 'lease_busy' });
    await other.resume();
    expect(await c.storage.load('synthetic-checkout')).toEqual(before);
    release();
    await rejected;
    expect((await c.storage.load('synthetic-checkout'))?.lease).toBeUndefined();
    if (operation === 'open') {
      h.sdk.open = vi.fn(async () => ({
        data: new Uint8Array([1]),
        meta: { name: 'f', mime: '', size: 1 },
      }));
      await c.open(new Uint8Array([1]));
      expect((await c.snapshot()).state).toBe('file_ready');
    }
    expect(h.sdk.buy).toHaveBeenCalledTimes(1);
  },
);
it('a long open renews its lease and keeps its final write compatible with heartbeats', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  try {
    let clock = now;
    const h = setup(() => clock);
    const c = await h.create();
    const before = await c.storage.load('synthetic-checkout');
    if (!before) throw new Error('missing fixture');
    await c.storage.save(before, { ...before, revision: 1, purchase: h.r, state: 'accepted' });
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.sdk.open = vi.fn(async () => {
      entered();
      await held;
      return { data: new Uint8Array([1]), meta: { name: 'f', mime: '', size: 1 } };
    });
    const pending = c.open(new Uint8Array([1]));
    await started;
    clock += 60;
    await vi.advanceTimersByTimeAsync(30000);
    await vi.waitFor(async () =>
      expect((await c.storage.load(before.id))?.lease?.expiresAt).toBe(clock + 120),
    );
    release();
    await pending;
    expect((await c.snapshot()).state).toBe('file_ready');
    expect((await c.storage.load(before.id))?.lease).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('resuming a submitted Base payload preserves its submission label while acquiring a lease', async () => {
  const h = setup();
  const c = await h.create();
  const before = await c.storage.load('synthetic-checkout');
  if (!before) throw new Error('missing fixture');
  const purchase = recordForBase();
  purchase.attempts = [
    {
      attemptId: 'synthetic-attempt',
      preparedAt: now,
      searchFromBlock: 1,
      validBefore: String(now + 100),
      paymentRequired: {} as never,
      payload: 'synthetic-signed-payload',
    },
  ];
  await c.storage.save(before, {
    ...before,
    revision: 1,
    route: 'base-usdc',
    purchase,
    state: 'payment_uncertain',
    submission: 'submitted',
  });
  await c.resume();
  expect((await c.storage.load(before.id))?.submission).toBe('submitted');
  expect((await c.snapshot()).state).toBe('accepting');
});

it('an open whose lease expires cannot publish a final state and remains retryable', async () => {
  let clock = now;
  const h = setup(() => clock);
  const c = await h.create();
  const before = await c.storage.load('synthetic-checkout');
  if (!before) throw new Error('missing fixture');
  await c.storage.save(before, { ...before, revision: 1, purchase: h.r, state: 'accepted' });
  h.sdk.open = vi.fn(async () => {
    clock += 121;
    return { data: new Uint8Array([1]), meta: { name: 'f', mime: '', size: 1 } };
  });
  await expect(c.open(new Uint8Array([1]))).rejects.toThrow(/lease expired/);
  expect((await c.snapshot()).state).toBe('accepted');
  h.sdk.open = vi.fn(async () => ({
    data: new Uint8Array([1]),
    meta: { name: 'f', mime: '', size: 1 },
  }));
  await c.open(new Uint8Array([1]));
  expect((await c.snapshot()).state).toBe('file_ready');
  expect(h.sdk.buy).not.toHaveBeenCalled();
});
