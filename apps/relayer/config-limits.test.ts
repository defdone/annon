import { expect, it } from 'vitest';
import { fromEnv } from './server.ts';

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
  ['SPONSORED_FILES_PER_IP_DAY', '2'],
  ['REGISTRATIONS_PER_SELLER_DAY', '2'],
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
  expect(c.sponsoredFilesPerIpDay).toBe(1);
  expect(c.policy.registrationsPerSeller).toBe(1);
  expect(c.admissionFloor).toBe(3n * 10n ** 24n);
  expect(
    fromEnv({ ...base, SPONSORED_FILES_PER_DAY: '60' }).config.policy.sponsoredFilesPerDay,
  ).toBe(60);
  for (const value of ['0', '-1', 'NaN', ''])
    expect(() => fromEnv({ ...base, ADMISSION_FLOOR_NEAR: value })).toThrow('ADMISSION_FLOOR_NEAR');
});
