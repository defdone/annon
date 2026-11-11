import { spawnSync } from 'node:child_process';
import { appendFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Annon } from '../../packages/annon/src/api/annon.ts';
import { createAdapter } from '../../packages/annon/src/node/adapter.ts';
import {
  canonicalRequest,
  checkRelay,
  contractArgs,
  RelayError,
} from '../../packages/annon/src/relay/relay.ts';
import { termsHash } from '../../packages/annon/src/settle-near/terms.ts';
import { purchase, terms } from '../../packages/annon/test/fixtures.ts';
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
    expect(await handle(config(), 'POST', '/v1/relay', 'pending', body, as('in_flight'))).toEqual({
      status: 202,
      body: { pending: true, retryAfterMs: 5000 },
    });
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

describe('the container start', () => {
  it('loads server.ts with Node type stripping, as the Docker image runs it', () => {
    // vitest transpiles; Node only strips types, so syntax it lacks (e.g. parameter properties)
    // passes the other tests and stops the relayer at start.
    const out = spawnSync(
      process.execPath,
      ['--no-warnings', '--import', './ts-hook.mjs', '-e', "await import('./server.ts')"],
      { cwd: import.meta.dirname, encoding: 'utf8' },
    );
    expect(out.stderr).toBe('');
    expect(out.status).toBe(0);
  });
});

describe.runIf(process.env.ANNON_TEST_CONTAINER === '1')(
  'isolated production container dependencies',
  () => {
    it('starts after the Docker prod-filter install and has no development dependencies', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'annon-prod-install-'));
      const root = join(import.meta.dirname, '../..');
      try {
        for (const folder of ['packages/annon', 'packages/annon-mcp', 'apps/relayer'])
          await mkdir(join(dir, folder), { recursive: true });
        for (const file of [
          'package.json',
          'pnpm-lock.yaml',
          'pnpm-workspace.yaml',
          'packages/annon/package.json',
          'packages/annon-mcp/package.json',
          'apps/relayer/package.json',
          'apps/relayer/server.ts',
          'apps/relayer/ts-hook.mjs',
        ])
          await cp(join(root, file), join(dir, file));
        await cp(join(root, 'packages/annon/src'), join(dir, 'packages/annon/src'), {
          recursive: true,
        });
        const install = spawnSync(
          'pnpm',
          [
            'install',
            '--frozen-lockfile',
            '--prod',
            '--filter',
            '@defdone/annon',
            '--filter',
            '@defdone/annon-relayer',
            '--store-dir',
            join(dir, 'store'),
          ],
          {
            cwd: dir,
            encoding: 'utf8',
            timeout: 120000,
            env: { PATH: process.env.PATH, CI: 'true', npm_config_cache: join(dir, 'npm-cache') },
          },
        );
        expect(install.status, install.stdout + install.stderr).toBe(0);
        const app = join(dir, 'apps/relayer');
        const noDev = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            "try { import.meta.resolve('vitest'); process.exit(1); } catch { process.exit(0); }",
          ],
          { cwd: app, encoding: 'utf8' },
        );
        expect(noDev.status).toBe(0);
        const start = spawnSync(
          process.execPath,
          ['--no-warnings', '--import', './ts-hook.mjs', 'server.ts'],
          { cwd: app, encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH } },
        );
        expect(start.stderr).toContain('CONTRACT_ID is not set');
        expect(start.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
        // Prove this harness detects a dev-only runtime import that the dev install permits.
        await appendFile(join(app, 'server.ts'), "\nimport 'vitest';\n");
        const broken = spawnSync(
          process.execPath,
          ['--no-warnings', '--import', './ts-hook.mjs', 'server.ts'],
          {
            cwd: app,
            encoding: 'utf8',
            timeout: 10000,
            env: { PATH: process.env.PATH },
          },
        );
        expect(broken.stderr).toContain('ERR_MODULE_NOT_FOUND');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 150000);
  },
);

describe('adapter to relayer boundary without a signing transport', () => {
  it.each(['outcome', 'lost-post-pending', 'legacy-duplicate'] as const)(
    'passes claim_key through the relayer and handles %s without reposting a known hash',
    async (mode) => {
      const dir = await mkdtemp(join(tmpdir(), 'annon-relay-boundary-'));
      const c = config({ contractId: terms.contract, usdc: purchase.asset });
      const args = { purchase_id: `0x${'11'.repeat(32)}`, grant: 0 };
      const answer = { big_y: 'bls12381g1:Y', big_c: 'bls12381g1:C' };
      let wire: object | undefined;
      let httpRequests = 0;
      let lookups = 0;
      const send = vi.fn(async (input: unknown) => {
        const req = canonicalRequest(input);
        await checkRelay(req, c);
        wire = contractArgs(req);
        return { txHash: 'H' };
      });
      const fetcher = vi.fn<typeof fetch>(async (url, init) => {
        if (String(url).endsWith('/v1/relay')) {
          httpRequests++;
          if (mode !== 'outcome' && httpRequests === 1) throw new Error('POST timed out');
          if (mode === 'legacy-duplicate' && httpRequests === 2)
            return Response.json({ error: 'duplicate' }, { status: 409 });
          if (mode === 'lost-post-pending' && httpRequests === 2)
            return Response.json({ pending: true, retryAfterMs: 5000 }, { status: 202 });
          const response = await handle(
            c,
            'POST',
            '/v1/relay',
            'boundary',
            String(init?.body),
            send,
          );
          return Response.json(response.body, { status: response.status });
        }
        const q = JSON.parse(String(init?.body));
        if (q.method === 'EXPERIMENTAL_tx_status') {
          if (++lookups === 1) throw new Error('request timed out');
          return Response.json({
            id: q.id,
            result: {
              transaction: {
                hash: 'H',
                signer_id: c.sender.accountId,
                receiver_id: c.contractId,
                actions: [
                  {
                    FunctionCall: {
                      method_name: 'claim_key',
                      args: Buffer.from(JSON.stringify(wire)).toString('base64'),
                    },
                  },
                ],
              },
              status: { SuccessValue: Buffer.from(JSON.stringify(answer)).toString('base64') },
              receipts_outcome: [],
            },
          });
        }
        const method = q.params.method_name;
        const value =
          method === 'get_file'
            ? {
                terms,
                terms_hash: termsHash(terms),
                header_hash: null,
                sales_stopped_at: null,
                taken_down: null,
              }
            : method === 'get_purchase'
              ? {
                  ...args,
                  file_id: terms.file_id,
                  terms_hash: termsHash(terms),
                  buyer_key: purchase.buyer_key,
                  recovery: purchase.recovery,
                  route: 'base-usdc',
                  delivery: null,
                  accepted_at: 1,
                  grants: 1,
                }
              : { ...args, buyer_key: purchase.buyer_key };
        return Response.json({
          id: q.id,
          result: { result: [...Buffer.from(JSON.stringify(value))] },
        });
      });
      vi.stubGlobal('fetch', fetcher);
      const wait = vi.fn(async () => {});
      const adapter = createAdapter(
        { ANNON_BACKUP_SECRET: 'ab'.repeat(32) },
        {
          fetch: fetcher,
          wait,
          wallet: async () => ({ identity: terms.seller, authorize: vi.fn() }),
          sdk(options) {
            const sdk = new Annon(options);
            vi.spyOn(sdk, 'stop').mockImplementation(async () => {
              expect(await options.send?.('claim_key', args)).toEqual(answer);
            });
            return sdk;
          },
        },
      );
      try {
        await adapter({
          command: 'stop',
          target: terms.file_id,
          contractId: terms.contract,
          nearRpc: c.nearRpc,
          baseRpc: c.baseRpc,
          relayer: 'https://relay.example',
          stateDir: dir,
          config: join(dir, 'none'),
          trustContract: true,
        });
        expect(wire).toEqual(args);
        expect(httpRequests).toBe(mode === 'outcome' ? 1 : 3);
        expect(lookups).toBe(2);
        expect(wait).toHaveBeenCalledWith(1000);
      } finally {
        vi.unstubAllGlobals();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
