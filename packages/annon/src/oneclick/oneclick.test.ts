import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { purchase as base } from '../../test/fixtures.js';
import { buildPurchaseMessage } from '../settle-near/purchase.js';
import { NEAR_USDC } from '../settle-near/terms.js';
import { OneClick } from './oneclick.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const recordedDeadline = (name: string) => {
  const full = fixture(name);
  return full.quoteRequest?.deadline ?? full.requestDeadline;
};
const now = Math.floor(Date.parse(recordedDeadline('quote')) / 1000) - 3600;
const purchase = {
  ...base,
  route: 'near-usdc' as const,
  network: 'near:mainnet',
  asset: NEAR_USDC,
  expires_at: String(Math.floor(Date.parse(recordedDeadline('quote')) / 1000) + 600),
};
const message = buildPurchaseMessage(purchase);
function recorded(request: { deadline: string }, name = 'quote') {
  const full = fixture(name);
  return { ...full, quoteRequest: { ...full.quoteRequest, ...request } };
}

const origin = {
  asset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  chain: 'evm' as const,
  refundTo: base.refund.id,
};
describe('1Click with synthetic response fixtures', () => {
  it.each(['quote', 'quote-base', 'quote-solana'])(
    'quotes EXACT_OUTPUT with the %s fixture timing and a byte-identical message',
    async (name) => {
      const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
        Response.json(recorded(JSON.parse(String(_init?.body)), name), { status: 201 }),
      );
      const c = new OneClick({ fetch: fetcher as typeof fetch, now: () => now });
      const perQuoteMessage = buildPurchaseMessage({
        ...purchase,
        expires_at: String(Math.floor(Date.parse(recordedDeadline(name)) / 1000) + 600),
      });
      const result = await c.quote(
        perQuoteMessage,
        name === 'quote-solana'
          ? { ...origin, chain: 'solana', asset: 'nep141:solana-usdc', refundTo: 'solana-wallet' }
          : origin,
      );
      const sent = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
      expect(sent).toMatchObject({
        swapType: 'EXACT_OUTPUT',
        amount: '200000',
        recipient: purchase.contract,
        recipientType: 'DESTINATION_CHAIN',
        customRecipientMsg: perQuoteMessage,
        destinationAsset: `nep141:${NEAR_USDC}`,
        refundType: 'ORIGIN_CHAIN',
        deadline: new Date(
          Math.floor(Date.parse(recordedDeadline(name)) / 1000) * 1000,
        ).toISOString(),
      });
      expect(result.deposit.depositBefore).toBe(sent.deadline);
      expect(Date.parse(result.deposit.purchaseExpiresAt)).toBe(Date.parse(sent.deadline) + 600000);
      expect(result.response.quote).toEqual(fixture(name).quote);
      expect(result.deposit.amount).toBe(fixture(name).quote.amountIn);
      expect(result.deposit.address).toBe(fixture(name).quote.depositAddress);
      expect(JSON.parse(result.deposit.qrData).address).toBe(result.deposit.address);
    },
  );
  it('uses INTENTS for a NEAR origin/refund; refuses malformed messages without HTTP', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(recorded(JSON.parse(String(_init?.body)))),
    );
    const c = new OneClick({ fetch: fetcher as typeof fetch, now: () => now });
    await c.quote(message, { asset: `nep141:${NEAR_USDC}`, chain: 'near', refundTo: 'buyer.near' });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).refundType).toBe('INTENTS');
    await expect(c.quote(message.replace('"annon":2', '"annon":1'), origin)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('polls until terminal status, keeps SUCCESS separate from contract acceptance', async () => {
    const done = fixture('refused-success');
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ status: 'PENDING_DEPOSIT' }))
      .mockResolvedValueOnce(Response.json({ status: 'PROCESSING' }))
      .mockResolvedValueOnce(Response.json(done));
    const wait = vi.fn(async () => {});
    const c = new OneClick({ fetch: fetcher as typeof fetch, wait });
    expect((await c.poll('0xdeposit', { maxPolls: 3 })).status).toBe('SUCCESS');
    expect(wait).toHaveBeenCalledTimes(2);
    expect(done.swapDetails.refundedAmount).toBe('0'); // A refused delivery can leave funds in the quote's Intents account.
  });
  it('fails closed on HTTP, amount, expiry and status errors and supports cancellation', async () => {
    const c = new OneClick({
      fetch: vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ error: 'bad' }, { status: 400 }),
      ) as typeof fetch,
      now: () => now,
    });
    await expect(c.quote(message, origin)).rejects.toThrow();
    await expect(
      c.quote(buildPurchaseMessage({ ...purchase, expires_at: String(now - 1) }), origin),
    ).rejects.toThrow(/expired/);
    const malformed = new OneClick({
      fetch: vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ quote: { ...fixture('quote').quote, amountOut: '1' } }),
      ) as typeof fetch,
      now: () => now,
    });
    await expect(malformed.quote(message, origin)).rejects.toThrow(/output/);
    const abort = new AbortController();
    abort.abort();
    await expect(c.poll('address', { signal: abort.signal })).rejects.toThrow();
  });
  it.each([
    'recipient',
    'customRecipientMsg',
    'refundTo',
    'refundType',
    'destinationAsset',
    'originAsset',
    'amount',
    'dry',
    'swapType',
    'slippageTolerance',
    'depositType',
    'recipientType',
    'deadline',
  ])('refuses a changed quoteRequest echo: %s', async (field) => {
    const c = new OneClick({
      now: () => now,
      fetch: (async (_u, init) => {
        const request = JSON.parse(String(init?.body));
        return Response.json({
          ...fixture('quote'),
          quoteRequest: { ...request, [field]: 'wrong' },
        });
      }) as typeof fetch,
    });
    await expect(c.quote(message, origin)).rejects.toThrow(/echo/);
  });
  it('refuses an expired deposit address deadline', async () => {
    const c = new OneClick({
      now: () => now,
      fetch: (async (_u, init) =>
        Response.json({
          ...fixture('quote'),
          quoteRequest: JSON.parse(String(init?.body)),
          quote: { ...fixture('quote').quote, deadline: '2020-01-01T00:00:00Z' },
        })) as typeof fetch,
    });
    await expect(c.quote(message, origin)).rejects.toThrow(/deadline/);
  });

  it('retains the recorded v1 echo and rejects it for a different v2 purchase', async () => {
    const full = fixture('quote');
    expect(full.quoteRequest.customRecipientMsg).toContain('"annon":1');
    expect(Date.parse(full.quote.deadline)).toBeGreaterThan(
      Date.parse(full.quoteRequest?.deadline ?? full.requestDeadline),
    );
    const c = new OneClick({
      now: () => now,
      fetch: (async () => Response.json(full)) as typeof fetch,
    });
    await expect(c.quote(message, origin)).rejects.toThrow(/echo/);
  });
});

it('refuses a quote with insufficient delivery time before giving deposit instructions', async () => {
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const response = recorded(JSON.parse(String(init?.body)));
    response.quote.timeEstimate = 601;
    return Response.json(response);
  });
  const c = new OneClick({ fetch: fetcher as typeof fetch, now: () => now });
  await expect(c.quote(message, origin)).rejects.toThrow(/delivery/);
  fetcher.mockClear();
  await expect(
    c.quote(buildPurchaseMessage({ ...purchase, expires_at: String(now + 600) }), origin),
  ).rejects.toThrow(/delivery/);
  expect(fetcher).not.toHaveBeenCalled();
});

it('refuses a quote missing the required timeEstimate before giving deposit instructions', async () => {
  const c = new OneClick({
    now: () => now,
    fetch: async (_url, init) => {
      const response = recorded(JSON.parse(String(init?.body)));
      delete response.quote.timeEstimate;
      return Response.json(response);
    },
  });
  await expect(c.quote(message, origin)).rejects.toThrow(/delivery estimate/);
});

it('surfaces a safe quote refusal and decimal USDC minimum, discarding other response fields', async () => {
  const c = new OneClick({
    now: () => now,
    fetch: async () =>
      Response.json(
        {
          message: 'Amount is too low for bridge, try at least 149983',
          secret: 'SECRET_VALUE',
        },
        { status: 400 },
      ),
  });
  const { publicError } = await import('../node/errors.js');
  const error = await c.quote(message, origin).catch((e: unknown) => e);
  expect(publicError(error)).toMatchObject({
    code: 'oneclick_refused',
    message: 'Amount is too low for bridge, try at least 149983',
    minimumAmountUsdc: '0.149983',
  });
  expect(JSON.stringify(publicError(error))).not.toContain('SECRET_VALUE');
});
it.each(['private_key=SECRET_VALUE', '<html>bad gateway</html>'])(
  'keeps unrecognized 1Click failures generic: %s',
  async (messageText) => {
    const c = new OneClick({
      now: () => now,
      fetch: async () => Response.json({ message: messageText }, { status: 400 }),
    });
    const { publicError } = await import('../node/errors.js');
    expect(publicError(await c.quote(message, origin).catch((e: unknown) => e)).code).toBe(
      'operation_failed',
    );
  },
);
