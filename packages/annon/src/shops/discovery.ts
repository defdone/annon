import { AnnonError, type AnnonErrorCode, toPublicError } from '../errors.js';
import { MAX_PAY2_BYTES, MAX_PLAINTEXT_BYTES } from '../limits.js';
import { account, bytes, exactKeys } from '../settle-near/codec.js';
import { type Terms, termsHash } from '../settle-near/terms.js';

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new AnnonError('invalid_record');
  return value;
}

export interface ShopManifest {
  version: 1;
  name: string;
  shopUrl: string;
  network: 'near:mainnet';
  contract: string;
  relayer: string;
  host: string;
  catalog: { url: string; format: 'annon-catalog-array-v1'; search: 'client' };
}
/** Deployment facts approved in local configuration, never copied from remote documents. */
export interface ShopProfile {
  network: 'near:mainnet';
  contract: string;
  nearRpc: string;
  baseRpc?: string;
  relayer: string;
  host: string;
}
export interface ConfiguredShop {
  manifest: string;
  id?: string;
  profile?: ShopProfile;
}
export interface DiscoveryConfig {
  shopDirectoryUrl?: string;
  shops?: ConfiguredShop[];
  defaultShop?: string;
}
export interface Shop {
  manifest: string;
  id?: string;
  info: ShopManifest;
  trusted: boolean;
}
export interface ShopFailure {
  manifest: string;
  id?: string;
  trusted: boolean;
  error: AnnonErrorCode;
}
export interface CatalogEntry {
  name: string;
  fileId: string;
  title: string;
  description: string;
  url: string;
  header: string;
  byteSize: number;
  plaintextSize: number;
  createdAt: number;
  expiresAt: number | null;
  termsHash: string;
  terms: Terms;
  salesStopped: boolean;
  takenDown: boolean;
}
export interface DiscoveryQuery {
  search?: string;
  limit?: number;
  offset?: number;
}
export interface CatalogQuery extends DiscoveryQuery {
  shop?: string;
}
export interface DiscoveryPage<T> {
  items: T[];
  total: number;
  nextOffset: number | null;
}
const MANIFEST_PATH = '/.well-known/annon-shop.json';
function https(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('invalid URL');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new TypeError('invalid discovery URL');
  return url.href;
}
function origin(value: unknown): string {
  const url = new URL(https(value));
  if (url.pathname !== '/') throw new TypeError('service must be an origin');
  return url.origin;
}
export function canonicalManifestUrl(value: string): string {
  return new URL(MANIFEST_PATH, https(value)).href;
}
const alias = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('invalid object');
  return value as Record<string, unknown>;
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string') throw new TypeError('invalid text');
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max)
    throw new TypeError('invalid integer');
}
export function validateDiscoveryConfig(value: unknown): DiscoveryConfig {
  try {
    const c = object(value);
    const out: DiscoveryConfig = {};
    if (c.shopDirectoryUrl !== undefined) out.shopDirectoryUrl = https(c.shopDirectoryUrl);
    if (c.shops !== undefined) {
      if (!Array.isArray(c.shops) || c.shops.length > 100) throw new TypeError('invalid shops');
      const ids = new Set<string>();
      const urls = new Set<string>();
      out.shops = c.shops.map((item) => {
        const s = object(item);
        exactKeys(s, ['manifest', ...['id', 'profile'].filter((key) => Object.hasOwn(s, key))]);
        const manifest = canonicalManifestUrl(s.manifest as string);
        if (urls.has(manifest)) throw new TypeError('duplicate shop');
        urls.add(manifest);
        const shop: ConfiguredShop = { manifest };
        if (s.id !== undefined) {
          if (!alias(s.id) || ids.has(s.id)) throw new TypeError('invalid alias');
          ids.add(s.id);
          shop.id = s.id;
        }
        if (s.profile !== undefined) {
          const p = object(s.profile);
          exactKeys(p, [
            'network',
            'contract',
            'nearRpc',
            'relayer',
            'host',
            ...(Object.hasOwn(p, 'baseRpc') ? ['baseRpc'] : []),
          ]);
          if (p.network !== 'near:mainnet') throw new TypeError('invalid profile network');
          shop.profile = {
            network: p.network,
            contract: account(p.contract as string),
            nearRpc: https(p.nearRpc),
            ...(p.baseRpc !== undefined ? { baseRpc: https(p.baseRpc) } : {}),
            relayer: origin(p.relayer),
            host: origin(p.host),
          };
        }
        return shop;
      });
    }
    if (c.defaultShop !== undefined) {
      text(c.defaultShop);
      if (!out.shops?.some((s) => s.id === c.defaultShop || s.manifest === c.defaultShop))
        throw new TypeError('unknown default shop');
      out.defaultShop = c.defaultShop;
    }
    return out;
  } catch (cause) {
    throw new AnnonError('invalid_config', undefined, { cause });
  }
}
function validateManifest(value: unknown): ShopManifest {
  const m = object(value);
  exactKeys(m, ['version', 'name', 'shopUrl', 'network', 'contract', 'relayer', 'host', 'catalog']);
  const c = object(m.catalog);
  exactKeys(c, ['url', 'format', 'search']);
  if (
    m.version !== 1 ||
    m.network !== 'near:mainnet' ||
    c.format !== 'annon-catalog-array-v1' ||
    c.search !== 'client'
  )
    throw new TypeError('unsupported manifest');
  text(m.name);
  if (!m.name.trim()) throw new TypeError('missing shop name');
  const host = origin(m.host);
  const url = https(c.url);
  if (new URL(url).origin !== host) throw new TypeError('catalog origin mismatch');
  return {
    version: 1,
    name: m.name,
    shopUrl: https(m.shopUrl),
    network: m.network,
    contract: account(m.contract as string),
    relayer: origin(m.relayer),
    host,
    catalog: { url, format: c.format, search: c.search },
  };
}
async function json(url: string, max: number, fetcher: typeof fetch): Promise<unknown> {
  try {
    const r = await fetcher(https(url), {
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (r.status !== 200 || r.redirected || (r.url && r.url !== url) || !r.body)
      throw new AnnonError('bad_response');
    const reader = r.body.getReader();
    try {
      if (Number(r.headers.get('content-length')) > max) throw new AnnonError('too_large');
      let size = 0;
      const parts: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > max) throw new AnnonError('too_large');
        parts.push(value);
      }
      const all = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        all.set(part, offset);
        offset += part.byteLength;
      }
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all));
      } catch (cause) {
        throw new AnnonError('invalid_record', undefined, { cause });
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch (cause) {
    if (cause instanceof AnnonError) throw cause;
    throw new AnnonError('transport', undefined, { cause });
  }
}
export async function readShop(
  shop: ConfiguredShop,
  fetcher: typeof fetch = globalThis.fetch,
): Promise<Shop> {
  const manifest = canonicalManifestUrl(shop.manifest);
  let info: ShopManifest;
  try {
    const raw = object(await json(manifest, 65536, fetcher));
    const p = shop.profile;
    if (
      p &&
      (raw.network !== p.network ||
        raw.contract !== p.contract ||
        origin(raw.relayer) !== p.relayer ||
        origin(raw.host) !== p.host ||
        (raw.nearRpc !== undefined && https(raw.nearRpc) !== p.nearRpc) ||
        (raw.baseRpc !== undefined && https(raw.baseRpc) !== p.baseRpc))
    )
      throw new AnnonError('config_conflict');
    info = validateManifest(raw);
  } catch (cause) {
    if (cause instanceof AnnonError) throw cause;
    throw new AnnonError('invalid_record', undefined, { cause });
  }
  return {
    manifest,
    ...(shop.id !== undefined ? { id: shop.id } : {}),
    info,
    trusted: shop.profile !== undefined,
  };
}
function paging(query: DiscoveryQuery) {
  const { limit = 20, offset = 0, search = '' } = query;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    typeof search !== 'string'
  )
    throw new AnnonError('invalid_arguments');
  return { limit, offset, search: search.toLowerCase() };
}
function page<T>(all: T[], { limit, offset }: { limit: number; offset: number }): DiscoveryPage<T> {
  const items = all.slice(offset, offset + limit);
  const nextOffset = offset + items.length < all.length ? offset + items.length : null;
  return { items, total: all.length, nextOffset };
}
async function configuredShops(
  config: DiscoveryConfig,
  fetcher: typeof fetch,
): Promise<ConfiguredShop[]> {
  const shops = [...(config.shops ?? [])];
  if (config.shopDirectoryUrl) {
    const d = await json(config.shopDirectoryUrl, 262144, fetcher);
    try {
      exactKeys(d, ['version', 'shops']);
      if (d.version !== 1 || !Array.isArray(d.shops)) throw new TypeError('invalid directory');
      if (d.shops.length > 100) throw new AnnonError('too_large');
      for (const entry of d.shops) {
        exactKeys(entry, ['manifest']);
        const manifest = canonicalManifestUrl(entry.manifest as string);
        if (!shops.some((s) => s.manifest === manifest)) shops.push({ manifest });
      }
    } catch (cause) {
      if (cause instanceof AnnonError) throw cause;
      throw new AnnonError('invalid_record', undefined, { cause });
    }
  }
  return shops;
}
export async function listShops(
  config: DiscoveryConfig = {},
  query: DiscoveryQuery = {},
  fetcher: typeof fetch = globalThis.fetch,
): Promise<DiscoveryPage<Shop | ShopFailure>> {
  const q = paging(query);
  const c = validateDiscoveryConfig(config);
  const shops = await configuredShops(c, fetcher);
  const all: (Shop | ShopFailure)[] = new Array(shops.length);
  let next = 0;
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(4, shops.length) }, async () => {
      while (next < shops.length) {
        const index = next++;
        const shop = present(shops[index]);
        try {
          all[index] = await readShop(shop, fetcher);
        } catch (error) {
          if (shop.profile && error instanceof AnnonError && error.code === 'config_conflict')
            throw error;
          all[index] = {
            manifest: shop.manifest,
            ...(shop.id !== undefined ? { id: shop.id } : {}),
            trusted: !!shop.profile,
            error: toPublicError(error).code,
          };
        }
      }
    }),
  );
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  return page(
    all.filter((shop) =>
      ('info' in shop ? shop.info.name : (shop.id ?? shop.manifest))
        .toLowerCase()
        .includes(q.search),
    ),
    q,
  );
}
function validateCatalog(value: unknown, shop: ShopManifest): CatalogEntry[] {
  if (!Array.isArray(value)) throw new TypeError('invalid catalog');
  if (value.length > 10000) throw new AnnonError('too_large');
  return value.map((item) => {
    exactKeys(item, [
      'name',
      'fileId',
      'title',
      'description',
      'url',
      'header',
      'byteSize',
      'plaintextSize',
      'createdAt',
      'expiresAt',
      'termsHash',
      'terms',
      'salesStopped',
      'takenDown',
    ]);
    for (const key of ['name', 'title', 'description']) text(item[key]);
    bytes(item.fileId as string, 32);
    bytes(item.termsHash as string, 32);
    for (const key of ['url', 'header'])
      if (new URL(https(item[key])).origin !== shop.host) throw new AnnonError('config_conflict');
    integer(item.byteSize, MAX_PAY2_BYTES);
    integer(item.plaintextSize, MAX_PLAINTEXT_BYTES);
    integer(item.createdAt);
    if (item.expiresAt !== null) {
      integer(item.expiresAt);
      if (item.expiresAt < item.createdAt) throw new TypeError('invalid expiry');
    }
    if (typeof item.salesStopped !== 'boolean' || typeof item.takenDown !== 'boolean')
      throw new TypeError('invalid listing flags');
    const terms = item.terms as Terms;
    if (terms.contract !== shop.contract || terms.network !== shop.network)
      throw new AnnonError('config_conflict');
    if (terms.file_id !== item.fileId || termsHash(terms) !== item.termsHash)
      throw new TypeError('invalid catalog terms');
    return item as unknown as CatalogEntry;
  });
}
export async function catalog(
  config: DiscoveryConfig,
  query: CatalogQuery = {},
  fetcher: typeof fetch = globalThis.fetch,
): Promise<DiscoveryPage<CatalogEntry>> {
  const q = paging(query);
  const c = validateDiscoveryConfig(config);
  const selected = query.shop ?? c.defaultShop;
  if (typeof selected !== 'string' || !selected) throw new AnnonError('invalid_arguments');
  const local = c.shops?.find((s) => s.id === selected || s.manifest === selected);
  const found = local ?? (await configuredShops(c, fetcher)).find((s) => s.manifest === selected);
  if (!found) throw new AnnonError('invalid_arguments');
  const shop = await readShop(found, fetcher);
  let all: CatalogEntry[];
  try {
    all = validateCatalog(await json(shop.info.catalog.url, 8388608, fetcher), shop.info);
  } catch (cause) {
    if (cause instanceof AnnonError) throw cause;
    throw new AnnonError('invalid_record', undefined, { cause });
  }
  all = all.filter((e) =>
    [e.name, e.title, e.description].some((s) => s.toLowerCase().includes(q.search)),
  );
  all.sort(
    (a, b) => b.createdAt - a.createdAt || (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0),
  );
  return page(all, q);
}
