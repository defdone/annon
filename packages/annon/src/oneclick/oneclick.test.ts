import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { purchase as base } from '../../test/fixtures.js';
import { buildPurchaseMessage } from '../settle-near/purchase.js';
import { NEAR_USDC } from '../settle-near/terms.js';
import { OneClick } from './oneclick.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const purchase = {
  ...base,
  route: 'near-usdc' as const,
  network: 'near:mainnet',
  asset: NEAR_USDC,
  expires_at: '1800003600',
};
const message = buildPurchaseMessage(purchase);
const origin = {
  asset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  chain: 'evm' as const,
  refundTo: base.refund.id,
};
describe('1Click with synthetic response fixtures', () => {
  it('quotes EXACT_OUTPUT to the contract with a byte-identical message', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(
        {
          ...fixture('quote'),
          quoteRequest: { ...fixture('quote').quoteRequest, ...JSON.parse(String(_init?.body)) },
          quote: { ...fixture('quote').quote, deadline: JSON.parse(String(_init?.body)).deadline },
        },
        { status: 201 },
      ),
    );
    const c = new OneClick({ fetch: fetcher as typeof fetch, now: () => 1800000000 });
    const result = await c.quote(message, origin);
    const sent = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(sent).toMatchObject({
      swapType: 'EXACT_OUTPUT',
      amount: '200000',
      recipient: purchase.contract,
      recipientType: 'DESTINATION_CHAIN',
      customRecipientMsg: message,
      destinationAsset: `nep141:${NEAR_USDC}`,
      refundType: 'ORIGIN_CHAIN',
      deadline: '2027-01-15T09:00:00.000Z',
    });
    expect(result.deposit.amount).toBe('202064');
    expect(result.deposit.address).toBe(fixture('quote').quote.depositAddress);
    expect(JSON.parse(result.deposit.qrData).address).toBe(result.deposit.address);
  });
  it('uses INTENTS for a NEAR origin/refund; refuses malformed messages without HTTP', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({
        ...fixture('quote'),
        quoteRequest: { ...fixture('quote').quoteRequest, ...JSON.parse(String(_init?.body)) },
        quote: { ...fixture('quote').quote, deadline: JSON.parse(String(_init?.body)).deadline },
      }),
    );
    const c = new OneClick({ fetch: fetcher as typeof fetch, now: () => 1800000000 });
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
    expect(done.swapDetails.refundedAmount).toBe('0'); // Real refused delivery: funds stayed in the quote's Intents account.
  });
  it('fails closed on HTTP, amount, expiry and status errors and supports cancellation', async () => {
    const c = new OneClick({
      fetch: vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ error: 'bad' }, { status: 400 }),
      ) as typeof fetch,
      now: () => 1800000000,
    });
    await expect(c.quote(message, origin)).rejects.toThrow();
    await expect(
      c.quote(buildPurchaseMessage({ ...purchase, expires_at: '1799999999' }), origin),
    ).rejects.toThrow(/expired/);
    const malformed = new OneClick({
      fetch: vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ quote: { ...fixture('quote').quote, amountOut: '1' } }),
      ) as typeof fetch,
      now: () => 1800000000,
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
  ])('refuses a changed quoteRequest echo: %s', async (field) => {
    const c = new OneClick({
      now: () => 1800000000,
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
  it('refuses a quote deadline outside the purchase expiry', async () => {
    const c = new OneClick({
      now: () => 1800000000,
      fetch: (async (_u, init) =>
        Response.json({
          ...fixture('quote'),
          quoteRequest: JSON.parse(String(init?.body)),
          quote: { ...fixture('quote').quote, deadline: '2030-01-01T00:00:00Z' },
        })) as typeof fetch,
    });
    await expect(c.quote(message, origin)).rejects.toThrow(/deadline/);
  });

  it('retains the complete recorded echo and rejects the recorded service extension beyond its request deadline', async () => {
    const full = fixture('quote');
    expect(full.quoteRequest.customRecipientMsg).toContain('"annon":1');
    expect(Date.parse(full.quote.deadline)).toBeGreaterThan(Date.parse(full.quoteRequest.deadline));
    const c = new OneClick({
      now: () => 1800000000,
      fetch: (async () => Response.json(full)) as typeof fetch,
    });
    await expect(c.quote(message, origin)).rejects.toThrow(/echo/);
  });
});
