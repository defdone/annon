import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { terms as initial, must, purchase } from '../../test/fixtures.js';
import { registerText } from '../near/texts.js';
import { canonicalRequest, checkRelay, contractArgs, relay, resetRelayState } from './relay.js';

const wallet = privateKeyToAccount(`0x${'44'.repeat(32)}`);
const terms = { ...initial, seller: { kind: 'evm', id: wallet.address.toLowerCase() } as const };
const opts = {
  nearRpc: 'https://near.rpc',
  baseRpc: 'https://base.rpc',
  contractId: terms.contract,
  usdc: purchase.asset,
  policy: { minPrice: 10000n, maxDeadlineSeconds: 600 },
  now: 1800000000,
};
const sender = { accountId: 'relayer.near', key: 'ed25519:test-double' };
const sign = async () => {
  const args = { terms, seller_key: purchase.buyer_key, deadline: 1800000600 };
  return {
    method: 'register' as const,
    args,
    auth: {
      kind: 'evm' as const,
      sig: await wallet.signMessage({ message: registerText(terms.contract, args) }),
    },
  };
};
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
beforeEach(() => {
  resetRelayState();
  created.mockReset();
  created.mockResolvedValue({ transaction: { encode: () => new Uint8Array([1, 2, 3]) } });
});
afterEach(() => vi.unstubAllGlobals());
const rpc = (read: (method: string, args: Record<string, unknown>) => unknown) =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      const q = JSON.parse(String(init?.body));
      const result =
        q.method === 'query'
          ? {
              result: [
                ...Buffer.from(
                  JSON.stringify(
                    read(
                      q.params.method_name,
                      JSON.parse(Buffer.from(q.params.args_base64, 'base64').toString()),
                    ),
                  ),
                ),
              ],
            }
          : { final_execution_status: 'INCLUDED' };
      return { json: async () => ({ id: q.id, result }) };
    }),
  );
describe('relay purchase arguments and authorization', () => {
  it('takes the source contract JSON and refuses old entry points/formats', async () => {
    const r = await sign();
    expect(canonicalRequest(r)).toEqual(r);
    expect(contractArgs(r)).toEqual({ args: r.args, auth: r.auth });
    for (const bad of [
      { ...r, method: 'register_v2' },
      { ...r, sig: r.auth.sig },
      { method: 'register', args: { file_id: terms.file_id }, sig: r.auth.sig },
      { ...r, args: { ...r.args, extra: 1 } },
      {
        method: 'reopen',
        args: {
          file_id: terms.file_id,
          wallet: wallet.address,
          key: purchase.buyer_key,
          deadline: 1800000600,
        },
        auth: r.auth,
      },
    ])
      expect(() => canonicalRequest(bad)).toThrow();
  });
  it('checks authoritative registration signatures, price policy and deadline', async () => {
    rpc(() => null);
    const r = await sign();
    await checkRelay(r, opts);
    await expect(
      checkRelay({ ...r, auth: { ...r.auth, sig: `0x${'00'.repeat(65)}` } }, opts),
    ).rejects.toMatchObject({ code: 'bad_signature' });
    await expect(checkRelay(r, { ...opts, now: 1800000601 })).rejects.toMatchObject({
      code: 'bad_deadline',
    });
    await expect(
      checkRelay(r, { ...opts, policy: { ...opts.policy, minPrice: 200001n } }),
    ).rejects.toMatchObject({ code: 'not_sponsored' });
  });
  it('serializes source args to transactions and suppresses duplicate writes', async () => {
    rpc((method) => (method === 'storage_balance_of' ? '100000000000000000000000' : null));
    const r = await sign();
    const o = { ...opts, sender };
    const result = await relay(r, o);
    expect(result.txHash).toBeTruthy();
    expect(must(created.mock.calls[0])[0].actions[0].functionCall.methodName).toBe('register');
    const sent = must(created.mock.calls[0])[0].actions[0].functionCall.args;
    expect(JSON.parse(new TextDecoder().decode(sent))).toEqual(contractArgs(r));
    await expect(relay(r, o)).rejects.toMatchObject({ code: 'duplicate' });
  });
  it('uses flat claim_key/unlock args and validates grants', () => {
    const r = canonicalRequest({
      method: 'claim_key',
      args: { purchase_id: terms.file_id, grant: 0 },
    });
    expect(contractArgs(r)).toEqual(r.args);
    for (const grant of [-1, 0.5, 2 ** 32])
      expect(() =>
        canonicalRequest({ method: 'claim_key', args: { purchase_id: terms.file_id, grant } }),
      ).toThrow();
  });
  it('keeps failed checks out of admission holds and preserves storage/gas budgets', async () => {
    rpc((method) => (method === 'storage_balance_of' ? '0' : null));
    const r = await sign();
    await expect(relay(r, { ...opts, sender })).rejects.toMatchObject({ code: 'unavailable' });
    expect(created).not.toHaveBeenCalled();
    rpc((method) => (method === 'storage_balance_of' ? '100000000000000000000000' : null));
    expect((await relay(r, { ...opts, sender })).txHash).toBeTruthy();
  });
  it('returns uncertainty after lost RPC answers, so a caller never assumes a transaction did not land', async () => {
    const r = await sign();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const q = JSON.parse(String(init?.body));
        if (q.method === 'query')
          return {
            json: async () => ({
              id: q.id,
              result: {
                result: [
                  ...Buffer.from(
                    JSON.stringify(
                      q.params.method_name === 'storage_balance_of'
                        ? '100000000000000000000000'
                        : null,
                    ),
                  ),
                ],
              },
            }),
          };
        throw new Error('lost response');
      }),
    );
    const result = await relay(r, { ...opts, sender });
    expect(result.uncertain).toBe(true);
    expect(result.txHash).toBeTruthy();
    expect(created).toHaveBeenCalledTimes(1);
  });
});
