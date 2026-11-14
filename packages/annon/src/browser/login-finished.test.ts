import { createContext, runInContext } from 'node:vm';
import { build } from 'esbuild';
import { privateKeyToAccount } from 'viem/accounts';
import { expect, it, vi } from 'vitest';
import { browserBuildOptions } from '../../scripts/build-browser.js';
import { type FakeElement, fakeDocument } from '../../test/login-page.js';

async function page(resultBody: () => Promise<unknown>, resultOk = true, nextPoll: unknown = null) {
  const asset =
    (await build({ ...browserBuildOptions, write: false })).outputFiles?.[0]?.text ?? '';
  const elements = new Map<string, FakeElement>();
  const timers: (() => void)[] = [];
  const synthetic = privateKeyToAccount(`0x${'11'.repeat(32)}`);
  const action = {
    id: 'proof',
    operation: 'evm.personalSign',
    account: synthetic.address,
    chain: 'eip155:8453',
    expiresAt: Date.now() + 60000,
    payload: { message: 'proof' },
  };
  const fetcher = vi.fn(async (url: string) => {
    if (url === '/api/action') {
      if (nextPoll === 'fail') throw new TypeError('Failed to fetch');
      return Response.json({ pairingCode: '123', action: nextPoll });
    }
    if (url === '/api/result') return { ok: resultOk, json: resultBody };
    throw new TypeError('Failed to fetch');
  });
  fetcher.mockImplementationOnce(async () => Response.json({ pairingCode: '123', action }));
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
            : [synthetic.address],
    },
  });
  runInContext('globalThis.window = globalThis; globalThis.self = globalThis;', context);
  runInContext(asset, context);
  await new Promise((r) => setTimeout(r, 0));
  await elements.get('approve')?.onclick?.();
  await new Promise((r) => setTimeout(r, 0));
  const flush = async () => {
    const t = timers.splice(0);
    for (const f of t) f();
    await new Promise((r) => setTimeout(r, 0));
  };
  return { elements, fetcher, flush };
}

it('keeps Signed when polling fails after acceptance', async () => {
  const p = await page(
    async () => {
      throw new TypeError('lost body');
    },
    true,
    'fail',
  );
  await p.flush();
  expect(p.elements.get('status')?.textContent).toMatch(/^Signed\. Return to the terminal/);
});
it('recovers the next request when the accepted follow body is lost', async () => {
  const next = {
    id: 'next',
    operation: 'evm.personalSign',
    account: '0x0',
    chain: 'eip155:8453',
    expiresAt: Date.now() + 60000,
    payload: { message: 'next' },
  };
  const p = await page(
    async () => {
      throw new TypeError('lost body');
    },
    true,
    next,
  );
  await p.flush();
  expect(p.elements.get('message')?.textContent).toBe('next');
  expect(p.elements.get('approve')?.disabled).toBe(false);
});
it('polls after follow delivers a step and shows its expiry', async () => {
  const next = {
    id: 'next',
    operation: 'evm.personalSign',
    account: '0x0',
    chain: 'eip155:8453',
    expiresAt: Date.now() + 50,
    payload: { message: 'next' },
  };
  const p = await page(async () => ({ action: next }));
  await new Promise((resolve) => setTimeout(resolve, 60));
  await p.flush();
  expect(p.elements.get('status')?.textContent).toContain('expired');
  expect(p.elements.get('approve')?.disabled).toBe(true);
});
it('rejects non-OK results without finishing or resuming', async () => {
  const p = await page(async () => ({}), false);
  await p.flush();
  expect(p.elements.get('status')?.textContent).toBe(
    'The CLI did not accept the wallet result. Check the terminal for the reason.',
  );
  expect(p.elements.get('steps')?.children).toHaveLength(0);
  expect(p.elements.get('step-state')?.textContent).not.toBe('Done');
  expect(p.elements.get('summary')?.hidden).toBe(false);
  expect(p.fetcher.mock.calls.map(([url]) => url)).toEqual(['/api/action', '/api/result']);
});
