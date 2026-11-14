/** The approval page bundle run in a VM against fake DOM, fetch and wallets: shared test harness. */
import { createContext, runInContext } from 'node:vm';
import { base58 } from '@scure/base';
import { build } from 'esbuild';
import { expect, vi } from 'vitest';
import { browserBuildOptions } from '../scripts/build-browser.js';

/** A DOM element as far as the approval page uses one. */
export interface FakeElement {
  textContent: string;
  disabled: boolean;
  hidden: boolean;
  value: string;
  className: string;
  tag: string;
  children: FakeElement[];
  attributes: Map<string, string>;
  onclick?: () => Promise<void> | void;
  onkeydown?: (e: { key: string; preventDefault(): void }) => void;
  append(...c: FakeElement[]): void;
  replaceChildren(...c: FakeElement[]): void;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  getAttribute(name: string): string | null;
  focus(): void;
  contains(other: unknown): boolean;
}
export function fakeElement(tag = 'div', value = ''): FakeElement {
  const e: FakeElement = {
    textContent: '',
    disabled: false,
    hidden: false,
    value,
    className: '',
    tag,
    children: [],
    attributes: new Map(),
    append: (...c) => {
      e.children.push(...c);
    },
    replaceChildren: (...c) => {
      e.children = c;
    },
    setAttribute: (name, value) => {
      e.attributes.set(name, value);
    },
    removeAttribute: (name) => {
      e.attributes.delete(name);
    },
    getAttribute: (name) => e.attributes.get(name) ?? null,
    focus: () => {},
    contains: (other) => other === e,
  };
  return e;
}
/** Picks a wallet in the page's picker with the keyboard, as a person would. */
export function pickWallet(elements: Map<string, FakeElement>, walletId: string) {
  const press = (key: string) =>
    elements.get('near-wallet')?.onkeydown?.({ key, preventDefault() {} });
  if (walletId === 'hot-wallet') for (const key of ['ArrowDown', 'ArrowDown', 'Enter']) press(key);
}
export function fakeDocument(
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

export const nearAction = (operation: string, chain = 'near:testnet') => ({
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
export async function approveNear(
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
    server = {},
    refuse = () => false,
    ...rest
  } = globals as {
    rpc: (method: string, params: Record<string, unknown>) => unknown;
    fetch?: (url: string, init?: RequestInit) => Response;
    document?: object;
    listeners?: Set<(e: unknown) => void>;
    /** Extra fields of the CLI's /api/action answer, e.g. `sendStarted`. */
    server?: Record<string, unknown>;
    /** API calls the CLI answers with 409. */
    refuse?: (url: string, body: { reason?: string }) => boolean;
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
        ...fakeDocument(elements),
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
        if (url.startsWith('/') && refuse(url, JSON.parse(String(init?.body ?? '{}'))))
          return Response.json({}, { status: 409 });
        if (url.startsWith('/')) return Response.json({ pairingCode: '123', action, ...server });
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
  pickWallet(elements, walletId);
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
export function logged(logs: unknown[][]): string[] {
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
export function secretFindings(logs: unknown[][], stored: Map<string, string>) {
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
export function expectNoSecretLogged(logs: unknown[][], stored: Map<string, string>) {
  const { secrets, findings } = secretFindings(logs, stored);
  expect(findings).toEqual([]);
  return secrets;
}

export const accessKey = `ed25519:${base58.encode(new Uint8Array(32).fill(7))}`;
export const nearRpc = (method: string, params: Record<string, unknown>) =>
  method === 'block'
    ? { header: { hash: '11111111111111111111111111111111' } }
    : method === 'query' && params.request_type === 'view_access_key_list'
      ? {
          block_height: 1,
          block_hash: '11111111111111111111111111111111',
          keys: [{ public_key: accessKey, access_key: { nonce: 5, permission: 'FullAccess' } }],
        }
      : null;

/** Meteor's web popup: answers each action with `reply(actionType)`, success by default. */
export function meteorPopup(
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
