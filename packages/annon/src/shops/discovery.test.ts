import { expect, it, vi } from 'vitest';
import { terms } from '../../test/fixtures.js';
import { canonicalManifestUrl, catalog, listShops, validateDiscoveryConfig } from './discovery.js';

const manifestUrl = 'https://shop.test/.well-known/annon-shop.json';
const manifest = {
  version: 1,
  name: 'Example',
  shopUrl: 'https://shop.test/demo',
  network: 'near:mainnet',
  contract: terms.contract,
  relayer: 'https://relay.test',
  host: 'https://files.test',
  catalog: {
    url: 'https://files.test/files.json',
    format: 'annon-catalog-array-v1',
    search: 'client',
  },
};
const entry = (n: number) => ({
  name: `file-${n}`,
  fileId: terms.file_id,
  title: 'A title',
  description: 'Notes',
  url: `https://files.test/${n}`,
  header: `https://files.test/${n}/header`,
  byteSize: 100,
  plaintextSize: 1,
  createdAt: n,
  expiresAt: n + 604800,
  termsHash: '',
  terms: { ...terms, network: 'near:mainnet' },
  salesStopped: false,
  takenDown: false,
});
const config = { shops: [{ manifest: manifestUrl, id: 'local' }], defaultShop: 'local' };
const fetcher = (items: unknown[] = []) =>
  vi.fn<typeof globalThis.fetch>(async (url) =>
    Response.json(String(url) === manifestUrl ? manifest : items),
  );

it('canonicalizes shop URLs and refuses insecure or credentialed discovery', () => {
  expect(canonicalManifestUrl('https://SHOP.test/demo')).toBe(manifestUrl);
  expect(canonicalManifestUrl(manifestUrl)).toBe(manifestUrl);
  for (const url of [
    'http://localhost',
    'https://user:pass@shop.test',
    'https://shop.test/?secret=1',
    'file:///tmp/a',
  ])
    expect(() => canonicalManifestUrl(url)).toThrow();
});
it('has no default directory and never fetches with empty configuration', async () => {
  const fetch = vi.fn();
  expect(await listShops({}, {}, fetch)).toEqual({ items: [], total: 0, nextOffset: null });
  expect(fetch).not.toHaveBeenCalled();
});
it('deduplicates canonical identities without taking aliases or defaults from remote documents', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
    Response.json(
      String(url) === 'https://directory.test/list'
        ? { version: 1, shops: [{ manifest: manifestUrl }] }
        : manifest,
    ),
  );
  const result = await listShops(
    { ...config, shopDirectoryUrl: 'https://directory.test/list' },
    {},
    fetch,
  );
  expect(result.total).toBe(1);
  expect(result.items[0]).toMatchObject({ manifest: manifestUrl, id: 'local', trusted: false });
  expect(config.defaultShop).toBe('local');
  for (const [, options] of fetch.mock.calls) {
    expect(options).toMatchObject({ credentials: 'omit', redirect: 'error' });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  }
});
it('filters before stable sorting and paging, and searches all three text fields', async () => {
  const { termsHash } = await import('../settle-near/terms.js');
  const items = [entry(1), entry(3), entry(2)].map((e) => ({
    ...e,
    termsHash: termsHash(e.terms),
  }));
  const fetch = fetcher(items);
  expect((await catalog(config, {}, fetch)).items).toEqual([items[1], items[2], items[0]]);
  expect(await catalog(config, { search: 'TITLE', limit: 1, offset: 1 }, fetch)).toEqual({
    items: [items[2]],
    total: 3,
    nextOffset: 2,
  });
  for (const search of ['FILE', 'notes'])
    expect((await catalog(config, { search }, fetch)).total).toBe(3);
  expect((await catalog(config, { offset: 3 }, fetch)).nextOffset).toBeNull();
});
it.each([
  { limit: 0 },
  { limit: 101 },
  { limit: 1.1 },
  { offset: -1 },
  { offset: Number.MAX_SAFE_INTEGER + 1 },
  { offset: 0.5 },
])('rejects invalid paging before fetching: %j', async (options) => {
  const fetch = fetcher();
  await expect(catalog(config, options, fetch)).rejects.toMatchObject({
    code: 'invalid_arguments',
  });
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['manifest', 'directory', 'catalog'] as const)(
  'counts streamed bytes for %s and returns no partial results',
  async (kind) => {
    const sizes = { manifest: 65536, directory: 262144, catalog: 8388608 };
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (
        (kind === 'manifest' && String(url) === manifestUrl) ||
        (kind === 'catalog' && String(url).endsWith('files.json')) ||
        kind === 'directory'
      )
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(sizes[kind]));
              c.enqueue(new Uint8Array(1));
              c.close();
            },
          }),
        );
      return Response.json(manifest);
    });
    await expect(
      kind === 'directory'
        ? listShops({ shopDirectoryUrl: 'https://dir.test/list' }, {}, fetch)
        : catalog(config, {}, fetch),
    ).rejects.toMatchObject({ code: 'too_large' });
  },
);
it('rejects directory and catalog count overflow', async () => {
  await expect(
    listShops(
      { shopDirectoryUrl: 'https://dir.test/list' },
      {},
      vi.fn(async () =>
        Response.json({
          version: 1,
          shops: Array.from({ length: 101 }, () => ({ manifest: manifestUrl })),
        }),
      ),
    ),
  ).rejects.toMatchObject({ code: 'too_large' });
  await expect(catalog(config, {}, fetcher(Array(10001).fill({})))).rejects.toMatchObject({
    code: 'too_large',
  });
});
it('rejects deployment substitution against a human profile before fetching its catalog', async () => {
  const profile = {
    network: 'near:mainnet' as const,
    contract: terms.contract,
    nearRpc: 'https://near.test',
    baseRpc: 'https://base.test',
    relayer: 'https://approved-relay.test',
    host: 'https://files.test',
  };
  const fetch = fetcher();
  await expect(
    catalog({ shops: [{ manifest: manifestUrl, id: 'local', profile }] }, { shop: 'local' }, fetch),
  ).rejects.toMatchObject({ code: 'config_conflict' });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('rejects remote alias injection, duplicate human aliases and invalid defaults', async () => {
  await expect(
    listShops(
      { shopDirectoryUrl: 'https://dir.test/list' },
      {},
      vi.fn(async (url) =>
        Response.json(
          String(url) === 'https://dir.test/list'
            ? { version: 1, shops: [{ manifest: manifestUrl, id: 'local' }] }
            : manifest,
        ),
      ),
    ),
  ).rejects.toMatchObject({ code: 'invalid_record' });
  for (const c of [
    { shops: [config.shops[0], { manifest: 'https://other.test', id: 'local' }] },
    { defaultShop: 'missing' },
  ])
    expect(() => validateDiscoveryConfig(c)).toThrow();
});

it.each(['version', 'format', 'search', 'network', 'extra', 'host'] as const)(
  'rejects malformed manifest %s',
  async (field) => {
    const edited = structuredClone(manifest) as Record<string, unknown>;
    if (field === 'format' || field === 'search')
      (edited.catalog as Record<string, unknown>)[field] = 'unsupported';
    else edited[field] = field === 'version' ? 2 : 'unsupported';
    await expect(
      listShops(
        config,
        {},
        vi.fn(async () => Response.json(edited)),
      ),
    ).rejects.toMatchObject({ code: 'invalid_record' });
  },
);
it.each(['contract', 'network', 'relayer', 'host'] as const)(
  'binds approved profile %s',
  async (field) => {
    const profile = {
      network: 'near:mainnet',
      contract: terms.contract,
      nearRpc: 'https://near.test',
      relayer: manifest.relayer,
      host: manifest.host,
    };
    const edited = {
      ...manifest,
      [field]:
        field === 'contract'
          ? 'other.near'
          : field === 'network'
            ? 'near:testnet'
            : 'https://other.test',
    };
    if (field === 'host')
      edited.catalog = { ...manifest.catalog, url: 'https://other.test/files.json' };
    await expect(
      listShops(
        { shops: [{ manifest: manifestUrl, profile: profile as never }] },
        {},
        vi.fn(async () => Response.json(edited)),
      ),
    ).rejects.toMatchObject({ code: 'config_conflict' });
  },
);
it('rejects redirects, failed responses, invalid JSON and upstream details', async () => {
  for (const r of [
    new Response(null, { status: 302, headers: { location: 'https://other.test' } }),
    new Response('bad json'),
    new Response(null, { status: 503 }),
  ])
    await expect(
      listShops(
        config,
        {},
        vi.fn(async () => r),
      ),
    ).rejects.toThrow();
  await expect(
    listShops(
      config,
      {},
      vi.fn(async () => {
        throw new Error('PRIVATE');
      }),
    ),
  ).rejects.toMatchObject({ code: 'transport' });
});
it('sorts equal timestamps by fileId and binds catalog terms, hashes and service origins', async () => {
  const { termsHash } = await import('../settle-near/terms.js');
  const a = entry(1),
    b = {
      ...entry(1),
      fileId: `0x${'11'.repeat(32)}`,
      terms: { ...terms, file_id: `0x${'11'.repeat(32)}` },
    };
  const items = [a, b].map((e) => ({ ...e, termsHash: termsHash(e.terms) }));
  expect((await catalog(config, {}, fetcher(items))).items).toEqual([items[1], items[0]]);
  for (const patch of [
    { termsHash: `0x${'00'.repeat(32)}` },
    { fileId: `0x${'44'.repeat(32)}` },
    { terms: { ...a.terms, contract: 'other.near' } },
    { url: 'https://other.test/file' },
    { extra: true },
  ])
    await expect(catalog(config, {}, fetcher([{ ...items[0], ...patch }]))).rejects.toThrow();
});

it('rejects remote RPC substitution and malformed profile endpoints', async () => {
  const profile = {
    network: 'near:mainnet' as const,
    contract: terms.contract,
    nearRpc: 'https://near.test/',
    baseRpc: 'https://base.test/',
    relayer: manifest.relayer,
    host: manifest.host,
  };
  for (const rpc of ['nearRpc', 'baseRpc'])
    await expect(
      listShops(
        { shops: [{ manifest: manifestUrl, profile }] },
        {},
        vi.fn(async () => Response.json({ ...manifest, [rpc]: 'https://other.test/' })),
      ),
    ).rejects.toMatchObject({ code: 'config_conflict' });
  for (const nearRpc of [
    'http://localhost',
    'https://user:pass@near.test',
    'https://near.test/?key=value',
  ])
    expect(() =>
      validateDiscoveryConfig({
        shops: [{ manifest: manifestUrl, profile: { ...profile, nearRpc } }],
      }),
    ).toThrow();
});
it('applies a 10-second deadline to stalled requests', async () => {
  const controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
  try {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async (_url, options) =>
        new Promise((_resolve, reject) =>
          options?.signal?.addEventListener('abort', () => reject(new Error('TIMEOUT'))),
        ),
    );
    const pending = expect(listShops(config, {}, fetch)).rejects.toMatchObject({
      code: 'transport',
    });
    await vi.waitFor(() => expect(timeout).toHaveBeenCalledWith(10000));
    controller.abort();
    await pending;
  } finally {
    controller.abort();
    timeout.mockRestore();
  }
});

it('rejects an oversized declared response before reading its body', async () => {
  const read = vi.fn(() => {
    throw new Error('BODY_READ');
  });
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(new ReadableStream({ pull: read }, { highWaterMark: 0 }), {
        headers: { 'Content-Length': '65537' },
      }),
  );
  await expect(listShops(config, {}, fetch)).rejects.toMatchObject({ code: 'too_large' });
  expect(read).not.toHaveBeenCalled();
});

it('uses a default page of 20 and returns an empty page beyond the end', async () => {
  const { termsHash } = await import('../settle-near/terms.js');
  const items = Array.from({ length: 21 }, (_, n) => {
    const e = entry(n);
    return { ...e, termsHash: termsHash(e.terms) };
  });
  expect(await catalog(config, {}, fetcher(items))).toMatchObject({
    total: 21,
    items: expect.any(Array),
    nextOffset: 20,
  });
  expect((await catalog(config, {}, fetcher(items))).items).toHaveLength(20);
  expect(await catalog(config, { offset: 100 }, fetcher(items))).toEqual({
    items: [],
    total: 21,
    nextOffset: null,
  });
});
it('rejects valid JSON on error, redirected or substituted responses', async () => {
  for (const field of ['status', 'redirected', 'url']) {
    const response = Response.json(manifest, field === 'status' ? { status: 503 } : {});
    if (field !== 'status')
      Object.defineProperty(response, field, {
        value: field === 'redirected' ? true : 'https://other.test/',
      });
    await expect(
      listShops(
        config,
        {},
        vi.fn(async () => response),
      ),
    ).rejects.toMatchObject({ code: 'bad_response' });
  }
});
it('rejects duplicate local identities, excess local shops and invalid local profiles', () => {
  expect(() =>
    validateDiscoveryConfig({
      shops: [config.shops[0], { manifest: 'https://shop.test/demo', id: 'other' }],
    }),
  ).toThrow();
  expect(() =>
    validateDiscoveryConfig({
      shops: Array.from({ length: 101 }, (_, n) => ({ manifest: `https://shop-${n}.test` })),
    }),
  ).toThrow();
  for (const patch of [
    { network: 'near:testnet' },
    { host: 'https://files.test/path' },
    { extra: true },
  ]) {
    expect(() =>
      validateDiscoveryConfig({
        shops: [
          {
            manifest: manifestUrl,
            profile: {
              network: 'near:mainnet',
              contract: terms.contract,
              nearRpc: 'https://near.test',
              relayer: manifest.relayer,
              host: manifest.host,
              ...patch,
            },
          },
        ],
      }),
    ).toThrow();
  }
});

it('validates every catalog field before returning a page', async () => {
  const { termsHash } = await import('../settle-near/terms.js');
  const valid = { ...entry(1), termsHash: termsHash(terms) };
  for (const patch of [
    { name: 1 },
    { title: null },
    { description: [] },
    { byteSize: -1 },
    { byteSize: 50086017 },
    { plaintextSize: 50000001 },
    { createdAt: 0.5 },
    { expiresAt: -1 },
    { expiresAt: 0 },
    { salesStopped: 0 },
    { takenDown: null },
    { header: 'https://other.test/header' },
  ])
    await expect(catalog(config, {}, fetcher([valid, { ...valid, ...patch }]))).rejects.toThrow();
});
it('validates directory schema and selected shop before catalog access', async () => {
  for (const directory of [
    { version: 2, shops: [] },
    { version: 1, shops: {} },
    { version: 1, shops: [], defaultShop: 'local' },
  ])
    await expect(
      listShops(
        { shopDirectoryUrl: 'https://dir.test/list' },
        {},
        vi.fn(async () => Response.json(directory)),
      ),
    ).rejects.toMatchObject({ code: 'invalid_record' });
  for (const query of [{}, { shop: 'unknown' }])
    await expect(catalog({}, query, fetcher())).rejects.toMatchObject({
      code: 'invalid_arguments',
    });
});

it('refuses self-consistent catalog deployment substitution', async () => {
  const { termsHash } = await import('../settle-near/terms.js');
  for (const changed of [
    { ...terms, contract: 'other.near' },
    { ...terms, network: 'near:testnet' },
  ]) {
    const e = { ...entry(1), terms: changed, termsHash: termsHash(changed) };
    await expect(catalog(config, {}, fetcher([e]))).rejects.toMatchObject({
      code: 'config_conflict',
    });
  }
});

it('keeps approved RPC profile configuration out of discovery results', async () => {
  const profile = {
    network: 'near:mainnet' as const,
    contract: terms.contract,
    nearRpc: 'https://near.test/operator-key',
    baseRpc: 'https://base.test/operator-key',
    relayer: manifest.relayer,
    host: manifest.host,
  };
  const result = await listShops(
    { shops: [{ manifest: manifestUrl, id: 'local', profile }] },
    {},
    fetcher(),
  );
  expect(result.items[0]).toMatchObject({ manifest: manifestUrl, id: 'local', trusted: true });
  expect(result.items[0]).not.toHaveProperty('profile');
  expect(JSON.stringify(result)).not.toContain('operator-key');
});
