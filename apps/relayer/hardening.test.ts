import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NEAR_USDC } from '../../packages/annon/src/settle-near/terms.ts';
import { type Config, deliverKeeperAlert, fromEnv, handle, hits, serve } from './server.ts';

const settings = {
  DEMO_HOST_ORIGIN: 'https://demo.test',
  SELLERS: 'near:seller.test',
  CONTRACT_ID: 'market.test',
  RELAYER_ACCOUNT: 'relay.test',
  RELAYER_KEY: 'ed25519:test-double',
  RELAYER_STATE_DIR: '/unused',
  TREASURY_EVM: `0x${'55'.repeat(20)}`,
};
const config = (): Config => ({
  nearRpc: 'https://near.test',
  baseRpc: 'https://base.test',
  contractId: 'market.test',
  usdc: `0x${'11'.repeat(20)}`,
  sender: { accountId: 'relay.test', key: 'ed25519:test-double' },
  policy: { minPrice: 100000n, maxDeadlineSeconds: 600 },
  disabled: false,
  perIpHour: 1,
  perDay: 1000,
});
beforeEach(() => hits.clear());
afterEach(() => vi.restoreAllMocks());
it('uses frozen sponsorship, method, storage and keeper defaults and rejects malformed settings', () => {
  const { config: c } = fromEnv(settings);
  expect(c).toMatchObject({
    perDay: 1000,
    perIpHour: 600,
    unlockReserved: 500,
    unlockListedReserved: 250,
    nearUsdc: NEAR_USDC,
    perMethodDay: {
      register: 100,
      unlock: 500,
      claim_key: 250,
      reopen: 50,
      reopen_seller: 50,
      stop_sales: 100,
      fund_file_storage: 50,
    },
    balanceLowWater: 3n * 10n ** 24n,
    storageLowWater: 5n * 10n ** 23n,
    policy: {
      fileBudget: 41n * 10n ** 21n,
      listedFileBudget: 5n * 10n ** 22n,
      topupPerFile: 82n * 10n ** 21n,
      prepaidUnlockFloor: 10n ** 24n,
      registrationsPerSeller: 5,
      listedRegistrationsPerSeller: 20,
      claimsPerGrant: 3,
      unlocksPerFile: 10,
      unlocksPerSeller: 20,
      listedUnlocksPerFile: 100,
      listedUnlocksPerSeller: 250,
    },
  });
  expect(c.ipHeader).toBeUndefined();
  for (const [name, value] of Object.entries({
    DISABLED: 'yes',
    OPEN_POOL_ENABLED: 'true',
    BASE_SPONSORSHIP: '2',
    MAX_FILE_BYTES: '50000001',
    SPONSORED_FILES_PER_DAY: '101',
    SPONSORED_FILES_PER_IP_DAY: '6',
    IP_HEADER: 'bad,header',
    DEMO_RESERVATION_PUBLIC_KEY: 'wrong',
    MAX_WAITING: '-1',
    PORT: '0',
    MIN_PRICE: '0',
  }))
    expect(() => fromEnv({ ...settings, [name]: value })).toThrow();
  expect(
    fromEnv({ ...settings, PER_DAY: '0', OPEN_POOL_ENABLED: '0', SPONSORED_FILES_PER_DAY: '0' })
      .config,
  ).toMatchObject({ perDay: 0, policy: { openPoolEnabled: false, sponsoredFilesPerDay: 0 } });
  const keeper = fromEnv({
    ...settings,
    KEEPER_SECONDS: '15',
    KEEPER_ACCOUNT: 'keeper.test',
    KEEPER_KEY: 'ed25519:other-test-double',
    KEEPER_STATE_DIR: '/unused-keeper',
  }).config.keeper;
  expect(keeper).toMatchObject({
    minPayout: 100000n,
    dailyBudget: 10n ** 24n,
    hourlyBudget: 5n * 10n ** 23n,
    balanceLowWater: 2n * 10n ** 24n,
  });
});
it('returns the time left in the current UTC hour for a shared IPv6 /48', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1800000);
  const c = config();
  expect((await handle(c, 'POST', '/v1/relay', '2001:db8:aaaa:1::1', '{')).status).toBe(400);
  const blocked = await handle(c, 'POST', '/v1/relay', '2001:db8:aaaa:ffff::2', '{');
  expect(blocked).toMatchObject({
    status: 429,
    headers: { 'Retry-After': '1800' },
    body: { retryAfterSeconds: 1800 },
  });
});
it('applies exact CORS on errors and refuses unsupported browser request types before reading', async (context) => {
  const server = serve({ ...config(), disabled: true }, 0);
  const error = await new Promise<Error | undefined>((resolve) => {
    server.once('listening', () => resolve(undefined));
    server.once('error', resolve);
  });
  if (error && 'code' in error && error.code === 'EPERM')
    return context.skip('sandbox prohibits binding a local HTTP socket');
  if (error) throw error;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/relay`;
  try {
    const preflight = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://annon.dev',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://annon.dev');
    const denied = await fetch(url, {
      method: 'OPTIONS',
      headers: { Origin: 'https://annon.dev', 'Access-Control-Request-Method': 'DELETE' },
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    const wrong = await fetch(url, {
      method: 'POST',
      headers: { Origin: 'https://www.annon.dev', 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(wrong.status).toBe(415);
    expect(wrong.headers.get('access-control-allow-origin')).toBe('https://www.annon.dev');
    const paused = await fetch(url, {
      method: 'POST',
      headers: { Origin: 'https://annon.dev', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(paused.status).toBe(503);
    expect(paused.headers.get('access-control-expose-headers')).toBe('Retry-After');
    expect(paused.headers.get('cache-control')).toBe('no-store');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('leaves a supplied HTTPS webhook URL unchanged', async () => {
  const url = 'https://discord.com/api/webhooks/123/test-only';
  const fetcher = vi.fn<typeof fetch>(async () => new Response(null));
  await deliverKeeperAlert(url, { type: 'breaker' }, fetcher);
  expect(fetcher.mock.calls[0]?.[0]).toBe(url);
});
