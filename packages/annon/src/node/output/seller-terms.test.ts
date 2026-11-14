import { expect, it } from 'vitest';
import { localTime } from '../../browser/login-format.js';
import {
  hostingExpiry,
  nearText,
  salesCovered,
  sellSplitText,
  shareTermsText,
  usdcText,
} from './seller-terms.js';

const NEAR = 10n ** 24n;
const near = (text: string) => {
  const [whole = '0', fraction = ''] = text.split('.');
  return BigInt(whole) * NEAR + BigInt(fraction.padEnd(24, '0'));
};

it('estimates the sales a purchase storage budget covers with the contract numbers', () => {
  expect(salesCovered(near('0.05'))).toBe(2n);
  expect(salesCovered(near('0.2'))).toBe(19n);
  expect(salesCovered(near('0.04'))).toBe(0n);
  // The first sale needs 4096 bytes free; each later one about 854.
  expect(salesCovered(near('0.04096'))).toBe(1n);
  expect(salesCovered(near('0.04096') - 1n)).toBe(0n);
  expect(salesCovered(near('0.0495') - 1n)).toBe(1n);
  expect(salesCovered(near('0.0495'))).toBe(2n);
  expect(salesCovered(0n)).toBe(0n);
});

it('formats USDC with two decimals and NEAR as a plain amount', () => {
  expect(usdcText('100000')).toBe('0.10');
  expect(usdcText('1')).toBe('0.000001');
  expect(usdcText('12000000')).toBe('12.00');
  expect(nearText(near('0.01'))).toBe('0.01');
  expect(nearText(near('2'))).toBe('2');
});

const nearSeller = { kind: 'near', id: 'alice.near' } as const;
const base = {
  seller: nearSeller,
  host: 'https://demo.annon.dev',
  contract: 'v1.annon.defdone.near',
  price: '100000',
  split: { price: '100000', recipients: [{ identity: nearSeller, bps: 10000 }], remainder: 0 },
  fee: null,
  listingStorage: '10000000000000000000000',
  purchaseStorage: '50000000000000000000000',
  registerDeposit: '0',
};

it('shows NEAR share terms as short lines', () => {
  expect(shareTermsText(base)).toBe(
    [
      'Seller: alice.near',
      'Host: https://demo.annon.dev',
      'Contract: v1.annon.defdone.near',
      'Price: 0.10 USDC',
      'Split: alice.near 100%',
      'Fee: none',
      'Listing storage: 0.01 NEAR',
      'Purchase storage: 0.05 NEAR (covers about 2 sales)',
    ].join('\n'),
  );
});

it('shows an EVM share with a fee, a treasury share and a register deposit, shortened and sanitized', () => {
  const seller = { kind: 'evm', id: `0x${'e8'.repeat(20)}` } as const;
  const treasury = { kind: 'evm', id: `0x${'cf'.repeat(20)}` } as const;
  const split = {
    recipients: [
      { identity: seller, bps: 9750 },
      { identity: treasury, bps: 250 },
    ],
  };
  const fee = { fixed: '10000', bps: 100, treasuryNear: null, treasuryEvm: treasury };
  expect(
    shareTermsText({
      ...base,
      seller,
      host: 'https://shop.test\u001b[31m\u202e',
      split,
      fee,
      listingStorage: null,
      purchaseStorage: null,
      registerDeposit: '1000000000000000000000',
    }),
  ).toBe(
    [
      'Seller: 0xe8e8e8e8...e8e8',
      'Host: https://shop.test [31m',
      'Contract: v1.annon.defdone.near',
      'Price: 0.10 USDC',
      'Split: 0xe8e8e8e8...e8e8 97.5%, 0xcfcfcfcf...cfcf 2.5%',
      'Fee: 0.01 USDC + 1%, treasury 0xcfcfcfcf...cfcf gets 2.5%',
      'Register deposit: 0.001 NEAR',
    ].join('\n'),
  );
  expect(sellSplitText(split, fee, true)).toBe(
    [
      'Split: 0xe8e8e8e8...e8e8 97.5%, 0xcfcfcfcf...cfcf 2.5%',
      'Fee: 0.01 USDC + 1%, treasury 0xcfcfcfcf...cfcf gets 2.5% (above your maxProtocolFee)',
    ].join('\n'),
  );
});

it('shows a hosting expiry as local time with the Unix value, or no expiry', () => {
  expect(hostingExpiry(1795294406)).toBe(`${localTime(1795294406000)} (1795294406)`);
  expect(hostingExpiry(1795294406)).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \(1795294406\)$/);
  expect(hostingExpiry(null)).toBe('no expiry');
});
