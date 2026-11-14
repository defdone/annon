import { readFile } from 'node:fs/promises';
import { createContext, runInContext, runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { expect, it, vi } from 'vitest';
import { browserBuildOptions } from '../../scripts/build-browser.js';
import { type FakeElement, fakeDocument } from '../../test/login-page.js';

it('bundled page starts with dynamic code generation disabled by CSP and no persistent capabilities', async () => {
  const asset =
    (await build({ ...browserBuildOptions, write: false })).outputFiles?.[0]?.text ?? '';
  if (!asset) throw new Error('empty browser bundle');
  const elements = new Map<string, FakeElement>();
  const localStorage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
  const context = createContext(
    {
      console,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      URL,
      URLSearchParams,
      AbortController,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      location: { hash: '', pathname: '/' },
      fetch: async () => Response.json({ capability: '' }),
      history: { replaceState: vi.fn() },
      addEventListener: vi.fn(),
      document: fakeDocument(elements),
      localStorage,
    },
    { codeGeneration: { strings: false, wasm: false } },
  );
  runInContext('globalThis.window = globalThis; globalThis.self = globalThis;', context);
  runInContext(asset, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(elements.get('status')?.textContent).toContain('exact URL');
  expect(localStorage.setItem).not.toHaveBeenCalled();
});

it('callback sends only an opaque action nonce and result to its same-origin opener, with no API credential', async () => {
  const asset =
    (await build({ ...browserBuildOptions, write: false })).outputFiles?.[0]?.text ?? '';
  const fetcher = vi.fn(),
    postMessage = vi.fn(),
    replaceState = vi.fn();
  const context = createContext(
    {
      console,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      URL,
      URLSearchParams,
      AbortController,
      fetch: fetcher,
      setTimeout: vi.fn(),
      clearTimeout,
      setInterval: vi.fn(),
      clearInterval,
      location: {
        hash: '#accountId=bot.near&publicKey=ed25519%3Afake&signature=encoded&state=opaque-action-nonce',
        pathname: '/callback',
        origin: 'http://127.0.0.1:1234',
      },
      history: { replaceState },
      document: fakeDocument(new Map()),
      opener: { postMessage },
    },
    { codeGeneration: { strings: false, wasm: false } },
  );
  runInContext('globalThis.window = globalThis; globalThis.self = globalThis;', context);
  runInContext(asset, context);
  expect(postMessage).toHaveBeenCalledWith(
    {
      type: 'annon-wallet-result',
      state: 'opaque-action-nonce',
      result: { accountId: 'bot.near', publicKey: 'ed25519:fake', signature: 'encoded' },
    },
    'http://127.0.0.1:1234',
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(replaceState).toHaveBeenCalledWith(null, '', '/callback');
});

it('the approval session API omits credentials and rejects redirects', async () => {
  const source = await readFile(new URL('./login.ts', import.meta.url), 'utf8');
  const api = source
    .slice(source.indexOf('const api = async'), source.indexOf('/** Requests whose result'))
    .replace('path: string, body?: unknown, accepted?: () => void', 'path, body, accepted');
  const fetcher = vi.fn(async () => Response.json({ ok: true }));
  await runInNewContext(`${api}\napi('/api/action')`, {
    fetch: fetcher,
    capability: 'synthetic-capability',
  });
  expect(fetcher).toHaveBeenCalledWith(
    '/api/action',
    expect.objectContaining({
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      headers: expect.objectContaining({ authorization: 'Bearer synthetic-capability' }),
    }),
  );
});
