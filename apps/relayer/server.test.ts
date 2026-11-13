import { spawnSync } from 'node:child_process';
import { appendFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Annon } from '../../packages/annon/src/api/annon.ts';
import * as rpcModule from '../../packages/annon/src/near/rpc.ts';
import { createAdapter } from '../../packages/annon/src/node/adapter.ts';
import * as relayModule from '../../packages/annon/src/relay/relay.ts';
import {
  canonicalRequest,
  checkRelay,
  contractArgs,
  RelayError,
} from '../../packages/annon/src/relay/relay.ts';
import { termsHash } from '../../packages/annon/src/settle-near/terms.ts';
import { purchase, terms } from '../../packages/annon/test/fixtures.ts';
import { dockerAppFiles } from '../docker-test.ts';
import { type Config, deliverKeeperAlert, fromEnv, handle, hits, serve } from './server.ts';

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
const configuredEnv = (e: Record<string, string | undefined>) =>
  fromEnv({
    RELAYER_STATE_DIR: '/unused',
    DEMO_HOST_ORIGIN: 'https://demo.test',
    SELLERS: 'near:seller.test',
    ...e,
  });
const ok = async () => ({ txHash: 'H' });
const body = JSON.stringify({ method: 'unlock', args: { file_id: `0x${'11'.repeat(32)}` } });
beforeEach(() => hits.clear());
afterEach(() => vi.unstubAllGlobals());

describe('relayer HTTP', () => {
  it('says what it sponsors, and relays a request', async () => {
    const cap = await handle(config(), 'GET', '/v1/capabilities', '1.1.1.1', '');
    expect(cap).toMatchObject({
      status: 200,
      body: {
        contract: 'v1.annon.defdone.near',
        minPrice: '10000',
        disabled: false,
        methods: [
          'register',
          'unlock',
          'claim_key',
          'reopen',
          'reopen_seller',
          'stop_sales',
          'fund_file_storage',
        ],
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
    expect(await handle(c, 'POST', '/v1/relay', '192.0.2.10', body, lost)).toEqual({
      status: 202,
      body: {
        txHash: 'H',
        signer: 'relayer.annon.defdone.near',
        uncertain: true,
        reason: 'NEAR answered: x',
      },
    });
    expect((await handle(c, 'POST', '/v1/relay', '192.0.2.11', body, ok)).status).toBe(503);
  });

  it('takes a limit of zero as zero, from the first request', async () => {
    let sent = 0;
    const count = async () => {
      sent++;
      return { txHash: 'H' };
    };
    expect(
      (await handle(config({ perDay: 0 }), 'POST', '/v1/relay', '192.0.2.10', body, count)).status,
    ).toBe(503);
    expect(
      (await handle(config({ perIpHour: 0 }), 'POST', '/v1/relay', '192.0.2.11', body, count))
        .status,
    ).toBe(429);
    expect(sent).toBe(0);
  });

  it('refuses to start on a missing or malformed setting, instead of serving without a limit', () => {
    const base = {
      DEV_ALLOW_ANY_SELLER: '1',
      CONTRACT_ID: 'c.near',
      RELAYER_ACCOUNT: 'r.near',
      RELAYER_KEY: 'ed25519:x',
      TREASURY_EVM: `0x${'55'.repeat(20)}`,
    };
    expect(configuredEnv(base).config).toMatchObject({ perDay: 1000, perIpHour: 600 });
    expect(configuredEnv({ ...base, PER_DAY: '0', UNLOCK_RESERVED: '0' }).config.perDay).toBe(0);
    for (const [name, bad] of [
      ['PER_DAY', 'abc'],
      ['PER_IP_HOUR', '-1'],
      ['MAX_DEADLINE_SECONDS', '1.5'],
      ['MIN_PRICE', '0.5'],
      ['PORT', 'x'],
    ])
      expect(() => configuredEnv({ ...base, [name as string]: bad })).toThrow(name);
    expect(() => configuredEnv({ ...base, RELAYER_KEY: ' ' })).toThrow('RELAYER_KEY');
  });

  it('sends nothing when switched off, or for a bad body or path', async () => {
    let sent = 0;
    const count = async () => {
      sent++;
      return { txHash: 'H' };
    };
    expect(
      (await handle(config({ disabled: true }), 'POST', '/v1/relay', '192.0.2.10', body, count))
        .status,
    ).toBe(503);
    expect((await handle(config(), 'POST', '/v1/relay', '192.0.2.10', '{', count)).status).toBe(
      400,
    );
    expect((await handle(config(), 'GET', '/v1/relay', '192.0.2.10', '', count)).status).toBe(404);
    expect(sent).toBe(0);
  });

  it('maps relay errors to HTTP: too early, gone, conflict, bad request, upstream', async () => {
    const as = (code: ConstructorParameters<typeof RelayError>[0]) => async () => {
      throw new RelayError(code);
    };
    const status = async (code: ConstructorParameters<typeof RelayError>[0]) =>
      (await handle(config(), 'POST', '/v1/relay', `ip-${code}`, body, as(code))).status;
    expect(await status('settlement_pending')).toBe(425);
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

  it('refunds unsafe unlock admission but still charges coarse requests and successful admissions', async () => {
    const c = config({ perIpHour: 1, perDay: 1 });
    const unsafe = vi.fn(async () => {
      throw new RelayError('settlement_pending');
    });
    for (let i = 0; i < 3; i++) {
      expect((await handle(c, 'POST', '/v1/relay', '192.0.2.1', body, unsafe)).status).toBe(425);
      expect(hits.get('ip:192.0.2.1')?.n).toBe(0);
      expect(hits.get('day:unlock')?.n).toBe(0);
    }
    expect(hits.get('req:192.0.2.1')?.n).toBe(3);
    expect((await handle(c, 'POST', '/v1/relay', '192.0.2.1', body, ok)).status).toBe(200);
    expect(hits.get('ip:192.0.2.1')?.n).toBe(1);
    expect(hits.get('day:unlock')?.n).toBe(1);
    expect((await handle(c, 'POST', '/v1/relay', '192.0.2.1', body, unsafe)).status).toBe(429);
    expect(unsafe).toHaveBeenCalledTimes(3);
  });
  it('does not refund other refusals or a newer IP admission window', async () => {
    const c = config({ perIpHour: 1, perDay: 1 });
    const refused = async () => {
      throw new RelayError('bad_signature');
    };
    expect((await handle(c, 'POST', '/v1/relay', '192.0.2.1', body, refused)).status).toBe(400);
    expect(hits.get('ip:192.0.2.1')?.n).toBe(1);
    let reject: (error: Error) => void = () => {};
    let entered!: () => void;
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = handle(
      c,
      'POST',
      '/v1/relay',
      '192.0.2.2',
      body,
      async () =>
        new Promise<never>((_resolve, r) => {
          reject = r;
          entered();
        }),
    );
    await admitted;
    const newerWindow = { n: 1, until: Date.now() + 7200000 };
    hits.set('ip:192.0.2.2', newerWindow);
    reject(new RelayError('settlement_pending'));
    expect((await pending).status).toBe(425);
    expect(hits.get('ip:192.0.2.2')).toEqual(newerWindow);
    expect(newerWindow.n).toBe(1);
  });
  it.each(['pending', 'outcome'] as const)(
    'does not charge admitted %s polling against the IP or daily budget',
    async (mode) => {
      const c = config({ perIpHour: 1, perDay: 1 });
      const result = { txHash: 'H', uncertain: true as const };
      const send = vi.fn(async () => result);
      const lookup = vi.fn(() => (mode === 'pending' ? ('pending' as const) : result));
      expect((await handle(c, 'POST', '/v1/relay', '192.0.2.1', body, send)).status).toBe(202);
      for (let i = 0; i < 3; i++) {
        const poll = await handle(c, 'POST', '/v1/relay', '192.0.2.1', body, send, lookup);
        expect(poll.status).toBe(202);
        expect(poll.body).toMatchObject(
          mode === 'pending' ? { pending: true } : { txHash: 'H', uncertain: true },
        );
      }
      expect(hits.get('ip:192.0.2.1')?.n).toBe(1);
      expect(hits.get('day:unlock')?.n).toBe(1);
      expect(send).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledTimes(3);
      expect(
        (await handle(c, 'POST', '/v1/relay', '192.0.2.1', body, send, () => null)).status,
      ).toBe(429);
    },
  );

  it('caps polling per address before parsing anything', async () => {
    const c = config({ perIpHour: 1 });
    const lookup = vi.fn(() => 'pending' as const);
    for (let i = 0; i < 10; i++)
      expect((await handle(c, 'POST', '/v1/relay', '192.0.2.1', body, ok, lookup)).status).toBe(
        202,
      );
    expect((await handle(c, 'POST', '/v1/relay', '192.0.2.1', body, ok, lookup)).status).toBe(429);
    expect(lookup).toHaveBeenCalledTimes(10);
    expect((await handle(c, 'POST', '/v1/relay', '192.0.2.2', body, ok, lookup)).status).toBe(202);
  });

  it('limits each address per hour and the whole day, counting only what was sent', async () => {
    const c = config({ perIpHour: 2, perDay: 1 });
    const refused = async () => {
      throw new RelayError('payment_not_found');
    };
    expect((await handle(c, 'POST', '/v1/relay', '192.0.2.10', body, refused)).status).toBe(404);
    expect((await handle(c, 'POST', '/v1/relay', '192.0.2.11', body, ok)).status).toBe(200);
    // The refused request did not use the day's budget; the sent one did.
    expect((await handle(c, 'POST', '/v1/relay', '192.0.2.12', body, ok)).status).toBe(503);
    expect((await handle(c, 'POST', '/v1/relay', '192.0.2.10', body, ok)).status).toBe(503);
    expect((await handle(c, 'POST', '/v1/relay', '192.0.2.10', body, ok)).status).toBe(429);
  });

  it("gives a failed request's budget back to its own day, not to the next", async () => {
    const c = config({ perDay: 1, perIpHour: 100 });
    let fail: (e: Error) => void = () => {};
    let entered!: () => void;
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const late = () =>
      new Promise<{ txHash: string }>((_, no) => {
        fail = no;
        entered();
      });
    const first = handle(c, 'POST', '/v1/relay', '192.0.2.10', body, late);
    await admitted;
    vi.setSystemTime(Date.now() + 86_400_000 + 1);
    try {
      expect((await handle(c, 'POST', '/v1/relay', '192.0.2.11', body, ok)).status).toBe(200);
      fail(new RelayError('payment_not_found'));
      expect((await first).status).toBe(404);
      expect((await handle(c, 'POST', '/v1/relay', '192.0.2.12', body, ok)).status).toBe(503);
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
    expect((await handle(config(), 'POST', '/v1/relay', 'another', body, ok)).status).toBe(200);
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
      fetch(`http://127.0.0.1:${port}/v1/relay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: b,
      }).then((r) => r.status);
    try {
      expect(await post('null')).toBe(400);
      expect(await post('x'.repeat(70_000))).toBe(413);
      // Announce a body, send half, hang up.
      await new Promise<void>((done) => {
        const s = connect(port, '127.0.0.1', () => {
          s.write(
            'POST /v1/relay HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"a":',
          );
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
        ])
          await cp(join(root, file), join(dir, file));
        for (const name of await dockerAppFiles(import.meta.dirname))
          await cp(join(import.meta.dirname, name), join(dir, 'apps/relayer', name));
        await cp(join(root, 'packages/annon/src'), join(dir, 'packages/annon/src'), {
          recursive: true,
          filter: (file) => !file.endsWith('.test.ts'),
        });
        const install = spawnSync(
          'pnpm',
          [
            'install',
            '--frozen-lockfile',
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
        const build = spawnSync(
          process.execPath,
          ['--no-warnings', 'apps/relayer/build-runtime.ts'],
          {
            cwd: dir,
            encoding: 'utf8',
            timeout: 30000,
            env: { PATH: process.env.PATH },
          },
        );
        expect(build.status, build.stdout + build.stderr).toBe(0);
        // Install the same production filters used by the runtime stage, then discard build inputs.
        const production = spawnSync(
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
        expect(production.status, production.stdout + production.stderr).toBe(0);
        await rm(join(dir, 'packages/annon/src'), { recursive: true });
        await rm(join(app, 'build-runtime.ts'));

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
        expect(start.status).toBe(1);
        expect(start.stderr).toContain('RELAYER_STATE_DIR is not set');
        expect(start.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
        const cutover = spawnSync(
          process.execPath,
          ['--no-warnings', '--import', './ts-hook.mjs', 'cutover.ts'],
          { cwd: app, encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH } },
        );
        expect(cutover.status).toBe(1);
        expect(cutover.stderr).toContain(
          'Policy file, RELAYER_STATE_DIR and NEAR_ARCHIVAL_RPC are required.',
        );
        expect(cutover.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
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
    });
  },
);

describe('adapter to relayer boundary without a signing transport', () => {
  it.each([
    'outcome',
    'lost-post-pending',
    'duplicate',
    'rate-limited-seconds',
    'rate-limited-date',
  ] as const)(
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
        await checkRelay(req, c as unknown as Parameters<typeof checkRelay>[1]);
        wire = contractArgs(req);
        return { txHash: 'H' };
      });
      const fetcher = vi.fn<typeof fetch>(async (url, init) => {
        if (String(url).endsWith('/v1/relay')) {
          httpRequests++;
          if (mode !== 'outcome' && httpRequests === 1)
            throw new DOMException('POST timed out', 'TimeoutError');
          if (mode.startsWith('rate-limited') && httpRequests === 2)
            return Response.json(
              { error: 'rate_limited' },
              {
                status: 429,
                headers: {
                  'Retry-After':
                    mode === 'rate-limited-seconds'
                      ? '7'
                      : new Date(Date.now() + 7000).toUTCString(),
                },
              },
            );
          if (mode === 'duplicate' && httpRequests === 2)
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
      const wait = vi.fn(async (_ms: number) => {});
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
        if (mode === 'rate-limited-seconds') expect(wait).toHaveBeenCalledWith(7000);
        if (mode === 'rate-limited-date')
          expect(wait.mock.calls.some(([ms]) => ms > 5900 && ms <= 7000)).toBe(true);
        expect(wait).toHaveBeenCalledWith(1000);
      } finally {
        vi.unstubAllGlobals();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

it('requires separate durable keeper credentials and budgets when explicitly enabled', () => {
  const base = {
    DEV_ALLOW_ANY_SELLER: '1',
    CONTRACT_ID: 'c.near',
    RELAYER_ACCOUNT: 'r.near',
    RELAYER_KEY: 'ed25519:fake',
    TREASURY_EVM: `0x${'55'.repeat(20)}`,
  };
  expect(configuredEnv(base).keeperSeconds).toBe(0);
  expect(() => configuredEnv({ ...base, KEEPER_SECONDS: '30' })).toThrow('KEEPER_ACCOUNT');
  const enabled = {
    ...base,
    KEEPER_SECONDS: '30',
    KEEPER_ACCOUNT: 'k.near',
    KEEPER_KEY: 'ed25519:fake-keeper',
    KEEPER_STATE_DIR: '/tmp/keeper',
    KEEPER_HOURLY_BUDGET: '100000',
    KEEPER_DAILY_BUDGET: '200000',
  };
  expect(configuredEnv(enabled).config.keeper?.sender.accountId).toBe('k.near');
  expect(() => configuredEnv({ ...enabled, KEEPER_ACCOUNT: 'r.near' })).toThrow(/separate/);
});

it.each(['account', 'key'] as const)(
  'serve rejects a shared keeper %s before listening or signing',
  (shared) => {
    const c = config();
    c.keeper = {
      sender: {
        accountId: shared === 'account' ? c.sender.accountId : 'keeper.near',
        key: shared === 'key' ? c.sender.key : 'ed25519:fake-other',
      },
      stateDir: '/unused',
      hourlyBudget: 1n,
      dailyBudget: 1n,
      gasPrice: 1n,
      reserveLowWater: 0n,
    };
    expect(() => serve(c, 0, 10)).toThrow('separate account and key');
  },
);

it('delivers every keeper alert as bounded webhook JSON and swallows failures without key material', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({}))
    .mockRejectedValueOnce(new Error('SECRET_VALUE'));
  const alert = { type: 'low_balance' as const, balance: '1', needed: '2', key: 'SECRET_KEY' };
  await expect(
    deliverKeeperAlert('https://hooks.example/incoming', alert, fetcher),
  ).resolves.toBeUndefined();
  await expect(
    deliverKeeperAlert('https://hooks.example/incoming', alert, fetcher),
  ).resolves.toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(2);
  const init = fetcher.mock.calls[0]?.[1];
  expect(JSON.parse(String(init?.body))).toEqual({
    text: 'keeper: alert {"type":"low_balance","balance":"1","needed":"2"}',
    alert: { type: 'low_balance', balance: '1', needed: '2' },
  });
  expect(init?.method).toBe('POST');
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain('SECRET');
});
it('validates optional keeper webhook HTTPS URLs and balance low water', () => {
  const enabled = {
    DEV_ALLOW_ANY_SELLER: '1',
    CONTRACT_ID: 'c.near',
    RELAYER_ACCOUNT: 'r.near',
    RELAYER_KEY: 'fake',
    TREASURY_EVM: `0x${'55'.repeat(20)}`,
    KEEPER_SECONDS: '30',
    KEEPER_ACCOUNT: 'k.near',
    KEEPER_KEY: 'fake-keeper',
    KEEPER_STATE_DIR: '/unused',
    KEEPER_HOURLY_BUDGET: '1',
    KEEPER_DAILY_BUDGET: '2',
    KEEPER_BALANCE_LOW_WATER: '123',
    KEEPER_ALERT_WEBHOOK: 'https://hooks.example/incoming',
  };
  expect(configuredEnv(enabled).config.keeper).toMatchObject({
    balanceLowWater: 123n,
    alertWebhook: enabled.KEEPER_ALERT_WEBHOOK,
  });
  for (const url of ['http://hooks.example', 'https://user:pass@hooks.example', 'invalid'])
    expect(() => configuredEnv({ ...enabled, KEEPER_ALERT_WEBHOOK: url })).toThrow(
      'KEEPER_ALERT_WEBHOOK',
    );
});

it.each([
  'http://hooks.example',
  'https://user:pass@hooks.example',
  'https://hooks.example/#fragment',
  'invalid',
  '',
])('rejects a bad embedded keeper webhook at serve startup: %s', (alertWebhook) => {
  const c = config();
  c.keeper = {
    sender: { accountId: 'keeper.near', key: 'fake-keeper' },
    stateDir: '/unused',
    hourlyBudget: 1n,
    dailyBudget: 1n,
    gasPrice: 1n,
    reserveLowWater: 0n,
    alertWebhook,
  };
  let server: ReturnType<typeof serve> | undefined;
  try {
    expect(() => {
      server = serve(c, 0);
    }).toThrow('KEEPER_ALERT_WEBHOOK');
  } finally {
    server?.close();
  }
});

it('preserves a Slack webhook URL and times out stalled delivery', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({}));
  await deliverKeeperAlert('https://hooks.example/incoming', { type: 'breaker' }, fetcher);
  expect(fetcher.mock.calls[0]?.[0]).toBe('https://hooks.example/incoming');
  expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
  let timeoutSignal: AbortSignal | null | undefined;
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(AbortSignal.abort());
  const stalled = vi.fn<typeof fetch>(async (_url, init) => {
    timeoutSignal = init?.signal;
    timeoutSignal?.throwIfAborted();
    throw new Error('unreachable');
  });
  try {
    await expect(
      deliverKeeperAlert(
        'https://hooks.example/incoming',
        { type: 'uncertain', deliveryId: 3 },
        stalled,
      ),
    ).resolves.toBeUndefined();
    expect(timeout).toHaveBeenCalledWith(3000);
    expect(timeoutSignal?.aborted).toBe(true);
  } finally {
    timeout.mockRestore();
  }
});

it('reserves an independent daily pool for unlock and buckets IPv6 clients by /48', async () => {
  const c = config({ perDay: 2, unlockReserved: 1, perMethodDay: { claim_key: 1 }, perIpHour: 1 });
  const claim = JSON.stringify({ method: 'claim_key', args: { purchase_id: terms.file_id } });
  expect((await handle(c, 'POST', '/v1/relay', '192.0.2.10', claim, ok)).status).toBe(200);
  expect((await handle(c, 'POST', '/v1/relay', '192.0.2.11', claim, ok)).status).toBe(503);
  expect((await handle(c, 'POST', '/v1/relay', '192.0.2.12', body, ok)).status).toBe(200);
  hits.clear();
  expect((await handle(c, 'POST', '/v1/relay', '2001:db8:1:2::1', body, ok)).status).toBe(200);
  expect((await handle(c, 'POST', '/v1/relay', '2001:0db8:0001:0002::2', body, ok)).status).toBe(
    429,
  );
});
it('does not require a seller allowlist or a development flag', () => {
  const base = {
    CONTRACT_ID: 'c.near',
    RELAYER_ACCOUNT: 'r.near',
    RELAYER_KEY: 'fake',
    TREASURY_EVM: `0x${'55'.repeat(20)}`,
  };
  expect(configuredEnv(base).config.policy).toBeDefined();
  expect(configuredEnv({ ...base, DEV_ALLOW_ANY_SELLER: '1' }).config.policy).toBeDefined();
});

it('reports low relayer liquid balance and prepaid storage with the shared alert mechanism', async () => {
  const { relayerAlerts } = await import('./server.ts');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      const q = JSON.parse(String(init?.body));
      const result =
        q.method === 'block'
          ? { header: { hash: 'final' } }
          : q.method === 'gas_price'
            ? { gas_price: '1' }
            : q.method === 'EXPERIMENTAL_protocol_config'
              ? {
                  runtime_config: {
                    min_gas_purchase_price: '1',
                    storage_amount_per_byte: '1',
                    transaction_costs: {
                      action_receipt_creation_config: {
                        send_sir: 1,
                        send_not_sir: 1,
                        execution: 1,
                      },
                      action_creation_config: {
                        function_call_cost: { send_sir: 1, send_not_sir: 1, execution: 1 },
                        function_call_cost_per_byte: { send_sir: 1, send_not_sir: 1, execution: 1 },
                      },
                    },
                  },
                }
              : q.params.request_type === 'view_account'
                ? { amount: '1', locked: '0', storage_usage: 0 }
                : { result: [...Buffer.from('"1"')] };
      return Response.json({ id: q.id, result });
    }),
  );
  const c = config({ balanceLowWater: 10n, storageLowWater: 10n });
  expect(await relayerAlerts(c)).toEqual([
    expect.objectContaining({ type: 'low_balance', balance: '1' }),
    expect.objectContaining({ type: 'storage_low', reserve: '1' }),
  ]);
  expect(await relayerAlerts(c)).toEqual([]);
});

it('returns Retry-After on every retryable refusal and bounds log fields', async () => {
  const { logField } = await import('./server.ts');
  for (const code of ['limited', 'unavailable', 'settlement_pending'] as const) {
    const out = await handle(config(), 'POST', '/v1/relay', code, body, async () => {
      throw new RelayError(code);
    });
    expect(out.headers?.['Retry-After']).toMatch(/^[0-9]+$/);
  }
  expect(logField('a'.repeat(10000), 32)).toHaveLength(32);
  expect(logField({ huge: 'a'.repeat(10000) }, 66)).toBeUndefined();
});

it('caches keeper get_config across scheduled passes', async () => {
  const { keeper } = await import('./server.ts');
  const dir = await mkdtemp(join(tmpdir(), 'annon-config-cache-'));
  const getConfig = vi
    .spyOn(rpcModule, 'getConfig')
    .mockResolvedValue({ network: 'near:mainnet' } as Awaited<
      ReturnType<typeof rpcModule.getConfig>
    >);
  const keep = vi
    .spyOn(relayModule, 'keep')
    .mockResolvedValue({ sent: [], errors: [], incidents: [] });
  vi.useFakeTimers();
  const stop = keeper(
    config({
      keeper: {
        sender: { accountId: 'keeper.near', key: 'fake' },
        stateDir: dir,
        hourlyBudget: 1n,
        dailyBudget: 1n,
        gasPrice: 1n,
        reserveLowWater: 0n,
      },
    }),
    1,
  );
  try {
    await vi.waitFor(() => expect(keep).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(keep).toHaveBeenCalledTimes(2));
    expect(getConfig).toHaveBeenCalledTimes(1);
  } finally {
    stop();
    vi.useRealTimers();
    getConfig.mockRestore();
    keep.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

it('enforces the global daily cap while reserving unlock capacity across method pools', async () => {
  const c = config({
    perDay: 4,
    unlockReserved: 2,
    perIpHour: 100,
    perMethodDay: { claim_key: 1 },
  });
  const claim = JSON.stringify({ method: 'claim_key', args: { purchase_id: terms.file_id } });
  const reopen = JSON.stringify({ method: 'reopen', args: {} });
  expect((await handle(c, 'POST', '/v1/relay', '192.0.2.10', claim, ok)).status).toBe(200);
  expect((await handle(c, 'POST', '/v1/relay', '192.0.2.11', claim, ok)).status).toBe(503);
  expect((await handle(c, 'POST', '/v1/relay', '192.0.2.12', reopen, ok)).status).toBe(200);
  expect((await handle(c, 'POST', '/v1/relay', 'd', reopen, ok)).status).toBe(503);
  expect((await handle(c, 'POST', '/v1/relay', 'e', body, ok)).status).toBe(200);
  expect((await handle(c, 'POST', '/v1/relay', 'f', body, ok)).status).toBe(200);
  expect((await handle(c, 'POST', '/v1/relay', 'g', body, ok)).status).toBe(503);
  expect(hits.get('day')?.n).toBe(4);
});
it('normalizes scoped IPv6 without throwing and keeps quota Retry-After until the window end', async () => {
  const { ipBucket } = await import('./server.ts');
  expect(ipBucket('fe80::1%en0')).toBe(ipBucket('fe80::2%en1'));
  const until = Date.now() + 123000;
  const out = await handle(config(), 'POST', '/v1/relay', '192.0.2.1', body, async () => {
    throw Object.assign(new RelayError('limited'), { retryAt: until });
  });
  expect(out.headers?.['Retry-After']).toBe('123');
});

it('awaits cached claim lookup before charging admission or daily budgets', async () => {
  const c = config({
    perDay: 0,
    perIpHour: 0,
    sender: { accountId: 'relay.testnet', key: 'synthetic' },
  });
  // Coarse polling still needs capacity; admission and daily budgets can be exhausted.
  c.perIpHour = 1;
  hits.set('ip:192.0.2.1', { n: 1, until: Date.now() + 3600000 });
  const send = vi.fn(async () => ({ txHash: 'new' }));
  const lookup = vi.fn(async () => ({ txHash: 'cached' }));
  const result = await handle(
    c,
    'POST',
    '/v1/relay',
    '192.0.2.1',
    JSON.stringify({ method: 'claim_key', args: { purchase_id: terms.file_id, grant: 0 } }),
    send,
    lookup,
  );
  expect(result).toMatchObject({ status: 200, body: { txHash: 'cached' } });
  expect(send).not.toHaveBeenCalled();
  expect(hits.has('day')).toBe(false);
});

it.each(['global', 'pool'] as const)(
  'still limits claims across grants by the %s daily cap',
  async (limit) => {
    const c = config({
      perDay: limit === 'global' ? 2 : 4,
      unlockReserved: 0,
      perMethodDay: { claim_key: limit === 'pool' ? 1 : 3 },
      perIpHour: 100,
    });
    const send = vi.fn(async () => ({ txHash: 'synthetic-hash' }));
    const bodyFor = (grant: number) =>
      JSON.stringify({ method: 'claim_key', args: { purchase_id: terms.file_id, grant } });
    expect(
      (await handle(c, 'POST', '/v1/relay', '192.0.2.1', bodyFor(0), send, () => null)).status,
    ).toBe(200);
    if (limit === 'global')
      expect(
        (await handle(c, 'POST', '/v1/relay', '192.0.2.1', bodyFor(1), send, () => null)).status,
      ).toBe(200);
    expect(
      (await handle(c, 'POST', '/v1/relay', '192.0.2.1', bodyFor(2), send, () => null)).status,
    ).toBe(503);
    expect(send).toHaveBeenCalledTimes(limit === 'global' ? 2 : 1);
  },
);

it('opens sponsorship without SELLERS and publishes bounded budgets and the protocol fee', async () => {
  const c = configuredEnv({
    CONTRACT_ID: 'contract.test',
    RELAYER_ACCOUNT: 'relay.test',
    RELAYER_KEY: 'ed25519:test',
    TREASURY_EVM: `0x${'55'.repeat(20)}`,
  }).config;
  expect(c.policy.minPrice).toBe(100000n);
  const result = await handle(c, 'GET', '/v1/capabilities', '192.0.2.10', '');
  expect(result.body).toMatchObject({
    fee: { fixed: '30000', bps: 100 },
    sponsorship: { filesPerDay: 60, filesPerIpDay: 1, fileBudget: '41000000000000000000000' },
  });
});

it('caps sponsored files globally and per IP before any concurrent send', async () => {
  const c = config({
    sponsoredFilesPerIpDay: 1,
    policy: { minPrice: 100000n, maxDeadlineSeconds: 600, sponsoredFilesPerDay: 2 },
  });
  const req = JSON.stringify({ method: 'register', args: {} });
  const send = vi.fn(ok);
  const lookup = async () => null;
  const results = await Promise.all(
    ['192.0.2.10', '192.0.2.10', '192.0.2.11', '192.0.2.12'].map((ip) =>
      handle(c, 'POST', '/v1/relay', ip, req, send, lookup),
    ),
  );
  expect(results.map((r) => r.status)).toEqual([200, 429, 200, 429]);
  expect(send).toHaveBeenCalledTimes(2);
});

it('keeps the per-IP sponsored-file day cap when client counters are evicted', async () => {
  const c = config({
    hitsCap: 1,
    sponsoredFilesPerIpDay: 1,
    perIpHour: 100,
    policy: { minPrice: 100000n, maxDeadlineSeconds: 600, sponsoredFilesPerDay: 5 },
  });
  const req = JSON.stringify({ method: 'register', args: {} });
  const lookup = async () => null;
  expect((await handle(c, 'POST', '/v1/relay', '192.0.2.10', req, ok, lookup)).status).toBe(200);
  expect((await handle(c, 'POST', '/v1/relay', '192.0.2.10', req, ok, lookup)).status).toBe(429);
});

it('refuses startup with fees and no treasury or Base sponsorship and no EVM treasury', () => {
  const e = {
    CONTRACT_ID: 'contract.test',
    RELAYER_ACCOUNT: 'relayer.test',
    RELAYER_KEY: 'test-double',
  };
  expect(() => configuredEnv(e)).toThrow('treasury');
  expect(() => configuredEnv({ ...e, TREASURY_NEAR: 'treasury.test' })).toThrow('TREASURY_EVM');
  expect(() => configuredEnv({ ...e, FEE_FIXED: '0', FEE_BPS: '0' })).toThrow('TREASURY_EVM');
  expect(() =>
    configuredEnv({ ...e, FEE_FIXED: '0', FEE_BPS: '0', BASE_SPONSORSHIP: '0' }),
  ).toThrow('FEE_FIXED');
});

it('accepts EVM-only treasury configuration and validates the Base sponsorship switch', () => {
  const e = {
    CONTRACT_ID: 'contract.test',
    RELAYER_ACCOUNT: 'relay.test',
    RELAYER_KEY: 'test-double',
    TREASURY_EVM: `0x${'55'.repeat(20)}`,
  };
  expect(configuredEnv(e).config.policy.fee).toMatchObject({
    treasuryNear: null,
    treasuryEvm: { kind: 'evm', id: e.TREASURY_EVM },
  });
  expect(() => configuredEnv({ ...e, BASE_SPONSORSHIP: 'typo' })).toThrow('BASE_SPONSORSHIP');
  expect(() =>
    configuredEnv({
      ...e,
      TREASURY_EVM: '',
      TREASURY_NEAR: 'treasury.test',
      BASE_SPONSORSHIP: '0',
    }),
  ).not.toThrow();
});

it('requires durable sponsorship state in environment configuration', () => {
  expect(() =>
    fromEnv({
      CONTRACT_ID: 'market.test',
      RELAYER_ACCOUNT: 'relay.test',
      RELAYER_KEY: 'test-double',
      TREASURY_EVM: `0x${'55'.repeat(20)}`,
    }),
  ).toThrow('RELAYER_STATE_DIR');
});
