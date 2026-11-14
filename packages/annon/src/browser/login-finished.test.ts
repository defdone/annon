import { createContext, runInContext } from 'node:vm';
import { build } from 'esbuild';
import { privateKeyToAccount } from 'viem/accounts';
import { expect, it, vi } from 'vitest';
import { browserBuildOptions } from '../../scripts/build-browser.js';
import { type FakeElement, fakeDocument } from '../../test/login-page.js';

it.each([false, true])(
  'accepted result stops requests when the server disappears; next step: %s',
  async (next) => {
    const asset =
      (await build({ ...browserBuildOptions, write: false })).outputFiles?.[0]?.text ?? '';
    const elements = new Map<string, FakeElement>();
    const timers: (() => void)[] = [];
    const synthetic = privateKeyToAccount(`0x${'11'.repeat(32)}`);
    const address = synthetic.address;
    const action = {
      id: 'proof',
      operation: 'evm.personalSign',
      account: address,
      chain: 'eip155:8453',
      expiresAt: Date.now() + 60000,
      payload: { message: 'proof' },
    };
    const fetcher = vi.fn(async (url: string) => {
      if (url === '/api/action') return Response.json({ pairingCode: '123', action });
      if (url === '/api/result')
        return {
          ok: true,
          json: async () => {
            if (next)
              return { action: { ...action, id: 'transfer', payload: { message: 'transfer' } } };
            throw new TypeError('Failed to fetch');
          },
        };
      throw new TypeError('Failed to fetch');
    });
    const context = createContext({
      TextEncoder,
      TextDecoder,
      Uint8Array,
      URL,
      URLSearchParams,
      AbortController,
      location: { hash: '#CAP', pathname: '/' },
      history: { replaceState() {} },
      document: fakeDocument(elements),
      addEventListener() {},
      fetch: fetcher,
      setTimeout: (fn: () => void) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimeout() {},
      ethereum: {
        request: async ({ method }: { method: string }) =>
          method === 'eth_chainId'
            ? '0x2105'
            : method === 'personal_sign'
              ? synthetic.signMessage({ message: 'proof' })
              : [address],
      },
    });
    runInContext('globalThis.window = globalThis; globalThis.self = globalThis;', context);
    runInContext(asset, context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await elements.get('approve')?.onclick?.();
    for (const timer of timers) timer();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/action', '/api/result']);
    if (next) {
      expect(elements.get('steps')?.children).toHaveLength(1);
      expect(elements.get('approve')?.disabled).toBe(false);
      expect(elements.get('message')?.textContent).toBe('transfer');
    } else expect(elements.get('status')?.textContent).toBe('Signed. Return to the terminal.');
  },
);
