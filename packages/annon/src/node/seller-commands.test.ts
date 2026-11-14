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
  ['the defaults', {}, {}, near / 100n, near / 5n],
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

it('a person at a terminal reads the share terms as lines; --json-free piped runs keep the JSON prompt', async () => {
  const ws = await workspace('share-human', shopConfig);
  const file = join(ws.dir, 'notes.txt');
  await writeFile(file, 'notes');
  const nearSeller = { kind: 'near' as const, id: 'seller.synthetic.near' };
  const split = { ...terms.near, recipients: [{ identity: nearSeller, bps: 10000 }] };
  try {
    const prompts: string[] = [];
    for (const human of [true, false, undefined]) {
      const run = createAdapter(
        { ANNON_CONFIG: ws.config, ANNON_BACKUP_SECRET: backupSecretHex },
        {
          ...(human === undefined ? {} : { human }),
          fetch: async () => Response.json(manifest),
          prompt: async (message: string) => {
            prompts.push(message);
            return true;
          },
          wallet: async () => ({ identity: nearSeller, authorize: vi.fn() }),
          sdk: (options) => {
            const sdk = new Annon(options);
            vi.spyOn(sdk, 'share').mockImplementation((async (o: ShareOptions) => {
              await o.onSplit?.(split, undefined, false);
              return { fileId: terms.file_id };
            }) as never);
            return sdk;
          },
        },
      );
      await run({ command: 'share', target: file, price: '0.1' });
    }
    expect(prompts[0]).toBe(
      [
        'Seller: seller.synthetic.near',
        `Host: ${profile.host}`,
        `Contract: ${profile.contract}`,
        'Price: 0.20 USDC',
        'Split: seller.synthetic.near 100%',
        'Fee: none',
        'Listing storage: 0.01 NEAR',
        'Purchase storage: 0.2 NEAR (covers about 19 sales)',
        'These storage amounts are proposals. Change them with --listing-storage and --storage-budget.',
        'Type yes to share: ',
      ].join('\n'),
    );
    // Without human output the prompt is the exact JSON object, byte for byte.
    const json = `{"seller":{"kind":"near","id":"seller.synthetic.near"},"host":"${profile.host}","contract":"${profile.contract}","price":"200000","split":${JSON.stringify(split)},"fee":null,"listingStorage":"10000000000000000000000","purchaseStorage":"200000000000000000000000","registerDeposit":"0"}\nType yes to share: `;
    expect(prompts.slice(1)).toEqual([json, json]);
  } finally {
    await ws.remove();
  }
});

it('a failed seller check names both identities for a person; scripts keep the plain error', async () => {
  const ws = await workspace('stop-wrong', shopConfig);
  const required = { kind: 'evm' as const, id: `0xe8cc${'00'.repeat(16)}d86d` };
  const offered = { kind: 'near' as const, id: 'alice.near' };
  const { AnnonError, withIdentities } = await import('../errors.js');
  try {
    const errors = [];
    for (const [human, json] of [
      [true, false],
      [true, true],
      [false, false],
    ] as const) {
      const run = createAdapter(
        { ANNON_CONFIG: ws.config, ANNON_BACKUP_SECRET: backupSecretHex },
        {
          human,
          wallet: async () => ({ identity: offered, authorize: vi.fn() }),
          sdk: (options) => {
            const sdk = new Annon(options);
            vi.spyOn(sdk, 'stop').mockRejectedValue(
              withIdentities(
                new AnnonError('wrong_identity', 'not the registered seller'),
                required,
                offered,
              ),
            );
            return sdk;
          },
        },
      );
      errors.push(
        publicError(
          await run({ command: 'stop', target: terms.file_id, ...(json ? { json } : {}) }).catch(
            (e) => e,
          ),
        ),
      );
    }
    const plain = {
      code: 'wrong_identity',
      message: 'The wallet does not control the required identity.',
      exitCode: errors[2]?.exitCode,
    };
    expect(errors).toEqual([
      {
        ...plain,
        message:
          "Your wallet is near:alice.near. This file's seller is evm:0xe8cc0000...d86d. Use the seller's wallet, then run the command again.",
      },
      plain,
      plain,
    ]);
  } finally {
    await ws.remove();
  }
});

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
