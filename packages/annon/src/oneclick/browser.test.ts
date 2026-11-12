import { base58 } from '@scure/base';
import { describe, expect, it, vi } from 'vitest';
import { purchase as base } from '../../test/fixtures.js';
import { buildPurchaseMessage } from '../settle-near/purchase.js';
import { NEAR_USDC } from '../settle-near/terms.js';
import { OneClick, originFromToken, validateRefundAddress } from './oneclick.js';

const now = 1800000000;
const message = buildPurchaseMessage({
  ...base,
  route: 'near-usdc',
  network: 'near:mainnet',
  asset: NEAR_USDC,
  expires_at: String(now + 3600),
});
const origin = {
  asset: 'nep141:synthetic',
  chain: 'evm' as const,
  refundTo: `0x${'12'.repeat(20)}`,
};
function service(change: Record<string, unknown> = {}) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    return Response.json({
      quoteRequest: request,
      quote: {
        amountIn: '250000',
        amountOut: '200000',
        timeEstimate: 30,
        ...(request.dry ? {} : { depositAddress: 'synthetic-deposit', deadline: request.deadline }),
        ...change,
      },
    });
  });
}
describe('browser 1Click', () => {
  it('parses a dry preview without an address and never exposes instructions', async () => {
    const fetcher = service();
    const c = new OneClick({ fetch: fetcher, now: () => now });
    const preview = await c.preview(message, origin);
    expect(preview.amountIn).toBe('250000');
    expect(preview).not.toHaveProperty('deposit');
    expect(preview).not.toHaveProperty('response');
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).dry).toBe(true);
    expect(await c.quote(message, origin, { dry: true })).not.toHaveProperty('deposit');
  });
  it('loads tokens by exact asset and blockchain, refusing unknown and slow families', async () => {
    const tokens = [
      { assetId: origin.asset, blockchain: 'base', symbol: 'SYN', decimals: 6 },
      { assetId: origin.asset, blockchain: 'eth', symbol: 'SYN', decimals: 18 },
      { assetId: 'nep141:slow', blockchain: 'btc', symbol: 'SLOW', decimals: 8 },
    ];
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(tokens));
    const c = new OneClick({ fetch: fetcher });
    expect(await c.tokens()).toEqual(tokens);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toBeUndefined();
    expect(originFromToken(tokens, origin.asset, 'base', origin.refundTo)).toMatchObject({
      asset: origin.asset,
      chain: 'evm',
      blockchain: 'base',
    });
    expect(() => originFromToken(tokens, 'SYN', 'base', origin.refundTo)).toThrow();
    expect(() => originFromToken(tokens, 'nep141:slow', 'btc', 'synthetic')).toThrow(
      /window|unsupported/,
    );
    await expect(c.tokens()).resolves.toHaveLength(3);
  });
  it.each([
    ['evm', 'bad'],
    ['solana', 'bad'],
    ['near', 'Bad Account'],
    ['other', 'bad refund'],
  ] as const)('rejects invalid %s refunds before any quote request', async (chain, refundTo) => {
    const fetcher = service();
    await expect(
      new OneClick({ fetch: fetcher, now: () => now }).quote(message, {
        ...origin,
        chain,
        refundTo,
      }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('validates supported chain families and explicit source refunds for NEAR', async () => {
    expect(() =>
      validateRefundAddress('solana', base58.encode(new Uint8Array(32).fill(2))),
    ).not.toThrow();
    expect(() => validateRefundAddress('near', 'synthetic-buyer.test')).not.toThrow();
    const fetcher = service();
    const c = new OneClick({ fetch: fetcher, now: () => now });
    await c.quote(message, {
      ...origin,
      chain: 'near',
      refundTo: 'synthetic-buyer.test',
      refundType: 'ORIGIN_CHAIN',
    });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).refundType).toBe('ORIGIN_CHAIN');
  });
  it('sends depositMode and retains the required memo; refuses a missing memo', async () => {
    const fetcher = service({ depositMemo: 'synthetic-memo' });
    const c = new OneClick({ fetch: fetcher, now: () => now });
    const result = await c.quote(message, { ...origin, blockchain: 'base', depositMode: 'MEMO' });
    expect(result.deposit.memo).toBe('synthetic-memo');
    expect(result.deposit.blockchain).toBe('base');
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).depositMode).toBe('MEMO');
    await expect(
      new OneClick({ fetch: service(), now: () => now }).quote(message, {
        ...origin,
        depositMode: 'MEMO',
      }),
    ).rejects.toThrow(/memo/);
  });
  it.each(['REFUNDED', 'FAILED', 'SUCCESS'] as const)(
    'resumes checkpoints through offline, 429, incomplete and %s',
    async (terminal) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new TypeError('offline'))
        .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '5' } }))
        .mockResolvedValueOnce(
          Response.json({ status: 'INCOMPLETE_DEPOSIT', swapDetails: { depositedAmount: '1' } }),
        )
        .mockResolvedValueOnce(Response.json({ status: terminal }));
      const wait = vi.fn(async (_ms: number) => {});
      const c = new OneClick({ fetch: fetcher, wait, now: () => now });
      const checkpoints: unknown[] = [];
      const result = await c.poll('synthetic-deposit', {
        memo: 'synthetic-memo',
        maxPolls: 4,
        intervalMs: 1000,
        checkpoint: {
          address: 'synthetic-deposit',
          memo: 'synthetic-memo',
          attempts: 3,
          errors: 0,
        },
        onProgress: async (checkpoint) => {
          checkpoints.push(checkpoint);
        },
      });
      expect(result.status).toBe(terminal);
      expect(checkpoints).toHaveLength(4);
      expect(checkpoints[2]).toMatchObject({
        attempts: 6,
        lastStatus: { status: 'INCOMPLETE_DEPOSIT' },
      });
      expect(wait.mock.calls.map((x) => x[0])).toEqual([1000, 5000, 1000]);
      expect(
        fetcher.mock.calls.every(
          ([u, init]) =>
            String(u).includes('depositMemo=synthetic-memo') && init?.headers === undefined,
        ),
      ).toBe(true);
    },
  );
  it('does not swallow persistence failures, cancellation, malformed status or checkpoint substitution', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ status: 'PENDING_DEPOSIT' }));
    const c = new OneClick({ fetch: fetcher, wait: async () => {} });
    await expect(
      c.poll('synthetic', {
        onProgress: async () => {
          throw new Error('quota');
        },
      }),
    ).rejects.toThrow('quota');
    await expect(
      c.poll('synthetic', { checkpoint: { address: 'different', attempts: 0, errors: 0 } }),
    ).rejects.toThrow(/checkpoint/);
    const abort = new AbortController();
    abort.abort();
    await expect(c.poll('synthetic', { signal: abort.signal })).rejects.toThrow();
    await expect(
      new OneClick({ fetch: async () => Response.json({ status: 'UNKNOWN' }) }).poll('synthetic'),
    ).rejects.toThrow(/status/);
  });
});

it('resumes a saved terminal poll checkpoint without another request or wait', async () => {
  const fetcher = vi.fn<typeof fetch>();
  const wait = vi.fn(async () => {});
  const c = new OneClick({ fetch: fetcher, wait });
  const checkpoint = {
    address: 'synthetic',
    attempts: 5,
    errors: 0,
    lastStatus: { status: 'REFUNDED' as const, refundAmount: '1' },
  };
  expect(await c.poll('synthetic', { checkpoint })).toEqual(checkpoint.lastStatus);
  expect(fetcher).not.toHaveBeenCalled();
  expect(wait).not.toHaveBeenCalled();
});
it.each(['btc', 'doge', 'zec', 'xrp', 'stellar', 'unknown'])(
  'refuses %s even if its family is mislabeled as EVM',
  async (blockchain) => {
    const fetcher = service();
    await expect(
      new OneClick({ fetch: fetcher, now: () => now }).quote(message, { ...origin, blockchain }),
    ).rejects.toThrow(/unsupported/);
    expect(fetcher).not.toHaveBeenCalled();
  },
);

it('preserves legacy other-family refunds while catalog selection stays strict', async () => {
  const fetcher = service();
  const c = new OneClick({ fetch: fetcher, now: () => now });
  await expect(
    c.quote(message, { ...origin, chain: 'other', refundTo: 'synthetic-refund' }),
  ).resolves.toHaveProperty('deposit');
  expect(() =>
    originFromToken(
      [{ assetId: origin.asset, blockchain: 'sui', symbol: 'SYN', decimals: 6 }],
      origin.asset,
      'sui',
      'synthetic-refund',
    ),
  ).toThrow(/unsupported/);
});
it('skips nep245 and malformed catalog entries while rejecting a non-list response', async () => {
  const tokens = (await import('./fixtures/tokens-mixed.json')).default;
  const c = new OneClick({ fetch: async () => Response.json(tokens) });
  expect(await c.tokens()).toEqual([tokens[0]]);
  await expect(
    new OneClick({ fetch: async () => Response.json({ tokens }) }).tokens(),
  ).rejects.toThrow(/catalog|response/);
});
it('requests source-chain refunds for a catalog-selected NEAR origin', () => {
  expect(
    originFromToken(
      [{ assetId: origin.asset, blockchain: 'near', symbol: 'SYN', decimals: 6 }],
      origin.asset,
      'near',
      'synthetic-refund.test',
    ).refundType,
  ).toBe('ORIGIN_CHAIN');
});
it('uses only the live CLI quote-expiry message without a released-instructions branch', async () => {
  const { OneClickQuoteExpired } = await import('./oneclick.js');
  const { publicError } = await import('../node/errors.js');
  const error = new OneClickQuoteExpired();
  expect(error.message).toBe('The 1Click quote expired. Run buy again.');
  expect(publicError(error).message).toBe(error.message);
  expect(error).not.toHaveProperty('instructionsReleased');
});
