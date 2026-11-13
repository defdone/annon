import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createAdapter } from './adapter.js';
import { savePublicConfig } from './agent.js';

it('discovers and adds shops without deployment, wallet, secret or trust configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-shops-'));
  const path = join(dir, 'config.json');
  const manifest = {
    version: 1,
    name: 'Shop',
    shopUrl: 'https://shop.test/demo',
    network: 'near:mainnet',
    contract: 'annon.near',
    relayer: 'https://relay.test',
    host: 'https://files.test',
    catalog: {
      url: 'https://files.test/files.json',
      format: 'annon-catalog-array-v1',
      search: 'client',
    },
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
    Response.json(String(url).endsWith('files.json') ? [] : manifest),
  );
  const wallet = vi.fn(),
    prompt = vi.fn(),
    browser = vi.fn();
  const adapter = createAdapter({ ANNON_CONFIG: path }, { fetch, wallet, prompt, browser });
  try {
    expect(await adapter({ command: 'shops' })).toEqual({ items: [], total: 0, nextOffset: null });
    await adapter({ command: 'shop', target: 'https://shop.test/demo', id: 'mine' });
    const saved = JSON.parse(await readFile(path, 'utf8'));
    expect(saved.shops).toEqual([
      { manifest: 'https://shop.test/.well-known/annon-shop.json', id: 'mine' },
    ]);
    expect(saved.trustContract).toBeUndefined();
    expect(saved.defaultShop).toBeUndefined();
    expect((await adapter({ command: 'shops' })).total).toBe(1);
    expect(await adapter({ command: 'catalog', shop: 'mine' })).toEqual({
      items: [],
      total: 0,
      nextOffset: null,
    });
    for (const spy of [wallet, prompt, browser]) expect(spy).not.toHaveBeenCalled();
    await savePublicConfig(path, {
      signer: { mode: 'browser', identity: { kind: 'near', id: 'buyer.test' } },
      agent: false,
    });
    expect(JSON.parse(await readFile(path, 'utf8')).shops).toEqual(saved.shops);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('preserves directory and defaultShop through public config saves and refuses alias replacement', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-shop-config-'));
  const path = join(dir, 'config.json');
  const saved = {
    shopDirectoryUrl: 'https://dir.test/list',
    shops: [{ manifest: 'https://shop.test/.well-known/annon-shop.json', id: 'mine' }],
    defaultShop: 'mine',
  };
  try {
    await writeFile(path, JSON.stringify(saved));
    await savePublicConfig(path, {
      signer: { mode: 'browser', identity: { kind: 'near', id: 'buyer.test' } },
      agent: false,
    });
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject(saved);
    const adapter = createAdapter({ ANNON_CONFIG: path }, { fetch: vi.fn() });
    await expect(
      adapter({ command: 'shop', target: 'https://other.test', id: 'mine' }),
    ).rejects.toMatchObject({ code: 'config_conflict' });
    await expect(
      adapter({ command: 'shop', target: 'https://shop.test', id: 'renamed' }),
    ).rejects.toMatchObject({ code: 'config_conflict' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('forced tool policy refuses persistent additions before fetching', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-shop-policy-'));
  try {
    const fetch = vi.fn();
    const adapter = createAdapter(
      { ANNON_CONFIG: join(dir, 'missing.json') },
      { agent: true, fetch },
    );
    await expect(adapter({ command: 'shop', target: 'https://shop.test' })).rejects.toMatchObject({
      code: 'human_only',
    });
    expect(await adapter({ command: 'shops' })).toMatchObject({ total: 0 });
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('refuses discovery deployment overrides under forced policy before network access', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-shop-pinned-'));
  try {
    const fetch = vi.fn();
    const adapter = createAdapter(
      { ANNON_CONFIG: join(dir, 'missing.json') },
      { agent: true, fetch },
    );
    for (const command of ['shops', 'catalog'] as const) {
      await expect(adapter({ command, contractId: 'other.near' })).rejects.toMatchObject({
        code: 'agent_policy',
      });
      await expect(adapter({ command, trustContract: true })).rejects.toMatchObject({
        code: 'agent_policy',
      });
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('keeps the approved profile local when a human re-adds a shop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-shop-profile-'));
  const path = join(dir, 'config.json');
  const profile = {
    network: 'near:mainnet',
    contract: 'annon.near',
    nearRpc: 'https://near.test/operator-key',
    host: 'https://files.test',
    relayer: 'https://relay.test',
  };
  const manifest = {
    version: 1,
    name: 'Shop',
    shopUrl: 'https://shop.test/demo',
    network: 'near:mainnet',
    contract: 'annon.near',
    relayer: profile.relayer,
    host: profile.host,
    catalog: {
      url: 'https://files.test/files.json',
      format: 'annon-catalog-array-v1',
      search: 'client',
    },
  };
  try {
    await writeFile(
      path,
      JSON.stringify({
        shops: [
          { manifest: 'https://shop.test/.well-known/annon-shop.json', id: 'local', profile },
        ],
      }),
    );
    const adapter = createAdapter(
      { ANNON_CONFIG: path },
      { fetch: vi.fn(async () => Response.json(manifest)) },
    );
    const result = await adapter({ command: 'shop', target: 'https://shop.test', id: 'local' });
    expect(result).not.toHaveProperty('profile');
    expect(JSON.stringify(result)).not.toContain('operator-key');
    expect(JSON.parse(await readFile(path, 'utf8')).shops[0].profile).toEqual(profile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
