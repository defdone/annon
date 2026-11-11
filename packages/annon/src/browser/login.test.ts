import { createContext, runInContext } from 'node:vm';
import { build } from 'esbuild';
import { expect, it, vi } from 'vitest';
import { browserBuildOptions } from '../../scripts/build-browser.js';

it('bundled page starts with dynamic code generation disabled by CSP and no persistent capabilities', async () => {
  const asset =
    (await build({ ...browserBuildOptions, write: false })).outputFiles?.[0]?.text ?? '';
  if (!asset) throw new Error('empty browser bundle');
  const elements = new Map<string, { textContent: string; disabled?: boolean }>();
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
      document: {
        getElementById: (id: string) => {
          const e = { textContent: '' };
          elements.set(id, e);
          return e;
        },
      },
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
      document: { getElementById: () => ({ textContent: '' }) },
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

it('starts a wallet action only once even with repeated clicks while approval is pending', async () => {
  const asset =
    (await build({ ...browserBuildOptions, write: false })).outputFiles?.[0]?.text ?? '';
  const address = `0x${'11'.repeat(20)}`;
  const elements = new Map<
    string,
    { textContent: string; disabled: boolean; onclick?: () => Promise<void> }
  >();
  const provider = {
    request: vi.fn(async ({ method }: { method: string }) =>
      method === 'eth_requestAccounts' || method === 'eth_accounts'
        ? [address]
        : method === 'eth_chainId'
          ? '0x2105'
          : new Promise(() => {}),
    ),
  };
  const context = createContext(
    {
      console,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      URL,
      URLSearchParams,
      AbortController,
      setTimeout: vi.fn(),
      clearTimeout,
      setInterval: vi.fn(),
      clearInterval,
      location: { hash: '#CAP', pathname: '/' },
      history: { replaceState: vi.fn() },
      ethereum: provider,
      fetch: async () =>
        Response.json({
          pairingCode: '123',
          action: {
            id: 'once',
            version: 1,
            operation: 'evm.personalSign',
            account: address,
            chain: 'eip155:8453',
            expiresAt: Date.now() + 10000,
            payload: { message: 'exact' },
          },
        }),
      addEventListener: vi.fn(),
      document: {
        getElementById: (id: string) => {
          const e = { textContent: '', disabled: false };
          elements.set(id, e);
          return e;
        },
      },
      localStorage: { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() },
    },
    { codeGeneration: { strings: false, wasm: false } },
  );
  runInContext('globalThis.window = globalThis; globalThis.self = globalThis;', context);
  runInContext(asset, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  void elements.get('approve')?.onclick?.();
  void elements.get('approve')?.onclick?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(
    provider.request.mock.calls.filter(([q]) => q.method === 'eth_requestAccounts'),
  ).toHaveLength(1);
});

it.each(['near.nep413', 'near.signTransaction'])(
  'bundled MyNearWallet %s uses account-only approval and the exact payload',
  async (operation) => {
    const asset =
      (await build({ ...browserBuildOptions, write: false })).outputFiles?.[0]?.text ?? '';
    const elements = new Map<
      string,
      { textContent: string; disabled: boolean; onclick?: () => Promise<void> }
    >();
    const listeners = new Set<(e: unknown) => void>();
    const urls: URL[] = [];
    const stored = new Map<string, string>();
    const writes: string[] = [];
    const action = {
      id: 'near-once',
      version: 1,
      operation,
      account: 'bot.near',
      chain: 'near:testnet',
      expiresAt: Date.now() + 10000,
      payload:
        operation === 'near.nep413'
          ? {
              message: 'exact',
              recipient: 'annon',
              nonce: Array(32).fill(1),
              callbackUrl: 'http://127.0.0.1:1234/callback',
            }
          : {
              receiverId: 'usdc.near',
              method: 'ft_transfer_call',
              args: { receiver_id: 'annon.near', amount: '1', msg: 'exact' },
              gas: '150000000000000',
              deposit: '1',
            },
    };
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/')) return Response.json({ pairingCode: '123', action });
      const q = JSON.parse(String(init?.body));
      return Response.json({
        jsonrpc: '2.0',
        id: q.id,
        result:
          q.method === 'block'
            ? { header: { hash: '11111111111111111111111111111111' } }
            : { transaction: { hash: 'FAKE-TX-HASH' } },
      });
    });
    const context = createContext(
      {
        console,
        TextEncoder,
        TextDecoder,
        Uint8Array,
        URL,
        URLSearchParams,
        AbortController,
        crypto,
        setTimeout: (fn: () => void, ms: number) => (ms < 100 ? setTimeout(fn, ms) : 0),
        clearTimeout,
        setInterval: vi.fn(() => 0),
        clearInterval,
        screen: { width: 1000, height: 800 },
        innerWidth: 1000,
        innerHeight: 800,
        navigator: { userAgent: 'Mozilla/5.0' },
        location: {
          hash: '#CAP',
          pathname: '/',
          href: 'http://127.0.0.1:1234/',
          origin: 'http://127.0.0.1:1234',
        },
        history: { replaceState: vi.fn() },
        addEventListener: (name: string, fn: (e: unknown) => void) => {
          if (name === 'message') listeners.add(fn);
        },
        removeEventListener: (_name: string, fn: (e: unknown) => void) => listeners.delete(fn),
        open: (url: string) => {
          const u = new URL(url);
          urls.push(u);
          const popup = {
            closed: false,
            close() {
              popup.closed = true;
            },
          };
          setTimeout(() => {
            for (const fn of listeners)
              fn({
                origin: u.origin,
                source: popup,
                data: {
                  status: 'success',
                  account_id: 'bot.near',
                  transactionHashes: 'FAKE-TX-HASH',
                  signedRequest: {
                    accountId: 'bot.near',
                    publicKey: 'ed25519:fake',
                    signature: 'fake',
                  },
                },
              });
          }, 0);
          return popup;
        },
        fetch: fetcher,
        document: {
          getElementById: (id: string) => {
            const e = { textContent: '', disabled: false };
            elements.set(id, e);
            return e;
          },
        },
        localStorage: {
          getItem: (k: string) => stored.get(k) ?? null,
          setItem: (k: string, v: string) => {
            writes.push(k);
            stored.set(k, v);
          },
          removeItem: (k: string) => stored.delete(k),
        },
      },
      { codeGeneration: { strings: false, wasm: false } },
    );
    runInContext('globalThis.window = globalThis; globalThis.self = globalThis;', context);
    runInContext(asset, context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await elements.get('approve')?.onclick?.();
    expect(elements.get('status')?.textContent).toContain('Verified');
    expect(urls).toHaveLength(2);
    expect(urls[0]?.searchParams.has('contract_id')).toBe(false);
    expect(urls[0]?.searchParams.has('public_key')).toBe(false);
    if (operation === 'near.nep413') {
      expect(urls[1]?.searchParams.get('message')).toBe('exact');
      expect(urls[1]?.searchParams.get('state')).toMatch(/^[0-9a-f-]{36}$/);
      expect(urls[1]?.href).not.toContain('CAP');
      expect(urls[1]?.href).not.toContain(action.id);
      expect(urls[1]?.searchParams.get('callbackUrl')).toBe(action.payload.callbackUrl);
    } else {
      const { decodeTransaction } = await import('near-api-js');
      const encoded = urls[1]?.searchParams.get('transactions') ?? '';
      const tx = decodeTransaction(new Uint8Array(Buffer.from(encoded, 'base64')));
      expect(tx.receiverId).toBe('usdc.near');
      expect(tx.actions[0]?.functionCall?.deposit).toBe(1n);
      expect(tx.actions[0]?.functionCall?.methodName).toBe('ft_transfer_call');
    }
    expect(writes).not.toContain('functionCallKey');
  },
);
