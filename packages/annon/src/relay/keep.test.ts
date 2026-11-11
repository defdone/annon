import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keep, resetRelayState } from './relay.js';

const created = vi.hoisted(() => vi.fn());
vi.mock('near-api-js', async (importOriginal) => {
  const original = await importOriginal<typeof import('near-api-js')>();
  return {
    ...original,
    Account: class {
      createSignedTransaction = created;
    },
    encodeTransaction: () => new Uint8Array([1, 2, 3]),
  };
});

const o = {
  nearRpc: 'https://near.rpc',
  contractId: 'annon.near',
  sender: { accountId: 'relayer.near', key: 'ed25519:test-double' },
};
const step = (state: 0 | 1 | 2) => ({ state, attempt: state === 0 ? 0 : 1 });
const slot = (state: 0 | 1 | 2) => ({
  to: { kind: 'near', id: 'seller.near' },
  amount: '9500',
  step: step(state),
});
const delivery = (id: number, fund: 0 | 1 | 2, slots: (0 | 1 | 2)[]) => ({
  id,
  amount: '10000',
  sender: 'intents.near',
  purchase: null,
  reason: 0,
  fund: step(fund),
  funded: fund === 2 ? '10000' : '0',
  slots: slots.map(slot),
});

/** NEAR as seen by the keeper: `list_deliveries` pages and accepted transactions. */
function near(all: ReturnType<typeof delivery>[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      const q = JSON.parse(String(init?.body));
      if (q.method !== 'query')
        return { json: async () => ({ id: q.id, result: { final_execution_status: 'INCLUDED' } }) };
      if (q.params.method_name === 'delivery_count') {
        const count = all.length ? Math.max(...all.map((d) => d.id)) + 1 : 0;
        return {
          json: async () => ({ id: q.id, result: { result: [...Buffer.from(String(count))] } }),
        };
      }
      const { from, limit } = JSON.parse(Buffer.from(q.params.args_base64, 'base64').toString());
      const page = all.filter((d) => d.id >= from && d.id < from + limit);
      return {
        json: async () => ({
          id: q.id,
          result: { result: [...Buffer.from(JSON.stringify(page))] },
        }),
      };
    }),
  );
}

const calls = () =>
  created.mock.calls.map(([tx]) => {
    const fc = tx.actions[0].functionCall;
    return [fc.methodName, JSON.parse(Buffer.from(fc.args).toString())];
  });

beforeEach(() => {
  resetRelayState();
  created.mockReset();
  created.mockResolvedValue({ transaction: { encode: () => new Uint8Array([1, 2, 3]) } });
});

describe('keep', () => {
  it('funds pending deliveries and pays pending slots, never steps in flight', async () => {
    near([
      delivery(0, 2, [2, 2]), // done
      delivery(1, 0, [0, 0]), // to fund
      delivery(2, 1, [0, 0]), // deposit in flight: wait
      delivery(3, 2, [0, 1, 2]), // pay slot 0 only
    ]);
    const r = await keep(o);
    expect(calls()).toEqual([
      ['fund_delivery', { delivery_id: 1 }],
      ['pay_slot', { delivery_id: 3, slot: 0 }],
    ]);
    expect(r.sent.every((s) => s.result.txHash)).toBe(true);
    expect(created.mock.calls.map(([tx]) => tx.actions[0].functionCall.gas)).toEqual([
      150000000000000n,
      80000000000000n,
    ]);
  });

  it('does not send the same call again while it is held', async () => {
    near([delivery(0, 0, [0])]);
    await keep(o);
    await keep(o);
    expect(calls()).toEqual([['fund_delivery', { delivery_id: 0 }]]);
  });

  it('scans every id, across pages and gaps, from the start each pass', async () => {
    // 0..120 settled, a run of 60 refund leaves with no record (120..179), one pending at 180.
    const all = [
      ...Array.from({ length: 120 }, (_, i) => delivery(i, 2, [2])),
      delivery(180, 0, [0]),
    ];
    near(all);
    await keep(o);
    expect(calls()).toEqual([['fund_delivery', { delivery_id: 180 }]]);
    // A leaf materialized later at an old id (5) is still found.
    created.mockClear();
    near([...all.filter((d) => d.id !== 5), delivery(5, 0, [0])]);
    await keep(o);
    expect(calls()).toEqual([['fund_delivery', { delivery_id: 5 }]]);
  });
  it('isolates a malformed delivery and a signing failure, then retries pending slots after the normal hold', async () => {
    near([{ ...delivery(0, 0, [0]), amount: 'bad' }, delivery(1, 0, [0]), delivery(2, 2, [0])]);
    created.mockRejectedValueOnce(new Error('unavailable'));
    const first = await keep(o);
    expect(first.sent).toHaveLength(1);
    expect(first.errors).toHaveLength(2);
    const time = Date.now();
    vi.setSystemTime(time + 60001);
    await keep(o);
    const n = created.mock.calls.length;
    vi.setSystemTime(time + 120002);
    await keep(o);
    expect(created).toHaveBeenCalledTimes(n + 2);
    vi.useRealTimers();
  });

  it('bounds each scan and revisits old ids across passes', async () => {
    near([delivery(0, 0, [0]), delivery(100, 0, [0])]);
    await keep({ ...o, maxPages: 1 });
    expect(calls()).toEqual([['fund_delivery', { delivery_id: 0 }]]);
    await keep({ ...o, maxPages: 1 });
    expect(calls()).toHaveLength(1);
    await keep({ ...o, maxPages: 1 });
    expect(calls()[1]).toEqual(['fund_delivery', { delivery_id: 100 }]);
  });
  it('continues with the next page when one view fails', async () => {
    near([delivery(100, 0, [0])]);
    const original = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        const q = JSON.parse(String(init?.body));
        if (
          q.params?.method_name === 'list_deliveries' &&
          JSON.parse(Buffer.from(q.params.args_base64, 'base64').toString()).from === 0
        )
          throw new Error('failed page');
        return original(url, init);
      }),
    );
    const result = await keep(o);
    expect(result.errors).toHaveLength(1);
    expect(result.sent).toHaveLength(1);
  });
});

it.each(['success', 'outage', 'finished'] as const)(
  'resets keeper backoff after %s',
  async (kind) => {
    const time = Date.now();
    try {
      near([delivery(0, 0, [0])]);
      await keep(o);
      vi.setSystemTime(time + 60001);
      if (kind === 'outage') created.mockRejectedValueOnce(new Error('RPC down'));
      if (kind === 'finished') near([delivery(0, 2, [2])]);
      await keep(o);
      near([delivery(0, 0, [0])]);
      vi.setSystemTime(time + 120002);
      const n = created.mock.calls.length;
      await keep(o);
      expect(created).toHaveBeenCalledTimes(n + 1);
    } finally {
      vi.useRealTimers();
    }
  },
);
it('does not defer the 10001st pending step behind a daily retry-map cap', async () => {
  near(Array.from({ length: 10001 }, (_, i) => delivery(i, 0, [0])));
  const r = await keep({ ...o, maxPages: 201 });
  expect(r.errors).toEqual([]);
  expect(r.sent).toHaveLength(10001);
}, 30000);
