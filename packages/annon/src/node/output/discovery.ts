/** Human output for `shops`, `shop add` and `catalog`. */
import { usdc } from '../../settle-near/codec.js';
import type { CatalogEntry, Shop, ShopFailure, ShopRules } from '../../shops/discovery.js';
import type { Input } from '../cli.js';
import { cleanText, short, table, truncate } from './text.js';

type Page<T> = { items: T[]; total: number; nextOffset: number | null };
const more = (page: Page<unknown>) =>
  page.nextOffset === null ? [] : [`More: add --offset ${page.nextOffset}`];

export function shopsText(page: Page<Shop | ShopFailure>): string {
  if (page.items.length === 0)
    return 'No shops configured. Add one with: annon shop add <shop url> --id <name>';
  return [
    `Shops (${page.total}):`,
    table(
      page.items.map((shop) => [
        ` ${cleanText(shop.id ?? '-')}`,
        'info' in shop ? cleanText(shop.info.name) : `unavailable (${shop.error})`,
        'info' in shop ? shop.info.shopUrl : shop.manifest,
        shop.trusted ? 'trusted profile' : '',
      ]),
    ),
    ...more(page),
  ].join('\n');
}

export const shopAddedText = (r: { manifest: string; id?: string; trusted: boolean }) =>
  `Shop added${r.id ? ` as ${cleanText(r.id)}` : ''}: ${r.manifest}\nList its files with: annon catalog --shop ${cleanText(r.id ?? r.manifest)}`;

/** Row numbers count from the start of the listing, so `buy <n>` means the same row on any page. */
export const rowNumber = (input: Input, index: number) => (input.offset ?? 0) + index + 1;

const routes = (e: CatalogEntry) =>
  e.takenDown
    ? 'taken down'
    : e.salesStopped
      ? 'sales stopped'
      : ['near', ...(e.terms.base ? ['base'] : []), '1click'].join(', ');
const day = (seconds: number | null) =>
  seconds === null ? '-' : new Date(seconds * 1000).toISOString().slice(0, 10);

/** The shop's rules in one line; the full text stays in `--json` and is shown by `share`. */
const rulesLine = (shop: { name: string } | undefined, rules: ShopRules) =>
  `Shop rules${shop ? ` (${cleanText(shop.name)})` : ''}: ${truncate(cleanText(rules.text).replace(/\s+/g, ' ').trim(), 160)}`;

export function catalogText(
  input: Input,
  page: Page<CatalogEntry> & { shop?: { manifest: string; name: string }; rules?: ShopRules },
): string {
  if (page.items.length === 0) return page.total === 0 ? 'No files.' : 'No files on this page.';
  const first = rowNumber(input, 0);
  const shop = input.shop === undefined ? '' : ` --shop ${input.shop}`;
  return [
    `Files ${first} to ${first + page.items.length - 1} of ${page.total}:`,
    table([
      [' #', 'Title', 'Price', 'Routes', 'Seller', 'Expires'],
      ...page.items.map((e, i) => [
        String(rowNumber(input, i)).padStart(2),
        truncate(cleanText(e.title || e.name), 40),
        `${usdc(e.terms.near.price)} USDC`,
        routes(e),
        short(cleanText(`${e.terms.seller.kind}:${e.terms.seller.id}`)),
        day(e.expiresAt),
      ]),
    ]),
    ...(page.rules ? [rulesLine(page.shop, page.rules)] : []),
    ...more(page),
    `Buy a row with: annon buy <#>${shop}${input.search === undefined ? '' : ` --search ${JSON.stringify(input.search)}`}`,
  ].join('\n');
}
