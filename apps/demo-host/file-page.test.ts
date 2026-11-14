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
    expect(html.match(/https?:\/\/[^\s"<]+/g)).toEqual([
      `https://annon.dev/demo#file=${FILE_ID}`,
      'https://h.example/f/a&quot;&lt;b&gt;',
    ]);
  });
});
