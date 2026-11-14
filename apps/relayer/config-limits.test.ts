import { once } from 'node:events';
import { memoryStore } from '@defdone/annon/pay/store';
import type { CheckOptions } from '@defdone/annon/relay';
import { RelayLedger, type RelayState } from '@defdone/annon/relay';
import { expect, it, vi } from 'vitest';
import { fromEnv, handle, hits, serve } from './server.ts';

const base = {
  DEMO_HOST_ORIGIN: 'https://demo.test',
  SELLERS: 'near:seller.test',
  CONTRACT_ID: 'market.test',
  RELAYER_ACCOUNT: 'relay.test',
  RELAYER_KEY: 'test-double',
  TREASURY_EVM: `0x${'55'.repeat(20)}`,
  RELAYER_STATE_DIR: '/unused',
};
it.each([
  ['SPONSORED_FILES_PER_DAY', '61'],
  ['SPONSORED_FILES_PER_IP_DAY', '3'],
  ['REGISTRATIONS_PER_SELLER_DAY', '3'],
  ['SPONSORED_FILES_PER_DAY', '101'],
  ['SPONSORED_FILES_PER_IP_DAY', '6'],
  ['REGISTRATIONS_PER_SELLER_DAY', '6'],
  ['LISTED_REGISTRATIONS_PER_SELLER_DAY', '21'],
  ['FILE_BUDGET', '0.042'],
  ['LISTED_FILE_BUDGET', '0.051'],
  ['TOPUP_PER_FILE', '0.083'],
  ['TOPUP_PER_FILE_DAY', '0.042'],
  ['LISTED_TOPUP_PER_FILE', '0.151'],
  ['LISTED_TOPUP_PER_FILE_DAY', '0.051'],
  ['TOPUP_PER_DAY', '0.51'],
  ['PREPAID_UNLOCK_FLOOR', '0.99'],
])('refuses %s outside the frozen sponsorship bound', (name, value) => {
  expect(() => fromEnv({ ...base, [name]: value })).toThrow(name);
});
it('allows tighter open limits, zero capacity, and listed allowance independently', () => {
  const c = fromEnv({
    ...base,
    SPONSORED_FILES_PER_DAY: '0',
    SPONSORED_FILES_PER_IP_DAY: '0',
    FILE_BUDGET: '0.041',
  }).config;
  expect(c.policy.sponsoredFilesPerDay).toBe(0);
  expect(c.sponsoredFilesPerIpDay).toBe(0);
  expect(c.policy.listedRegistrationsPerSeller).toBe(20);
});

it('requires an explicit hosting origin and listed sellers when the demo pool is enabled', () => {
  expect(() => fromEnv({ ...base, DEMO_HOST_ORIGIN: undefined })).toThrow('DEMO_HOST_ORIGIN');
  expect(() => fromEnv({ ...base, SELLERS: undefined })).toThrow('SELLERS');
});
it('uses final pool defaults and a positive liquid admission floor in NEAR', () => {
  const c = fromEnv(base).config;
  expect(c.policy.sponsoredFilesPerDay).toBe(60);
  expect(c.sponsoredFilesPerIpDay).toBe(2);
  expect(c.policy.registrationsPerSeller).toBe(2);
  expect(c.admissionFloor).toBe(3n * 10n ** 24n);
  expect(
    fromEnv({ ...base, SPONSORED_FILES_PER_DAY: '60' }).config.policy.sponsoredFilesPerDay,
  ).toBe(60);
  for (const value of ['0', '-1', 'NaN', ''])
    expect(() => fromEnv({ ...base, ADMISSION_FLOOR_NEAR: value })).toThrow('ADMISSION_FLOOR_NEAR');
});

it('accepts relayer ceilings independently from the larger host quotas', async () => {
  const { settings } = await import('../demo-host/settings.ts');
  const quotas = {
    SPONSORED_FILES_PER_DAY: '60',
    SPONSORED_FILES_PER_IP_DAY: '2',
    REGISTRATIONS_PER_SELLER_DAY: '2',
  };
  const relay = fromEnv({ ...base, ...quotas }).config;
  expect(relay.policy.sponsoredFilesPerDay).toBe(60);
  expect(relay.sponsoredFilesPerIpDay).toBe(2);
  expect(relay.policy.registrationsPerSeller).toBe(2);
  expect(settings({}).capacity).toMatchObject({
    filesPerDay: 200,
    filesPerIpDay: 10,
    filesPerSellerDay: 10,
  });
  expect(settings(quotas).capacity).toMatchObject({
    filesPerDay: 60,
    filesPerIpDay: 2,
    filesPerSellerDay: 2,
  });
  expect(fromEnv(base).config.policy.sponsoredFilesPerDay).toBe(60);
});

it('publishes and enforces the omitted IP setting as two registrations', async () => {
  hits.clear();
  try {
    const c = fromEnv(base).config;
    delete c.sponsoredFilesPerIpDay;
    expect((await handle(c, 'GET', '/v1/capabilities', '192.0.2.1', '')).body).toMatchObject({
      sponsorship: { filesPerDay: 60, filesPerIpDay: 2 },
    });
    const send = vi.fn(async () => ({ txHash: 'test-hash' }));
    const request = JSON.stringify({ method: 'register', args: {} });
    for (let i = 0; i < 2; i++)
      expect((await handle(c, 'POST', '/v1/relay', '192.0.2.1', request, send)).status).toBe(200);
    expect((await handle(c, 'POST', '/v1/relay', '192.0.2.1', request, send)).status).toBe(429);
    expect(send).toHaveBeenCalledTimes(2);
    hits.clear();
    c.ledger = new RelayLedger(memoryStore<RelayState>(), 'fallback-quota');
    const durableSend = vi.fn(async (_request: unknown, options: CheckOptions) => {
      expect(options.admissionLimits?.filesPerIp).toBe(2);
      return { txHash: 'test-hash' };
    });
    expect((await handle(c, 'POST', '/v1/relay', '192.0.2.1', request, durableSend)).status).toBe(
      200,
    );
    expect(durableSend).toHaveBeenCalledTimes(1);
  } finally {
    hits.clear();
  }
});

it('sets the startup admission IP fallback to two', async () => {
  const c = fromEnv(base).config;
  delete c.stateDir;
  delete c.sponsoredFilesPerIpDay;
  c.disabled = true;
  const server = serve(c, 0);
  try {
    await once(server, 'listening');
    expect(c.admissionLimits?.filesPerIp).toBe(2);
  } finally {
    const drained = once(server, 'drained');
    server.close();
    await drained;
  }
});
