import { expect, it, vi } from 'vitest';
import { must } from '../../test/fixtures.js';
import type { Config } from './config.js';
import { shareHost } from './sharing.js';

const profile = {
  network: 'near:mainnet' as const,
  contract: 'contract.synthetic.near',
  nearRpc: 'https://near.example',
  baseRpc: 'https://base.example',
  relayer: 'https://relay.example',
  host: 'https://host.example',
};
const config: Config = {
  ...profile,
  contractId: profile.contract,
  stateDir: '/tmp/synthetic',
  defaultShop: 'mine',
  shops: [{ id: 'mine', manifest: 'https://shop.example/.well-known/annon-shop.json', profile }],
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
it('hosting has no default and cannot grant trust from discovery', async () => {
  const fetcher = vi.fn();
  await expect(shareHost({ ...config, shops: [] }, undefined, fetcher)).rejects.toMatchObject({
    code: 'invalid_config',
  });
  await expect(
    shareHost(
      {
        ...config,
        shops: [{ id: 'mine', manifest: 'https://shop.example/.well-known/annon-shop.json' }],
      },
      undefined,
      fetcher,
    ),
  ).rejects.toMatchObject({ code: 'trust_required' });
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(['contractId', 'network', 'nearRpc', 'baseRpc', 'relayer'] as const)(
  'rejects a %s substitution before fetching',
  async (key) => {
    const fetcher = vi.fn();
    await expect(
      shareHost({ ...config, [key]: 'changed' }, undefined, fetcher),
    ).rejects.toMatchObject({ code: 'config_conflict' });
    expect(fetcher).not.toHaveBeenCalled();
  },
);
it('reads the selected approved shop and rejects host substitution', async () => {
  const fetcher = vi.fn(async () => Response.json(manifest));
  expect(await shareHost(config, undefined, fetcher)).toBe(profile.host);
  fetcher.mockResolvedValueOnce(Response.json({ ...manifest, host: 'https://other.example' }));
  await expect(shareHost(config, 'mine', fetcher)).rejects.toMatchObject({
    code: 'config_conflict',
  });
});

it.each([undefined, 'other', 'https://other.example/.well-known/annon-shop.json'])(
  'share and resume retain selected shop rules for %s',
  async (shop) => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createAdapter } = await import('./adapter.js');
    const { Annon } = await import('../api/annon.js');
    const dir = await mkdtemp(join(tmpdir(), 'annon-share-'));
    try {
      const path = join(dir, 'config.json'),
        file = join(dir, 'file.txt');
      await writeFile(file, 'file');
      await writeFile(
        path,
        JSON.stringify({
          ...config,
          shops: [
            ...must(config.shops),
            { id: 'other', manifest: 'https://other.example/.well-known/annon-shop.json', profile },
          ],
          stateDir: dir,
          trustContract: true,
        }),
      );
      const share = vi.fn(async (options) => {
        expect(options.hosting.origin).toBe(profile.host);
        expect(options.data.size).toBe(4);
        expect(await new Response(options.data.read()).text()).toBe('file');
        expect(typeof options.confirmBackup).toBe('function');
        expect(typeof options.hosting.spool).toBe('function');
        return {
          fileId: `0x${'11'.repeat(32)}`,
          url: 'https://host.example/f/synthetic',
          header: 'https://host.example/f/synthetic/header',
          expiresAt: 1800000000,
        };
      });
      const resume = vi.fn(async () => ({
        fileId: `0x${'11'.repeat(32)}`,
        url: 'https://host.example/f/synthetic',
        header: 'https://host.example/f/synthetic/header',
        expiresAt: 1800000000,
      }));
      const selectedManifest = shop
        ? 'https://other.example/.well-known/annon-shop.json'
        : must(must(config.shops)[0]).manifest;
      const rules = { text: shop ? 'Other shop text' : 'Shop text', fileLifetimeDays: 7 };
      const expected = { shop: { manifest: selectedManifest, name: 'Shop' }, rules };
      const adapter = createAdapter(
        { ANNON_CONFIG: path, ANNON_BACKUP_SECRET: '09'.repeat(32) },
        {
          fetch: async (url) =>
            Response.json({
              ...manifest,
              rules: {
                text:
                  String(url) === 'https://other.example/.well-known/annon-shop.json'
                    ? 'Other shop text'
                    : 'Shop text',
                fileLifetimeDays: 7,
              },
            }),
          wallet: async () => ({
            identity: { kind: 'evm', id: `0x${'11'.repeat(20)}` },
            authorize: vi.fn(),
          }),
          sdk: (options) => {
            const sdk = new Annon(options);
            vi.spyOn(sdk, 'share').mockImplementation(share);
            vi.spyOn(sdk, 'resumeShare').mockImplementation(resume);
            return sdk;
          },
        },
      );
      expect(
        await adapter({
          command: 'share',
          target: file,
          price: '0.10',
          title: 'File',
          json: true,
          ...(shop ? { shop } : {}),
        }),
      ).toMatchObject(expected);
      expect(
        await adapter({
          command: 'share',
          target: file,
          resume: `0x${'11'.repeat(32)}`,
          json: true,
          ...(shop ? { shop } : {}),
        }),
      ).toMatchObject(expected);
      expect(resume).toHaveBeenCalledTimes(1);
      expect(share).toHaveBeenCalledTimes(1);
      expect(must(share.mock.calls[0])[0]).toMatchObject({
        price: '100000',
        name: 'file.txt',
        title: 'File',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it('share source confinement applies without creating a PAY2 output path', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { confinePaths } = await import('./paths.js');
  const dir = await mkdtemp(join(tmpdir(), 'annon-share-path-'));
  try {
    await writeFile(join(dir, 'file.txt'), 'file');
    const input = await confinePaths({ command: 'share', target: 'file.txt', price: '0.1' }, dir);
    expect(input.target).toBe(
      await (await import('node:fs/promises')).realpath(join(dir, 'file.txt')),
    );
    expect(input.output).toBeUndefined();
    await expect(
      confinePaths({ command: 'share', target: '../file.txt' }, dir),
    ).rejects.toMatchObject({ code: 'path_not_allowed' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('noninteractive NEAR sharing requires previously approved funding amounts', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createAdapter } = await import('./adapter.js');
  const { Annon } = await import('../api/annon.js');
  const dir = await mkdtemp(join(tmpdir(), 'annon-share-near-'));
  try {
    const path = join(dir, 'config.json'),
      file = join(dir, 'file.txt');
    await writeFile(file, 'file');
    await writeFile(path, JSON.stringify({ ...config, stateDir: dir, trustContract: true }));
    const share = vi.fn(async () => {
      throw new Error('SHARE_REACHED');
    });
    const adapter = createAdapter(
      { ANNON_CONFIG: path, ANNON_BACKUP_SECRET: '09'.repeat(32) },
      {
        fetch: async () => Response.json(manifest),
        wallet: async () => ({
          identity: { kind: 'near', id: 'seller.synthetic.near' },
          authorize: vi.fn(),
        }),
        sdk: (options) => {
          const sdk = new Annon(options);
          vi.spyOn(sdk, 'share').mockImplementation(share);
          return sdk;
        },
      },
    );
    await expect(
      adapter({ command: 'share', target: file, price: '0.10', json: true }),
    ).rejects.toMatchObject({ code: 'storage_required' });
    expect(share).not.toHaveBeenCalled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(['transport', 'storage_required'] as const)(
  'retains a known relayer hash after %s without replacing a definite refusal',
  async (mode) => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createAdapter } = await import('./adapter.js');
    const { Annon } = await import('../api/annon.js');
    const rpc = await import('../near/rpc.js');
    const { publicError } = await import('./errors.js');
    const dir = await mkdtemp(join(tmpdir(), 'annon-share-hash-'));
    try {
      const path = join(dir, 'config.json'),
        file = join(dir, 'file.txt');
      await writeFile(file, 'file');
      await writeFile(path, JSON.stringify({ ...config, stateDir: dir, trustContract: true }));
      vi.spyOn(rpc, 'txOutcome').mockRejectedValueOnce(
        mode === 'transport'
          ? new rpc.NearError('transport')
          : new (await import('../errors.js')).AnnonError('storage_required'),
      );
      const adapter = createAdapter(
        { ANNON_CONFIG: path, ANNON_BACKUP_SECRET: '09'.repeat(32) },
        {
          fetch: async (url) =>
            String(url).endsWith('/v1/relay')
              ? Response.json({
                  txHash: 'synthetic-register-transaction',
                  signer: 'relay.synthetic.near',
                })
              : Response.json(manifest),
          wallet: async () => ({
            identity: { kind: 'evm', id: `0x${'11'.repeat(20)}` },
            authorize: vi.fn(),
          }),
          sdk: (options) => {
            const sdk = new Annon(options);
            vi.spyOn(sdk, 'share').mockImplementation(async () => {
              await must(options.send)('register', { args: { file_id: `0x${'11'.repeat(32)}` } });
              throw new Error('UNREACHABLE');
            });
            return sdk;
          },
        },
      );
      const error = await adapter({
        command: 'share',
        target: file,
        price: '0.10',
        json: true,
      }).catch((e) => e);
      expect(publicError(error)).toMatchObject({
        code: mode === 'transport' ? 'transaction_uncertain' : 'storage_required',
        txHash: 'synthetic-register-transaction',
      });
    } finally {
      vi.restoreAllMocks();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it.each(['header', 'body'] as const)(
  'surfaces a relayer budget refusal with its %s retry hint through CLI without retrying admission',
  async (hint) => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { createAdapter } = await import('./adapter.js');
    const { runCli } = await import('./cli.js');
    const { Annon, SellError } = await import('../api/annon.js');
    const dir = await mkdtemp(join(tmpdir(), 'annon-budget-'));
    try {
      const path = join(dir, 'config.json'),
        file = join(dir, 'file.txt');
      await writeFile(file, 'file');
      await writeFile(path, JSON.stringify({ ...config, stateDir: dir, trustContract: true }));
      const wait = vi.fn(async () => {});
      const fetcher = vi.fn(async (url) =>
        String(url).endsWith('/v1/relay')
          ? Response.json(
              {
                error: 'budget',
                message: 'PRIVATE_UPSTREAM',
                ...(hint === 'body' ? { retryAfterSeconds: 37 } : {}),
              },
              { status: 429, headers: hint === 'header' ? { 'Retry-After': '37' } : {} },
            )
          : Response.json(manifest),
      );
      const adapter = createAdapter(
        { ANNON_CONFIG: path, ANNON_BACKUP_SECRET: '09'.repeat(32) },
        {
          fetch: fetcher,
          wait,
          wallet: async () => ({
            identity: { kind: 'evm', id: `0x${'11'.repeat(20)}` },
            authorize: vi.fn(),
          }),
          sdk: (options) => {
            const sdk = new Annon(options);
            vi.spyOn(sdk, 'share').mockImplementation(async () => {
              try {
                await must(options.send)('register', { args: { file_id: `0x${'11'.repeat(32)}` } });
              } catch (cause) {
                throw new SellError(`0x${'11'.repeat(32)}`, { cause });
              }
              throw new Error('UNREACHABLE');
            });
            return sdk;
          },
        },
      );
      const output = vi.fn();
      expect(await runCli(['share', file, '--price', '0.10', '--json'], adapter, output)).toBe(4);
      expect(JSON.parse(must(output.mock.calls[0])[0])).toMatchObject({
        ok: false,
        error: { code: 'budget', retryAfterSeconds: 37, exitCode: 4 },
      });
      expect(must(output.mock.calls[0])[0]).not.toContain('PRIVATE_UPSTREAM');
      expect(wait).not.toHaveBeenCalled();
      expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/v1/relay'))).toHaveLength(
        1,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it('A2 a human refusal stops share before backup or signing', async () => {
  const { mkdtemp, writeFile, rm, readdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createAdapter } = await import('./adapter.js');
  const rpc = await import('../near/rpc.js');
  const dir = await mkdtemp(join(tmpdir(), 'annon-share-decline-'));
  const authorize = vi.fn();
  try {
    const path = join(dir, 'config.json'),
      file = join(dir, 'file.txt');
    await writeFile(file, 'file');
    await writeFile(path, JSON.stringify({ ...config, stateDir: dir, trustContract: true }));
    vi.spyOn(rpc, 'getConfig').mockResolvedValue({
      network: profile.network,
      nearUsdc: 'usdc.synthetic.near',
      usdc: `0x${'11'.repeat(20)}`,
    } as never);
    const prompt = vi.fn(async () => false);
    const adapter = createAdapter(
      { ANNON_CONFIG: path, ANNON_BACKUP_SECRET: '09'.repeat(32) },
      {
        fetch: async (url) =>
          Response.json(
            String(url).endsWith('/v1/capabilities')
              ? {
                  contract: profile.contract,
                  fee: {
                    fixed: '30000',
                    bps: 100,
                    treasuryNear: null,
                    treasuryEvm: { kind: 'evm', id: `0x${'22'.repeat(20)}` },
                  },
                }
              : manifest,
          ),
        prompt,
        wallet: async () => ({ identity: { kind: 'evm', id: `0x${'11'.repeat(20)}` }, authorize }),
      },
    );
    await expect(adapter({ command: 'share', target: file, price: '0.10' })).rejects.toMatchObject({
      code: 'sale_not_approved',
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(authorize).not.toHaveBeenCalled();
    expect(await readdir(join(dir, 'backups'))).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
});

it('a sponsored share registration checks the outcome against the contract call only', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createAdapter } = await import('./adapter.js');
  const { Annon } = await import('../api/annon.js');
  const rpc = await import('../near/rpc.js');
  const dir = await mkdtemp(join(tmpdir(), 'annon-share-outcome-'));
  try {
    const path = join(dir, 'config.json'),
      file = join(dir, 'file.txt');
    await writeFile(file, 'file');
    await writeFile(path, JSON.stringify({ ...config, stateDir: dir, trustContract: true }));
    const outcome = vi
      .spyOn(rpc, 'txOutcome')
      .mockResolvedValue({ state: 'done', value: 'registered' } as never);
    const contractArgs = { file_id: `0x${'11'.repeat(32)}` };
    const auth = { kind: 'evm', signature: `0x${'22'.repeat(65)}` };
    const hostingReservation = { uploadId: 'synthetic-upload' };
    const relayed: unknown[] = [];
    let value: unknown;
    const adapter = createAdapter(
      { ANNON_CONFIG: path, ANNON_BACKUP_SECRET: '09'.repeat(32) },
      {
        fetch: async (url, init) => {
          if (!String(url).endsWith('/v1/relay')) return Response.json(manifest);
          relayed.push(JSON.parse(String(init?.body)));
          return Response.json({
            txHash: 'synthetic-register-transaction',
            signer: 'relay.synthetic.near',
          });
        },
        wallet: async () => ({
          identity: { kind: 'evm', id: `0x${'11'.repeat(20)}` },
          authorize: vi.fn(),
        }),
        sdk: (options) => {
          const sdk = new Annon(options);
          vi.spyOn(sdk, 'share').mockImplementation(async () => {
            value = await must(options.send)('register', {
              args: contractArgs,
              auth,
              hostingReservation,
              baseSplit: { kind: 'push', salt: `0x${'00'.repeat(32)}` },
            });
            throw new Error('STOP_AFTER_REGISTER');
          });
          return sdk;
        },
      },
    );
    await adapter({ command: 'share', target: file, price: '0.10', json: true }).catch(() => {});
    expect(value).toBe('registered');
    expect(relayed).toHaveLength(1);
    expect(relayed[0]).toMatchObject({ method: 'register', hostingReservation });
    expect(outcome).toHaveBeenCalledTimes(1);
    expect(outcome.mock.calls[0]?.[5]).toEqual({
      method: 'register',
      args: { args: contractArgs, auth },
    });
  } finally {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  }
});
