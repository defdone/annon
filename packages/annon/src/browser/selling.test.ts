import { expect, it, vi } from 'vitest';
import { must, terms } from '../../test/fixtures.js';
import * as rpc from '../near/rpc.js';
import { type EncryptedRecord, newBackupSecret } from '../pay/backup.js';
import { memoryStore } from '../pay/store.js';
import { type BrowserSaleIndex, createBrowserSeller } from './selling.js';

function harness() {
  vi.spyOn(rpc, 'getConfig').mockResolvedValue({
    network: terms.network,
    nearUsdc: terms.near.token,
    usdc: must(terms.base).usdc,
  } as never);
  const rawStore = memoryStore<EncryptedRecord>();
  const indexStore = memoryStore<BrowserSaleIndex>();
  const wallet = {
    identity: { kind: 'near' as const, id: 'seller.synthetic.near' },
    authorize: vi.fn(async () => undefined),
    call: vi.fn(),
    transferPurchase: vi.fn(),
  };
  const connection = { id: 'near', kind: 'near' as const, label: 'Seller' };
  const options = {
    network: terms.network,
    contractId: terms.contract,
    nearRpc: 'https://near.example',
    baseRpc: 'https://base.example',
    rawStore,
    backupSecret: newBackupSecret(),
    writeBackup: vi.fn(async (_id: string, _text: string) => {}),
    indexStore,
    host: 'https://host.example',
    wallet: () => ({ wallet }),
    now: () => 1800000000,
  };
  const draft = {
    file: Object.assign(new Blob(['file']), { name: 'file.txt' }),
    title: 'File',
    description: '',
    priceUsdc: '0.10',
    listingStorageNear: '0.01',
    storageBudgetNear: '0.05',
  };
  return { seller: createBrowserSeller(options), options, wallet, connection, draft };
}
it('matches the facade quote/begin/backup contract without signing outside next', async () => {
  const h = harness();
  const quote = await h.seller.quote(h.connection, h.draft);
  expect(quote.routes).toEqual(['near', '1click']);
  expect(quote.funding).toEqual({ listingStorageNear: '0.01', purchaseStorageNear: '0.05' });
  const handle = await h.seller.begin(quote.quoteId);
  await expect(handle.next()).rejects.toMatchObject({ code: 'backup_secret_required' });
  const backup = await handle.exportBackup();
  expect(backup.secret).toMatch(/^[0-9a-f]{64}$/);
  expect(backup.text).not.toContain('fileKey');
  await handle.confirmBackup();
  expect((await handle.view()).next).toBe('stage');
  await handle.confirmBackup();
  expect((await handle.view()).done).toEqual(['backup']);
  expect(h.wallet.authorize).not.toHaveBeenCalled();
  expect(h.wallet.call).not.toHaveBeenCalled();
});
it('reload needs the separate secret, file and canonical wallet, and rejects replacements', async () => {
  const h = harness();
  const q = await h.seller.quote(h.connection, h.draft);
  const original = await h.seller.begin(q.quoteId);
  const backup = await original.exportBackup();
  await original.confirmBackup();
  const resumed = must(await createBrowserSeller(h.options).active());
  expect((await resumed.view()).needs.sort()).toEqual(['file', 'secret', 'wallet']);
  await expect(resumed.unlock('11'.repeat(32))).rejects.toMatchObject({ code: 'invalid_record' });
  await resumed.unlock(backup.secret);
  await expect(
    resumed.attachFile(Object.assign(new Blob(['else']), { name: 'file.txt' })),
  ).rejects.toMatchObject({ code: 'source_changed' });
  await resumed.attachFile(h.draft.file);
  h.wallet.identity = { kind: 'near', id: 'other.synthetic.near' };
  await expect(resumed.attachWallet(h.connection)).rejects.toMatchObject({
    code: 'wrong_identity',
  });
  expect(h.wallet.call).not.toHaveBeenCalled();
});
it('one active sale is enforced across controller instances by CAS', async () => {
  const h = harness();
  const other = createBrowserSeller(h.options);
  const a = await h.seller.quote(h.connection, h.draft),
    b = await other.quote(h.connection, h.draft);
  const result = await Promise.allSettled([h.seller.begin(a.quoteId), other.begin(b.quoteId)]);
  expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(result.filter((r) => r.status === 'rejected')).toHaveLength(1);
});
it('rejects malformed index data with a public error', async () => {
  const h = harness();
  vi.spyOn(h.options.indexStore, 'load').mockResolvedValue({
    id: 'browser-sale',
    revision: 0,
  } as never);
  await expect(h.seller.active()).rejects.toMatchObject({ code: 'invalid_record' });
});

it.each(['near', 'solana'] as const)(
  '%s approved terms cannot be edited before export or display',
  async (kind) => {
    const h = harness();
    h.wallet.identity = {
      kind,
      id: kind === 'near' ? 'seller.synthetic.near' : '08'.repeat(32),
    } as never;
    const connection = { ...h.connection, kind };
    const q = await h.seller.quote(connection, h.draft);
    const handle = await h.seller.begin(q.quoteId);
    const { encryptedSellStore } = await import('../pay/backup.js');
    const { termsHash } = await import('../settle-near/terms.js');
    const store = encryptedSellStore(h.options.rawStore, h.options.backupSecret);
    const job = must(await store.load(`annon/sell/${handle.id}`));
    const changed = structuredClone(job);
    changed.revision++;
    changed.terms.near.price = '900000';
    must(changed.hosting).intent.termsHash = termsHash(changed.terms);
    await store.compareAndSet(`annon/sell/${handle.id}`, job, changed);
    await expect(handle.view()).rejects.toMatchObject({ code: 'invalid_record' });
    await expect(handle.exportBackup()).rejects.toMatchObject({ code: 'invalid_record' });
    expect(h.wallet.authorize).not.toHaveBeenCalled();
  },
);
it('keeps seller storage and encrypted pending backups across IndexedDB reopen', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  const { browserSellerStorage } = await import('./selling.js');
  const factory = new IDBFactory();
  const first = await browserSellerStorage({ factory, name: 'synthetic-selling' });
  const h = harness();
  const seller = createBrowserSeller({ ...h.options, ...first });
  const q = await seller.quote(h.connection, h.draft);
  const handle = await seller.begin(q.quoteId);
  const backup = await handle.exportBackup();
  await handle.confirmBackup();
  const second = await browserSellerStorage({ factory, name: 'synthetic-selling' });
  const resumed = must(await createBrowserSeller({ ...h.options, ...second }).active());
  expect((await resumed.view()).needs).toContain('secret');
  await resumed.unlock(backup.secret);
  expect((await resumed.view()).next).toBe('stage');
});
it('returned quote changes do not replace the privately approved funding or price', async () => {
  const h = harness();
  const q = await h.seller.quote(h.connection, h.draft);
  q.priceUsdc = '9.00';
  must(q.funding).listingStorageNear = '9';
  q.routes.push('base');
  const handle = await h.seller.begin(q.quoteId);
  expect(await handle.view()).toMatchObject({
    priceUsdc: '0.1',
    funding: { listingStorageNear: '0.01' },
    routes: ['near', '1click'],
  });
});

it('a second sequential begin cannot replace an unfinished sale', async () => {
  const h = harness();
  const q = await h.seller.quote(h.connection, h.draft);
  await h.seller.begin(q.quoteId);
  const next = await h.seller.quote(h.connection, h.draft);
  await expect(h.seller.begin(next.quoteId)).rejects.toMatchObject({ code: 'sell_incomplete' });
});
it('a resumed sale cannot approve with only the locally stored encryption key', async () => {
  const h = harness();
  const q = await h.seller.quote(h.connection, h.draft),
    initial = await h.seller.begin(q.quoteId);
  await initial.exportBackup();
  await initial.confirmBackup();
  const resumed = must(await createBrowserSeller(h.options).active());
  await resumed.attachWallet(h.connection);
  await resumed.attachFile(h.draft.file);
  await expect(resumed.next()).rejects.toMatchObject({ code: 'backup_secret_required' });
  expect(h.wallet.call).not.toHaveBeenCalled();
});

it.each(['fileKey', 'sellerSecret'] as const)(
  'the approved %s cannot be replaced before backup export',
  async (field) => {
    const h = harness(),
      q = await h.seller.quote(h.connection, h.draft),
      handle = await h.seller.begin(q.quoteId);
    const { encryptedSellStore } = await import('../pay/backup.js');
    const store = encryptedSellStore(h.options.rawStore, h.options.backupSecret),
      job = must(await store.load(`annon/sell/${handle.id}`));
    await store.compareAndSet(`annon/sell/${handle.id}`, job, {
      ...job,
      revision: job.revision + 1,
      [field]: `0x${'01'.repeat(32)}`,
    });
    await expect(handle.view()).rejects.toMatchObject({ code: 'invalid_record' });
    await expect(handle.exportBackup()).rejects.toMatchObject({ code: 'invalid_record' });
  },
);
it.each(['fileKey', 'sellerSecret', 'nonce'] as const)(
  'the portable backup binds %s on resume',
  async (field) => {
    const h = harness(),
      q = await h.seller.quote(h.connection, h.draft),
      handle = await h.seller.begin(q.quoteId);
    const backup = await handle.exportBackup();
    const { encryptedSellStore } = await import('../pay/backup.js');
    const store = encryptedSellStore(h.options.rawStore, h.options.backupSecret),
      job = must(await store.load(`annon/sell/${handle.id}`));
    const changed = structuredClone(job);
    changed.revision++;
    if (field === 'nonce') must(changed.hosting).intent.nonce = `0x${'02'.repeat(32)}`;
    else changed[field] = `0x${'01'.repeat(32)}`;
    await store.compareAndSet(`annon/sell/${handle.id}`, job, changed);
    const resumed = must(await createBrowserSeller(h.options).active());
    await expect(resumed.unlock(backup.secret)).rejects.toMatchObject({ code: 'invalid_record' });
  },
);

it.each(['near', 'solana'] as const)(
  '%s display rejects a record swap while authenticating the prior revision',
  async (kind) => {
    const h = harness();
    h.wallet.identity = {
      kind,
      id: kind === 'near' ? 'seller.synthetic.near' : '08'.repeat(32),
    } as never;
    const q = await h.seller.quote({ ...h.connection, kind }, h.draft),
      handle = await h.seller.begin(q.quoteId);
    await handle.exportBackup();
    await handle.confirmBackup();
    const original = crypto.subtle.decrypt.bind(crypto.subtle);
    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      paused = new Promise<void>((resolve) => {
        release = resolve;
      });
    const decrypt = vi.spyOn(crypto.subtle, 'decrypt').mockImplementationOnce(async (...args) => {
      const value = await original(...args);
      entered();
      await paused;
      return value;
    });
    const reading = handle.view();
    void reading.catch(() => {});
    try {
      await inside;
      const { encryptedSellStore } = await import('../pay/backup.js');
      const { metadataHash } = await import('../download/upload.js');
      const store = encryptedSellStore(h.options.rawStore, h.options.backupSecret),
        job = must(await store.load(`annon/sell/${handle.id}`));
      const changed = structuredClone(job);
      changed.revision++;
      must(changed.hosting).metadata.title = 'Changed';
      must(changed.hosting).intent.metadataHash = await metadataHash(
        must(changed.hosting).metadata,
      );
      await store.compareAndSet(`annon/sell/${handle.id}`, job, changed);
      release();
      await expect(reading).rejects.toMatchObject({ code: 'store_conflict' });
      expect(h.wallet.authorize).not.toHaveBeenCalled();
      expect(h.wallet.call).not.toHaveBeenCalled();
    } finally {
      release();
      decrypt.mockRestore();
    }
  },
);

it('S1 rechecks the unlocked backup seal before every next', async () => {
  const h = harness(),
    q = await h.seller.quote(h.connection, h.draft),
    sale = await h.seller.begin(q.quoteId);
  const backup = await sale.exportBackup();
  await sale.confirmBackup();
  const resumed = must(await createBrowserSeller(h.options).active());
  await resumed.unlock(backup.secret);
  await resumed.attachFile(h.draft.file);
  await resumed.attachWallet(h.connection);
  const { encryptedSellStore } = await import('../pay/backup.js');
  const { termsHash } = await import('../settle-near/terms.js');
  const store = encryptedSellStore(h.options.rawStore, h.options.backupSecret),
    saved = must(await store.load(`annon/sell/${sale.id}`));
  const changed = structuredClone(saved);
  changed.revision++;
  changed.terms.near.price = '900000';
  must(changed.hosting).intent.termsHash = termsHash(changed.terms);
  await store.compareAndSet(`annon/sell/${sale.id}`, saved, changed);
  await expect(resumed.next()).rejects.toMatchObject({ code: 'invalid_record' });
  expect(h.wallet.authorize).not.toHaveBeenCalled();
  expect(h.wallet.call).not.toHaveBeenCalled();
});
it('S6 fences a revision changed between browser read and engine next', async () => {
  const h = harness(),
    q = await h.seller.quote(h.connection, h.draft),
    sale = await h.seller.begin(q.quoteId);
  await sale.exportBackup();
  await sale.confirmBackup();
  const { HostedSelling } = await import('../api/sharing.js');
  const { encryptedSellStore } = await import('../pay/backup.js');
  const store = encryptedSellStore(h.options.rawStore, h.options.backupSecret);
  const original = HostedSelling.prototype.next;
  const next = vi.spyOn(HostedSelling.prototype, 'next').mockImplementationOnce(async function (
    this: import('../api/sharing.js').HostedSelling,
    id,
    input,
  ) {
    const saved = must(await store.load(`annon/sell/${id}`));
    await store.compareAndSet(`annon/sell/${id}`, saved, {
      ...saved,
      revision: saved.revision + 1,
    });
    return original.call(this, id, input);
  });
  try {
    await expect(sale.next()).rejects.toMatchObject({ code: 'store_conflict' });
  } finally {
    next.mockRestore();
  }
  expect(h.wallet.authorize).not.toHaveBeenCalled();
  expect(h.wallet.call).not.toHaveBeenCalled();
});
it('a failed begin leaves the index clear and a later sale can start', async () => {
  const h = harness(),
    q = await h.seller.quote(h.connection, h.draft);
  h.options.writeBackup.mockRejectedValueOnce(new Error('backup unavailable'));
  await expect(h.seller.begin(q.quoteId)).rejects.toThrow('backup unavailable');
  expect(await h.seller.active()).toBeNull();
  const retry = await h.seller.quote(h.connection, h.draft);
  expect((await h.seller.begin(retry.quoteId)).id).toMatch(/^0x/);
});
it('an index conflict discards the new sale record', async () => {
  const h = harness(),
    q = await h.seller.quote(h.connection, h.draft);
  vi.spyOn(h.options.indexStore, 'compareAndSet').mockResolvedValueOnce(false);
  await expect(h.seller.begin(q.quoteId)).rejects.toMatchObject({ code: 'sell_incomplete' });
  const { encryptedSellStore } = await import('../pay/backup.js');
  expect(
    await encryptedSellStore(h.options.rawStore, h.options.backupSecret).load(
      `annon/sell/${String(must(h.options.writeBackup.mock.calls[0])[0]).slice(5)}`,
    ),
  ).toBeNull();
  expect(h.options.writeBackup).toHaveBeenCalledTimes(1);
});
it.each(['begin', 'discard'] as const)(
  'clears an index pointing to a missing record during %s',
  async (action) => {
    const h = harness(),
      q = await h.seller.quote(h.connection, h.draft),
      sale = await h.seller.begin(q.quoteId);
    const key = `annon/sell/${sale.id}`,
      saved = must(await h.options.rawStore.load(key));
    await h.options.rawStore.compareAndSet(key, saved, null);
    if (action === 'discard') {
      await sale.discard();
      expect(await h.seller.active()).toBeNull();
    } else {
      const retry = await h.seller.quote(h.connection, h.draft);
      expect((await h.seller.begin(retry.quoteId)).id).not.toBe(sale.id);
    }
  },
);
it('needs requests a secret only after backup confirmation', async () => {
  const h = harness(),
    q = await h.seller.quote(h.connection, h.draft),
    sale = await h.seller.begin(q.quoteId);
  expect((await sale.view()).needs).toEqual([]);
  const reload = must(await createBrowserSeller(h.options).active());
  expect((await reload.view()).needs).toEqual(['wallet', 'file']);
  await sale.exportBackup();
  await sale.confirmBackup();
  expect((await reload.view()).needs).toEqual(['wallet', 'file', 'secret']);
});
it('discard can forget a pending sale and allows another begin', async () => {
  const h = harness(),
    q = await h.seller.quote(h.connection, h.draft),
    sale = await h.seller.begin(q.quoteId);
  const { encryptedSellStore } = await import('../pay/backup.js');
  const store = encryptedSellStore(h.options.rawStore, h.options.backupSecret),
    key = `annon/sell/${sale.id}`,
    saved = must(await store.load(key));
  await store.compareAndSet(key, saved, {
    ...saved,
    revision: saved.revision + 1,
    hosting: { ...must(saved.hosting), pending: { step: 'stage', token: 'synthetic' } },
  });
  await sale.discard();
  expect(await h.seller.active()).toBeNull();
  const next = await h.seller.quote(h.connection, h.draft);
  await h.seller.begin(next.quoteId);
});

it.each(['ciphertext', 'seal'] as const)(
  'discards an unreadable %s record by clearing only its index',
  async (kind) => {
    const h = harness(),
      q = await h.seller.quote(h.connection, h.draft),
      sale = await h.seller.begin(q.quoteId);
    await sale.exportBackup();
    const key = `annon/sell/${sale.id}`;
    const raw = must(await h.options.rawStore.load(key));
    if (kind === 'ciphertext') {
      await h.options.rawStore.compareAndSet(key, raw, {
        ...raw,
        revision: raw.revision + 1,
        ciphertext: 'invalid',
      } as never);
    } else {
      const { encryptedSellStore } = await import('../pay/backup.js');
      const store = encryptedSellStore(h.options.rawStore, h.options.backupSecret),
        saved = must(await store.load(key));
      await store.compareAndSet(key, saved, {
        ...saved,
        revision: saved.revision + 1,
        fileKey: `0x${'11'.repeat(32)}`,
      });
    }
    const evidence = await h.options.rawStore.load(key);
    await expect(sale.view()).rejects.toMatchObject({ code: 'invalid_record' });
    await sale.discard();
    expect(await h.seller.active()).toBeNull();
    expect(await h.options.rawStore.load(key)).toEqual(evidence);
    const next = await h.seller.quote(h.connection, h.draft);
    await h.seller.begin(next.quoteId);
    expect(h.wallet.call).not.toHaveBeenCalled();
  },
);
it('passes the redirect wallet hash with the approved revision to the engine', async () => {
  const h = harness(),
    q = await h.seller.quote(h.connection, h.draft),
    sale = await h.seller.begin(q.quoteId);
  await sale.exportBackup();
  await sale.confirmBackup();
  const { HostedSelling } = await import('../api/sharing.js');
  const next = vi
    .spyOn(HostedSelling.prototype, 'next')
    .mockRejectedValueOnce(new Error('synthetic stop'));
  await expect(sale.next({ txHash: 'synthetic-redirect' })).rejects.toThrow('synthetic stop');
  expect(next).toHaveBeenCalledWith(
    sale.id,
    expect.objectContaining({ txHash: 'synthetic-redirect', expectedRevision: expect.any(Number) }),
  );
});
it('discard preserves the browser index when another tab holds the engine lease', async () => {
  const h = harness(),
    q = await h.seller.quote(h.connection, h.draft),
    sale = await h.seller.begin(q.quoteId);
  const { encryptedSellStore } = await import('../pay/backup.js');
  const store = encryptedSellStore(h.options.rawStore, h.options.backupSecret),
    key = `annon/sell/${sale.id}`,
    saved = must(await store.load(key));
  await store.compareAndSet(key, saved, {
    ...saved,
    revision: saved.revision + 1,
    hosting: {
      ...must(saved.hosting),
      lease: { owner: 'other-tab', until: h.options.now() + 120 },
    },
  });
  await expect(sale.discard()).rejects.toMatchObject({ code: 'lease_busy' });
  expect((await h.seller.active())?.id).toBe(sale.id);
  expect(await store.load(key)).not.toBeNull();
});
