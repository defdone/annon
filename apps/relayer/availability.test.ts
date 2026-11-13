import { expect, it } from 'vitest';
import { type Config, handle } from './server.ts';

it('returns pending evidence when the kill switch pauses a paid unlock', async () => {
  const config: Config = {
    nearRpc: 'https://rpc.test',
    baseRpc: 'https://base.test',
    contractId: 'market.test',
    usdc: `0x${'11'.repeat(20)}`,
    sender: { accountId: 'relay.test', key: 'test-double' },
    policy: { minPrice: 100000n, maxDeadlineSeconds: 600 },
    disabled: true,
    perIpHour: 600,
    perDay: 1000,
  };
  const result = await handle(
    config,
    'POST',
    '/v1/relay',
    '192.0.2.1',
    JSON.stringify({ method: 'unlock', args: {} }),
  );
  expect(result).toMatchObject({
    status: 503,
    body: { error: 'settlement_pending' },
    headers: { 'Retry-After': '30' },
  });
});

it('retains a valid paid unlock while disabled and leaves invalid requests out of durable work', async () => {
  const { memoryStore } = await import('../../packages/annon/src/pay/store.ts');
  const { RelayLedger } = await import('@defdone/annon/relay');
  const { purchase } = await import('../../packages/annon/test/fixtures.ts');
  const { buildPurchaseMessage } = await import('../../packages/annon/src/settle-near/purchase.ts');
  const ledger = new RelayLedger(memoryStore(), 'scope');
  const c: Config = {
    nearRpc: 'https://rpc.test',
    baseRpc: 'https://base.test',
    contractId: purchase.contract,
    usdc: purchase.asset,
    sender: { accountId: 'relay.test', key: 'test-double' },
    policy: { minPrice: 100000n, maxDeadlineSeconds: 600 },
    disabled: true,
    perIpHour: 600,
    perDay: 1000,
    ledger,
  };
  const log = {
    address: purchase.asset.slice(2),
    block_hash: 'aa'.repeat(32),
    block_number: 42,
    data: '0x',
    log_index: 0,
    removed: false,
    topics: ['bb'.repeat(32), 'cc'.repeat(32), 'dd'.repeat(32)],
    transaction_hash: 'ee'.repeat(32),
    transaction_index: 0,
  };
  const body = JSON.stringify({
    method: 'unlock',
    args: {
      purchase: buildPurchaseMessage(purchase),
      logs: [log, { ...log, log_index: 1 }],
      header: null,
    },
  });
  expect(await handle(c, 'POST', '/v1/relay', '192.0.2.99', body)).toMatchObject({
    status: 503,
    body: { error: 'settlement_pending' },
  });
  const work = Object.values((await ledger.read()).work);
  expect(work).toHaveLength(1);
  await handle(c, 'POST', '/v1/relay', '192.0.2.99', '{');
  expect(Object.values((await ledger.read()).work)).toHaveLength(1);
  expect((await ledger.read()).operations).toEqual({});
});

it('keeps different IPv6 /48 clients separate through the HTTP adapter', async () => {
  const { once } = await import('node:events');
  const { serve } = await import('./server.ts');
  const config: Config = {
    nearRpc: 'https://rpc.test',
    baseRpc: 'https://base.test',
    contractId: 'market.test',
    usdc: `0x${'11'.repeat(20)}`,
    sender: { accountId: 'relay.test', key: 'test-double' },
    policy: { minPrice: 100000n, maxDeadlineSeconds: 600 },
    disabled: false,
    perIpHour: 1,
    requestMultiplier: 1,
    perDay: 1000,
    ipHeader: 'test-client-ip',
  };
  const server = serve(config, 0);
  try {
    await once(server, 'listening');
    const port = (server.address() as import('node:net').AddressInfo).port;
    const post = (ip: string) =>
      fetch(`http://127.0.0.1:${port}/v1/relay`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'test-client-ip': ip },
        body: '{',
      });
    expect((await post('2001:db8:1::1')).status).toBe(400);
    expect((await post('2001:db8:2::1')).status).toBe(400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('ignores forwarding headers without ipHeader for requests on the same socket', async () => {
  const { once } = await import('node:events');
  const { Agent, request } = await import('node:http');
  const { serve } = await import('./server.ts');
  const config: Config = {
    nearRpc: 'https://rpc.test',
    baseRpc: 'https://base.test',
    contractId: 'market.test',
    usdc: `0x${'11'.repeat(20)}`,
    sender: { accountId: 'relay.test', key: 'test-double' },
    policy: { minPrice: 100000n, maxDeadlineSeconds: 600 },
    disabled: false,
    perIpHour: 1,
    requestMultiplier: 1,
    perDay: 1000,
  };
  const server = serve(config, 0);
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  let connections = 0;
  server.on('connection', () => connections++);
  try {
    await once(server, 'listening');
    const port = (server.address() as import('node:net').AddressInfo).port;
    const post = (ip: string) =>
      new Promise<number | undefined>((resolve, reject) => {
        const req = request(
          `http://127.0.0.1:${port}/v1/relay`,
          {
            agent,
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-forwarded-for': ip,
              'fly-client-ip': ip,
            },
          },
          (res) => {
            res.on('error', reject);
            res.on('end', () => resolve(res.statusCode));
            res.resume();
          },
        );
        req.on('error', reject);
        req.end('{');
      });
    expect(await post('192.0.2.10')).toBe(400);
    expect(await post('192.0.2.11')).toBe(429);
    expect(connections).toBe(1);
  } finally {
    agent.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('keeps a precise quota reset hint from eligibility admission', async () => {
  const { vi } = await import('vitest');
  const sponsorship = await import('../../packages/annon/src/relay/sponsorship.ts');
  const { RelayError } = await import('../../packages/annon/src/relay/relay.ts');
  const now = Date.now();
  const error = new RelayError('relayer_unavailable');
  error.retryAt = now + 123000;
  const check = vi.spyOn(sponsorship, 'baseEligibility').mockRejectedValue(error);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  try {
    const config: Config = {
      nearRpc: 'https://rpc.test',
      baseRpc: 'https://base.test',
      contractId: 'market.test',
      usdc: `0x${'11'.repeat(20)}`,
      sender: { accountId: 'relay.test', key: 'test-double' },
      policy: { minPrice: 100000n, maxDeadlineSeconds: 600 },
      disabled: false,
      perIpHour: 600,
      perDay: 1000,
    };
    expect(
      await handle(
        config,
        'POST',
        '/v1/base-eligibility',
        '192.0.2.44',
        JSON.stringify({ fileId: `0x${'22'.repeat(32)}`, termsHash: `0x${'33'.repeat(32)}` }),
      ),
    ).toMatchObject({ status: 503, headers: { 'Retry-After': '123' } });
  } finally {
    check.mockRestore();
    clock.mockRestore();
  }
});

it('bounds eligibility checks before starting additional chain reads', async () => {
  const { vi } = await import('vitest');
  const sponsorship = await import('../../packages/annon/src/relay/sponsorship.ts');
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const check = vi.spyOn(sponsorship, 'baseEligibility').mockImplementation(async () => {
    await gate;
    return { eligible: true } as Awaited<ReturnType<typeof sponsorship.baseEligibility>>;
  });
  const c: Config = {
    nearRpc: 'https://rpc.test',
    baseRpc: 'https://base.test',
    contractId: 'market.test',
    usdc: `0x${'11'.repeat(20)}`,
    sender: { accountId: 'relay.test', key: 'test-double' },
    policy: { minPrice: 100000n, maxDeadlineSeconds: 600, maxChecking: 2 },
    disabled: false,
    perIpHour: 600,
    perDay: 1000,
  };
  const body = JSON.stringify({
    fileId: `0x${'22'.repeat(32)}`,
    termsHash: `0x${'33'.repeat(32)}`,
  });
  const pending = [
    handle(c, 'POST', '/v1/base-eligibility', '192.0.2.10', body),
    handle(c, 'POST', '/v1/base-eligibility', '192.0.2.11', body),
  ];
  try {
    await vi.waitFor(() => expect(check).toHaveBeenCalledTimes(2));
    const third = handle(c, 'POST', '/v1/base-eligibility', '192.0.2.12', body);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await Promise.race([third, Promise.resolve(null)])).toMatchObject({
      status: 503,
      body: { error: 'relayer_unavailable' },
      headers: { 'Retry-After': '5' },
    });
    expect(check).toHaveBeenCalledTimes(2);
  } finally {
    release();
    await Promise.all(pending);
    check.mockRestore();
  }
});

it('advertises no new Base payments when sponsorship is paused even with a sealed cutover', async () => {
  const { RelayLedger } = await import('@defdone/annon/relay');
  const { memoryStore } = await import('../../packages/annon/src/pay/store.ts');
  const ledger = new RelayLedger(memoryStore(), 'scope');
  await ledger.seal(
    {
      policyVersion: 'legacy-v0',
      blockHash: 'b',
      blockHeight: 1,
      scannedThrough: 1,
      minPrice: '100000',
      inventory: [],
      fee: { fixed: '30000', bps: 100, treasuryNear: null, treasuryEvm: null },
    },
    [],
  );
  const c: Config = {
    nearRpc: 'https://rpc.test',
    baseRpc: 'https://base.test',
    contractId: 'market.test',
    usdc: `0x${'11'.repeat(20)}`,
    sender: { accountId: 'relay.test', key: 'test-double' },
    policy: { minPrice: 100000n, maxDeadlineSeconds: 600, baseSponsorship: false },
    disabled: false,
    perIpHour: 600,
    perDay: 1000,
    ledger,
  };
  expect(await handle(c, 'GET', '/v1/capabilities', '192.0.2.1', '')).toMatchObject({
    status: 200,
    body: { acceptingNewBasePayments: false },
  });
});

it('serves health and capabilities from an unsealed volume while refusing sponsored work', async () => {
  const { once } = await import('node:events');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { vi } = await import('vitest');
  const rpc = await import('../../packages/annon/src/near/rpc.ts');
  const { serve } = await import('./server.ts');
  const dir = await mkdtemp(join(tmpdir(), 'relayer-unsealed-'));
  const chain = vi.spyOn(rpc, 'getConfig').mockResolvedValue({
    network: 'near:mainnet',
    usdc: `0x${'11'.repeat(20)}`,
    nearUsdc: 'token.test',
  } as Awaited<ReturnType<typeof rpc.getConfig>>);
  const calls = vi.spyOn(rpc, 'rpcReply').mockResolvedValue({ error: {} });
  const c: Config = {
    stateDir: dir,
    nearRpc: 'https://rpc.test',
    baseRpc: 'https://base.test',
    contractId: 'market.test',
    nearUsdc: 'token.test',
    usdc: `0x${'11'.repeat(20)}`,
    sender: { accountId: 'relay.test', key: 'test-double' },
    policy: { minPrice: 100000n, maxDeadlineSeconds: 600 },
    disabled: false,
    perIpHour: 600,
    perDay: 1000,
  };
  const server = serve(c, 0);
  const drained = once(server, 'drained');
  try {
    await once(server, 'listening');
    const port = (server.address() as import('node:net').AddressInfo).port;
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    expect(await (await fetch(`http://127.0.0.1:${port}/v1/capabilities`)).json()).toMatchObject({
      acceptingNewBasePayments: false,
    });
    expect(
      await handle(
        c,
        'POST',
        '/v1/base-eligibility',
        '192.0.2.1',
        JSON.stringify({ fileId: `0x${'22'.repeat(32)}`, termsHash: `0x${'33'.repeat(32)}` }),
      ),
    ).toMatchObject({ status: 503, body: { error: 'relayer_unavailable' } });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await drained;
    chain.mockRestore();
    calls.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

it('refuses an unsealed pre-sign check before invoking chain admission', async () => {
  const { vi } = await import('vitest');
  const { RelayLedger } = await import('@defdone/annon/relay');
  const { memoryStore } = await import('../../packages/annon/src/pay/store.ts');
  const sponsorship = await import('../../packages/annon/src/relay/sponsorship.ts');
  const check = vi
    .spyOn(sponsorship, 'baseEligibility')
    .mockResolvedValue({ eligible: true } as Awaited<
      ReturnType<typeof sponsorship.baseEligibility>
    >);
  const alert = vi.fn();
  const c: Config = {
    nearRpc: 'https://rpc.test',
    baseRpc: 'https://base.test',
    contractId: 'market.test',
    usdc: `0x${'11'.repeat(20)}`,
    sender: { accountId: 'relay.test', key: 'test-double' },
    policy: { minPrice: 100000n, maxDeadlineSeconds: 600 },
    disabled: false,
    perIpHour: 600,
    perDay: 1000,
    ledger: new RelayLedger(memoryStore(), 'scope'),
    alert,
  };
  try {
    expect(
      await handle(
        c,
        'POST',
        '/v1/base-eligibility',
        '192.0.2.55',
        JSON.stringify({ fileId: `0x${'22'.repeat(32)}`, termsHash: `0x${'33'.repeat(32)}` }),
      ),
    ).toMatchObject({ status: 503, body: { error: 'relayer_unavailable' } });
    expect(check).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith('cutover_unsealed');
  } finally {
    check.mockRestore();
  }
});

it.each(['disabled', 'policy', 'unsealed'] as const)(
  'blocks a new SDK Base payment through the real capabilities handler: %s',
  async (mode) => {
    const { vi } = await import('vitest');
    const { terms, must } = await import('../../packages/annon/test/fixtures.ts');
    const rpc = await import('../../packages/annon/src/near/rpc.ts');
    const pay2 = await import('../../packages/annon/src/envelope/pay2.ts');
    const { Annon } = await import('../../packages/annon/src/api/annon.ts');
    const { termsHash } = await import('../../packages/annon/src/settle-near/terms.ts');
    const { memoryStore } = await import('../../packages/annon/src/pay/store.ts');
    const { RelayLedger } = await import('@defdone/annon/relay');
    const ledger = new RelayLedger(memoryStore(), 'gate');
    if (mode !== 'unsealed')
      await ledger.seal(
        {
          policyVersion: 'legacy-v0',
          blockHash: 'cutover',
          blockHeight: 1,
          scannedThrough: 1,
          minPrice: '100000',
          fee: { fixed: '0', bps: 0, treasuryNear: null, treasuryEvm: null },
          inventory: [],
        },
        [],
      );
    const c: Config = {
      nearRpc: 'https://near.test',
      baseRpc: 'https://base.test',
      contractId: terms.contract,
      network: terms.network,
      nearUsdc: terms.near.token,
      usdc: must(terms.base).usdc,
      sender: { accountId: 'relay.test', key: 'test-double' },
      ledger,
      policy: { minPrice: 1n, maxDeadlineSeconds: 600, baseSponsorship: mode !== 'policy' },
      disabled: mode === 'disabled',
      perIpHour: 600,
      perDay: 1000,
    };
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      const result = await handle(
        c,
        init?.method ?? 'GET',
        new URL(String(url)).pathname,
        '192.0.2.1',
        String(init?.body ?? ''),
      );
      return Response.json(result.body, { status: result.status, headers: result.headers ?? {} });
    });
    vi.spyOn(rpc, 'getFile').mockResolvedValue({
      terms,
      seller: terms.seller,
      termsHash: termsHash(terms),
      takenDown: null,
      salesStoppedAt: null,
      moderator: null,
    } as import('../../packages/annon/src/near/rpc.ts').FileInfo);
    vi.spyOn(rpc, 'getConfig').mockResolvedValue({
      network: terms.network,
      nearUsdc: terms.near.token,
      usdc: c.usdc,
    } as import('../../packages/annon/src/near/rpc.ts').Config);
    vi.spyOn(pay2, 'inspectHeader').mockResolvedValue({ usable: true } as never);
    const authorize = vi.fn(),
      signTypedData = vi.fn(),
      beforePayment = vi.fn();
    const wallet = { identity: terms.seller, authorize, signTypedData };
    const sdk = new Annon({
      ...c,
      network: terms.network,
      relayer: 'https://relay.test',
      fetch: fetcher,
      rawStore: memoryStore(),
      backupSecret: new Uint8Array(32).fill(1),
      writeBackup: async () => {},
    });
    try {
      await expect(
        sdk.buy({
          fileId: terms.file_id,
          header: new Uint8Array(),
          route: 'base',
          maxPrice: 1000000n,
          payer: wallet,
          recovery: wallet,
          refund: terms.seller,
          beforePayment,
        }),
      ).rejects.toMatchObject({ code: 'relayer_unavailable', retryAfterSeconds: 5 });
      expect(authorize).not.toHaveBeenCalled();
      expect(signTypedData).not.toHaveBeenCalled();
      expect(beforePayment).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(1);
      const cap = await handle(c, 'GET', '/v1/capabilities', '192.0.2.1', '');
      expect(cap.headers).toEqual({ 'Retry-After': '5' });
    } finally {
      vi.restoreAllMocks();
    }
  },
);
