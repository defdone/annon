import { expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  chainId: vi.fn(async () => 8453),
  call: vi.fn(async (request: { stateOverride?: unknown; blockOverrides?: { time: bigint } }) => ({
    data: request.stateOverride
      ? `0x${request.blockOverrides?.time.toString(16).padStart(64, '0')}`
      : '0x',
  })),
  sign: vi.fn(async () => '0x1234'),
  send: vi.fn(async () => '0xhash'),
  transport: vi.fn(),
  balance: vi.fn(async () => 10n ** 18n),
  receipt: vi.fn(async () => null),
  transaction: vi.fn(async () => {
    const { TransactionNotFoundError } = await import('viem');
    throw new TransactionNotFoundError({ hash: `0x${'55'.repeat(32)}` });
  }),
  nonce: vi.fn(async (_request: { blockTag: string }) => 0),
  code: vi.fn(async () => undefined as `0x${string}` | undefined),
  splitRead: vi.fn(async () => ({})),
  prepare: vi.fn(async () => ({ maxFeePerGas: 1n, gas: 120000n, nonce: 7 })),
  read: vi.fn(async ({ functionName }: { functionName: string }) =>
    functionName === 'balanceOf' ? 100n : false,
  ),
}));
vi.mock('viem', async (load) => ({
  ...(await load<typeof import('viem')>()),
  http: mocked.transport,
  createPublicClient: () => ({
    getBytecode: mocked.code,
    getChainId: mocked.chainId,
    call: mocked.call,
    readContract: mocked.read,
    getBlock: async () => ({ timestamp: 1000n }),
    getBalance: mocked.balance,
    getTransactionCount: mocked.nonce,
    getTransaction: mocked.transaction,
    getTransactionReceipt: mocked.receipt,
  }),
  createWalletClient: () => ({
    prepareTransactionRequest: mocked.prepare,
    signTransaction: mocked.sign,
    sendRawTransaction: mocked.send,
  }),
}));
vi.mock('viem/op-stack', () => ({ estimateL1Fee: vi.fn(async () => 10n) }));

vi.mock('../../packages/annon/src/pay/split.ts', async (load) => ({
  ...(await load<typeof import('../../packages/annon/src/pay/split.ts')>()),
  readSplit: mocked.splitRead,
}));

import { baseFacilitator } from './facilitator.ts';

it('uses bounded RPC transport, timestamp overrides and execution plus L1 fee reservations', async () => {
  const store = (await import('../../packages/annon/src/pay/store.ts')).memoryStore();
  const facilitator = await baseFacilitator('42'.repeat(32), 'https://base.invalid', 0.5, 10, {
    store: store as never,
    dailyGasBudgetWei: 120019n,
  });
  const a = {
    from: `0x${'11'.repeat(20)}`,
    to: `0x${'22'.repeat(20)}`,
    value: '1',
    validAfter: '0',
    validBefore: '1120',
    nonce: `0x${'33'.repeat(32)}`,
  };
  const body = {
    paymentRequirements: {
      network: 'eip155:8453',
      asset: (await import('../../packages/annon/src/settle-near/terms.ts')).BASE_USDC,
      payTo: a.to,
      amount: '1',
    },
    paymentPayload: { payload: { authorization: a, signature: `0x${'44'.repeat(65)}` } },
  } as never;
  expect(await facilitator.selfCheck()).toBe(true);
  await expect(facilitator(body, { signal: new AbortController().signal })).resolves.toMatchObject({
    errorReason: 'unavailable',
  });
  expect(mocked.transport).toHaveBeenCalledWith('https://base.invalid', {
    timeout: 5000,
    retryCount: 1,
  });
  expect(mocked.call).toHaveBeenCalledWith(
    expect.objectContaining({ blockOverrides: { time: 1030n } }),
  );
  expect(mocked.send).not.toHaveBeenCalled();
});
it('refuses a non-Base RPC before preparing a transaction', async () => {
  mocked.chainId.mockResolvedValueOnce(1);
  const f = await baseFacilitator('42'.repeat(32), 'https://base.invalid', 0.5, 10);
  const a = {
    from: `0x${'11'.repeat(20)}`,
    to: `0x${'22'.repeat(20)}`,
    value: '1',
    validAfter: '0',
    validBefore: '1120',
    nonce: `0x${'33'.repeat(32)}`,
  };
  const body = {
    paymentRequirements: {
      network: 'eip155:8453',
      asset: (await import('../../packages/annon/src/settle-near/terms.ts')).BASE_USDC,
      payTo: a.to,
      amount: '1',
    },
    paymentPayload: { payload: { authorization: a, signature: `0x${'44'.repeat(65)}` } },
  } as never;
  expect(await f.selfCheck()).toBe(false);
  expect(await f(body, { signal: new AbortController().signal })).toMatchObject({
    errorReason: 'unavailable',
  });
});
it('alerts on RPC sampling failures without including upstream details', async () => {
  const alert = vi.fn();
  const f = await baseFacilitator('42'.repeat(32), 'https://base.invalid', 0.5, 10, { alert });
  mocked.balance.mockRejectedValueOnce(new Error('private upstream response'));
  await expect(f.sample()).rejects.toThrow('private upstream response');
  expect(alert).toHaveBeenCalledExactlyOnceWith({ type: 'base_rpc_unhealthy' });
});

it('checks block override support before admitting paid requests and disables with a safe alert on failure', async () => {
  const alert = vi.fn();
  const f = await baseFacilitator('42'.repeat(32), 'https://base.invalid', 0.5, 10, { alert });
  mocked.call.mockRejectedValueOnce(new Error('private provider diagnostic'));
  await expect(f.selfCheck()).resolves.toBe(false);
  expect(alert).toHaveBeenCalledWith({ type: 'base_rpc_unhealthy' });
  expect(mocked.call).toHaveBeenLastCalledWith(
    expect.objectContaining({ data: '0x', blockOverrides: { time: 1030n } }),
  );
  const calls = mocked.call.mock.calls.length;
  expect(await f({} as never, { signal: new AbortController().signal })).toMatchObject({
    errorReason: 'unavailable',
  });
  expect(mocked.call.mock.calls).toHaveLength(calls);
  await expect(f.selfCheck()).resolves.toBe(true);
});

it('refuses a provider that accepts overrides but returns the unmodified block timestamp', async () => {
  const f = await baseFacilitator('42'.repeat(32), 'https://base.invalid', 0.5, 10);
  mocked.call.mockResolvedValueOnce({ data: `0x${(1000).toString(16).padStart(64, '0')}` });
  expect(await f.selfCheck()).toBe(false);
});

it.each([
  'fee',
  'l1',
  'gas',
  'nonce',
  'missing-gas',
  'missing-fee',
  'simulation',
  'network',
  'ready',
])('checks split adapter %s before broadcast', async (guard) => {
  const { createSplit, hostedSplitSalt } = await import('../../packages/annon/src/pay/split.ts');
  const { BASE_USDC, NEAR_USDC } = await import('../../packages/annon/src/settle-near/terms.ts');
  const { memoryStore } = await import('../../packages/annon/src/pay/store.ts');
  const treasury = { kind: 'evm' as const, id: `0x${'11'.repeat(20)}` };
  const split = {
    recipients: [treasury.id],
    allocations: [10000n],
    totalAllocation: 10000n,
    distributionIncentive: 0,
  };
  const terms = {
    network: 'near:mainnet',
    contract: 'market.test',
    file_id: `0x${'22'.repeat(32)}`,
    seller: treasury,
    pay2_version: 2 as const,
    cipher_hash: `0x${'33'.repeat(32)}`,
    moderator: null,
    near: {
      price: '100000',
      token: NEAR_USDC,
      recipients: [{ identity: treasury, bps: 10000 }],
      remainder: 0,
    },
    base: {
      price: '100000',
      usdc: BASE_USDC,
      pay_to: createSplit('push', split, hostedSplitSalt()).address,
    },
  };
  const limits = {
    enabled: true as const,
    deploymentsPerDay: 60,
    sendsPerMinute: 2,
    revertsPerDay: 1,
    gasLimit: 120000n,
    maxFeeGwei: 0.5,
    l1FeeAllowanceWei: guard === 'l1' ? 9n : 10n,
    dailyBudgetWei: 1000000000n,
    walletDailyBudgetWei: 10000000000000000n,
  };
  const f = await baseFacilitator('42'.repeat(32), 'https://base.invalid', 0.5, 10, {
    store: memoryStore(),
    split: limits,
    splitFee: { fixed: '30000', bps: 100, treasuryNear: null, treasuryEvm: treasury },
  });
  const before = mocked.send.mock.calls.length;
  const beforeSign = mocked.sign.mock.calls.length;
  if (guard === 'fee')
    mocked.prepare.mockResolvedValueOnce({ maxFeePerGas: 500000001n, gas: 120000n, nonce: 7 });
  if (guard === 'nonce')
    mocked.prepare.mockResolvedValueOnce({ maxFeePerGas: 1n, gas: 120000n } as never);
  if (guard === 'missing-gas')
    mocked.prepare.mockResolvedValueOnce({ maxFeePerGas: 1n, nonce: 7 } as never);
  if (guard === 'missing-fee')
    mocked.prepare.mockResolvedValueOnce({ gas: 120000n, nonce: 7 } as never);
  if (guard === 'gas')
    mocked.prepare.mockResolvedValueOnce({ maxFeePerGas: 1n, gas: 120001n, nonce: 7 });
  if (guard === 'simulation')
    mocked.call.mockRejectedValueOnce(new Error('simulation unavailable'));
  if (guard === 'network') mocked.chainId.mockResolvedValueOnce(1);
  if (guard === 'ready') mocked.code.mockResolvedValueOnce('0x1234');
  if (guard === 'ready') {
    expect(await f.deploySplit(terms)).toMatchObject({ state: 'ready' });
    expect(mocked.splitRead).toHaveBeenCalledWith(
      'https://base.invalid',
      terms.base.pay_to,
      split,
      { salt: hostedSplitSalt() },
    );
  } else await expect(f.deploySplit(terms)).rejects.toThrow();
  expect(mocked.send.mock.calls).toHaveLength(before);
  expect(mocked.sign.mock.calls).toHaveLength(beforeSign);
});

it.each([7, 8])(
  'reconciles a saved split with mined nonce %s independently of pending nonces',
  async (latest) => {
    const { memoryStore } = await import('../../packages/annon/src/pay/store.ts');
    const store = memoryStore<import('./facilitator.ts').FacilitatorState>();
    const hash = `0x${'55'.repeat(32)}`;
    await store.compareAndSet('facilitator', null, {
      id: 'facilitator',
      revision: 0,
      times: [],
      sends: {
        split: {
          operation: 'split',
          serialized: '0x1234',
          hash,
          nonce: 7,
          payer: `0x${'11'.repeat(20)}`,
          at: Date.now(),
          until: 0,
          day: 0,
          cost: '20',
          done: false,
        },
      },
      days: { 0: { cost: '0', reverts: 0, payers: {}, splitCost: '20' } },
    });
    mocked.nonce.mockImplementation(async ({ blockTag }) => (blockTag === 'latest' ? latest : 99));
    const sends = mocked.send.mock.calls.length;
    const f = await baseFacilitator('42'.repeat(32), 'https://base.invalid', 0.5, 10, { store });
    try {
      await f.sample();
      expect(mocked.nonce).toHaveBeenLastCalledWith(
        expect.objectContaining({ blockTag: 'latest' }),
      );
      expect((await store.load('facilitator'))?.sends.split).toMatchObject({
        done: latest === 8,
        cost: latest === 8 ? '0' : '20',
      });
      expect(mocked.send.mock.calls.length - sends).toBe(latest === 8 ? 0 : 1);
      if (latest === 7)
        expect(mocked.send).toHaveBeenLastCalledWith({ serializedTransaction: '0x1234' });
    } finally {
      mocked.nonce.mockImplementation(async () => 0);
    }
  },
);
