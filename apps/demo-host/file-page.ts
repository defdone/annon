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

const STYLE =
  'body{margin:0;background:#faf8f2;color:#111111;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}' +
  'main{max-width:40rem;margin:0 auto;padding:3rem 1rem}' +
  'h1{font:400 2rem/1.2 Georgia,"Times New Roman",serif;margin:.3rem 0 1rem;overflow-wrap:anywhere}' +
  '.k{color:#b3261e;font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;margin:0}' +
  'dl{display:grid;grid-template-columns:auto 1fr;gap:.3rem 1rem;margin:1.5rem 0}dt{color:#555}dd{margin:0;overflow-wrap:anywhere}' +
  'a.b{display:inline-block;background:#b3261e;color:#faf8f2;text-decoration:none;padding:.6rem 1.1rem;border-radius:4px;margin:.5rem 0 1.5rem}' +
  'a{color:#b3261e}pre,code{font:14px/1.5 ui-monospace,Menlo,monospace}' +
  'pre{background:#f0ece1;padding:.8rem;border-radius:4px;overflow-x:auto;white-space:pre}' +
  '.n{color:#555;font-size:.85rem;margin-top:2rem}';

const routeNames = { near: 'NEAR', base: 'Base', '1click': '1Click (from another chain)' };

/** The page for a file. Every value from the listing or the chain is escaped. */
export function filePage(
  f: PageFile,
  state: PageState,
  info?: { price: bigint; seller: FileInfo['seller']; routes: (keyof typeof routeNames)[] },
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
  const body =
    state === 'offer'
      ? `<p>This file is encrypted. Buy it in the Annon demo shop, or with the command line.</p>
<a class="b" href="${esc(`${DEMO_SHOP}#file=${f.fileId}`)}">Buy in the demo shop</a>
<pre>annon buy ${esc(f.url)} --route near</pre>`
      : state === 'stopped'
        ? '<p>The seller has stopped selling this file. Earlier buyers can still download it with the command line.</p>'
        : state === 'taken_down'
          ? '<p>This file was taken down and is no longer available.</p>'
          : '<p>This hosted file has expired and is no longer available.</p>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(f.title)} | Annon</title><style>${STYLE}</style></head>
<body><main><p class="k">Annon file</p><h1>${esc(f.title)}</h1>${f.description ? `<p>${esc(f.description)}</p>` : ''}
<dl>${rows}</dl>
${body}${state === 'offer' || state === 'stopped' ? '\n<p class="n">Agents and the Annon SDK read the x402 offer from the PAYMENT-REQUIRED header of this URL.</p>' : ''}</main></body></html>`;
}
