import { afterEach, expect, it, vi } from 'vitest';
import { block, dryRun } from './base.js';

const url = 'https://base.example';
afterEach(() => vi.unstubAllGlobals());

it.each(['matching', 'missing', 'foreign', 'invalid JSON'])(
  'names HTTP 429 with %s id or body',
  async (reply) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const id = JSON.parse(init.body).id;
        return new Response(
          reply === 'invalid JSON'
            ? 'busy'
            : JSON.stringify({
                jsonrpc: '2.0',
                ...(reply === 'missing' ? {} : { id: reply === 'matching' ? id : 1 }),
                error: { code: -32011, message: 'request limit reached' },
              }),
          { status: 429 },
        );
      }),
    );
    await expect(block(url, 'safe')).rejects.toMatchObject({
      code: 'base_rpc_rate_limited',
      message: 'Base RPC rate limited (429)',
    });
  },
);

it.each([500, 502, 503])('names HTTP %i without a structured RPC reply', async (status) => {
  for (const body of ['unavailable', '{}']) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status })),
    );
    await expect(block(url, 'safe')).rejects.toMatchObject({
      code: 'transport',
      message: `Base RPC HTTP ${status}`,
    });
  }
});

it.each([200, 400, 500])('preserves structured RPC errors on HTTP %i', async (status) => {
  const error = { code: -32000, message: 'execution reverted: test refusal' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) =>
      Response.json(
        {
          jsonrpc: '2.0',
          id: JSON.parse(init.body).id,
          error,
        },
        { status },
      ),
    ),
  );
  await expect(block(url, 'safe')).rejects.toMatchObject({
    code: 'transport',
    message: `Base RPC error: ${JSON.stringify(error)}`,
  });
  await expect(
    dryRun(
      url,
      `0x${'01'.repeat(20)}`,
      {
        from: `0x${'02'.repeat(20)}`,
        to: `0x${'03'.repeat(20)}`,
        value: 1n,
        validAfter: 0n,
        validBefore: 1n,
        nonce: `0x${'04'.repeat(32)}`,
      },
      `0x${'05'.repeat(65)}`,
    ),
  ).rejects.toMatchObject({ code: 'transport' });
});

it('uses a structured execution failure code independently of RPC wording', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) =>
      Response.json({
        id: JSON.parse(String(init?.body)).id,
        error: { code: 3, message: 'RPC_CALL_FAILED' },
      }),
    ),
  );
  await expect(
    dryRun(
      url,
      `0x${'01'.repeat(20)}`,
      {
        from: `0x${'02'.repeat(20)}`,
        to: `0x${'03'.repeat(20)}`,
        value: 1n,
        validAfter: 0n,
        validBefore: 1n,
        nonce: `0x${'04'.repeat(32)}`,
      },
      `0x${'05'.repeat(65)}`,
    ),
  ).rejects.toMatchObject({ code: 'payment_rejected' });
});
