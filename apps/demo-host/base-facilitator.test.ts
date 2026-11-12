import { expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
  chainId: vi.fn(async () => 8453),
  call: vi.fn(async () => ({ data: '0x' })),
  sign: vi.fn(async () => '0x1234'),
  send: vi.fn(async () => '0xhash'),
  transport: vi.fn(),
  balance: vi.fn(async () => 10n ** 18n),
  receipt: vi.fn(async () => null),
  prepare: vi.fn(async () => ({ maxFeePerGas: 1n, gas: 120000n })),
  read: vi.fn(async ({ functionName }: { functionName: string }) =>
    functionName === 'balanceOf' ? 100n : false,
  ),
}));
vi.mock('viem', async (load) => ({
  ...(await load<typeof import('viem')>()),
  http: mocked.transport,
  createPublicClient: () => ({
    getChainId: mocked.chainId,
    call: mocked.call,
    readContract: mocked.read,
    getBlock: async () => ({ timestamp: 1000n }),
    getBalance: mocked.balance,
    getTransactionCount: async () => 0,
    getTransactionReceipt: mocked.receipt,
  }),
  createWalletClient: () => ({
    prepareTransactionRequest: mocked.prepare,
    signTransaction: mocked.sign,
    sendRawTransaction: mocked.send,
  }),
}));
vi.mock('viem/op-stack', () => ({ estimateL1Fee: vi.fn(async () => 10n) }));

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
