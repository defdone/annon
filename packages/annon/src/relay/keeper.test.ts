import { afterEach, expect, it, vi } from 'vitest';
import { purchase, terms } from '../../test/fixtures.js';
import {
  fundDelivery,
  getDelivery,
  listDeliveries,
  materializeRefund,
  paySlot,
  refundRoot,
} from './keeper.js';

afterEach(() => vi.unstubAllGlobals());
it('uses the sandbox keeper call shapes, gas and payable materialization', async () => {
  const call = vi.fn(async (_call: import('../wallet/wallet.js').NearCall) => null);
  const wallet = { call };
  await fundDelivery(wallet, terms.contract, 0);
  await paySlot(wallet, terms.contract, 0, 1);
  const args = {
    leaf: { delivery_id: 0, refund: purchase.refund, amount: '200000' },
    index: 0,
    proof: Array(32).fill(terms.cipher_hash),
  };
  await materializeRefund(wallet, terms.contract, args, 10n ** 22n);
  expect(call.mock.calls.map((c) => c[0])).toEqual([
    {
      receiverId: terms.contract,
      method: 'fund_delivery',
      args: { delivery_id: 0 },
      gas: 150000000000000n,
    },
    {
      receiverId: terms.contract,
      method: 'pay_slot',
      args: { delivery_id: 0, slot: 1 },
      gas: 80000000000000n,
    },
    {
      receiverId: terms.contract,
      method: 'materialize_refund',
      args,
      gas: 100000000000000n,
      deposit: 10n ** 22n,
    },
  ]);
});
it('reads delivery, pages (max 50), and refund root at finality', async () => {
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
    const v =
      q.params.method_name === 'get_delivery'
        ? d
        : q.params.method_name === 'list_deliveries'
          ? [d]
          : { root: terms.cipher_hash, count: 1 };
    return {
      json: async () => ({ id: q.id, result: { result: [...Buffer.from(JSON.stringify(v))] } }),
    };
  });
  vi.stubGlobal('fetch', fetch);
  expect(await getDelivery('https://rpc', terms.contract, 0)).toEqual(d);
  expect(await listDeliveries('https://rpc', terms.contract, 0, 50)).toEqual([d]);
  expect(await refundRoot('https://rpc', terms.contract)).toEqual({
    root: terms.cipher_hash,
    count: 1,
  });
  expect(fetch.mock.calls.every((c) => JSON.parse(c[1].body).params.finality === 'final')).toBe(
    true,
  );
  await expect(listDeliveries('https://rpc', terms.contract, 0, 51)).rejects.toThrow();
});
