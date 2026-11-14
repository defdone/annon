import { describe, expect, it } from 'vitest';
import { filePage, sellerText, usdc, wantsPage } from './file-page.ts';

const headers = (h: Record<string, string>) => (name: string) =>
  Object.entries(h).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] ?? null;
const FILE_ID = `0x${'ab'.repeat(32)}`;

describe('file page', () => {
  it('answers with a page only to browser navigations', () => {
    const chrome =
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
    expect(wantsPage(headers({ Accept: chrome }))).toBe(true);
    expect(wantsPage(headers({ Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }))).toBe(true);
    expect(wantsPage(headers({ Accept: 'TEXT/HTML' }))).toBe(true);
    for (const accept of [
      '',
      '*/*',
      'application/json',
      'application/json, text/html',
      'text/html;q=0.5, application/json',
      'text/html;q=0',
      'text/htmlx',
      'application/octet-stream',
    ])
      expect(wantsPage(headers({ Accept: accept })), accept).toBe(false);
    expect(wantsPage(headers({}))).toBe(false);
    for (const h of ['PAYMENT-SIGNATURE', 'Annon-Buyer-Proof', 'Range'])
      expect(wantsPage(headers({ Accept: chrome, [h]: 'x' })), h).toBe(false);
  });

  it('formats USDC prices and short seller identities', () => {
    expect(usdc(100000n)).toBe('0.10');
    expect(usdc(1_000_000n)).toBe('1.00');
    expect(usdc(1_234_567n)).toBe('1.234567');
    expect(usdc(10n)).toBe('0.00001');
    expect(usdc(0n)).toBe('0.00');
    expect(sellerText({ kind: 'near', id: 'seller.near' })).toBe('NEAR seller.near');
    expect(sellerText({ kind: 'evm', id: `0x${'12'.repeat(19)}ab` })).toBe('EVM 0x1212...12ab');
    expect(sellerText({ kind: 'near', id: `${'a'.repeat(40)}.near` })).toBe(
      `NEAR ${'a'.repeat(12)}...${'a'.repeat(5)}.near`,
    );
  });

  it('escapes every field and loads nothing from outside', () => {
    const evil = `"><script>alert(1)</script><img src=x onerror=alert('x')>&`;
    const html = filePage(
      { fileId: FILE_ID, title: evil, description: evil, url: `https://h.example/f/a"<b>` },
      'offer',
      { price: 100000n, seller: { kind: 'near', id: 'seller.near' }, routes: ['near', '1click'] },
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&#39;x&#39;');
    expect(html).toContain('annon buy https://h.example/f/a&quot;&lt;b&gt; --route near');
    expect(html).toContain(`href="https://annon.dev/demo#file=${FILE_ID}"`);
    const clean = filePage({ fileId: FILE_ID, title: 'T', url: 'https://h.example/f/t' }, 'offer');
    expect(clean).not.toMatch(/src=|<link|<script|@import|url\(/i);
    // The resource URL repeats once per command; no other address appears.
    expect([...new Set(html.match(/https?:\/\/[^\s"<]+/g))]).toEqual([
      `https://annon.dev/demo#file=${FILE_ID}`,
      'https://h.example/f/a&quot;&lt;b&gt;',
    ]);
  });

  const file = { fileId: FILE_ID, title: 'T', url: 'https://h.example/f/t' };
  const offer = (routes: ('near' | 'base' | '1click')[]) =>
    filePage(file, 'offer', { price: 100000n, seller: { kind: 'near', id: 's.near' }, routes });
  const near = 'annon buy https://h.example/f/t --route near';
  const base = 'annon buy https://h.example/f/t --route base';
  const other = 'annon buy https://h.example/f/t --from-chain solana';

  it('lists one buy command per route the offer has', () => {
    const all = offer(['near', 'base', '1click']);
    expect(all).toContain('<h2>Buy with the command line</h2>');
    for (const command of [near, base, other])
      expect(all).toContain(`<code class="cmd">${command}</code>`);
    expect(all.indexOf(near)).toBeLessThan(all.indexOf(base));
    expect(all.indexOf(base)).toBeLessThan(all.indexOf(other));
    expect(all).toContain(
      '<code>--from-chain</code> takes solana, ethereum, arbitrum, optimism, polygon, avalanche and other chains 1Click supports.',
    );
    expect(all).toContain(
      'The route decides which wallet signs: a NEAR account for NEAR, an EVM wallet for Base.',
    );
    // A file without Base terms (a NEAR or Solana seller) gets no Base command.
    const noBase = offer(['near', '1click']);
    expect(noBase).toContain(near);
    expect(noBase).toContain(other);
    expect(noBase).not.toContain('--route base');
    expect(noBase).not.toContain('<span class="r">Base</span>');
    // Without the chain the routes are unknown: only the ones every file has.
    const unknown = filePage(file, 'offer');
    expect(unknown).toContain(near);
    expect(unknown).toContain(other);
    expect(unknown).not.toContain('--route base');
  });

  it('wraps commands instead of scrolling them sideways', () => {
    const html = offer(['near', 'base', '1click']);
    expect(html.match(/<code class="cmd">/g)).toHaveLength(3);
    expect(html).toMatch(/\.cmd\{[^}]*overflow-wrap:anywhere/);
    expect(html).toMatch(/\.cmd\{[^}]*white-space:normal/);
    expect(html).not.toMatch(/overflow-x|white-space:pre|<pre/);
  });

  it('tells earlier buyers how to open or recover the file', () => {
    const line =
      '<h2>Already bought it?</h2><p>Open it in the demo shop under My purchases in the browser you bought it with, or recover it with the same wallet: <code>annon recover --help</code>.</p>';
    expect(offer(['near', '1click'])).toContain(line);
    expect(filePage(file, 'stopped')).toContain(line);
    for (const state of ['taken_down', 'expired'] as const) {
      const html = filePage(file, state);
      expect(html, state).not.toContain('Already bought it?');
      expect(html, state).not.toContain('annon buy');
    }
  });

  it('uses the annon.dev print style and draws the mark inline', () => {
    const html = offer(['near']);
    expect(html).toContain('<p class="k">Annon file</p>');
    expect(html).toContain('<svg width="28" height="28" viewBox="0 0 120 120" aria-hidden="true"');
    expect(html).not.toMatch(/border-radius/);
    for (const color of ['#faf8f2', '#111111', '#b3261e', '#d9d3c7', '#f1ede3'])
      expect(html).toContain(color);
    expect(html).toContain('Newsreader,"Iowan Old Style",Georgia,serif');
    expect(html).toContain('"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,monospace');
  });
});
