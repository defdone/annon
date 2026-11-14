import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { backupSecretHex, workspace } from '../../test/commands.js';
import { terms } from '../../test/fixtures.js';
import { Annon } from '../api/annon.js';
import type { ShareOptions } from '../api/sharing-types.js';
import { createAdapter } from './adapter.js';
import { publicError } from './errors.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const profile = {
  network: 'near:mainnet' as const,
  contract: 'contract.synthetic.near',
  nearRpc: 'https://near.example',
  baseRpc: 'https://base.example',
  relayer: 'https://relay.example',
  host: 'https://host.example',
};
const manifest = {
  version: 1,
  name: 'Shop',
  shopUrl: 'https://shop.example/demo',
  network: profile.network,
  contract: profile.contract,
  relayer: profile.relayer,
  host: profile.host,
  catalog: {
    url: 'https://host.example/files.json',
    format: 'annon-catalog-array-v1',
    search: 'client',
  },
};
const shopConfig = {
  ...profile,
  contractId: profile.contract,
  defaultShop: 'mine',
  shops: [{ id: 'mine', manifest: 'https://shop.example/.well-known/annon-shop.json', profile }],
};
const near = 10n ** 24n;

it.each([
  ['the defaults', {}, {}, near / 100n, (near * 5n) / 100n],
  [
    'configured amounts',
    { listingStorage: '0.02', storageBudget: '0.03' },
    {},
    near / 50n,
    (near * 3n) / 100n,
  ],
  [
    'flags over configured amounts',
    { listingStorage: '0.02', storageBudget: '0.03' },
    { listingStorage: '0.04', storageBudget: '0.06' },
    near / 25n,
    (near * 6n) / 100n,
  ],
] as const)(
  'a human NEAR share approves its terms with %s',
  async (_name, config, flags, listingStorage, storageBudget) => {
    const ws = await workspace('share-near', { ...shopConfig, ...config });
    const file = join(ws.dir, 'notes.txt');
    await writeFile(file, 'notes');
    const seller = {
      identity: { kind: 'near' as const, id: 'seller.synthetic.near' },
      authorize: vi.fn(),
    };
    const paymentTerms = vi.fn();
    const prompt = vi.fn(async () => true);
    const share = vi.fn(async (o: ShareOptions) => {
      await o.onSplit?.(terms.near, undefined, false);
      return { fileId: terms.file_id, url: 'https://host.example/f' };
    });
    try {
      const run = createAdapter(
        { ANNON_CONFIG: ws.config, ANNON_BACKUP_SECRET: backupSecretHex },
        {
          fetch: async () => Response.json(manifest),
          prompt,
          paymentTerms,
          wallet: async () => seller,
          sdk: (options) => {
            const sdk = new Annon(options);
            vi.spyOn(sdk, 'share').mockImplementation(share as never);
            return sdk;
          },
        },
      );
      expect(await run({ command: 'share', target: file, price: '0.1', ...flags })).toEqual({
        fileId: terms.file_id,
        url: 'https://host.example/f',
      });
      expect(share).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'notes.txt',
          mime: 'application/octet-stream',
          seller,
          price: '100000',
          listingStorage,
          storageBudget,
          hosting: expect.objectContaining({ origin: profile.host }),
        }),
      );
      const approved = {
        seller: seller.identity,
        host: profile.host,
        contract: profile.contract,
        price: terms.near.price,
        split: terms.near,
        fee: null,
        listingStorage: listingStorage.toString(),
        purchaseStorage: storageBudget.toString(),
        registerDeposit: '0',
      };
      expect(paymentTerms).toHaveBeenCalledWith(approved);
      expect(prompt).toHaveBeenCalledWith(`${JSON.stringify(approved)}\nType yes to share: `);
    } finally {
      await ws.remove();
    }
  },
);

it('a declined NEAR share stops with sale_not_approved', async () => {
  const ws = await workspace('share-declined', shopConfig);
  const file = join(ws.dir, 'notes.txt');
  await writeFile(file, 'notes');
  const after = vi.fn();
  try {
    const run = createAdapter(
      { ANNON_CONFIG: ws.config, ANNON_BACKUP_SECRET: backupSecretHex },
      {
        fetch: async () => Response.json(manifest),
        prompt: async () => false,
        wallet: async () => ({
          identity: { kind: 'near', id: 'seller.synthetic.near' },
          authorize: vi.fn(),
        }),
        sdk: (options) => {
          const sdk = new Annon(options);
          vi.spyOn(sdk, 'share').mockImplementation((async (o: ShareOptions) => {
            await o.onSplit?.(terms.near, undefined, false);
            after();
          }) as never);
          return sdk;
        },
      },
    );
    const error = await run({ command: 'share', target: file, price: '0.1' }).catch((e) => e);
    expect(publicError(error)).toMatchObject({ code: 'sale_not_approved', exitCode: 3 });
    expect(after).not.toHaveBeenCalled();
  } finally {
    await ws.remove();
  }
});

it('a Base listing sends its split creation through the seller wallet on the configured Base RPC', async () => {
  const ws = await workspace('sell-base', { baseRpc: 'https://base.test' });
  const target = join(ws.dir, 'input.txt');
  await writeFile(target, 'input');
  const sendBase = vi.fn(async () => {});
  const seller = { identity: terms.seller, authorize: vi.fn(), sendBase };
  const call = { to: `0x${'99'.repeat(20)}`, data: '0x1234' };
  const baseSplit = {
    address: `0x${'98'.repeat(20)}`,
    kind: 'push' as const,
    salt: `0x${'97'.repeat(32)}`,
  };
  const sell = vi.fn(
    async (o: { base?: { price: string; sendTransaction: (c: typeof call) => Promise<void> } }) => {
      expect(o.base?.price).toBe('200000');
      await o.base?.sendTransaction(call);
      return { terms, baseSplit, file: new Uint8Array(), header: new Uint8Array() };
    },
  );
  try {
    const run = createAdapter(
      { ANNON_CONFIG: ws.config, ANNON_BACKUP_SECRET: backupSecretHex },
      {
        prompt: async () => true,
        wallet: async () => seller,
        sdk: (options) => {
          const sdk = new Annon(options);
          vi.spyOn(sdk, 'sell').mockImplementation(sell as never);
          return sdk;
        },
      },
    );
    expect(
      await run({
        command: 'sell',
        target,
        price: '0.2',
        split: `evm:${terms.seller.id}:10000`,
        base: true,
      }),
    ).toEqual({ fileId: terms.file_id, file: `${target}.pay2`, terms, baseSplit });
    expect(sendBase).toHaveBeenCalledWith(call, 'https://base.test');
  } finally {
    await ws.remove();
  }
});
