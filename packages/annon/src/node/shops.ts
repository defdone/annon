import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AnnonError } from '../errors.js';
import {
  canonicalManifestUrl,
  catalog,
  type DiscoveryConfig,
  listShops,
  readShop,
  validateDiscoveryConfig,
} from '../shops/discovery.js';
import { configPath } from './agent.js';
import type { Input } from './cli.js';
import { AdapterError } from './errors.js';
import { cleanText } from './output/text.js';
import type { Environment } from './wallets.js';

export const isDiscovery = (input: Input) => ['shops', 'shop', 'catalog'].includes(input.command);
async function readConfig(path: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new AnnonError('invalid_config', undefined, { cause });
  }
}
/** Discovery deliberately does not load deployment, signing or spending configuration. */
export async function discoverShops(
  input: Input,
  env: Environment,
  agent: boolean,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<Record<string, unknown>> {
  if (input.command === 'shop' && agent) throw new AnnonError('human_only');
  const path = configPath(input, env);
  const raw = await readConfig(path);
  const config: DiscoveryConfig = validateDiscoveryConfig(raw);
  const query = {
    ...(input.search !== undefined ? { search: input.search } : {}),
    ...(input.limit !== undefined ? { limit: input.limit } : {}),
    ...(input.offset !== undefined ? { offset: input.offset } : {}),
  };
  if (input.command === 'shops') return { ...(await listShops(config, query, fetcher)) };
  if (input.command === 'catalog')
    return {
      ...(await catalog(
        config,
        { ...query, ...(input.shop !== undefined ? { shop: input.shop } : {}) },
        fetcher,
      )),
    };
  if (input.command !== 'shop' || !input.target) throw new AnnonError('invalid_arguments');
  const manifest = canonicalManifestUrl(input.target);
  const shops = config.shops ?? [];
  const existing = shops.find((s) => s.manifest === manifest);
  if (
    (input.id !== undefined && shops.some((s) => s.id === input.id && s.manifest !== manifest)) ||
    (existing?.id !== undefined && input.id !== undefined && existing.id !== input.id)
  )
    throw new AnnonError('config_conflict');
  const added = { ...existing, manifest, ...(input.id !== undefined ? { id: input.id } : {}) };
  const next = existing ? shops.map((s) => (s === existing ? added : s)) : [...shops, added];
  validateDiscoveryConfig({ ...config, shops: next });
  await readShop(added, fetcher);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify({ ...raw, shops: next }, null, 2), {
    mode: 0o600,
    flag: 'wx',
  });
  await rename(tmp, path);
  return {
    manifest,
    ...(added.id !== undefined ? { id: added.id } : {}),
    trusted: added.profile !== undefined,
  };
}

/** Descriptive text retains its canonical shop provenance. */
export async function selectedShopRules(
  config: DiscoveryConfig,
  id: string | undefined,
  fetcher: typeof fetch,
) {
  const selected = id ?? config.defaultShop;
  const local = config.shops?.find((s) => s.id === selected || s.manifest === selected);
  if (!local) return {};
  const shop = await readShop(local, fetcher);
  return shop.info.rules
    ? { shop: { manifest: shop.manifest, name: shop.info.name }, rules: shop.info.rules }
    : {};
}

/**
 * `buy <row>`: the resource URL of that row in the listing `catalog` prints for the same `--shop`
 * and `--search`. The buy then checks the file and its terms as for a URL typed by hand.
 */
export async function catalogRow(
  input: Input,
  env: Environment,
  notify: ((message: string) => void) | undefined,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<Input> {
  const row = Number(input.target);
  const config = validateDiscoveryConfig(await readConfig(configPath(input, env)));
  const listing = await catalog(
    config,
    {
      offset: row - 1,
      limit: 1,
      ...(input.search !== undefined ? { search: input.search } : {}),
      ...(input.shop !== undefined ? { shop: input.shop } : {}),
    },
    fetcher,
  );
  const [entry] = listing.items;
  if (!entry)
    throw new AdapterError(
      'invalid_arguments',
      `The catalog has no row ${row}. Run annon catalog to list the rows.`,
      2,
    );
  notify?.(`Row ${row}: ${cleanText(entry.title)} (${entry.url})`);
  const { shop: _shop, search: _search, ...rest } = input;
  return { ...rest, target: entry.url };
}
