import { readFile } from 'node:fs/promises';
import { createContext, runInContext, runInNewContext } from 'node:vm';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58, base64 } from '@scure/base';
import { build } from 'esbuild';
import { expect, it, vi } from 'vitest';
import { browserBuildOptions } from '../../scripts/build-browser.js';
import { nep413Hash } from '../near/nep413.js';

/** A DOM element as far as the approval page uses one. */
interface FakeElement {
  textContent: string;
  disabled: boolean;
  hidden: boolean;
  value: string;
  className: string;
  tag: string;
  children: FakeElement[];
  onclick?: () => Promise<void> | void;
  append(...c: FakeElement[]): void;
  replaceChildren(...c: FakeElement[]): void;
}
function fakeElement(tag = 'div', value = ''): FakeElement {
  const e: FakeElement = {
    textContent: '',
    disabled: false,
    hidden: false,
    value,
    className: '',
    tag,
    children: [],
    append: (...c) => {
      e.children.push(...c);
    },
    replaceChildren: (...c) => {
      e.children = c;
    },
  };
  return e;
}
function fakeDocument(
  elements: Map<string, FakeElement>,
  value: (id: string) => string = () => '',
) {
  return {
    getElementById: (id: string) => {
      let e = elements.get(id);
      if (!e) {
        e = fakeElement(id, value(id));
        elements.set(id, e);
      }
      return e;
    },
    createElement: (tag: string) => fakeElement(tag),
  };
}

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
  const elements = new Map<string, FakeElement>();
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
      document: fakeDocument(elements),
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

const nearAction = (operation: string, chain = 'near:testnet') => ({
  id: 'near-once',
  version: 1,
  operation,
  account: 'bot.near',
  chain,
  expiresAt: Date.now() + 10000,
  payload:
    operation === 'near.nep413'
      ? { message: 'exact', recipient: 'annon', nonce: Array(32).fill(1) }
      : {
          receiverId: 'usdc.near',
          method: 'ft_transfer_call',
          args: { receiver_id: 'annon.near', amount: '1', msg: 'exact' },
          gas: '150000000000000',
          deposit: '1',
        },
});

/**
 * Runs the bundled page against one pending NEAR action and clicks approve `clicks` times, one
 * click per wallet step. `onClick` runs before each click (a fresh user activation).
 */
async function approveNear(
  action: ReturnType<typeof nearAction>,
  walletId: string,
  globals: Record<string, unknown>,
  clicks = 1,
  onClick: (elements: Map<string, FakeElement>) => void = () => {},
) {
  const asset =
    (await build({ ...browserBuildOptions, write: false })).outputFiles?.[0]?.text ?? '';
  const elements = new Map<string, FakeElement>();
  const reports: unknown[] = [];
  const {
    rpc,
    fetch: wallet,
    document: page,
    listeners = new Set(),
    ...rest
  } = globals as {
    rpc: (method: string, params: Record<string, unknown>) => unknown;
    fetch?: (url: string, init?: RequestInit) => Response;
    document?: object;
    listeners?: Set<(e: unknown) => void>;
  };
  const results: unknown[] = [];
  const logs: unknown[][] = [];
  const capture = (...args: unknown[]) => {
    logs.push(args);
  };
  const stored = new Map<string, string>();
  const context = createContext(
    {
      console: { log: capture, info: capture, warn: capture, error: capture, debug: capture },
      TextEncoder,
      TextDecoder,
      Uint8Array,
      URL,
      URLSearchParams,
      AbortController,
      Blob,
      crypto,
      setTimeout: (fn: () => void, ms: number) => (ms < 100 ? setTimeout(fn, ms) : 0),
      clearTimeout,
      setInterval: vi.fn(() => 0),
      clearInterval,
      screen: { width: 1000, height: 800 },
      innerWidth: 1000,
      innerHeight: 800,
      outerWidth: 1000,
      outerHeight: 800,
      screenX: 0,
      screenY: 0,
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
      document: {
        ...fakeDocument(elements, (id) => (id === 'near-wallet' ? walletId : '')),
        ...page,
      },
      localStorage: {
        getItem: (k: string) => stored.get(k) ?? null,
        setItem: (k: string, v: string) => stored.set(k, v),
        removeItem: (k: string) => stored.delete(k),
      },
      ...rest,
      fetch: async (url: string, init?: RequestInit) => {
        if (url === '/api/result') results.push(JSON.parse(String(init?.body)).result);
        if (url === '/api/report') reports.push(JSON.parse(String(init?.body)).reason);
        if (url.startsWith('/')) return Response.json({ pairingCode: '123', action });
        if (/^https:\/\/(free|test)\.rpc\.fastnear\.com\/?$/.test(url)) {
          const q = JSON.parse(String(init?.body));
          return Response.json({ jsonrpc: '2.0', id: q.id, result: rpc(q.method, q.params) });
        }
        if (wallet) return wallet(url, init);
        throw new Error(`unexpected fetch ${url}`);
      },
    },
    { codeGeneration: { strings: false, wasm: false } },
  );
  runInContext(
    'globalThis.window = globalThis; globalThis.self = globalThis; globalThis.top = globalThis;',
    context,
  );
  runInContext(asset, context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const statuses: string[] = [];
  for (let i = 0; i < clicks; i++) {
    onClick(elements);
    await elements.get('approve')?.onclick?.();
    statuses.push(elements.get('status')?.textContent ?? '');
  }
  return {
    status: elements.get('status')?.textContent ?? '',
    statuses,
    results,
    reports,
    logs,
    stored,
    elements,
  };
}

/**
 * Every string and property name reachable from logged values (cycle safe, any depth). Byte
 * values (typed arrays, ArrayBuffers, number arrays) are added as base58, hex and base64.
 */
function logged(logs: unknown[][]): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const bytes = (b: Uint8Array) =>
    out.push(base58.encode(b), Buffer.from(b).toString('hex'), Buffer.from(b).toString('base64'));
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'bigint' || typeof v === 'number') out.push(String(v));
    else if (v && (typeof v === 'object' || typeof v === 'function') && !seen.has(v)) {
      seen.add(v);
      if (ArrayBuffer.isView(v)) bytes(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      else if (v instanceof ArrayBuffer) bytes(new Uint8Array(v));
      else if (
        Array.isArray(v) &&
        v.length > 0 &&
        v.every((n) => Number.isInteger(n) && n >= 0 && n < 256)
      )
        bytes(Uint8Array.from(v));
      else if (Array.isArray(v) && v.length > 0 && v.every((c) => typeof c === 'string'))
        out.push(v.join(''));
      for (const key of Object.getOwnPropertyNames(v)) {
        out.push(key);
        try {
          walk((v as Record<string, unknown>)[key]);
        } catch {}
      }
      try {
        out.push(String(v));
      } catch {}
    }
  };
  for (const args of logs) for (const a of args) walk(a);
  return out;
}

/**
 * What in the logs reveals a key pair or a private key the page stored: key-pair property names,
 * the stored 64-byte key, or its 32-byte seed (Meteor's `secretKey`, which is not a substring of
 * the 64-byte encoding), each as base58, hex or base64. Compared only against the known stored
 * synthetic secrets, since public keys are 32 bytes too.
 */
function secretFindings(logs: unknown[][], stored: Map<string, string>) {
  const secrets = [...stored.values()].filter((v) => /^ed25519:[1-9A-HJ-NP-Za-km-z]{80,}$/.test(v));
  const forbidden = secrets.flatMap((secret) => {
    const full = base58.decode(secret.slice(8));
    return [full, full.slice(0, 32)].flatMap((b) => [
      base58.encode(b),
      Buffer.from(b).toString('hex'),
      Buffer.from(b).toString('base64'),
    ]);
  });
  const text = logged(logs);
  const findings = [
    ...text.filter((t) => /secretKey|extendedSecretKey/.test(t)),
    ...text.filter((t) => forbidden.some((f) => t.includes(f))),
  ];
  return { secrets, findings };
}

/** No logged value may carry a key pair or any private key the page stored. */
function expectNoSecretLogged(logs: unknown[][], stored: Map<string, string>) {
  const { secrets, findings } = secretFindings(logs, stored);
  expect(findings).toEqual([]);
  return secrets;
}

it('the console check rejects a logged key pair, its seed and its full key in any encoding', () => {
  const full = Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256);
  const seed = full.slice(0, 32);
  const stored = new Map([['_meteor_walletbot.near:testnet', `ed25519:${base58.encode(full)}`]]);
  const keyPair = { secretKey: base58.encode(seed), extendedSecretKey: base58.encode(full) };
  const leaks: unknown[][] = [
    [keyPair], // the original console.log(accessKey)
    [base58.encode(seed)], // console.info(accessKey.secretKey)
    [`key ${base58.encode(full)}`],
    [seed],
    [Array.from(seed)],
    [{ nested: { value: seed.buffer.slice(0) } }],
    [Buffer.from(seed).toString('hex')],
    [Buffer.from(seed).toString('base64')],
    [Array.from(base58.encode(seed))],
  ];
  for (const leak of leaks) expect(secretFindings([leak], stored).findings).not.toEqual([]);
  // The public half of the key and unrelated text are not findings.
  expect(
    secretFindings([[base58.encode(full.slice(32))], ['Comparing access key and actions']], stored)
      .findings,
  ).toEqual([]);
});

const accessKey = `ed25519:${base58.encode(new Uint8Array(32).fill(7))}`;
const nearRpc = (method: string, params: Record<string, unknown>) =>
  method === 'block'
    ? { header: { hash: '11111111111111111111111111111111' } }
    : method === 'query' && params.request_type === 'view_access_key_list'
      ? {
          block_height: 1,
          block_hash: '11111111111111111111111111111111',
          keys: [{ public_key: accessKey, access_key: { nonce: 5, permission: 'FullAccess' } }],
        }
      : null;

it.each(['near.nep413', 'near.signTransaction'])(
  'bundled Meteor Wallet %s opens one popup per click and approves the exact payload',
  async (operation) => {
    const action = nearAction(operation);
    const opened: URL[] = [];
    const sent: { actionType: string; inputs: Record<string, unknown> }[] = [];
    const listeners = new Set<(e: unknown) => void>();
    const payloads: Record<string, unknown> = {
      login: { accountId: 'bot.near', allKeys: [accessKey] },
      sign_message: { accountId: 'bot.near', publicKey: accessKey, signature: 'fake' },
      sign: { executionOutcomes: [{ transaction: { hash: 'FAKE-TX-HASH' } }] },
    };
    const nep413 = operation === 'near.nep413';
    const { status, statuses, results, logs, stored } = await approveNear(
      action,
      'meteor-wallet',
      {
        rpc: nearRpc,
        listeners,
        open: (url: string) => {
          opened.push(new URL(url));
          return {
            closed: false,
            focus() {},
            postMessage(
              data: {
                uid: string;
                status: string;
                actionType: string;
                inputs?: Record<string, unknown>;
              },
              origin: string,
            ) {
              if (origin !== 'https://wallet.meteorwallet.app') throw new Error('wrong origin');
              if (data.status !== 'initializing' || !data.inputs) return;
              sent.push({ actionType: data.actionType, inputs: data.inputs });
              const payload = payloads[data.actionType];
              setTimeout(() => {
                for (const fn of listeners)
                  fn({ origin, data: { uid: data.uid, status: 'closed_success', payload } });
              }, 0);
            },
          };
        },
      },
      nep413 ? 1 : 2,
    );
    expect(status).toContain('Signed. Return to the terminal.');
    // Meteor's SDK stores a generated connector key at sign-in; it must never reach the console.
    // A NEP-413 message needs no sign-in, so no key exists at all.
    expect(expectNoSecretLogged(logs, stored)).toHaveLength(nep413 ? 0 : 1);
    // One wallet window per click: NEP-413 signs directly, a transaction connects first.
    expect(opened.map((u) => `${u.origin}${u.pathname}`)).toEqual(
      nep413
        ? ['https://wallet.meteorwallet.app/connect/testnet/sign_message']
        : [
            'https://wallet.meteorwallet.app/connect/testnet/login',
            'https://wallet.meteorwallet.app/connect/testnet/sign',
          ],
    );
    if (!nep413) expect(statuses[0]).toContain('Connected as bot.near');
    for (const u of opened) {
      expect(u.href).not.toContain('CAP');
      expect(u.href).not.toContain(action.id);
    }
    if (nep413) {
      expect(sent.map((x) => x.actionType)).toEqual(['sign_message']);
      const inputs = sent[0]?.inputs ?? {};
      expect(inputs.message).toBe('exact');
      expect(inputs.recipient).toBe('annon');
      expect([...(inputs.nonce as Uint8Array)]).toEqual(Array(32).fill(1));
      expect(inputs.callbackUrl).toBeUndefined();
      expect(inputs.state).toMatch(/^[0-9a-f-]{36}$/);
      expect(results).toEqual([
        expect.objectContaining({ accountId: 'bot.near', publicKey: accessKey, signature: 'fake' }),
      ]);
    } else {
      // Account-only: no contract and no method list, so no function-call key is requested.
      expect(sent[0]?.actionType).toBe('login');
      expect(sent[0]?.inputs.contract_id).toBe('');
      expect(sent[0]?.inputs.methods).toBeUndefined();
      const { decodeTransaction } = await import('near-api-js');
      expect(sent[1]?.actionType).toBe('sign');
      const tx = decodeTransaction(
        new Uint8Array(Buffer.from(String(sent[1]?.inputs.transactions), 'base64')),
      );
      expect(tx.signerId).toBe('bot.near');
      expect(tx.receiverId).toBe('usdc.near');
      expect(tx.actions).toHaveLength(1);
      expect(tx.actions[0]?.functionCall?.methodName).toBe('ft_transfer_call');
      expect(tx.actions[0]?.functionCall?.deposit).toBe(1n);
      expect(tx.actions[0]?.functionCall?.gas).toBe(150000000000000n);
      expect(JSON.parse(Buffer.from(tx.actions[0]?.functionCall?.args ?? []).toString())).toEqual(
        action.payload.args,
      );
      expect(results).toEqual([{ txHash: 'FAKE-TX-HASH' }]);
    }
  },
);

it.each(['near.nep413', 'near.signTransaction'])(
  'bundled HOT Wallet %s sends the exact payload through its widget, one step per click',
  async (operation) => {
    const action = nearAction(operation, 'near:mainnet');
    const secret = new Uint8Array(32).fill(9);
    const publicKey = `ed25519:${base58.encode(ed25519.getPublicKey(secret))}`;
    const requests: { method: string; request: Record<string, unknown>; origin: string }[] = [];
    const responses = new Map<string, unknown>();
    const mounted: { children: { src?: string }[] }[] = [];
    const answer = (method: string, request: Record<string, unknown>) => {
      if (method === 'near:signIn') return { accountId: 'bot.near', publicKey };
      if (method === 'near:signMessage') {
        const hash = nep413Hash({
          message: String(request.message),
          recipient: String(request.recipient),
          nonce: Uint8Array.from(request.nonce as number[]),
        });
        return {
          accountId: 'bot.near',
          publicKey,
          signature: base64.encode(ed25519.sign(hash, secret)),
        };
      }
      return { transactions: [{ transaction: { hash: 'FAKE-TX-HASH' } }] };
    };
    const element = (tag: string) => {
      const e = Object.assign(fakeElement(tag), {
        style: {},
        appendChild: (child: FakeElement) => e.children.push(child),
        remove: () => {},
      });
      return e;
    };
    const nep413 = operation === 'near.nep413';
    const { status, results, logs, stored } = await approveNear(
      action,
      'hot-wallet',
      {
        rpc: nearRpc,
        setTimeout: (fn: () => void, ms: number) =>
          ms === 3000 || ms < 100 ? setTimeout(fn, 0) : 0,
        document: {
          createElement: element,
          body: { appendChild: (e: { children: { src?: string }[] }) => mounted.push(e) },
        },
        fetch: (url: string, init?: RequestInit) => {
          const [, id, kind] = new URL(url).pathname.split('/');
          if (new URL(url).origin !== 'https://h4n.app' || !id)
            throw new Error(`unexpected ${url}`);
          if (kind === 'request') {
            const query = JSON.parse(String(init?.body)).data as string;
            const q = JSON.parse(new TextDecoder().decode(base58.decode(query)));
            requests.push({ method: q.method, request: q.request, origin: q.origin });
            responses.set(id, { success: true, payload: answer(q.method, q.request) });
            return new Response('{}');
          }
          return Response.json({ data: JSON.stringify(responses.get(id)) });
        },
      },
      nep413 ? 1 : 2,
    );
    expect(status).toContain('Signed. Return to the terminal.');
    expectNoSecretLogged(logs, stored);
    expect(mounted.map((c) => c.children[0]?.src?.split('?')[0])).toEqual(
      Array(nep413 ? 1 : 2).fill('https://hot-labs.org/hot-widget/index.html'),
    );
    if (nep413) {
      expect(requests.map((r) => r.method)).toEqual(['near:signMessage']);
      expect(requests[0]?.request).toEqual({
        message: 'exact',
        recipient: 'annon',
        nonce: Array(32).fill(1),
      });
      const signed = results[0] as { accountId: string; publicKey: string; signature: string };
      expect(signed.accountId).toBe('bot.near');
      expect(signed.publicKey).toBe(publicKey);
      expect(
        ed25519.verify(
          base64.decode(signed.signature),
          nep413Hash({ message: 'exact', recipient: 'annon', nonce: new Uint8Array(32).fill(1) }),
          ed25519.getPublicKey(secret),
        ),
      ).toBe(true);
    } else {
      expect(requests[0]).toEqual({
        method: 'near:signIn',
        request: {},
        origin: 'http://127.0.0.1:1234/',
      });
      expect(requests[1]).toEqual({
        method: 'near:signAndSendTransactions',
        request: {
          transactions: [
            {
              signerId: 'bot.near',
              receiverId: 'usdc.near',
              actions: [
                {
                  type: 'FunctionCall',
                  params: {
                    methodName: 'ft_transfer_call',
                    args: action.payload.args,
                    gas: '150000000000000',
                    deposit: '1',
                  },
                },
              ],
            },
          ],
        },
        origin: 'http://127.0.0.1:1234/',
      });
      expect(results).toEqual([{ txHash: 'FAKE-TX-HASH' }]);
    }
  },
);

it('refuses a NEAR wallet the page does not offer', async () => {
  const action = nearAction('near.nep413');
  const open = vi.fn();
  const { status, results } = await approveNear(action, 'my-near-wallet', { rpc: nearRpc, open });
  expect(status).toContain('Unknown NEAR wallet');
  expect(open).not.toHaveBeenCalled();
  expect(results).toEqual([]);
});

it.each(['near:testnet', 'near:sandbox'])(
  'HOT Wallet on %s never reaches its extension, relay or widget, and its choice is disabled',
  async (chain) => {
    const action = nearAction('near.signTransaction', chain);
    const hotExtension = { autoRun: true, request: vi.fn(), subscribe: vi.fn() };
    // The page builds its own summary rows; the HOT widget would be an iframe mounted on body.
    const createElement = vi.fn((tag: string) => fakeElement(tag));
    const mount = vi.fn();
    const relay = vi.fn();
    const open = vi.fn();
    const { status, results, elements } = await approveNear(action, 'hot-wallet', {
      rpc: nearRpc,
      hotExtension,
      open,
      fetch: relay,
      document: { createElement, body: { appendChild: mount } },
    });
    expect(status).toMatch(
      chain === 'near:testnet' ? /HOT Wallet is offered for near:mainnet only/ : /not near:sandbox/,
    );
    expect(elements.get('near-wallet-hot')?.disabled).toBe(true);
    expect(hotExtension.request).not.toHaveBeenCalled();
    expect(hotExtension.subscribe).not.toHaveBeenCalled();
    expect(createElement.mock.calls.map(([tag]) => tag)).not.toContain('iframe');
    expect(mount).not.toHaveBeenCalled();
    expect(relay).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  },
);

it('a mainnet NEAR action leaves the HOT Wallet choice enabled', async () => {
  const action = nearAction('near.nep413', 'near:mainnet');
  const { elements } = await approveNear(action, 'meteor-wallet', {
    rpc: nearRpc,
    open: () => null,
  });
  expect(elements.get('near-wallet-hot')?.disabled).toBe(false);
});

it.each(['near:foo', 'near:Mainnet', 'eip155:8453'])(
  'refuses an unknown NEAR chain %s before any wallet runs',
  async (chain) => {
    const action = nearAction('near.nep413', chain);
    const open = vi.fn();
    const { status, results } = await approveNear(action, 'meteor-wallet', { rpc: nearRpc, open });
    expect(status).toContain(`not ${chain}`);
    expect(open).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  },
);

it('the approval session API omits credentials and rejects redirects', async () => {
  const source = await readFile(new URL('./login.ts', import.meta.url), 'utf8');
  const api = source
    .slice(source.indexOf('const api = async'), source.indexOf('/** Requests whose result'))
    .replace('path: string, body?: unknown', 'path, body');
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

/** Meteor's web popup: answers each action with `reply(actionType)`, success by default. */
function meteorPopup(
  listeners: Set<(e: unknown) => void>,
  o: { opened?: string[]; reply?: (actionType: string) => string; canOpen?: () => boolean } = {},
) {
  const payloads: Record<string, unknown> = {
    login: { accountId: 'bot.near', allKeys: [accessKey] },
    sign_message: { accountId: 'bot.near', publicKey: accessKey, signature: 'fake' },
    sign: { executionOutcomes: [{ transaction: { hash: 'FAKE-TX-HASH' } }] },
  };
  return (url: string) => {
    if (o.canOpen && !o.canOpen()) return null;
    o.opened?.push(new URL(url).pathname);
    return {
      closed: false,
      focus() {},
      postMessage(data: { uid: string; status: string; actionType: string; inputs?: unknown }) {
        if (data.status !== 'initializing' || !data.inputs) return;
        const status = o.reply?.(data.actionType) ?? 'closed_success';
        setTimeout(() => {
          for (const fn of listeners)
            fn({
              origin: 'https://wallet.meteorwallet.app',
              data: { uid: data.uid, status, payload: payloads[data.actionType], endTags: [] },
            });
        }, 0);
      },
    };
  };
}

it.each(['near.nep413', 'near.signTransaction'])(
  'Meteor %s: every popup opens inside its own click, never after an awaited popup',
  async (operation) => {
    // A browser allows window.open only with a fresh user activation, and window.open uses it up.
    let activation = false;
    let blocked = 0;
    const opened: string[] = [];
    const listeners = new Set<(e: unknown) => void>();
    const open = meteorPopup(listeners, {
      opened,
      canOpen: () => {
        if (!activation) {
          blocked++;
          return false;
        }
        activation = false;
        return true;
      },
    });
    const nep413 = operation === 'near.nep413';
    const { status, results, elements } = await approveNear(
      nearAction(operation),
      'meteor-wallet',
      { rpc: nearRpc, listeners, open },
      nep413 ? 1 : 2,
      (page) => {
        activation = true;
        if (!nep413 && opened.length === 0)
          expect(page.get('approve')?.textContent).toBe('Connect wallet');
      },
    );
    expect(blocked).toBe(0);
    expect(opened).toEqual(
      nep413
        ? ['/connect/testnet/sign_message']
        : ['/connect/testnet/login', '/connect/testnet/sign'],
    );
    expect(status).toContain('Signed. Return to the terminal.');
    expect(results).toHaveLength(1);
    expect(elements.get('approve')?.disabled).toBe(true);
  },
);

it('after a closed wallet window the page explains it, reports only the reason and lets the person retry', async () => {
  const listeners = new Set<(e: unknown) => void>();
  let attempts = 0;
  const open = meteorPopup(listeners, {
    reply: () => (++attempts === 1 ? 'closed_window' : 'closed_success'),
  });
  let enabledBeforeRetry: boolean | undefined;
  const { statuses, results, reports } = await approveNear(
    nearAction('near.nep413'),
    'meteor-wallet',
    { rpc: nearRpc, listeners, open },
    2,
    (page) => {
      if (attempts === 1) enabledBeforeRetry = page.get('approve')?.disabled === false;
    },
  );
  expect(statuses[0]).toBe(
    'The wallet window closed before signing. Try again or pick another wallet.',
  );
  expect(enabledBeforeRetry).toBe(true);
  expect(reports).toEqual(['window_closed']);
  expect(statuses[1]).toContain('Signed. Return to the terminal.');
  expect(results).toHaveLength(1);
});

it('renders the request summary, pairing code and a cancel that reports only "cancelled"', async () => {
  const listeners = new Set<(e: unknown) => void>();
  const { elements, reports, results } = await approveNear(
    nearAction('near.signTransaction'),
    'meteor-wallet',
    { rpc: nearRpc, listeners, open: meteorPopup(listeners) },
    0,
  );
  expect(elements.get('title')?.textContent).toBe('Approve a payment');
  expect(elements.get('amount')?.textContent).toBe('1 base units of usdc.near');
  expect(elements.get('pair')?.textContent).toBe('123');
  expect(elements.get('wallet-field')?.hidden).toBe(false);
  expect(elements.get('approve')?.textContent).toBe('Connect wallet');
  expect(elements.get('cancel')?.hidden).toBe(false);
  await elements.get('cancel')?.onclick?.();
  expect(reports).toEqual(['cancelled']);
  expect(elements.get('approve')?.disabled).toBe(true);
  expect(elements.get('status')?.textContent).toBe('Cancelled. Return to the terminal.');
  expect(results).toEqual([]);
});
