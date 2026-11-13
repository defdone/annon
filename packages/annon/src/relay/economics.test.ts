import { describe, expect, it } from 'vitest';
import { must, terms } from '../../test/fixtures.js';
import { applySponsoredFee, checkProtocolFee, requiredFeeBps } from './fees.js';

describe('sponsored protocol economics', () => {
  const treasury = { kind: 'near', id: 'treasury.test' } as const;
  const fee = { fixed: '30000', bps: 100, treasuryNear: treasury, treasuryEvm: null };
  it('rounds the fixed plus proportional fee up, including fractional price percentages', () => {
    expect(requiredFeeBps('100000', fee)).toBe(3100);
    expect(requiredFeeBps('100001', fee)).toBe(3100);
    expect(requiredFeeBps('200000', fee)).toBe(1600);
    expect(requiredFeeBps('100000', { fixed: '0', bps: 0 })).toBe(0);
  });
  it('scales seller shares and gives the original remainder recipient the rounding remainder', () => {
    const split = applySponsoredFee(terms.near, fee);
    expect(split.recipients.reduce((n, r) => n + r.bps, 0)).toBe(10000);
    expect(split.recipients.find((r) => r.identity.id === treasury.id)?.bps).toBe(1600);
    expect(
      split.recipients.find(
        (r) => r.identity.id === terms.near.recipients[terms.near.remainder]?.identity.id,
      )?.bps,
    ).toBe(8400);
    expect(() => checkProtocolFee({ ...terms, base: null, near: split }, fee)).not.toThrow();
    expect(() => checkProtocolFee({ ...terms, base: null }, fee)).toThrow();
  });
  it('refuses missing route treasury, excessive fees and more than eight recipients', () => {
    expect(() => applySponsoredFee(terms.near, fee, terms.near.price)).toThrow();
    expect(() => requiredFeeBps('1', fee)).toThrow();
    const eight = {
      ...terms.near,
      recipients: Array.from({ length: 8 }, (_, i) => ({
        identity: { kind: 'near' as const, id: `recipient${i}.test` },
        bps: 1250,
      })),
      remainder: 0,
    };
    expect(() => applySponsoredFee(eight, fee)).toThrow();
  });
});

it('uses one EVM treasury at the larger route requirement', async () => {
  const treasuryNear = { kind: 'evm', id: `0x${'44'.repeat(20)}` } as const;
  const treasuryEvm = { kind: 'evm', id: `0x${'55'.repeat(20)}` } as const;
  const fee = { fixed: '30000', bps: 100, treasuryNear, treasuryEvm };
  const near = applySponsoredFee(terms.near, fee, '100000');
  expect(near.recipients.find((r) => r.identity.id === treasuryNear.id)?.bps).toBeUndefined();
  expect(near.recipients.find((r) => r.identity.id === treasuryEvm.id)?.bps).toBe(3100);
  expect(() =>
    checkProtocolFee({ ...terms, near, base: { ...must(terms.base), price: '100000' } }, fee),
  ).not.toThrow();
});

it('allocates proportional bps rounding to the original first recipient after canonical sorting', () => {
  const first = { kind: 'evm', id: `0x${'77'.repeat(20)}` } as const;
  const second = { kind: 'evm', id: `0x${'11'.repeat(20)}` } as const;
  const treasury = { kind: 'evm', id: `0x${'44'.repeat(20)}` } as const;
  const near = {
    ...terms.near,
    price: '1234567',
    recipients: [
      { identity: first, bps: 3333 },
      { identity: second, bps: 6667 },
    ],
    remainder: 0,
  };
  const split = applySponsoredFee(near, {
    fixed: '30000',
    bps: 100,
    treasuryNear: treasury,
    treasuryEvm: treasury,
  });
  expect(split.recipients.map((r) => r.bps)).toEqual([6437, 344, 3219]);
  expect(split.remainder).toBe(2);
});

it('uses an EVM treasury for NEAR-only files when no NEAR treasury is configured', async () => {
  const treasuryEvm = { kind: 'evm' as const, id: `0x${'55'.repeat(20)}` };
  const fee = { fixed: '30000', bps: 100, treasuryNear: null, treasuryEvm };
  const near = applySponsoredFee(terms.near, fee);
  expect(near.recipients.find((r) => r.identity.id === treasuryEvm.id)?.bps).toBe(1600);
  expect(() => checkProtocolFee({ ...terms, base: null, near }, fee)).not.toThrow();
});

it('keeps a treasury-first split from receiving additional rounding', () => {
  const treasury = { kind: 'evm' as const, id: `0x${'44'.repeat(20)}` };
  const seller = { kind: 'evm' as const, id: `0x${'77'.repeat(20)}` };
  const near = {
    ...terms.near,
    recipients: [
      { identity: treasury, bps: 5000 },
      { identity: seller, bps: 5000 },
    ],
    remainder: 0,
  };
  const split = applySponsoredFee(near, {
    fixed: '30000',
    bps: 100,
    treasuryNear: treasury,
    treasuryEvm: treasury,
  });
  expect(split.recipients[split.remainder]?.identity).toEqual(seller);
});
