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
    expect(r.next).toBe(1);
    expect(r.sent.every((s) => s.result.txHash)).toBe(true);
  });

  it('does not send the same call again while it is held', async () => {
    near([delivery(0, 0, [0])]);
    await keep(o);
    await keep(o);
    expect(calls()).toEqual([['fund_delivery', { delivery_id: 0 }]]);
  });

  it('pages past 50 deliveries and starts after settled ones', async () => {
    near(Array.from({ length: 120 }, (_, i) => delivery(i, i === 110 ? 0 : 2, [2])));
    const r = await keep(o, 0);
    expect(calls()).toEqual([['fund_delivery', { delivery_id: 110 }]]);
    expect(r.next).toBe(110);
    near([]);
    expect((await keep(o, 7)).next).toBe(7);
    // All settled: the next pass starts right after the last one seen, not at the page's end.
    near(Array.from({ length: 120 }, (_, i) => delivery(i, 2, [2])));
    expect((await keep(o, 0)).next).toBe(120);
  });
});
