import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { base58 } from '@scure/base';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { terms as initial, must, purchase } from '../../test/fixtures.js';
import { txOutcome } from '../near/rpc.js';
import { registerText, reopenSellerText, stopSalesText } from '../near/texts.js';
import { termsHash } from '../settle-near/terms.js';
import {
  canonicalRequest,
  checkRelay,
  contractArgs,
  relay,
  relayStatus,
  resetRelayState,
} from './relay.js';

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
    expect(await relay(r, o)).toEqual(result);
    expect(created).toHaveBeenCalledTimes(1);
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

it('returns a retryable pending state for a duplicate still waiting for its tx hash', async () => {
  rpc((method) => (method === 'storage_balance_of' ? '100000000000000000000000' : null));
  const r = await sign();
  let release!: (v: unknown) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  created.mockImplementationOnce(() => {
    started();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const first = relay(r, { ...opts, sender });
  await entered;
  try {
    expect(await relayStatus(r, opts)).toBe('pending');
    expect(await relayStatus(r, { ...opts, nearRpc: 'https://other.rpc' })).toBeNull();
    const reads = vi.mocked(fetch).mock.calls.length;
    await expect(relay(r, { ...opts, sender })).rejects.toMatchObject({ code: 'in_flight' });
    expect(vi.mocked(fetch).mock.calls).toHaveLength(reads);
  } finally {
    release({ transaction: { encode: () => new Uint8Array([1, 2, 3]) } });
    await first;
  }
  expect(created).toHaveBeenCalledTimes(1);
});

it('returns the signed hash while the original POST is still awaiting send confirmation', async () => {
  rpc((method) => (method === 'storage_balance_of' ? '100000000000000000000000' : null));
  const original = globalThis.fetch;
  let release!: (v: Response) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      const q = JSON.parse(String(init?.body));
      if (q.method === 'send_tx') {
        started();
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return original(url, init);
    }),
  );
  const r = await sign();
  const first = relay(r, { ...opts, sender });
  await entered;
  try {
    const retry = await relay(r, { ...opts, sender });
    expect(await relayStatus(r, opts)).toEqual(retry);
    expect(retry).toMatchObject({ txHash: expect.any(String), uncertain: true });
    expect(created).toHaveBeenCalledTimes(1);
  } finally {
    release(Response.json({ result: { final_execution_status: 'INCLUDED' } }));
    await first;
  }
});

it('refuses a dust Base registration even when its NEAR price meets the floor', async () => {
  rpc(() => null);
  const r = await sign();
  r.args.terms = { ...r.args.terms, base: { ...must(r.args.terms.base), price: '1' } };
  r.auth.sig = await wallet.signMessage({ message: registerText(terms.contract, r.args) });
  await expect(checkRelay(r, opts)).rejects.toMatchObject({ code: 'not_sponsored' });
});

it.each(['NotEnoughBalance', 'NotEnoughAllowance', 'Expired', 'InvalidSignature'])(
  'releases holds and quota after a definite %s refusal',
  async (variant) => {
    rpc((method) => (method === 'storage_balance_of' ? '100000000000000000000000' : null));
    const original = globalThis.fetch;
    let reject = true;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        const q = JSON.parse(String(init?.body));
        if (q.method === 'send_tx' && reject)
          return Response.json({
            id: q.id,
            error: { data: { TxExecutionError: { InvalidTxError: { [variant]: {} } } } },
          });
        return original(url, init);
      }),
    );
    const r = await sign();
    const o = { ...opts, sender, policy: { ...opts.policy, registrationsPerSeller: 1 } };
    await expect(relay(r, o)).rejects.toMatchObject({ code: 'unavailable' });
    expect(await relayStatus(r, o)).toBeNull();
    reject = false;
    expect((await relay(r, o)).uncertain).toBeUndefined();
    expect(created).toHaveBeenCalledTimes(2);
  },
);
it('checks chain state outside the signing queue', async () => {
  rpc((method) => (method === 'storage_balance_of' ? '100000000000000000000000' : null));
  let entered!: () => void;
  let release!: (v: unknown) => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  created.mockImplementationOnce(() => {
    entered();
    return new Promise((r) => {
      release = r;
    });
  });
  const r = await sign();
  const first = relay(r, { ...opts, sender });
  await started;
  const other = await sign();
  other.args.terms = { ...other.args.terms, file_id: `0x${'aa'.repeat(32)}` };
  other.auth.sig = await wallet.signMessage({ message: registerText(terms.contract, other.args) });
  const read = vi.fn((method) =>
    method === 'storage_balance_of' ? '100000000000000000000000' : null,
  );
  rpc(read);
  const second = relay(other, { ...opts, sender });
  try {
    await vi.waitFor(() => expect(read).toHaveBeenCalledWith('get_file', expect.any(Object)));
    expect(created).toHaveBeenCalledTimes(1);
  } finally {
    release({ transaction: { encode: () => new Uint8Array([1, 2, 3]) } });
    await Promise.all([first, second]);
  }
});
it('allows separate grant quotas and never charges claim_key prepaid storage', async () => {
  rpc((method, args) =>
    method === 'get_purchase'
      ? { ...purchase, purchase_id: terms.file_id, grants: 2, accepted_at: 1, delivery: null }
      : method === 'get_file'
        ? {
            terms,
            terms_hash: termsHash(terms),
            header_hash: null,
            sales_stopped_at: null,
            taken_down: null,
          }
        : method === 'get_grant'
          ? { purchase_id: terms.file_id, grant: args.grant, buyer_key: purchase.buyer_key }
          : method === 'storage_balance_of'
            ? '0'
            : null,
  );
  const r = { method: 'claim_key', args: { purchase_id: terms.file_id, grant: 0 } };
  const o = { ...opts, sender, policy: { ...opts.policy, claimsPerPurchase: 1 } };
  expect((await relay(r, o)).txHash).toBeTruthy();
  expect(await relay(r, o)).toEqual(await relayStatus(r, o));
  expect(created).toHaveBeenCalledTimes(1);
  expect((await relay({ ...r, args: { ...r.args, grant: 1 } }, o)).txHash).toBeTruthy();
  expect(created).toHaveBeenCalledTimes(2);
  expect(
    vi
      .mocked(fetch)
      .mock.calls.every(
        ([, init]) => JSON.parse(String(init?.body)).params?.method_name !== 'storage_balance_of',
      ),
  ).toBe(true);
});

it.each(['stop_sales', 'reopen_seller'] as const)(
  'does not hold %s before seller authorization verifies',
  async (method) => {
    const args = {
      file_id: terms.file_id,
      key: method === 'stop_sales' ? null : purchase.buyer_key,
      deadline: 1800000600,
    };
    const text =
      method === 'stop_sales'
        ? stopSalesText(terms.contract, args, terms.seller)
        : reopenSellerText(terms.contract, args, terms.seller);
    const valid = {
      method,
      args,
      auth: { kind: 'evm' as const, sig: await wallet.signMessage({ message: text }) },
    };
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const q = JSON.parse(String(init?.body));
        entered();
        await gate;
        return Response.json({
          id: q.id,
          result: {
            result: [
              ...Buffer.from(
                JSON.stringify({
                  terms,
                  terms_hash: termsHash(terms),
                  header_hash: null,
                  sales_stopped_at: null,
                  taken_down: null,
                }),
              ),
            ],
          },
        });
      }),
    );
    const forged = relay(
      { ...valid, auth: { ...valid.auth, sig: `0x${'00'.repeat(65)}` } },
      { ...opts, sender },
    );
    const refusal = expect(forged).rejects.toMatchObject({ code: 'bad_signature' });
    await ready;
    try {
      expect(await relayStatus(valid, opts)).toBeNull();
    } finally {
      release();
      await refusal;
    }
    expect(created).not.toHaveBeenCalled();
  },
);

it('retains a claim hash for the entire quota window without charging repeats', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100000);
  rpc((method, args) =>
    method === 'get_purchase'
      ? { ...purchase, purchase_id: terms.file_id, grants: 4, accepted_at: 1, delivery: null }
      : method === 'get_file'
        ? {
            terms,
            terms_hash: termsHash(terms),
            header_hash: null,
            sales_stopped_at: null,
            taken_down: null,
          }
        : { purchase_id: terms.file_id, grant: args.grant, buyer_key: purchase.buyer_key },
  );
  const req = { method: 'claim_key', args: { purchase_id: terms.file_id, grant: 0 } };
  const o = { ...opts, sender, policy: { ...opts.policy, claimsPerPurchase: 1 } };
  try {
    const first = await relay(req, o);
    clock.mockReturnValue(100000 + 16 * 60000);
    expect(await relayStatus(req, o)).toEqual(first);
    expect(await relay(req, o)).toEqual(first);
    expect(created).toHaveBeenCalledTimes(1);
    const other = await relay({ ...req, args: { ...req.args, grant: 1 } }, o);
    expect(other.txHash).toBeTruthy();
    expect(await relay(req, o)).toEqual(first);
    expect(created).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(100000 + 86400000);
    await relay(req, o);
    expect(created).toHaveBeenCalledTimes(3);
  } finally {
    clock.mockRestore();
  }
});
it('keeps a later definite rejection uncertain after an earlier lost send', async () => {
  rpc((method) => (method === 'storage_balance_of' ? '100000000000000000000000' : null));
  const original = fetch;
  let sends = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      const q = JSON.parse(String(init?.body));
      if (q.method === 'send_tx') {
        if (++sends === 1) throw new Error('lost reply');
        return Response.json({
          id: q.id,
          error: { data: { TxExecutionError: { InvalidTxError: 'Expired' } } },
        });
      }
      if (q.method === 'tx')
        return Response.json({ id: q.id, error: { cause: { name: 'UNKNOWN_TRANSACTION' } } });
      return original(url, init);
    }),
  );
  const r = await sign();
  const result = await relay(r, { ...opts, sender });
  expect(result).toMatchObject({ uncertain: true });
  expect(result.rejected).toBeUndefined();
  expect(await relay(r, { ...opts, sender })).toEqual(result);
  expect(created).toHaveBeenCalledTimes(1);
});
it('bounds preflight reads before chain lookup and does not read for a held operation', async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  rpc((method) => (method === 'storage_balance_of' ? '100000000000000000000000' : null));
  const original = fetch;
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      const q = JSON.parse(String(init?.body));
      if (q.params?.method_name === 'get_file') {
        reads++;
        entered();
        await gate;
      }
      return original(url, init);
    }),
  );
  const r = await sign();
  const o = { ...opts, sender, policy: { ...opts.policy, maxChecking: 1 } };
  const first = relay(r, o);
  await started;
  try {
    await expect(relay(r, o)).rejects.toMatchObject({ code: 'unavailable' });
    expect(reads).toBe(1);
  } finally {
    release();
    await first;
  }
});

// Deterministic CKD wire fixture built from public curve points.
const claimAnswer = {
  big_y: `bls12381g1:${base58.encode(bls.G1.Point.BASE.toBytes(true))}`,
  big_c: `bls12381g1:${base58.encode(bls.G1.Point.BASE.multiply(2n).toBytes(true))}`,
};
const successValue = (value: unknown) => ({
  SuccessValue: Buffer.from(JSON.stringify(value)).toString('base64'),
});
function claimViews() {
  rpc((method, args) =>
    method === 'get_purchase'
      ? { ...purchase, purchase_id: terms.file_id, grants: 4, accepted_at: 1, delivery: null }
      : method === 'get_file'
        ? {
            terms,
            terms_hash: termsHash(terms),
            header_hash: null,
            sales_stopped_at: null,
            taken_down: null,
          }
        : { purchase_id: terms.file_id, grant: args.grant, buyer_key: purchase.buyer_key },
  );
}
function claimOutcome(hash: string, args: object, status: unknown, final = true) {
  return {
    final_execution_status: final ? 'FINAL' : 'INCLUDED',
    transaction: {
      hash,
      signer_id: sender.accountId,
      receiver_id: terms.contract,
      actions: [
        {
          FunctionCall: {
            method_name: 'claim_key',
            args: Buffer.from(JSON.stringify(args)).toString('base64'),
          },
        },
      ],
    },
    status,
    receipts_outcome: [],
  };
}
it('canonicalizes omitted grant so a repeated explicit grant has an SDK-verifiable cached outcome', async () => {
  claimViews();
  const o = { ...opts, sender };
  const first = await relay({ method: 'claim_key', args: { purchase_id: terms.file_id } }, o);
  const args = { purchase_id: terms.file_id, grant: 0 };
  expect(await relay({ method: 'claim_key', args }, o)).toEqual(first);
  expect(created).toHaveBeenCalledTimes(1);
  const wire = JSON.parse(
    Buffer.from(must(created.mock.calls[0])[0].actions[0].functionCall.args).toString(),
  );
  const answer = claimAnswer;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init) => {
      const q = JSON.parse(String(init?.body));
      expect(q.method).toBe('EXPERIMENTAL_tx_status');
      return Response.json({
        id: q.id,
        result: claimOutcome(first.txHash, wire, {
          SuccessValue: Buffer.from(JSON.stringify(answer)).toString('base64'),
        }),
      });
    }),
  );
  await expect(
    txOutcome(opts.nearRpc, first.txHash, sender.accountId, terms.contract, 'FINAL', {
      method: 'claim_key',
      args,
    }),
  ).resolves.toMatchObject({ state: 'released', answer });
});
it.each([
  'failed',
  'mpc-error',
  'empty',
  'null',
  'final-started',
  'unknown',
  'pending',
  'succeeded',
  'transport',
  'nonfinal-failure',
  'malformed',
] as const)(
  'revalidates a cached %s claim after the hold and charges only replacement sends',
  async (state) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100000);
    claimViews();
    const original = fetch;
    let lookups = 0;
    let hash = '';
    const args = { purchase_id: terms.file_id, grant: 0 };
    const o = { ...opts, sender, policy: { ...opts.policy, claimsPerPurchase: 2 } };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        const q = JSON.parse(String(init?.body));
        if (q.method !== 'tx') return original(url, init);
        lookups++;
        if (state === 'transport') throw new Error('unavailable');
        if (state === 'unknown')
          return Response.json({ id: q.id, error: { cause: { name: 'UNKNOWN_TRANSACTION' } } });
        const status =
          state === 'failed' || state === 'nonfinal-failure'
            ? { Failure: { ActionError: {} } }
            : state === 'pending' || state === 'final-started'
              ? 'Started'
              : state === 'mpc-error'
                ? successValue({ error: 'MPC did not release the key; ask again' })
                : state === 'empty'
                  ? { SuccessValue: '' }
                  : state === 'null'
                    ? successValue(null)
                    : successValue(claimAnswer);
        return Response.json({
          id: q.id,
          result: claimOutcome(
            state === 'malformed' ? 'wrong-hash' : hash,
            args,
            status,
            state !== 'pending' && state !== 'nonfinal-failure',
          ),
        });
      }),
    );
    try {
      const req = { method: 'claim_key', args };
      const first = await relay(req, o);
      hash = first.txHash;
      clock.mockReturnValue(100000 + 899999);
      expect(await relay(req, o)).toEqual(first);
      expect(lookups).toBe(0);
      clock.mockReturnValue(100000 + 900000);
      const retry = ['failed', 'mpc-error', 'empty', 'null', 'final-started', 'unknown'].includes(
        state,
      );
      const next = await relay(req, o);
      expect(next.txHash).toBeTruthy();
      expect(lookups).toBe(1);
      expect(created).toHaveBeenCalledTimes(retry ? 2 : 1);
      if (retry) {
        clock.mockReturnValue(100000 + 1800000);
        await expect(relay(req, o)).rejects.toMatchObject({
          code: 'limited',
          retryAt: 100000 + 86400000,
        });
        expect(created).toHaveBeenCalledTimes(2);
      } else {
        clock.mockReturnValue(100000 + 1800000);
        expect(await relay(req, o)).toEqual(first);
        expect(lookups).toBe(state === 'succeeded' ? 1 : 2);
        expect(created).toHaveBeenCalledTimes(1);
      }
    } finally {
      clock.mockRestore();
    }
  },
);
it('sends exactly once when two identical requests both finish preflight', async () => {
  rpc((method) => (method === 'storage_balance_of' ? '100000000000000000000000' : null));
  const original = fetch;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  let checked = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      const q = JSON.parse(String(init?.body));
      if (q.params?.method_name === 'get_file') {
        if (++checked === 2) entered();
        await gate;
      }
      return original(url, init);
    }),
  );
  const req = await sign();
  const pending = Promise.allSettled([
    relay(req, { ...opts, sender }),
    relay(req, { ...opts, sender }),
  ]);
  await ready;
  release();
  const results = await pending;
  expect(checked).toBe(2);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toEqual([
    { status: 'rejected', reason: expect.objectContaining({ code: 'in_flight' }) },
  ]);
  expect(created).toHaveBeenCalledTimes(1);
  expect(
    vi
      .mocked(fetch)
      .mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).method === 'send_tx'),
  ).toHaveLength(1);
});

it('keeps one grant quota exhausted without spending another grant quota', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100000);
  claimViews();
  const original = fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      const q = JSON.parse(String(init?.body));
      if (q.method !== 'tx') return original(url, init);
      return Response.json({ id: q.id, error: { cause: { name: 'UNKNOWN_TRANSACTION' } } });
    }),
  );
  const o = { ...opts, sender, policy: { ...opts.policy, claimsPerPurchase: 1 } };
  const request = (grant: number) => ({
    method: 'claim_key',
    args: { purchase_id: terms.file_id, grant },
  });
  try {
    await relay(request(0), o);
    clock.mockReturnValue(100000 + 900000);
    await expect(relay(request(0), o)).rejects.toMatchObject({
      code: 'limited',
      retryAt: 100000 + 86400000,
    });
    const other = await relay(request(1), o);
    expect(await relay(request(1), o)).toEqual(other);
    await expect(relay(request(0), o)).rejects.toMatchObject({ code: 'limited' });
    expect(created).toHaveBeenCalledTimes(2);
  } finally {
    clock.mockRestore();
  }
});
it('an old lookup cannot retire a replacement admitted after its cache window expires', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100000);
  claimViews();
  let nonce = 0;
  created.mockImplementation(async () => {
    const n = ++nonce;
    return { transaction: { encode: () => new Uint8Array([1, 2, n]) } };
  });
  const original = fetch;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  let lookups = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      const q = JSON.parse(String(init?.body));
      if (q.method !== 'tx') return original(url, init);
      lookups++;
      entered();
      await gate;
      return Response.json({ id: q.id, error: { cause: { name: 'UNKNOWN_TRANSACTION' } } });
    }),
  );
  const req = { method: 'claim_key', args: { purchase_id: terms.file_id, grant: 0 } };
  const o = { ...opts, sender, policy: { ...opts.policy, claimsPerPurchase: 1 } };
  let old: ReturnType<typeof relayStatus> | undefined;
  try {
    const first = await relay(req, o);
    clock.mockReturnValue(100000 + 86400000 - 1);
    old = relayStatus(req, o);
    await started;
    clock.mockReturnValue(100000 + 86400000 + 1);
    const replacement = await relay(req, o);
    expect(replacement.txHash).not.toBe(first.txHash);
    release();
    expect(await old).toEqual(replacement);
    expect(await relayStatus(req, o)).toEqual(replacement);
    expect(await relay(req, o)).toEqual(replacement);
    expect(created).toHaveBeenCalledTimes(2);
    expect(lookups).toBe(1);
  } finally {
    release();
    if (old) await Promise.allSettled([old]);
    clock.mockRestore();
  }
});
it('coalesces simultaneous stale claim lookups into one RPC request', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100000);
  claimViews();
  const original = fetch;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  let lookups = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      const q = JSON.parse(String(init?.body));
      if (q.method !== 'tx') return original(url, init);
      lookups++;
      entered();
      await gate;
      return Response.json({ id: q.id, result: { final_execution_status: 'INCLUDED' } });
    }),
  );
  const req = { method: 'claim_key', args: { purchase_id: terms.file_id, grant: 0 } };
  const o = { ...opts, sender };
  let polls: Promise<Awaited<ReturnType<typeof relayStatus>>[]> | undefined;
  try {
    const first = await relay(req, o);
    clock.mockReturnValue(100000 + 900000);
    polls = Promise.all(Array.from({ length: 8 }, () => relayStatus(req, o)));
    await started;
    expect(lookups).toBe(1);
    release();
    expect(await polls).toEqual(Array(8).fill(first));
    expect(lookups).toBe(1);
    expect(created).toHaveBeenCalledTimes(1);
  } finally {
    release();
    if (polls) await Promise.allSettled([polls]);
    clock.mockRestore();
  }
});
