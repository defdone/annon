/**
 * A readable page for a person who opens a file URL in a browser. Only the body changes: the status
 * and every header the SDK and agents read (the offer stays in `PAYMENT-REQUIRED`) are kept, and a
 * request that does not ask for HTML gets exactly the answer it got before.
 */
import { BUYER_PROOF_HEADER } from '../../packages/annon/src/download/proof.ts';
import type { FileInfo } from '../../packages/annon/src/near/rpc.ts';
import { identityText } from '../../packages/annon/src/settle-near/identity.ts';

export const DEMO_SHOP = 'https://annon.dev/demo';

export const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

/** The q value of a media range in an Accept header, 0 when it is not listed. */
function quality(accept: string, type: string): number {
  let best = 0;
  for (const part of accept.split(',')) {
    const [range, ...params] = part.split(';').map((s) => s.trim().toLowerCase());
    if (range !== type) continue;
    const q = params.find((p) => p.startsWith('q='));
    const value = q === undefined ? 1 : Number(q.slice(2));
    if (Number.isFinite(value)) best = Math.max(best, value);
  }
  return best;
}

/**
 * A browser navigation: it asks for text/html over JSON and carries none of the headers an Annon
 * client sends (payment, buyer proof, range).
 */
export function wantsPage(get: (name: string) => string | null): boolean {
  if (get('PAYMENT-SIGNATURE') || get(BUYER_PROOF_HEADER) || get('Range')) return false;
  const accept = get('Accept') ?? '';
  const html = quality(accept, 'text/html');
  return html > 0 && html > quality(accept, 'application/json');
}

/** 6-decimal USDC units as a price: at least two decimals, no trailing zeros beyond them. */
export function usdc(units: bigint): string {
  const fraction = String(units % 1_000_000n)
    .padStart(6, '0')
    .replace(/0{1,4}$/, '');
  return `${units / 1_000_000n}.${fraction.padEnd(2, '0')}`;
}

const shorten = (id: string, keep: number) =>
  id.length <= keep * 2 + 3 ? id : `${id.slice(0, keep + 2)}...${id.slice(-keep)}`;

/** `NEAR seller.near`, `EVM 0x1234...abcd` or `Solana AbCdEf...WxYz`. */
export function sellerText(seller: FileInfo['seller']): string {
  const text = identityText(seller);
  const at = text.indexOf(' ');
  const kind = text.slice(0, at);
  const id = text.slice(at + 1);
  return `${kind} ${kind === 'NEAR' ? shorten(id, 10) : shorten(id, 4)}`;
}

export interface PageFile {
  /** Empty when only an expired slug is known. */
  fileId: string;
  title: string;
  description?: string;
  /** The public file URL, as the offer's `resource.url`. */
  url: string;
}
export type PageState = 'offer' | 'stopped' | 'taken_down' | 'expired';

const SERIF = 'Newsreader,"Iowan Old Style",Georgia,serif';
const MONO = '"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,monospace';

/** The annon.dev "printed standard": paper, ink and one red, square corners, thin rules. */
const STYLE =
  `*{box-sizing:border-box}body{margin:0;background:#faf8f2;color:#111111;font:18px/1.55 ${SERIF}}` +
  '.top{border-bottom:1px solid #111111}' +
  '.bar{max-width:760px;margin:0 auto;padding:14px 16px;display:flex;align-items:center;gap:10px;font-size:24px;font-weight:600;line-height:1;letter-spacing:-.01em}' +
  'main{max-width:760px;margin:0 auto;padding:40px 16px 64px}' +
  'h1{font-weight:400;font-size:clamp(32px,6vw,48px);line-height:1.08;letter-spacing:-.01em;margin:12px 0 16px;overflow-wrap:anywhere}' +
  'h2{font-weight:400;font-size:24px;line-height:1.2;margin:0 0 16px}' +
  `p{margin:0 0 12px}.lead{color:#2e2c28;font-size:20px;overflow-wrap:anywhere}a{color:#b3261e}` +
  `.k,dt,.r,.b,.n,code{font-family:${MONO}}` +
  '.k{color:#b3261e;font-size:13px;letter-spacing:.08em;text-transform:uppercase;margin:0}' +
  'dl{display:grid;grid-template-columns:max-content 1fr;margin:28px 0;border-top:1px solid #d9d3c7}' +
  'dt,dd{margin:0;padding:10px 0;border-bottom:1px solid #d9d3c7}' +
  'dt{padding-right:24px;color:#4a4741;font-size:13px;letter-spacing:.06em;text-transform:uppercase;line-height:1.9}' +
  'dd{color:#2e2c28;overflow-wrap:anywhere}' +
  '.b{display:inline-block;background:#b3261e;color:#ffffff;text-decoration:none;font-size:15px;padding:12px 18px;margin:8px 0 0}.b:hover{background:#111111}' +
  'section{margin-top:40px;padding-top:24px;border-top:1px solid #111111}' +
  'ul{list-style:none;margin:0 0 16px;padding:0;border-top:1px solid #d9d3c7}li{padding:12px 0;border-bottom:1px solid #d9d3c7}' +
  '.r{display:block;color:#4a4741;font-size:12px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px}' +
  'code{font-size:14px;line-height:1.5;background:#f1ede3;padding:1px 4px}' +
  '.cmd{display:block;padding:10px 12px;white-space:normal;overflow-wrap:anywhere}' +
  '.note{color:#4a4741;font-size:15px;margin:8px 0 0}' +
  '.n{color:#4a4741;font-size:13px;margin:40px 0 0;padding-top:16px;border-top:1px solid #d9d3c7}' +
  '@media (max-width:520px){dl{grid-template-columns:1fr}dt{border-bottom:0;padding-bottom:0}dd{padding-top:2px}}';

/** The gate arch from annon.dev, drawn inline: the CSP loads nothing. */
const MARK =
  '<svg width="28" height="28" viewBox="0 0 120 120" aria-hidden="true" focusable="false">' +
  '<path d="M18 112 V58 A42 42 0 0 1 102 58 V112" fill="none" stroke="#111111" stroke-width="9"/>' +
  '<path d="M38 112 V62 A22 22 0 0 1 82 62 V112" fill="none" stroke="#b3261e" stroke-width="9"/></svg>';

type Route = 'near' | 'base' | '1click';
const routeNames: Record<Route, string> = {
  near: 'NEAR',
  base: 'Base',
  '1click': '1Click (from another chain)',
};

/** One `annon buy` line per route the offer lists; real CLI flags only (packages/annon/CLI.md). */
function commands(url: string, routes: Route[]): string {
  const line = (label: string, flags: string, note = '') =>
    `<li><span class="r">${esc(label)}</span><code class="cmd">annon buy ${esc(url)} ${flags}</code>${note}</li>`;
  return [
    ...(routes.includes('near') ? [line('NEAR', '--route near')] : []),
    ...(routes.includes('base') ? [line('Base', '--route base')] : []),
    ...(routes.includes('1click')
      ? [
          line(
            'Another chain',
            '--from-chain solana',
            '<p class="note"><code>--from-chain</code> takes solana, ethereum, arbitrum, optimism, polygon, avalanche and other chains 1Click supports.</p>',
          ),
        ]
      : []),
  ].join('');
}

const ALREADY_BOUGHT =
  '<section><h2>Already bought it?</h2><p>Open it in the demo shop under My purchases in the browser you bought it with, or recover it with the same wallet: <code>annon recover --help</code>.</p></section>';

/** The page for a file. Every value from the listing or the chain is escaped. */
export function filePage(
  f: PageFile,
  state: PageState,
  info?: { price: bigint; seller: FileInfo['seller']; routes: Route[] },
): string {
  let seller = '';
  try {
    if (info) seller = sellerText(info.seller);
  } catch {
    /* An unreadable identity is left out. */
  }
  const rows = [
    ...(info && state === 'offer' ? [['Price', `${usdc(info.price)} USDC`]] : []),
    ...(seller ? [['Seller', seller]] : []),
    ...(info && state === 'offer'
      ? [['Routes', info.routes.map((r) => routeNames[r]).join(', ')]]
      : []),
    ...(f.fileId ? [['File ID', f.fileId]] : []),
  ]
    .map(([k, v]) => `<dt>${esc(k as string)}</dt><dd>${esc(v as string)}</dd>`)
    .join('');
  // Without the chain the routes are unknown; NEAR and 1Click are offered for every file.
  const routes: Route[] = info?.routes ?? ['near', '1click'];
  const body =
    state === 'offer'
      ? `<p>This file is encrypted. Buy it in the Annon demo shop, or with the command line.</p>
<a class="b" href="${esc(`${DEMO_SHOP}#file=${f.fileId}`)}">Buy in the demo shop</a>
<section><h2>Buy with the command line</h2><ul>${commands(f.url, routes)}</ul>
<p>The route decides which wallet signs: a NEAR account for NEAR, an EVM wallet for Base.</p></section>
${ALREADY_BOUGHT}`
      : state === 'stopped'
        ? `<p>The seller has stopped selling this file. Earlier buyers can still download it with the command line.</p>
${ALREADY_BOUGHT}`
        : state === 'taken_down'
          ? '<p>This file was taken down and is no longer available.</p>'
          : '<p>This hosted file has expired and is no longer available.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(f.title)} | Annon</title><style>${STYLE}</style></head>
<body><header class="top"><div class="bar">${MARK}<span>annon</span></div></header>
<main><p class="k">Annon file</p><h1>${esc(f.title)}</h1>${f.description ? `<p class="lead">${esc(f.description)}</p>` : ''}
<dl>${rows}</dl>
${body}${state === 'offer' || state === 'stopped' ? '\n<p class="n">Agents and the Annon SDK read the x402 offer from the PAYMENT-REQUIRED header of this URL.</p>' : ''}</main></body></html>`;
}
