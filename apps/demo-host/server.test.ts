import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryStore } from '../../packages/annon/src/pay/store.ts';
import { BASE_USDC } from '../../packages/annon/src/settle-near/terms.ts';
import {
  type Chain,
  clientKey,
  facilitatorFor,
  type HostConfig,
  handler,
  limiter,
  loadFiles,
} from './server.ts';

const FILE_ID = `0x${'ab'.repeat(32)}`;
let dir = '';
let server: Server | undefined;

/** A fake PAY2: a u32 header length at byte 8, a header ending in a 65-byte signature, a body. */
function pay2(headerLen: number, bodyLen: number): Uint8Array {
  const b = new Uint8Array(headerLen + bodyLen);
  new DataView(b.buffer).setUint32(8, headerLen);
  b.fill(7, headerLen);
  return b;
}

async function setup(files: unknown, blobs: Record<string, Uint8Array>) {
  dir = await mkdtemp(join(tmpdir(), 'demo-host-'));
  await writeFile(join(dir, 'files.json'), JSON.stringify(files));
  for (const [name, bytes] of Object.entries(blobs))
    await writeFile(join(dir, `${name}.pay2`), bytes);
  return loadFiles(dir);
}
const reset = async () => {
  await rm(dir, { recursive: true, force: true });
};

async function start(c: Partial<HostConfig>, serve?: Parameters<typeof handler>[1]) {
  const config: HostConfig = {
    contractId: 'annon.test.near',
    nearRpc: 'https://near.invalid',
    baseRpc: 'https://base.invalid',
    publicUrl: 'https://demo.example',
    files: [],
    getFile: async () =>
      ({
        price: 100000n,
        takenDown: null,
        salesStoppedAt: null,
        termsHash: `0x${'11'.repeat(32)}`,
        terms: { network: 'near:mainnet', base: { pay_to: `0x${'22'.repeat(20)}` } },
      }) as never,
    store: memoryStore(),
    facilitator: async () => {
      throw new Error('unused');
    },
    perIpMinute: 100,
    paymentsPerClientMinute: 100,
    ...c,
  };
  server = createServer(handler(config, serve));
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise((r) => (server ? server.close(r) : r(null)));
  server = undefined;
  if (dir) await reset();
  dir = '';
});

const AUTH = {
  from: '0x0000000000000000000000000000000000000001',
  to: '0x00000000000000000000000000000000000000aa',
  value: '100000',
  validAfter: '0',
  validBefore: '9999999999',
  nonce: `0x${'11'.repeat(32)}`,
};
const body = (over: { to?: string; value?: string; asset?: string; network?: string } = {}) =>
  ({
    x402Version: 2,
    paymentRequirements: {
      payTo: '0x00000000000000000000000000000000000000aa',
      amount: '100000',
      asset: over.asset ?? BASE_USDC,
      network: over.network ?? 'eip155:8453',
    },
    paymentPayload: {
      payload: {
        signature: `0x${'22'.repeat(65)}`,
        authorization: {
          ...AUTH,
          ...(over.to ? { to: over.to } : {}),
          ...(over.value ? { value: over.value } : {}),
        },
      },
    },
  }) as never;
function fakeChain(
  o: { used?: boolean; cap?: boolean; sendDelay?: number; reverts?: boolean; lose?: number } = {},
) {
  const calls = { used: 0, simulate: 0, sign: 0, send: 0, inFlight: 0, maxInFlight: 0 };
  const chain: Chain = {
    timestamp: async () => Math.floor(Date.now() / 1000),
    balance: async () => 100000n,
    ethBalance: async () => 10n ** 18n,
    minedNonce: async () => 0,
    nonceClear: async () => true,
    receipt: async () => ({ reverted: false, costWei: 1n }),
    transaction: async () => true,
    used: async () => {
      calls.used++;
      return o.used ?? false;
    },
    simulate: async () => {
      calls.simulate++;
      return !o.reverts;
    },
    sign: async () => {
      calls.sign++;
      return o.cap ? null : { serialized: '0xsigned', hash: `0xhash${calls.sign}`, maxCostWei: 1n };
    },
    send: async () => {
      calls.send++;
      calls.inFlight++;
      calls.maxInFlight = Math.max(calls.maxInFlight, calls.inFlight);
      await new Promise((r) => setTimeout(r, o.sendDelay ?? 0));
      calls.inFlight--;
      if (calls.send <= (o.lose ?? 0)) throw new Error('answer lost');
      return `0xhash${calls.send}`;
    },
  };
  return { chain, calls };
}
const signal = () => new AbortController().signal;

describe('demo host files', () => {
  it('loads files and their headers, and refuses bad manifests', async () => {
    const files = await setup([{ name: 'hello', fileId: FILE_ID, title: 'Hello' }], {
      hello: pay2(100, 50),
    });
    expect(files[0]).toMatchObject({ name: 'hello', size: 150 });
    expect(files[0]?.header.length).toBe(100);
    expect(files[0]?.headerHash).toMatch(/^0x[0-9a-f]{64}$/);
    await reset();
    await expect(setup([{ name: '../x', fileId: FILE_ID, title: 'x' }], {})).rejects.toThrow('bad');
    await reset();
    await expect(
      setup(
        [
          { name: 'a', fileId: FILE_ID, title: 'a' },
          { name: 'a', fileId: FILE_ID, title: 'b' },
        ],
        { a: pay2(100, 1) },
      ),
    ).rejects.toThrow('duplicate');
    await reset();
    await expect(
      setup([{ name: 'short', fileId: FILE_ID, title: 's' }], { short: pay2(20, 1) }),
    ).rejects.toThrow('header length');
    await reset();
    await expect(
      setup([{ name: 'n', fileId: FILE_ID, title: 'n', priceUsdc: 0.1 }], { n: pay2(100, 1) }),
    ).rejects.toThrow('priceUsdc');
    await reset();
    await expect(setup([{ name: 'n', fileId: FILE_ID }], { n: pay2(100, 1) })).rejects.toThrow(
      'title',
    );
    await reset();
    await expect(setup({ name: 'n' }, {})).rejects.toThrow('list');
  });
});

describe('demo host routes', () => {
  it('lists files, escapes text, prints a price cap and serves headers', async () => {
    const files = await setup(
      [{ name: 'hello', fileId: FILE_ID, title: '<b>Hi</b>', priceUsdc: '0.10' }],
      { hello: pay2(100, 10) },
    );
    const url = await start({ files });
    const html = await (await fetch(`${url}/`)).text();
    expect(html).toContain('&lt;b&gt;Hi&lt;/b&gt;');
    expect(html).not.toContain('<b>Hi</b>');
    expect(html).toContain('annon buy https://demo.example/f/hello --route base --max-price 0.10');
    const list = await (await fetch(`${url}/files.json`)).json();
    expect(list).toEqual([
      expect.objectContaining({
        name: 'hello',
        url: 'https://demo.example/f/hello',
        header: 'https://demo.example/f/hello/header',
      }),
    ]);
    const h = await fetch(`${url}/f/hello/header`);
    expect(new Uint8Array(await h.arrayBuffer())).toEqual(files[0]?.header);
    expect((await fetch(`${url}/f/nope`)).status).toBe(404);
    expect((await fetch(`${url}/f/hello/other`)).status).toBe(404);
  });

  it('answers HEAD and other methods with 405 without serving', async () => {
    const files = await setup([{ name: 'hello', fileId: FILE_ID, title: 'Hello' }], {
      hello: pay2(100, 10),
    });
    let served = 0;
    const url = await start({ files }, async () => {
      served++;
      return { status: 402, headers: {} };
    });
    expect(
      (await fetch(`${url}/f/hello`, { method: 'HEAD', headers: { 'PAYMENT-SIGNATURE': 'x' } }))
        .status,
    ).toBe(405);
    expect(
      (
        await fetch(`${url}/f/hello`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      ).status,
    ).toBe(405);
    expect(served).toBe(0);
  });

  it('passes the request to serveFile with the public URLs and streams the answer', async () => {
    const files = await setup([{ name: 'hello', fileId: FILE_ID, title: 'Hello' }], {
      hello: pay2(100, 10),
    });
    let seen: { url?: string; header?: string; sig?: string | null } = {};
    const url = await start({ files }, async (req, o) => {
      seen = { url: o.url, header: o.header, sig: req.headers.get('PAYMENT-SIGNATURE') };
      return {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
        body: o.file.read(100),
      };
    });
    const r = await fetch(`${url}/f/hello`, { headers: { 'PAYMENT-SIGNATURE': 'abc' } });
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array(10).fill(7));
    expect(seen).toEqual({
      url: 'https://demo.example/f/hello',
      header: 'https://demo.example/f/hello/header',
      sig: 'abc',
    });
  });

  it('cancels the file stream when the client goes away', async () => {
    const files = await setup([{ name: 'hello', fileId: FILE_ID, title: 'Hello' }], {
      hello: pay2(100, 10),
    });
    let canceled = false;
    const url = await start({ files }, async () => ({
      status: 200,
      headers: {},
      body: new ReadableStream<Uint8Array>({
        pull: async (c) => {
          await new Promise((r) => setTimeout(r, 5));
          c.enqueue(new Uint8Array(64 * 1024));
        },
        cancel: () => {
          canceled = true;
        },
      }),
    }));
    await new Promise<void>((done) => {
      const req = request(`${url}/f/hello`, (res) => {
        res.once('data', () => {
          req.destroy();
          done();
        });
      });
      req.end();
    });
    for (let i = 0; i < 50 && !canceled; i++) await new Promise((r) => setTimeout(r, 10));
    expect(canceled).toBe(true);
  });

  it('answers 500 without detail when serving throws', async () => {
    const files = await setup([{ name: 'hello', fileId: FILE_ID, title: 'Hello' }], {
      hello: pay2(100, 1),
    });
    const url = await start({ files }, async () => {
      throw new Error('rpc down with secret detail');
    });
    const r = await fetch(`${url}/f/hello`);
    expect(r.status).toBe(500);
    expect(await r.text()).toBe('');
  });

  it('refuses Base payments with 501 and hides the Base command without a facilitator', async () => {
    const files = await setup([{ name: 'hello', fileId: FILE_ID, title: 'Hello' }], {
      hello: pay2(100, 1),
    });
    let served = 0;
    const url = await start({ files, facilitator: undefined } as never, async () => {
      served++;
      return { status: 402, headers: {} };
    });
    expect((await fetch(`${url}/f/hello`, { headers: { 'PAYMENT-SIGNATURE': 'x' } })).status).toBe(
      501,
    );
    expect(served).toBe(0);
    expect(await (await fetch(`${url}/`)).text()).not.toContain('--route base');
  });

  it('limits payment submissions per client', async () => {
    const files = await setup([{ name: 'hello', fileId: FILE_ID, title: 'Hello' }], {
      hello: pay2(100, 1),
    });
    const url = await start({ files, paymentsPerClientMinute: 1 }, async () => ({
      status: 402,
      headers: {},
    }));
    expect((await fetch(`${url}/f/hello`, { headers: { 'PAYMENT-SIGNATURE': 'x' } })).status).toBe(
      402,
    );
    expect((await fetch(`${url}/f/hello`, { headers: { 'PAYMENT-SIGNATURE': 'y' } })).status).toBe(
      429,
    );
    expect((await fetch(`${url}/f/hello`)).status).toBe(402);
  });
});

describe('demo host limits', () => {
  it('limits per key per minute, bounds the map, and not health checks', async () => {
    let t = 0;
    const allow = limiter(2, () => t, 2);
    expect([allow('a'), allow('a'), allow('a'), allow('b')]).toEqual([true, true, false, true]);
    expect([allow('c'), allow('d'), allow('e')]).toEqual([true, true, false]);
    t = 60_000;
    expect(allow('a')).toBe(true);
    const url = await start({ perIpMinute: 1 });
    expect((await fetch(`${url}/`)).status).toBe(200);
    expect((await fetch(`${url}/`)).status).toBe(429);
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
  });

  it('keys clients by a single-value header, IPv6 by /48', () => {
    expect(clientKey('203.0.113.7', '10.0.0.1')).toBe('203.0.113.7');
    expect(clientKey('203.0.113.7, 10.0.0.9', '10.0.0.1')).toBe('10.0.0.1');
    expect(clientKey(['a', 'b'], '10.0.0.1')).toBe('10.0.0.1');
    expect(clientKey(undefined, '::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(clientKey('2001:db8:1:2:3:4:5:6', undefined)).toBe('2001:db8:1::/48');
    expect(clientKey('2001:db8:1:2::9', undefined)).toBe('2001:db8:1::/48');
    expect(clientKey('2001:db8::1', undefined)).toBe('2001:db8:0::/48');
    expect(clientKey('x'.repeat(20_000), undefined)).toBe('unknown');
  });
});

describe('demo host facilitator', () => {
  it('refuses another recipient, amount, asset or network before touching the chain', async () => {
    const { chain, calls } = fakeChain();
    const f = facilitatorFor(chain);
    for (const over of [
      { to: '0x00000000000000000000000000000000000000bb' },
      { value: '99999' },
      { asset: '0x0000000000000000000000000000000000000001' },
      { network: 'eip155:1' },
    ])
      await expect(f(body(over), { signal: signal() })).resolves.toMatchObject({
        success: false,
        errorReason: 'invalid_authorization',
      });
    expect(calls).toMatchObject({ used: 0, sign: 0, send: 0 });
  });

  it('sends once, answers pending with the hash, and returns the same hash on a repeat', async () => {
    const { chain, calls } = fakeChain();
    const f = facilitatorFor(chain);
    await expect(f(body(), { signal: signal() })).resolves.toMatchObject({
      success: false,
      errorReason: 'settlement_pending',
      transaction: '0xhash1',
    });
    await expect(f(body(), { signal: signal() })).resolves.toMatchObject({
      errorReason: 'settlement_pending',
      transaction: '0xhash1',
    });
    expect(calls.send).toBe(1);
  });

  it('skips used authorizations and fees above the cap, and never sends after an abort', async () => {
    const used = fakeChain({ used: true });
    await expect(facilitatorFor(used.chain)(body(), { signal: signal() })).resolves.toMatchObject({
      errorReason: 'authorization_used',
    });
    expect(used.calls.send).toBe(0);
    const capped = fakeChain({ cap: true });
    await expect(facilitatorFor(capped.chain)(body(), { signal: signal() })).resolves.toMatchObject(
      { errorReason: 'gas_price_too_high' },
    );
    expect(capped.calls.send).toBe(0);
    const aborted = fakeChain();
    const a = new AbortController();
    a.abort(new Error('timed out'));
    await expect(facilitatorFor(aborted.chain)(body(), { signal: a.signal })).rejects.toThrow(
      'timed out',
    );
    expect(aborted.calls.send).toBe(0);
  });

  it('sends one transaction at a time', async () => {
    const { chain, calls } = fakeChain({ sendDelay: 20 });
    const f = facilitatorFor(chain);
    const other = (n: string) =>
      ({
        ...(body() as object),
        paymentPayload: {
          payload: {
            signature: `0x${'22'.repeat(65)}`,
            authorization: { ...AUTH, from: `0x${n.repeat(40)}`, nonce: `0x${n.repeat(64)}` },
          },
        },
      }) as never;
    await Promise.all([
      f(other('1'), { signal: signal() }),
      f(other('2'), { signal: signal() }),
      f(other('3'), { signal: signal() }),
    ]);
    expect(calls.send).toBe(1);
    expect(calls.maxInFlight).toBe(1);
  });

  it('simulates first: a payer USDC would refuse costs no gas', async () => {
    const { chain, calls } = fakeChain({ reverts: true });
    await expect(facilitatorFor(chain)(body(), { signal: signal() })).resolves.toMatchObject({
      errorReason: 'invalid_authorization',
    });
    expect(calls).toMatchObject({ simulate: 1, sign: 0, send: 0 });
  });

  it('caps sends per minute', async () => {
    const { chain, calls } = fakeChain();
    const f = facilitatorFor(chain, 1, () => 0);
    const other = (n: string) =>
      ({
        ...(body() as object),
        paymentPayload: {
          payload: {
            signature: `0x${'22'.repeat(65)}`,
            authorization: { ...AUTH, from: `0x${n.repeat(40)}`, nonce: `0x${n.repeat(64)}` },
          },
        },
      }) as never;
    await expect(f(other('1'), { signal: signal() })).resolves.toMatchObject({
      errorReason: 'settlement_pending',
    });
    await expect(f(other('2'), { signal: signal() })).resolves.toMatchObject({
      errorReason: 'facilitator_busy',
    });
    expect(calls.send).toBe(1);
  });

  it('after a lost send preserves the signed hash for reconciliation', async () => {
    let t = 1_000_000;
    const { chain, calls } = fakeChain({ lose: 1 });
    const f = facilitatorFor(chain, 10, () => t);
    await expect(f(body(), { signal: signal() })).rejects.toThrow('answer lost');
    await expect(f(body(), { signal: signal() })).resolves.toMatchObject({
      errorReason: 'settlement_pending',
      transaction: '0xhash1',
    });
    expect(calls.send).toBe(1);
    t += 61_000;
    await expect(f(body(), { signal: signal() })).resolves.toMatchObject({
      errorReason: 'settlement_pending',
      transaction: '0xhash1',
    });
    expect(calls.send).toBe(1);
  });

  it('retains authorization evidence until reconciliation', async () => {
    let t = 0;
    const { chain, calls } = fakeChain();
    const f = facilitatorFor(chain, 10, () => t);
    await f(body(), { signal: signal() });
    t = 86_000_000;
    await f(body(), { signal: signal() });
    expect(calls.send).toBe(1);
  });

  it('sends one authorization per payer at a time', async () => {
    let now = 0;
    const { chain, calls } = fakeChain();
    const f = facilitatorFor(chain, 10, () => now);
    const other = (n: string) =>
      ({
        ...(body() as object),
        paymentPayload: {
          payload: {
            signature: `0x${'22'.repeat(65)}`,
            authorization: { ...AUTH, nonce: `0x${n.repeat(64)}` },
          },
        },
      }) as never;
    await expect(f(other('1'), { signal: signal() })).resolves.toMatchObject({
      errorReason: 'settlement_pending',
    });
    await expect(f(other('2'), { signal: signal() })).resolves.toMatchObject({
      errorReason: 'payer_busy',
    });
    now = 31_000;
    await expect(f(other('2'), { signal: signal() })).resolves.toMatchObject({
      errorReason: 'settlement_pending',
    });
    expect(calls.send).toBe(2);
  });
});

it('sets browser security headers and CORS on success, errors and preflight before admission', async () => {
  const url = await start({ perIpMinute: 1 });
  const headers = { Origin: 'https://annon.dev' };
  const page = await fetch(`${url}/`, { headers });
  expect(page.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
  expect(page.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(page.headers.get('Access-Control-Allow-Origin')).toBe(headers.Origin);
  const busy = await fetch(`${url}/missing`, { headers });
  expect(busy.status).toBe(429);
  expect(Number(busy.headers.get('Retry-After'))).toBeGreaterThan(0);
  expect(await busy.json()).toMatchObject({ error: 'rate_limited', message: expect.any(String) });
  expect(busy.headers.get('Access-Control-Allow-Origin')).toBe(headers.Origin);
  const preflight = await fetch(`${url}/f/missing`, {
    method: 'OPTIONS',
    headers: {
      ...headers,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'Range, Annon-Buyer-Proof',
    },
  });
  expect(preflight.status).toBe(204);
  expect(
    (await fetch(`${url}/f/missing`, { method: 'POST', headers: { 'Content-Type': 'text/plain' } }))
      .status,
  ).toBe(415);
});
it('rejects files exceeding encrypted or inferred plaintext size limits', async () => {
  const { truncate } = await import('node:fs/promises');
  dir = await mkdtemp(join(tmpdir(), 'host-size-'));
  await writeFile(
    join(dir, 'files.json'),
    JSON.stringify([{ name: 'large', fileId: FILE_ID, title: 'Large' }]),
  );
  await writeFile(join(dir, 'large.pay2'), pay2(100, 1));
  await truncate(join(dir, 'large.pay2'), 50_086_017);
  await expect(loadFiles(dir)).rejects.toThrow();
  await truncate(join(dir, 'large.pay2'), 50_000_101);
  await expect(loadFiles(dir)).rejects.toThrow();
});
it('records successful writes, prepares completion before end, and bills only after response finish', async () => {
  const files = await setup([{ name: 'hello', fileId: FILE_ID, title: 'Hello' }], {
    hello: pay2(100, 10),
  });
  const calls: string[] = [];
  const url = await start({ files }, async (_req, o) => ({
    status: 206,
    headers: { 'Content-Length': '10', 'Content-Range': 'bytes 100-109/110' },
    body: o.file.read(100),
    delivery: {
      wrote: async (offset) => {
        calls.push(`wrote:${offset}`);
      },
      prepare: async () => {
        calls.push('prepare');
      },
      finish: async () => {
        calls.push('finish');
      },
      interrupt: async () => {
        calls.push('interrupt');
      },
    },
  }));
  const r = await fetch(`${url}/f/hello`);
  await r.arrayBuffer();
  for (let i = 0; i < 20 && !calls.includes('finish'); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(calls).toEqual(['wrote:110', 'prepare', 'finish']);
});
it('uses final terms for the catalog, omits stopped sales and fails closed on chain failure', async () => {
  const files = await setup(
    [{ name: 'hello', fileId: FILE_ID, title: 'Hello', priceUsdc: '999' }],
    { hello: pay2(100, 10) },
  );
  let state = 'active';
  const url = await start({
    files,
    getFile: async () => {
      if (state === 'error') throw new Error('private');
      return {
        price: 100000n,
        terms: { network: 'near:mainnet', base: { pay_to: `0x${'22'.repeat(20)}` } },
        termsHash: 'final',
        takenDown: null,
        salesStoppedAt: state === 'stopped' ? 1 : null,
      } as never;
    },
  });
  const r = await fetch(`${url}/files.json`);
  const catalog = await r.json();
  expect(catalog[0]).toMatchObject({
    termsHash: 'final',
    terms: { network: 'near:mainnet', base: { pay_to: `0x${'22'.repeat(20)}` } },
    byteSize: 110,
    plaintextSize: 10,
  });
  expect(catalog[0]).not.toHaveProperty('priceUsdc');
  state = 'stopped';
  expect(await (await fetch(`${url}/files.json`)).json()).toEqual([]);
  state = 'error';
  expect((await fetch(`${url}/files.json`)).status).toBe(503);
});
it('interrupts accounting on a client disconnect while the source is waiting', async () => {
  const files = await setup([{ name: 'hello', fileId: FILE_ID, title: 'Hello' }], {
    hello: pay2(100, 10),
  });
  const events: string[] = [];
  let canceled = false;
  const url = await start({ files }, async () => ({
    status: 200,
    headers: {},
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((r) => setTimeout(r, 20));
        if (!canceled) controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        canceled = true;
      },
    }),
    delivery: {
      async wrote() {
        events.push('write');
      },
      async prepare() {
        events.push('prepare');
      },
      async finish() {
        events.push('finish');
      },
      async interrupt() {
        events.push('interrupt');
      },
    },
  }));
  await new Promise<void>((resolve) => {
    const req = request(`${url}/f/hello`, (res) => {
      res.once('data', () => {
        req.destroy();
        resolve();
      });
    });
    req.end();
  });
  for (let i = 0; i < 50 && !events.includes('interrupt'); i++)
    await new Promise((r) => setTimeout(r, 10));
  expect(events).toContain('interrupt');
  expect(events).not.toContain('finish');
  expect(events).not.toContain('prepare');
});
it('reports startup failures without stack traces or upstream diagnostics', async () => {
  const { execFile } = await import('node:child_process');
  const result = await new Promise<{ code: number; stderr: string }>((resolve) => {
    execFile(
      process.execPath,
      ['--import', './ts-hook.mjs', 'server.ts'],
      { cwd: import.meta.dirname, env: { PATH: process.env.PATH ?? '', NODE_NO_WARNINGS: '1' } },
      (error, _stdout, stderr) => resolve({ code: error?.code as number, stderr }),
    );
  });
  expect(result.code).toBe(1);
  expect(result.stderr.trim()).toBe('{"error":"host_startup_failed","reason":"config_invalid"}');
});

it('removes allow-origin on a forbidden preflight from an allowed origin', async () => {
  const url = await start({});
  const res = await fetch(url, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://annon.dev',
      'Access-Control-Request-Method': 'DELETE',
    },
  });
  expect(res.status).toBe(403);
  expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
});

it('includes a safe message when the payment admission limit is reached', async () => {
  const files = await setup([{ name: 'hello', fileId: FILE_ID, title: 'Hello' }], {
    hello: pay2(100, 10),
  });
  const url = await start({ files, paymentsPerClientMinute: 1 }, async () => ({
    status: 402,
    headers: {},
  }));
  const headers = { 'PAYMENT-SIGNATURE': 'payload' };
  expect((await fetch(`${url}/f/hello`, { headers })).status).toBe(402);
  const blocked = await fetch(`${url}/f/hello`, { headers });
  expect(blocked.status).toBe(429);
  expect(await blocked.json()).toMatchObject({
    error: 'rate_limited',
    message: expect.any(String),
  });
});

it.each(['transport', 'base_rpc_rate_limited', 'payment_rejected'] as const)(
  'alerts on transient payment failure %s',
  async (code) => {
    const { PayError } = await import('../../packages/annon/src/pay/base.ts');
    const alerts: unknown[] = [];
    const files = await setup([{ name: 'hello', fileId: FILE_ID, title: 'Hello' }], {
      hello: pay2(100, 10),
    });
    const url = await start(
      {
        files,
        alert: async (event) => {
          alerts.push(event);
        },
      },
      async (_req, options) => {
        options.onPaymentError?.(new PayError(code));
        return { status: 503, headers: {} };
      },
    );
    expect((await fetch(`${url}/f/hello`)).status).toBe(503);
    expect(alerts).toEqual(code === 'payment_rejected' ? [] : [{ type: 'base_rpc_unhealthy' }]);
  },
);

it.each([
  ['../bad\r\nname(1)!.txt', 'badname%281%29%21.txt'],
  ['../', 'download'],
  ['a\u202eb\u200bc\u2028d\u2029.txt', 'abcd.txt'],
  ['..', 'download'],
])('confines Content-Disposition filename %j to a plain basename', async (filename, encoded) => {
  const files = await setup([{ name: 'hello', fileId: FILE_ID, title: 'Hello' }], {
    hello: pay2(100, 10),
  });
  const file = files[0];
  if (!file) throw new Error('Missing fixture');
  file.filename = filename;
  const url = await start({ files }, async () => ({ status: 200, headers: {} }));
  const response = await fetch(`${url}/f/hello`);
  expect(response.headers.get('Content-Disposition')).toBe(
    `attachment; filename*=UTF-8''${encoded}`,
  );
  await response.arrayBuffer();
});

it('reports unavailable upload hosting before processing requests when it is not configured', async () => {
  const url = await start({ files: [] });
  const response = await fetch(`${url}/v1/uploads`);
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: 'unavailable' });
});

it('verifies hosted bytes before serving a public header or invoking payment work', async () => {
  const files = await setup([{ name: 'hello', fileId: FILE_ID, title: 'Hello' }], {
    hello: pay2(100, 10),
  });
  const file = files[0];
  if (!file) throw new Error('Missing fixture');
  file.verify = async () => {
    throw new Error('Corrupt body');
  };
  const serve = vi.fn(async () => ({ status: 200, headers: {} }));
  const url = await start({ files }, serve);
  expect((await fetch(`${url}/f/hello/header`)).status).toBe(500);
  expect((await fetch(`${url}/f/hello`)).status).toBe(500);
  expect(serve).not.toHaveBeenCalled();
});
it.each([null, { pay_to: `0x${'22'.repeat(20)}` }])(
  'advertises Base only from final terms (%j)',
  async (base) => {
    const files = await setup([{ name: 'file', fileId: FILE_ID, title: 'File' }], {
      file: pay2(128, 50),
    });
    const url = await start({
      files,
      getFile: async () =>
        ({ price: 100000n, takenDown: null, salesStoppedAt: null, terms: { base } }) as never,
    });
    const html = await (await fetch(url)).text();
    expect(html.includes('--route base')).toBe(base !== null);
    expect(html).toContain('--route near');
    expect(html).toContain('--route 1click');
  },
);
it('refuses a crafted Base payment before the settlement handler for a file without Base terms', async () => {
  const files = await setup([{ name: 'file', fileId: FILE_ID, title: 'File' }], {
    file: pay2(128, 50),
  });
  const serve = vi.fn();
  const url = await start(
    { files, getFile: async () => ({ takenDown: null, terms: { base: null } }) as never },
    serve,
  );
  const response = await fetch(`${url}/f/file`, { headers: { 'Payment-Signature': 'crafted' } });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: 'route_unavailable',
    message: 'This file does not support the selected payment route.',
  });
  expect(serve).not.toHaveBeenCalled();
});
