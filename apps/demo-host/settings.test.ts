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

const splitEnv = {
  SPLIT_DEPLOY_ENABLED: '1',
  SPLIT_DEPLOYMENTS_PER_DAY: '60',
  SPLIT_SENDS_PER_MINUTE: '2',
  SPLIT_REVERTS_PER_DAY: '1',
  SPLIT_GAS_LIMIT: '1000000',
  SPLIT_MAX_FEE_GWEI: '0.5',
  SPLIT_L1_FEE_ALLOWANCE_WEI: '100',
  SPLIT_DAILY_BUDGET_WEI: '1000',
  BASE_WALLET_DAILY_BUDGET_WEI: '2000',
  FACILITATOR_DAILY_GAS_BUDGET_WEI: '1000',
};
it('defaults split spending off and requires every explicit positive deployment limit', () => {
  expect(settings({}).split).toEqual({ enabled: false });
  expect(settings(splitEnv).split).toMatchObject({ enabled: true, deploymentsPerDay: 60 });
  for (const key of Object.keys(splitEnv).filter(
    (k) => !['SPLIT_DEPLOY_ENABLED', 'FACILITATOR_DAILY_GAS_BUDGET_WEI'].includes(k),
  )) {
    for (const value of [undefined, '', '0', '-1', 'NaN', 'Infinity'])
      expect(() => settings({ ...splitEnv, [key]: value }), `${key}=${value}`).toThrow(key);
  }
  expect(() => settings({ SPLIT_DEPLOY_ENABLED: '2' })).toThrow('SPLIT_DEPLOY_ENABLED');
});
it('uses the final open-pool defaults and ceilings', () => {
  expect(settings({}).capacity).toMatchObject({
    filesPerDay: 60,
    filesPerIpDay: 1,
    filesPerSellerDay: 1,
  });
  expect(() => settings({ SPONSORED_FILES_PER_DAY: '60' })).not.toThrow();
  for (const [name, value] of [
    ['SPONSORED_FILES_PER_DAY', '61'],
    ['SPONSORED_FILES_PER_IP_DAY', '2'],
    ['REGISTRATIONS_PER_SELLER_DAY', '2'],
  ] as const)
    expect(() => settings({ [name]: value })).toThrow(name);
});

it('reserves the entire configured payment and split budgets at startup', () => {
  expect(() => settings({ ...splitEnv, BASE_WALLET_DAILY_BUDGET_WEI: '1999' })).toThrow(
    'BASE_WALLET_DAILY_BUDGET_WEI',
  );
  expect(() => settings(splitEnv)).not.toThrow();
  expect(() => settings({ ...splitEnv, FACILITATOR_DAILY_GAS_BUDGET_WEI: undefined })).toThrow(
    'BASE_WALLET_DAILY_BUDGET_WEI',
  );
});
