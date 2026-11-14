import { createContext, runInContext } from 'node:vm';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58, base64 } from '@scure/base';
import { build } from 'esbuild';
import { expect, it, vi } from 'vitest';
import { browserBuildOptions } from '../../scripts/build-browser.js';
import {
  accessKey,
  approveNear,
  expectNoSecretLogged,
  type FakeElement,
  fakeDocument,
  fakeElement,
  nearAction,
  nearRpc,
  secretFindings,
} from '../../test/login-page.js';
import { nep413Hash } from '../near/nep413.js';

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

it.each(['near:testnet', 'near:sandbox'])(
  'HOT Wallet on %s is disabled in the picker, cannot be chosen and never loads',
  async (chain) => {
    const action = nearAction('near.signTransaction', chain);
    const hotExtension = { autoRun: true, request: vi.fn(), subscribe: vi.fn() };
    // The page builds its own summary rows; the HOT widget would be an iframe mounted on body.
    const createElement = vi.fn((tag: string) => fakeElement(tag));
    const mount = vi.fn();
    const relay = vi.fn();
    const open = vi.fn();
    const { results, elements } = await approveNear(
      action,
      'hot-wallet',
      {
        rpc: nearRpc,
        hotExtension,
        open,
        fetch: relay,
        document: { createElement, body: { appendChild: mount } },
      },
      0,
    );
    expect(elements.get('near-wallet-hot')?.getAttribute('aria-disabled')).toBe('true');
    // The keyboard could not choose it: the picker still shows Meteor Wallet.
    expect(elements.get('near-wallet-value')?.textContent).toBe('Meteor Wallet');
    expect(elements.get('near-wallet-meteor')?.getAttribute('aria-selected')).toBe('true');
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
  expect(elements.get('near-wallet-hot')?.getAttribute('aria-disabled')).toBe('false');
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
