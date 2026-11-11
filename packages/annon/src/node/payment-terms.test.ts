import { expect, it } from 'vitest';
import type { OneClickQuote } from '../oneclick/oneclick.js';
import type { PurchaseRecord, SourcePayment } from '../pay/purchase.js';
import { BASE_USDC, NEAR_USDC } from '../settle-near/terms.js';
import {
  humanPaymentTerms,
  quotedSource,
  savedPayment,
  validatePaymentToken,
} from './payment-terms.js';

const source: SourcePayment = {
  chain: 'sol',
  asset: 'nep141:test-token',
  symbol: 'USDC',
  contractAddress: 'test-token',
  decimals: 6,
  amount: '202064',
  amountFormatted: '0.202064',
  depositBefore: '2026-11-11T12:00:00Z',
};
const withSource = (value: unknown) =>
  ({
    purchase: { route: 'near-usdc' },
    quote: {},
    terms: { price: '200000', usdc: 'test-token', network: 'near:sandbox' },
    payment: { source: value },
  }) as unknown as PurchaseRecord;

it.each(
  [
    null,
    'invalid',
    [],
    { ...source, chain: 1 },
    { ...source, chain: '' },
    { ...source, chain: 'x'.repeat(129) },
    { ...source, asset: {} },
    { ...source, asset: 'x'.repeat(129) },
    { ...source, asset: 'unsafe\ntext' },
    { ...source, symbol: 1 },
    { ...source, symbol: 'x'.repeat(33) },
    { ...source, contractAddress: [] },
    { ...source, contractAddress: 'x'.repeat(129) },
    { ...source, amount: 1 },
    { ...source, amount: '-1' },
    { ...source, amount: '1.5' },
    { ...source, amount: '01' },
    { ...source, amount: '0' },
    { ...source, amount: '9'.repeat(40) },
    { ...source, amount: String(2n ** 128n) },
    { ...source, decimals: '6' },
    { ...source, decimals: -1 },
    { ...source, decimals: 256 },
    { ...source, decimals: 1.5 },
    { ...source, decimals: NaN },
    { ...source, amountFormatted: {} },
    { ...source, amountFormatted: '1e6' },
    { ...source, amountFormatted: '1'.repeat(400) },
    { ...source, depositBefore: 1 },
    { ...source, depositBefore: 'invalid' },
    { ...source, depositBefore: 'x'.repeat(65) },
  ].map((value) => ({ value })),
)('drops malformed saved payment source $value without losing the verified price', ({ value }) => {
  const summary = savedPayment(withSource(value));
  expect(summary).toMatchObject({ amountUsdc: '0.2', amountBaseUnits: '200000' });
  expect(summary).not.toHaveProperty('source');
});

it.each([0, 6, 255])('keeps valid saved source metadata with %s decimals', (decimals) => {
  const value = { ...source, decimals, amount: String(2n ** 128n - 1n) };
  expect(savedPayment(withSource(value)).source).toEqual(value);
});

it('shows a 0.01 USDC NEAR purchase with exact rounded shares and the remainder recipient', () => {
  const text = humanPaymentTerms({
    file: `0x${'ab'.repeat(32)}`,
    resource: 'https://files.example/f',
    network: 'near:mainnet',
    route: '1click',
    token: NEAR_USDC,
    price: '10000',
    recipients: [
      { identity: { kind: 'near', id: 'alice.near' }, bps: 3333 },
      { identity: { kind: 'near', id: 'bob.near' }, bps: 6667 },
    ],
    remainder: 1,
  });
  expect(text).toContain('Price: 0.01 USDC');
  expect(text).toContain('Recipient: near:alice.near | 33.33% | 0.003333 USDC');
  expect(text).toContain('Recipient: near:bob.near | 66.67% | 0.006667 USDC');
  expect(text).toContain('Rounding remainder: 0 USDC to near:bob.near');
  expect(text).toContain('Token: USDC on NEAR');
  expect(text).toContain('Resource: https://files.example/f');
  expect(text).toContain(`File: 0x${'ab'.repeat(32)}`);
  expect(text).toContain(`Token: USDC on NEAR (${NEAR_USDC})`);
  expect(text).not.toContain('\u2014');
  expect(text).not.toContain('10000');
});

it('adds the indivisible micro-USDC remainder to the specified recipient', () => {
  const text = humanPaymentTerms({
    file: 'file',
    resource: 'https://files.example/f',
    network: 'near:mainnet',
    route: 'near',
    token: NEAR_USDC,
    price: '1',
    recipients: [
      { identity: { kind: 'near', id: 'alice.near' }, bps: 5000 },
      { identity: { kind: 'near', id: 'bob.near' }, bps: 5000 },
    ],
    remainder: 0,
  });
  expect(text).toContain('Recipient: near:alice.near | 50% | 0.000001 USDC');
  expect(text).toContain('Recipient: near:bob.near | 50% | 0 USDC');
  expect(text).toContain('Rounding remainder: 0.000001 USDC to near:alice.near');
});

const payment = {
  file: `0x${'cd'.repeat(32)}`,
  resource: 'https://files.example/f',
  network: 'near:mainnet',
  route: 'near',
  token: NEAR_USDC,
  price: '10000',
  recipients: [{ identity: { kind: 'near' as const, id: 'alice.near' }, bps: 10000 }],
  remainder: 0,
};
it('shows the full Base token address and file id without em dashes', () => {
  const text = humanPaymentTerms({
    ...payment,
    network: 'eip155:8453',
    route: 'base',
    token: BASE_USDC,
  });
  expect(text).toContain(`Token: USDC on Base (${BASE_USDC})`);
  expect(text).toContain(`File: ${payment.file}`);
  expect(text).not.toContain('\u2014');
});
it.each([
  { token: 'fake-usdc.near' },
  { token: undefined },
  { network: 'near:testnet' },
  { route: 'base', network: 'eip155:8453', token: `0x${'11'.repeat(20)}` },
  { route: 'base', network: 'eip155:1', token: BASE_USDC },
])('refuses a token without a canonical USDC match for the network: %j', (change) => {
  expect(() => humanPaymentTerms({ ...payment, ...change })).toThrow(/canonical USDC/);
});

it.each(['near:testnet', 'near:sandbox'])(
  'validates and displays the contract-configured tokens on %s',
  (network) => {
    const config = { network, nearUsdc: 'usdc.testnet', usdc: `0x${'12'.repeat(20)}` };
    for (const route of ['near', '1click', 'base']) {
      const t = {
        ...payment,
        network: route === 'base' ? 'eip155:8453' : network,
        route,
        token: route === 'base' ? config.usdc : config.nearUsdc,
      };
      expect(() => validatePaymentToken(t, config)).not.toThrow();
      expect(humanPaymentTerms(t, config)).toContain(`(${t.token})`);
      expect(() => validatePaymentToken({ ...t, token: NEAR_USDC }, config)).toThrow();
    }
  },
);

it.each<[string, number, string]>([
  ['202064', 6, '0.202064'],
  ['1234567890123456789', 8, '12345678901.23456789'],
  ['1000', 0, '1000'],
  ['1000000', 6, '1'],
])(
  'formats the quoted input %s at %s decimals without floating point',
  (amount, decimals, expected) => {
    const source = quotedSource(
      {
        deposit: { amount, depositBefore: '2026-11-11T12:00:00Z' },
        response: { quote: { amountInFormatted: '999' } },
      } as unknown as OneClickQuote,
      { chain: 'sol', asset: 'nep141:source', symbol: 'USDC', decimals },
    );
    expect(source.amount).toBe(amount);
    expect(source.amountFormatted).toBe(expected);
  },
);
