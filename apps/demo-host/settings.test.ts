import { expect, it } from 'vitest';
import { settings } from './settings.ts';

it('uses frozen defaults and accepts zero only for disableable caps', () => {
  const s = settings({});
  expect(s.perIpMinute).toBe(600);
  expect(s.paymentsPerClientMinute).toBe(60);
  expect(s.capacity.ingressPerDay).toBe(1_000_000_000);
  expect(s.facilitator.dailyGasBudgetWei).toBe(1_000_000_000_000_000n);
  expect(settings({ POOL_STORAGE_BYTES: '0' }).capacity.poolBytes).toBe(0);
  expect(() => settings({ POOL_STORAGE_BYTES: '' })).toThrow();
  for (const value of ['-1', 'NaN', 'Infinity', '1.5', ''])
    expect(() => settings({ PER_IP_MINUTE: value })).toThrow();
  for (const name of [
    'MAX_FILE_BYTES',
    'MAX_PAY2_BYTES',
    'DOWNLOAD_CONCURRENCY_PER_PURCHASE',
    'SPONSORED_FILES_LISTED_RESERVED',
  ])
    expect(() => settings({ [name]: '999999999999' })).toThrow();
  expect(() => settings({ UPLOAD_TTL_SECONDS: '604801' })).toThrow();
  expect(() => settings({ PER_IP_MINUTE: '0' })).toThrow();
});

it('rejects every raised send, request, fee and gas budget ceiling', () => {
  for (const [name, value] of Object.entries({
    PER_IP_MINUTE: '601',
    PAYMENTS_PER_CLIENT_MINUTE: '61',
    SENDS_PER_MINUTE: '11',
    MAX_FEE_GWEI: '0.5000001',
    FACILITATOR_DAILY_GAS_BUDGET_WEI: '1000000000000001',
  }))
    expect(() => settings({ [name]: value })).toThrow();
  expect(settings({ MAX_FEE_GWEI: '0.1', FACILITATOR_DAILY_GAS_BUDGET_WEI: '0' }).maxFeeGwei).toBe(
    0.1,
  );
});
