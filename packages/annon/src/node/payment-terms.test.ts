import { expect, it } from 'vitest';
import { BASE_USDC, NEAR_USDC } from '../settle-near/terms.js';
import { humanPaymentTerms, validatePaymentToken } from './payment-terms.js';

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
