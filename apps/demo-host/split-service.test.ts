import { expect, it, vi } from 'vitest';
import { createSplit, hostedSplitSalt } from '../../packages/annon/src/pay/split.ts';
import { memoryStore } from '../../packages/annon/src/pay/store.ts';
import { BASE_USDC, NEAR_USDC, type Terms } from '../../packages/annon/src/settle-near/terms.ts';
import {
  type Chain,
  type FacilitatorState,
  facilitatorFor,
  initFacilitatorState,
} from './facilitator.ts';

const seller = { kind: 'evm' as const, id: `0x${'11'.repeat(20)}` };
const treasury = { kind: 'evm' as const, id: `0x${'22'.repeat(20)}` };
const split = {
  recipients: [seller.id, treasury.id],
  allocations: [6900n, 3100n],
  totalAllocation: 10000n,
  distributionIncentive: 0,
};
const terms: Terms = {
  network: 'near:mainnet',
  contract: 'market.synthetic.near',
  file_id: `0x${'33'.repeat(32)}`,
  seller,
  pay2_version: 2,
  cipher_hash: `0x${'44'.repeat(32)}`,
  moderator: null,
  near: {
    token: NEAR_USDC,
    price: '100000',
    recipients: [
      { identity: seller, bps: 6900 },
      { identity: treasury, bps: 3100 },
    ],
    remainder: 0,
  },
  base: {
    usdc: BASE_USDC,
    price: '100000',
    pay_to: createSplit('push', split, `0x${'00'.repeat(32)}`).address,
  },
};
const config = {
  enabled: true,
  deploymentsPerDay: 60,
  sendsPerMinute: 2,
  revertsPerDay: 1,
  gasLimit: 1000000n,
  maxFeeGwei: 1,
  l1FeeAllowanceWei: 5n,
  dailyBudgetWei: 100n,
  walletDailyBudgetWei: 200n,
};
function fixture(over = {}, minimum = 100000n) {
  let now = 1000;
  const chain: Chain & { minedNonce(): Promise<number> } & Required<
      Pick<Chain, 'readSplit' | 'simulateSplit'>
    > = {
    timestamp: vi.fn(async () => 1000),
    used: vi.fn(async () => false),
    balance: vi.fn(async () => 1n),
    simulate: vi.fn(async () => true),
    simulateSplit: vi.fn(async () => true),
    readSplit: vi.fn(async () => false),
    sign: vi.fn(async () => ({
      serialized: 'signed-bytes',
      hash: `0x${'55'.repeat(32)}`,
      maxCostWei: 20n,
      nonce: 0,
    })),
    send: vi.fn(async () => `0x${'55'.repeat(32)}`),
    receipt: vi.fn(async () => null),
    transaction: vi.fn(async () => true),
    ethBalance: vi.fn(async () => 10n ** 18n),
    nonceClear: vi.fn(async () => true),
    minedNonce: vi.fn(async () => 0),
  };
  const store = memoryStore<FacilitatorState>();
  const options = {
    store,
    dailyGasBudgetWei: 100n,
    split: { ...config, ...over },
    splitMinPrice: minimum,
    splitFee: { fixed: '30000', bps: 100, treasuryNear: null, treasuryEvm: treasury },
  };
  const make = () => facilitatorFor(chain, 10, () => now, options);
  return {
    chain,
    store,
    options,
    make,
    setNow: (v: number) => {
      now = v;
    },
  };
}
it('uses a canonical file-independent salt and derives the complete ownerless deployment', async () => {
  expect(hostedSplitSalt()).toBe(`0x${'00'.repeat(32)}`);
  const f = fixture();
  const result = await f.make().deploySplit(terms);
  expect(result).toEqual({
    state: 'pending',
    address: terms.base?.pay_to,
    kind: 'push',
    salt: hostedSplitSalt(),
    txHash: `0x${'55'.repeat(32)}`,
  });
  expect(f.chain.sign).toHaveBeenCalledWith(expect.any(String), expect.any(String), config);
  expect(f.chain.simulateSplit).toHaveBeenCalledBefore(f.chain.sign as never);
  const state = await f.store.load('facilitator');
  expect(Object.values(state?.sends ?? {})[0]).toMatchObject({
    serialized: 'signed-bytes',
    nonce: 0,
    operation: 'split',
  });
});
it('persists before an uncertain broadcast and reconciles the same transaction after restart', async () => {
  const f = fixture();
  vi.mocked(f.chain.send).mockImplementation(async () => {
    expect(Object.values((await f.store.load('facilitator'))?.sends ?? {})[0]).toMatchObject({
      serialized: 'signed-bytes',
    });
    throw new Error('response lost');
  });
  const first = await f.make().deploySplit(terms);
  expect(first.state).toBe('pending');
  expect(await f.make().deploySplit(terms)).toEqual(first);
  expect(f.chain.sign).toHaveBeenCalledOnce();
  vi.mocked(f.chain.readSplit).mockResolvedValue(true);
  expect(await f.make().deploySplit(terms)).toMatchObject({ state: 'ready', txHash: first.txHash });
  expect(f.chain.send).toHaveBeenCalledOnce();
});
it('reuses and verifies an existing split without spending', async () => {
  const f = fixture();
  vi.mocked(f.chain.readSplit).mockResolvedValue(true);
  expect(await f.make().deploySplit(terms)).toMatchObject({ state: 'ready', txHash: null });
  expect(f.chain.sign).not.toHaveBeenCalled();
});
it.each(['disabled', 'fee', 'payee', 'recipient', 'simulation', 'nonce', 'rpc'])(
  'refuses %s before signing',
  async (guard) => {
    const f = fixture(guard === 'disabled' ? { enabled: false } : {});
    const t = structuredClone(terms);
    if (guard === 'fee' && t.near.recipients[0] && t.near.recipients[1] && t.base) {
      t.near.recipients[0].bps = 7000;
      t.near.recipients[1].bps = 3000;
      t.base.pay_to = createSplit(
        'push',
        { ...split, allocations: [7000n, 3000n] },
        hostedSplitSalt(),
      ).address;
    }
    if (guard === 'payee' && t.base) t.base.pay_to = seller.id;
    if (guard === 'recipient' && t.near.recipients[0])
      t.near.recipients[0].identity = { kind: 'near', id: seller.id };
    if (guard === 'simulation') vi.mocked(f.chain.simulateSplit).mockResolvedValue(false);
    if (guard === 'nonce') vi.mocked(f.chain.nonceClear).mockResolvedValue(false);
    if (guard === 'rpc') vi.mocked(f.chain.readSplit).mockRejectedValue(new Error('unavailable'));
    await expect(f.make().deploySplit(t)).rejects.toThrow();
    expect(f.chain.sign).not.toHaveBeenCalled();
  },
);
it.each(['dailyBudgetWei', 'walletDailyBudgetWei'])(
  'protects %s and reports the actual UTC retry',
  async (field) => {
    const f = fixture({ [field]: field === 'dailyBudgetWei' ? 19n : 119n });
    await expect(f.make().deploySplit(terms)).rejects.toMatchObject({
      code: 'budget',
      retryAfterSeconds: 86399,
    });
    expect(f.chain.send).not.toHaveBeenCalled();
  },
);
it('keeps payment and split transactions in the same nonce queue', async () => {
  const f = fixture();
  await f.make().deploySplit(terms);
  const other = structuredClone(terms);
  other.near.recipients.reverse();
  if (other.base)
    other.base.pay_to = createSplit(
      'push',
      {
        ...split,
        recipients: [...split.recipients].reverse(),
        allocations: [...split.allocations].reverse(),
      },
      hostedSplitSalt(),
    ).address;
  await expect(f.make().deploySplit(other)).rejects.toMatchObject({ code: 'settlement_pending' });
  expect(f.chain.sign).toHaveBeenCalledOnce();
});
it('counts mined reverts as spend and enforces the split revert cap', async () => {
  const f = fixture();
  await f.make().deploySplit(terms);
  vi.mocked(f.chain.receipt).mockResolvedValue({ reverted: true, costWei: 7n });
  await f.make().sample();
  const state = await f.store.load('facilitator');
  expect(state?.days[0]).toMatchObject({ splitCost: '7', splitReverts: 1 });
  const other = structuredClone(terms);
  other.near.recipients.reverse();
  if (other.base)
    other.base.pay_to = createSplit(
      'push',
      {
        ...split,
        recipients: [...split.recipients].reverse(),
        allocations: [...split.allocations].reverse(),
      },
      hostedSplitSalt(),
    ).address;
  await expect(f.make().deploySplit(other)).rejects.toMatchObject({ code: 'budget' });
  expect(f.chain.send).toHaveBeenCalledOnce();
});
it.each(['deploymentsPerDay', 'sendsPerMinute'])(
  'enforces durable %s independently after restart',
  async (field) => {
    const f = fixture({ [field]: 1 });
    await f.make().deploySplit(terms);
    vi.mocked(f.chain.receipt).mockResolvedValue({ reverted: false, costWei: 2n });
    await f.make().sample();
    const other = structuredClone(terms);
    other.near.recipients.reverse();
    if (other.base)
      other.base.pay_to = createSplit(
        'push',
        {
          ...split,
          recipients: [...split.recipients].reverse(),
          allocations: [...split.allocations].reverse(),
        },
        hostedSplitSalt(),
      ).address;
    await expect(f.make().deploySplit(other)).rejects.toMatchObject({
      code: field === 'sendsPerMinute' ? 'rate_limited' : 'budget',
      retryAfterSeconds: field === 'sendsPerMinute' ? 60 : 86399,
    });
    expect(f.chain.send).toHaveBeenCalledOnce();
  },
);
it('does not mark a mined transaction ready until readSplit succeeds', async () => {
  const f = fixture();
  await f.make().deploySplit(terms);
  vi.mocked(f.chain.receipt).mockResolvedValue({ reverted: false, costWei: 2n });
  expect(await f.make().deploySplit(terms)).toMatchObject({ state: 'pending' });
  expect(f.chain.send).toHaveBeenCalledOnce();
});
it('serializes concurrent requests for an identical split and blocks payments behind split uncertainty', async () => {
  const f = fixture();
  const service = f.make();
  await Promise.all([service.deploySplit(terms), service.deploySplit(terms)]);
  expect(f.chain.sign).toHaveBeenCalledOnce();
  const a = {
    from: seller.id,
    to: treasury.id,
    value: '1',
    validAfter: '0',
    validBefore: '1120',
    nonce: `0x${'66'.repeat(32)}`,
  };
  const body = {
    paymentRequirements: { network: 'eip155:8453', asset: BASE_USDC, payTo: a.to, amount: a.value },
    paymentPayload: { payload: { authorization: a, signature: `0x${'77'.repeat(65)}` } },
  };
  expect(await service(body as never, { signal: new AbortController().signal })).toMatchObject({
    errorReason: 'facilitator_busy',
  });
  expect(f.chain.sign).toHaveBeenCalledOnce();
});
it('reconciles a deployment race after signing without a second broadcast', async () => {
  const f = fixture();
  vi.mocked(f.chain.readSplit).mockResolvedValueOnce(false).mockResolvedValue(true);
  expect(await f.make().deploySplit(terms)).toMatchObject({ state: 'ready', txHash: null });
  expect(f.chain.sign).toHaveBeenCalledOnce();
  expect(f.chain.send).not.toHaveBeenCalled();
});
it('persists payment signed bytes and reserves the aggregate wallet cap for payments', async () => {
  const f = fixture({ walletDailyBudgetWei: 120n });
  const service = f.make();
  await service.deploySplit(terms);
  vi.mocked(f.chain.receipt).mockResolvedValue({ reverted: false, costWei: 20n });
  const a = {
    from: seller.id,
    to: treasury.id,
    value: '1',
    validAfter: '0',
    validBefore: '1120',
    nonce: `0x${'66'.repeat(32)}`,
  };
  const body = {
    paymentRequirements: { network: 'eip155:8453', asset: BASE_USDC, payTo: a.to, amount: a.value },
    paymentPayload: { payload: { authorization: a, signature: `0x${'77'.repeat(65)}` } },
  };
  expect(await service(body as never, { signal: new AbortController().signal })).toMatchObject({
    errorReason: 'settlement_pending',
  });
  expect(
    Object.values((await f.store.load('facilitator'))?.sends ?? {}).find((r) => !r.operation),
  ).toMatchObject({ serialized: 'signed-bytes', nonce: 0 });
});
it('refuses a split when either route price is below the sponsorship minimum', async () => {
  for (const route of ['near', 'base'] as const) {
    const f = fixture();
    const t = structuredClone(terms);
    if (t.near.recipients[0]) t.near.recipients[0].bps = 6800;
    if (t.near.recipients[1]) t.near.recipients[1].bps = 3200;
    if (t.base)
      t.base.pay_to = createSplit(
        'push',
        { ...split, allocations: [6800n, 3200n] },
        hostedSplitSalt(),
      ).address;
    const priced = t[route];
    if (priced) priced.price = '99999';
    await expect(f.make().deploySplit(t)).rejects.toMatchObject({ code: 'not_sponsored' });
    expect(f.chain.sign).not.toHaveBeenCalled();
  }
});

it('respects a higher configured sponsorship price before any split RPC', async () => {
  const f = fixture({}, 200000n);
  await expect(f.make().deploySplit(terms)).rejects.toMatchObject({ code: 'not_sponsored' });
  expect(f.chain.readSplit).not.toHaveBeenCalled();
  expect(f.chain.sign).not.toHaveBeenCalled();
});
it('retains uncertain split spend after UTC rollover even when the wallet nonce appears clear', async () => {
  const f = fixture();
  await f.make().deploySplit(terms);
  vi.mocked(f.chain.transaction).mockResolvedValue(true);
  f.setNow(2 * 86400000);
  await f.make().sample();
  const state = await f.store.load('facilitator');
  expect(Object.values(state?.sends ?? {})[0]).toMatchObject({ done: false, cost: '20' });
  expect(state?.days[0]).toMatchObject({ splitCost: '20' });
  expect(f.chain.send).toHaveBeenCalledOnce();
});

it('retains completed split transaction provenance for reuse after a later day', async () => {
  const f = fixture();
  const result = await f.make().deploySplit(terms);
  vi.mocked(f.chain.receipt).mockResolvedValue({ reverted: false, costWei: 7n });
  f.setNow(2 * 86400000);
  await f.make().sample();
  vi.mocked(f.chain.readSplit).mockResolvedValue(true);
  expect(await f.make().splitStatus(terms)).toMatchObject({
    state: 'ready',
    txHash: result.txHash,
  });
});
it('bounds queued split requests while preserving an active broadcast', async () => {
  const f = fixture();
  let release = () => {};
  vi.mocked(f.chain.send).mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve(`0x${'55'.repeat(32)}`);
      }),
  );
  const service = facilitatorFor(f.chain, 10, () => 1000, { ...f.options, maxWaiting: 0 });
  const first = service.deploySplit(terms);
  await vi.waitFor(() => expect(f.chain.send).toHaveBeenCalledOnce());
  const second = expect(service.deploySplit(terms)).rejects.toMatchObject({
    code: 'rate_limited',
    retryAfterSeconds: 10,
  });
  release();
  await first;
  await second;
});
it('checks the durable queue again after transaction preparation', async () => {
  const f = fixture();
  vi.mocked(f.chain.sign).mockImplementationOnce(async () => {
    const old = await f.store.load('facilitator');
    if (!old) throw new Error('missing state');
    await f.store.compareAndSet('facilitator', old, {
      ...old,
      revision: old.revision + 1,
      sends: {
        ...old.sends,
        held: {
          hash: 'held',
          payer: seller.id,
          at: 1000,
          until: 1120,
          day: 0,
          cost: '1',
          done: false,
        },
      },
    });
    return { serialized: 'signed-bytes', hash: `0x${'55'.repeat(32)}`, maxCostWei: 20n, nonce: 0 };
  });
  await expect(f.make().deploySplit(terms)).rejects.toMatchObject({ code: 'settlement_pending' });
  expect(f.chain.send).not.toHaveBeenCalled();
});
it('enforces a reduced aggregate wallet budget for subsequent payments', async () => {
  const f = fixture();
  await f.make().deploySplit(terms);
  vi.mocked(f.chain.receipt).mockResolvedValue({ reverted: false, costWei: 20n });
  const service = facilitatorFor(f.chain, 10, () => 1000, {
    ...f.options,
    split: { ...config, walletDailyBudgetWei: 39n },
  });
  const a = {
    from: seller.id,
    to: treasury.id,
    value: '1',
    validAfter: '0',
    validBefore: '1120',
    nonce: `0x${'66'.repeat(32)}`,
  };
  const body = {
    paymentRequirements: { network: 'eip155:8453', asset: BASE_USDC, payTo: a.to, amount: a.value },
    paymentPayload: { payload: { authorization: a, signature: `0x${'77'.repeat(65)}` } },
  };
  expect(await service(body as never, { signal: new AbortController().signal })).toMatchObject({
    errorReason: 'unavailable',
  });
  expect(f.chain.send).toHaveBeenCalledOnce();
});

it('rechecks the live reservation at the wallet queue boundary before committing a new send', async () => {
  const f = fixture();
  const beforeSend = vi.fn(async () => {
    throw new Error('reservation expired while queued');
  });
  await expect(f.make().deploySplit(terms, beforeSend)).rejects.toThrow('reservation expired');
  expect(beforeSend).toHaveBeenCalledOnce();
  expect(f.chain.send).not.toHaveBeenCalled();
  expect(Object.keys((await f.store.load('facilitator'))?.sends ?? {})).toHaveLength(0);
});

const payment = () => {
  const a = {
    from: seller.id,
    to: treasury.id,
    value: '1',
    validAfter: '0',
    validBefore: '1120',
    nonce: `0x${'66'.repeat(32)}`,
  };
  return {
    paymentRequirements: { network: 'eip155:8453', asset: BASE_USDC, payTo: a.to, amount: a.value },
    paymentPayload: { payload: { authorization: a, signature: `0x${'77'.repeat(65)}` } },
  } as never;
};
it('rebroadcasts identical saved split bytes after a failed send and restart, then admits a buyer', async () => {
  const f = fixture();
  vi.mocked(f.chain.transaction).mockResolvedValue(false);
  vi.mocked(f.chain.send).mockRejectedValueOnce(new Error('broadcast failed'));
  const first = await f.make().deploySplit(terms);
  const restarted = f.make();
  await restarted.sample();
  expect(vi.mocked(f.chain.send).mock.calls).toEqual([['signed-bytes'], ['signed-bytes']]);
  expect(f.chain.sign).toHaveBeenCalledOnce();
  expect(await restarted.splitStatus(terms)).toMatchObject({
    state: 'pending',
    txHash: first.txHash,
  });
  vi.mocked(f.chain.receipt).mockResolvedValue({ reverted: false, costWei: 7n });
  await restarted.sample();
  expect(await restarted(payment(), { signal: new AbortController().signal })).toMatchObject({
    errorReason: 'settlement_pending',
  });
  expect(f.chain.sign).toHaveBeenCalledTimes(2);
});
it.each([false, true])(
  'drops a split with known hash %s when its nonce was consumed, releases its cost and admits a buyer',
  async (known) => {
    const f = fixture();
    vi.mocked(f.chain.transaction).mockResolvedValue(known);
    const alert = vi.fn();
    const make = () => facilitatorFor(f.chain, 10, () => 1000, { ...f.options, alert });
    vi.mocked(f.chain.send).mockRejectedValueOnce(new Error('broadcast rejected'));
    await make().deploySplit(terms);
    vi.mocked(f.chain.minedNonce).mockResolvedValue(1);
    await make().sample();
    expect(Object.values((await f.store.load('facilitator'))?.sends ?? {})[0]).toMatchObject({
      done: true,
      dropped: true,
      cost: '0',
    });
    expect((await f.store.load('facilitator'))?.days[0]?.splitCost).toBe('0');
    expect(alert).toHaveBeenCalledWith({ type: 'facilitator_dropped' });
    expect(f.chain.send).toHaveBeenCalledOnce();
    expect(await make().splitStatus(terms)).toBeNull();
    expect(await make()(payment(), { signal: new AbortController().signal })).toMatchObject({
      errorReason: 'settlement_pending',
    });
    expect(f.chain.sign).toHaveBeenCalledTimes(2);
  },
);
it('counts a split receipt that appears after the first read before treating its nonce as dropped', async () => {
  const f = fixture();
  await f.make().deploySplit(terms);
  vi.mocked(f.chain.receipt)
    .mockResolvedValueOnce(null)
    .mockResolvedValue({ reverted: true, costWei: 30n });
  vi.mocked(f.chain.minedNonce).mockResolvedValue(1);
  await f.make().sample();
  const state = await f.store.load('facilitator');
  expect(Object.values(state?.sends ?? {})[0]).toMatchObject({
    done: true,
    reverted: true,
    cost: '30',
  });
  expect(Object.values(state?.sends ?? {})[0]?.dropped).not.toBe(true);
  expect(state?.days[0]).toMatchObject({ splitCost: '30', splitReverts: 1 });
  await expect(f.make().deploySplit(terms)).rejects.toMatchObject({ code: 'budget' });
  expect(f.chain.sign).toHaveBeenCalledOnce();
});
it('retains a split whose nonce is unspent when every rebroadcast is rejected', async () => {
  const f = fixture();
  vi.mocked(f.chain.transaction).mockResolvedValue(false);
  vi.mocked(f.chain.send).mockRejectedValue(new Error('rejected'));
  await f.make().deploySplit(terms);
  await f.make().sample();
  expect(f.chain.send).toHaveBeenCalledTimes(2);
  expect(Object.values((await f.store.load('facilitator'))?.sends ?? {})[0]).toMatchObject({
    done: false,
    cost: '20',
  });
  expect(await f.make()(payment(), { signal: new AbortController().signal })).toMatchObject({
    errorReason: 'facilitator_busy',
  });
  expect(f.chain.sign).toHaveBeenCalledOnce();
});
it.each(['near', 'solana'] as const)(
  'refuses a %s seller with EVM recipients before split RPC, signing or broadcast',
  async (kind) => {
    const f = fixture();
    const t = structuredClone(terms);
    t.seller = { kind, id: kind === 'near' ? 'seller.test' : '11111111111111111111111111111111' };
    await expect(f.make().deploySplit(t)).rejects.toMatchObject({ code: 'not_sponsored' });
    expect(f.chain.readSplit).not.toHaveBeenCalled();
    expect(f.chain.sign).not.toHaveBeenCalled();
    expect(f.chain.send).not.toHaveBeenCalled();
  },
);
it('retries the same reverted split while charging its cost and stopping at the revert cap', async () => {
  const f = fixture({ revertsPerDay: 2, sendsPerMinute: 10 });
  await f.make().deploySplit(terms);
  vi.mocked(f.chain.receipt).mockResolvedValue({ reverted: true, costWei: 7n });
  await f.make().sample();
  expect(Object.values((await f.store.load('facilitator'))?.sends ?? {})[0]).toMatchObject({
    done: true,
    reverted: true,
  });
  expect(await f.make().splitStatus(terms)).toBeNull();
  vi.mocked(f.chain.receipt).mockResolvedValue(null);
  await expect(f.make().deploySplit(terms)).resolves.toMatchObject({ state: 'pending' });
  expect(f.chain.sign).toHaveBeenCalledTimes(2);
  expect((await f.store.load('facilitator'))?.days[0]?.splitCost).toBe('27');
  vi.mocked(f.chain.receipt).mockResolvedValue({ reverted: true, costWei: 7n });
  await f.make().sample();
  await expect(f.make().deploySplit(terms)).rejects.toMatchObject({
    code: 'budget',
    retryAfterSeconds: 86399,
  });
  expect((await f.store.load('facilitator'))?.days[0]).toMatchObject({
    splitCost: '14',
    splitReverts: 2,
  });
  expect(f.chain.sign).toHaveBeenCalledTimes(2);
});
it('bounds a retry after a reverted split by its remaining spend budget', async () => {
  const f = fixture({ revertsPerDay: 2, dailyBudgetWei: 26n });
  await f.make().deploySplit(terms);
  vi.mocked(f.chain.receipt).mockResolvedValue({ reverted: true, costWei: 7n });
  await f.make().sample();
  vi.mocked(f.chain.receipt).mockResolvedValue(null);
  await expect(f.make().deploySplit(terms)).rejects.toMatchObject({ code: 'budget' });
  expect(f.chain.send).toHaveBeenCalledOnce();
});
it('reads split status independently of current sponsorship fees and minimums', async () => {
  const f = fixture();
  vi.mocked(f.chain.readSplit).mockResolvedValue(true);
  const { splitFee: _fee, ...options } = f.options;
  const service = facilitatorFor(f.chain, 10, () => 1000, {
    ...options,
    splitMinPrice: 999999n,
  });
  expect(await service.splitStatus(terms)).toMatchObject({ state: 'ready' });
  expect(f.chain.sign).not.toHaveBeenCalled();
});
it('returns null status with disabled splits without reading the chain', async () => {
  const f = fixture({ enabled: false });
  const { splitFee: _fee, ...options } = f.options;
  const service = facilitatorFor(f.chain, 10, () => 1000, options);
  expect(await service.splitStatus(terms)).toBeNull();
  expect(f.chain.readSplit).not.toHaveBeenCalled();
});
it.each(['serialized', 'hash', 'reverted', 'dropped'] as const)(
  'refuses startup with invalid durable split %s',
  async (field) => {
    const f = fixture();
    await f.make().deploySplit(terms);
    const old = await f.store.load('facilitator');
    if (!old) throw new Error('missing state');
    const state = structuredClone(old);
    const record = Object.values(state.sends)[0];
    if (!record) throw new Error('missing split');
    if (field === 'serialized') delete record.serialized;
    else if (field === 'hash') record.hash = 'malformed';
    else record[field] = 'invalid' as never;
    state.revision++;
    await f.store.compareAndSet('facilitator', old, state);
    await expect(initFacilitatorState(f.store)).rejects.toMatchObject({ reason: 'state_invalid' });
  },
);

it('cannot apply an older receipt sample to a replacement attempt for the same split', async () => {
  const f = fixture({ revertsPerDay: 3 });
  const service = f.make();
  await service.deploySplit(terms);
  let release = (_receipt: { reverted: boolean; costWei: bigint } | null) => {};
  vi.mocked(f.chain.receipt).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const stale = service.sample();
  try {
    await vi.waitFor(() => expect(f.chain.receipt).toHaveBeenCalledOnce());
    vi.mocked(f.chain.receipt).mockResolvedValueOnce({ reverted: true, costWei: 7n });
    await service.sample();
    vi.mocked(f.chain.sign).mockResolvedValueOnce({
      serialized: 'retry-bytes',
      hash: `0x${'88'.repeat(32)}`,
      maxCostWei: 20n,
      nonce: 1,
    });
    await service.deploySplit(terms);
  } finally {
    release({ reverted: true, costWei: 7n });
    await stale;
  }
  const state = await f.store.load('facilitator');
  expect(Object.values(state?.sends ?? {})[0]).toMatchObject({
    hash: `0x${'88'.repeat(32)}`,
    done: false,
    cost: '20',
  });
  expect(state?.days[0]).toMatchObject({ splitCost: '27', splitReverts: 1 });
  expect(await service(payment(), { signal: new AbortController().signal })).toMatchObject({
    errorReason: 'facilitator_busy',
  });
  expect(f.chain.sign).toHaveBeenCalledTimes(2);
});
