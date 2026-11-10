import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayError } from '../../packages/annon/src/relay/relay.ts';
import { type Config, fromEnv, handle, hits, serve } from './server.ts';

const config = (over: Partial<Config> = {}): Config => ({
  nearRpc: 'https://near.rpc',
  baseRpc: 'https://base.rpc',
  contractId: 'v1.annon.defdone.near',
  usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  sender: { accountId: 'relayer.annon.defdone.near', key: 'ed25519:x' },
  policy: { minPrice: 10_000n, maxDeadlineSeconds: 600 },
  disabled: false,
  perIpHour: 60,
  perDay: 500,
  ...over,
});
const ok = async () => ({ txHash: 'H' });
const body = JSON.stringify({ method: 'unlock', args: { file_id: `0x${'11'.repeat(32)}` } });
beforeEach(() => hits.clear());

describe('relayer HTTP', () => {
  it('says what it sponsors, and relays a request', async () => {
    const cap = await handle(config(), 'GET', '/v1/capabilities', '1.1.1.1', '');
    expect(cap).toMatchObject({
      status: 200,
      body: {
        contract: 'v1.annon.defdone.near',
        minPrice: '10000',
        disabled: false,
        methods: ['register', 'unlock', 'claim_key', 'reopen', 'reopen_seller', 'stop_sales'],
      },
    });
    expect(await handle(config(), 'POST', '/v1/relay', '1.1.1.1', body, ok)).toEqual({
      status: 200,
      body: { txHash: 'H', signer: 'relayer.annon.defdone.near' },
    });
  });

  it("says 202 and uncertain when NEAR's answer was lost, and keeps the budget spent", async () => {
    const c = config({ perDay: 1 });
    const lost = async () => ({
      txHash: 'H',
      uncertain: true as const,
      reason: 'NEAR answered: x',
    });
    expect(await handle(c, 'POST', '/v1/relay', 'a', body, lost)).toEqual({
      status: 202,
      body: {
        txHash: 'H',
        signer: 'relayer.annon.defdone.near',
        uncertain: true,
        reason: 'NEAR answered: x',
      },
    });
    expect((await handle(c, 'POST', '/v1/relay', 'b', body, ok)).status).toBe(503);
  });

  it('takes a limit of zero as zero, from the first request', async () => {
    let sent = 0;
    const count = async () => {
      sent++;
      return { txHash: 'H' };
    };
    expect(
      (await handle(config({ perDay: 0 }), 'POST', '/v1/relay', 'a', body, count)).status,
    ).toBe(503);
    expect(
      (await handle(config({ perIpHour: 0 }), 'POST', '/v1/relay', 'b', body, count)).status,
    ).toBe(429);
    expect(sent).toBe(0);
  });

  it('refuses to start on a missing or malformed setting, instead of serving without a limit', () => {
    const base = { CONTRACT_ID: 'c.near', RELAYER_ACCOUNT: 'r.near', RELAYER_KEY: 'ed25519:x' };
    expect(fromEnv(base).config).toMatchObject({ perDay: 500, perIpHour: 60 });
    expect(fromEnv({ ...base, PER_DAY: '0' }).config.perDay).toBe(0);
    for (const [name, bad] of [
      ['PER_DAY', 'abc'],
      ['PER_IP_HOUR', '-1'],
      ['MAX_DEADLINE_SECONDS', '1.5'],
      ['MIN_PRICE', '0.5'],
      ['PORT', 'x'],
    ])
      expect(() => fromEnv({ ...base, [name as string]: bad })).toThrow(name);
    expect(() => fromEnv({ ...base, RELAYER_KEY: ' ' })).toThrow('RELAYER_KEY');
  });

  it('sends nothing when switched off, or for a bad body or path', async () => {
    let sent = 0;
    const count = async () => {
      sent++;
      return { txHash: 'H' };
    };
    expect(
      (await handle(config({ disabled: true }), 'POST', '/v1/relay', 'a', body, count)).status,
    ).toBe(503);
    expect((await handle(config(), 'POST', '/v1/relay', 'a', '{', count)).status).toBe(400);
    expect((await handle(config(), 'GET', '/v1/relay', 'a', '', count)).status).toBe(404);
    expect(sent).toBe(0);
  });

  it('maps relay errors to HTTP: too early, gone, conflict, bad request, upstream', async () => {
    const as = (code: ConstructorParameters<typeof RelayError>[0]) => async () => {
      throw new RelayError(code);
    };
    const status = async (code: ConstructorParameters<typeof RelayError>[0]) =>
      (await handle(config(), 'POST', '/v1/relay', `ip-${code}`, body, as(code))).status;
    expect(await status('payment_not_safe')).toBe(425);
    expect(await status('taken_down')).toBe(410);
    expect(await status('payment_used')).toBe(409);
    expect(await status('bad_signature')).toBe(400);
    expect(await status('not_sponsored')).toBe(403);
    expect(await status('transport')).toBe(502);
    const crash = async () => {
      throw new Error('boom');
    };
    expect(await handle(config(), 'POST', '/v1/relay', 'x', body, crash)).toEqual({
      status: 500,
      body: { error: 'internal', message: 'unexpected error' },
    });
  });

  it('limits each address per hour and the whole day, counting only what was sent', async () => {
    const c = config({ perIpHour: 2, perDay: 1 });
    const refused = async () => {
      throw new RelayError('payment_not_found');
    };
    expect((await handle(c, 'POST', '/v1/relay', 'a', body, refused)).status).toBe(404);
    expect((await handle(c, 'POST', '/v1/relay', 'b', body, ok)).status).toBe(200);
    // The refused request did not use the day's budget; the sent one did.
    expect((await handle(c, 'POST', '/v1/relay', 'c', body, ok)).status).toBe(503);
    expect((await handle(c, 'POST', '/v1/relay', 'a', body, ok)).status).toBe(503);
    expect((await handle(c, 'POST', '/v1/relay', 'a', body, ok)).status).toBe(429);
  });

  it("gives a failed request's budget back to its own day, not to the next", async () => {
    const c = config({ perDay: 1, perIpHour: 100 });
    let fail: (e: Error) => void = () => {};
    const late = () => new Promise<{ txHash: string }>((_, no) => (fail = no));
    const first = handle(c, 'POST', '/v1/relay', 'a', body, late);
    vi.setSystemTime(Date.now() + 86_400_000 + 1);
    try {
      expect((await handle(c, 'POST', '/v1/relay', 'b', body, ok)).status).toBe(200);
      fail(new RelayError('payment_not_found'));
      expect((await first).status).toBe(404);
      expect((await handle(c, 'POST', '/v1/relay', 'c', body, ok)).status).toBe(503);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the day's budget under concurrent requests", async () => {
    const c = config({ perDay: 1, perIpHour: 100 });
    const slow = () =>
      new Promise<{ txHash: string }>((r) => setTimeout(() => r({ txHash: 'H' }), 20));
    const all = await Promise.all(
      Array.from({ length: 20 }, () => handle(c, 'POST', '/v1/relay', 'same', body, slow)),
    );
    expect(all.filter((r) => r.status === 200)).toHaveLength(1);
    expect(all.filter((r) => r.status === 503)).toHaveLength(19);
  });
});

describe('relayer limits memory', () => {
  it('sweeps expired counters, and bounds them when they are not expired', async () => {
    const now = Date.now();
    for (let i = 0; i < 10_000; i++) hits.set(`ip:old${i}`, { n: 1, until: now - 1 });
    await handle(config(), 'POST', '/v1/relay', 'fresh', '{', async () => ({ txHash: 'H' }));
    expect(hits.size).toBeLessThan(10);
    for (let i = 0; i < 100_000; i++) hits.set(`ip:live${i}`, { n: 1, until: now + 3_600_000 });
    expect((await handle(config(), 'POST', '/v1/relay', 'another', body, ok)).status).toBe(429);
  });
});

describe('relayer HTTP server', () => {
  it('survives a null body, an oversized body and an aborted upload', async (context) => {
    const server = serve(config(), 0);
    const listenError = await new Promise<Error | undefined>((resolve) => {
      server.once('listening', () => resolve(undefined));
      server.once('error', resolve);
    });
    // Managed workspaces may prohibit socket binding. Exercise handle() above in every environment.
    if (listenError && 'code' in listenError && listenError.code === 'EPERM')
      return context.skip('sandbox prohibits binding a local HTTP socket');
    if (listenError) throw listenError;
    const port = (server.address() as AddressInfo).port;
    const post = (b: string) =>
      fetch(`http://127.0.0.1:${port}/v1/relay`, { method: 'POST', body: b }).then((r) => r.status);
    try {
      expect(await post('null')).toBe(400);
      expect(await post('x'.repeat(70_000))).toBe(413);
      // Announce a body, send half, hang up.
      await new Promise<void>((done) => {
        const s = connect(port, '127.0.0.1', () => {
          s.write('POST /v1/relay HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\n\r\n{"a":');
          setTimeout(() => {
            s.destroy();
            done();
          }, 20);
        });
      });
      await new Promise((r) => setTimeout(r, 30));
      const cap = await fetch(`http://127.0.0.1:${port}/v1/capabilities`);
      expect(cap.status).toBe(200);
    } finally {
      server.close();
    }
  });
});
