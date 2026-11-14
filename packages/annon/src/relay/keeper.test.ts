import { afterEach, expect, it, vi } from 'vitest';
import { purchase, terms } from '../../test/fixtures.js';
import { getDelivery, listOpenDeliveries, materializeRefund, openDeliveryCount } from './keeper.js';

afterEach(() => vi.unstubAllGlobals());
it('uses the sandbox materialization call shape, gas and payable storage', async () => {
  const call = vi.fn(async (_call: import('../wallet/wallet.js').NearCall) => null);
  const wallet = { call };
  const args = {
    leaf: { delivery_id: 0, refund: purchase.refund, amount: '200000' },
    index: 0,
    proof: Array(32).fill(terms.cipher_hash),
  };
  await materializeRefund(wallet, terms.contract, args, 10n ** 22n);
  expect(call.mock.calls.map((c) => c[0])).toEqual([
    {
      receiverId: terms.contract,
      method: 'materialize_refund',
      args,
      gas: 100000000000000n,
      deposit: 10n ** 22n,
    },
  ]);
});

it('pins all open-index views to the same block', async () => {
  const fetch = vi.fn(async (_url, init) => {
    const q = JSON.parse(init.body);
    const v = q.params.method_name === 'open_delivery_count' ? 0 : [];
    expect(q.params.block_id).toBe(12345);
    expect(q.params.finality).toBeUndefined();
    return {
      json: async () => ({ id: q.id, result: { result: [...Buffer.from(JSON.stringify(v))] } }),
    };
  });
  vi.stubGlobal('fetch', fetch);
  expect(await openDeliveryCount('https://rpc', terms.contract, 12345)).toBe(0);
  expect(await listOpenDeliveries('https://rpc', terms.contract, 0, 50, 12345)).toEqual([]);
  await expect(listOpenDeliveries('https://rpc', terms.contract, 0, 51)).rejects.toThrow();
});

it('materializes with prepaid storage and zero attached deposit for function-call keys', async () => {
  const call = vi.fn(async (_call: import('../wallet/wallet.js').NearCall) => null);
  const args = {
    leaf: { delivery_id: 3, refund: purchase.refund, amount: '7' },
    index: 0,
    proof: Array(32).fill(terms.cipher_hash),
  };
  await materializeRefund({ call }, terms.contract, args, 0n);
  expect(call).toHaveBeenCalledWith({
    receiverId: terms.contract,
    method: 'materialize_refund',
    args,
    gas: 100000000000000n,
    deposit: 0n,
  });
  expect(() => materializeRefund({ call }, terms.contract, args, -1n)).toThrow();
});
it('reads delivery at finality', async () => {
  const step = { state: 0, attempt: 0 };
  const d = {
    id: 0,
    amount: '200000',
    sender: 'buyer.near',
    purchase: terms.file_id,
    reason: 0,
    fund: step,
    funded: '0',
    slots: [{ to: purchase.refund, amount: '200000', step }],
  };
  const fetch = vi.fn(async (_url, init) => {
    const q = JSON.parse(init.body);
    const v = d;
    return {
      json: async () => ({ id: q.id, result: { result: [...Buffer.from(JSON.stringify(v))] } }),
    };
  });
  vi.stubGlobal('fetch', fetch);
  expect(await getDelivery('https://rpc', terms.contract, 0)).toEqual(d);
  expect(fetch.mock.calls.every((c) => JSON.parse(c[1].body).params.finality === 'final')).toBe(
    true,
  );
});
