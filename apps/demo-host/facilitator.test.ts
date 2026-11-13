import { expect, it, vi } from 'vitest';
import { memoryStore } from '../../packages/annon/src/pay/store.ts';
import { BASE_USDC } from '../../packages/annon/src/settle-near/terms.ts';
import { type Chain, type FacilitatorState, facilitatorFor } from './facilitator.ts';

const auth = {
  from: `0x${'11'.repeat(20)}`,
  to: `0x${'22'.repeat(20)}`,
  value: '1',
  validAfter: '0',
  validBefore: '1120',
  nonce: `0x${'33'.repeat(32)}`,
};
const body = (changes = {}) =>
  ({
    paymentRequirements: { network: 'eip155:8453', asset: BASE_USDC, payTo: auth.to, amount: '1' },
    paymentPayload: {
      payload: { authorization: { ...auth, ...changes }, signature: `0x${'44'.repeat(65)}` },
    },
  }) as never;
const o = () => ({ signal: new AbortController().signal });
function fake() {
  const chain: Chain = {
    timestamp: vi.fn(async () => 1000),
    used: vi.fn(async () => false),
    balance: vi.fn(async () => 1n),
    simulate: vi.fn(async () => true),
    sign: vi.fn(async () => ({ serialized: 'signed', hash: 'hash', maxCostWei: 20n })),
    send: vi.fn(async () => 'hash'),
    receipt: vi.fn(async () => null),
    ethBalance: vi.fn(async () => 10n ** 18n),
    transaction: vi.fn(async () => true),
    minedNonce: async () => 0,
    nonceClear: vi.fn(async () => true),
  };
  return chain;
}
it('requires remaining Base validity, forwards the simulation timestamp margin, and checks balance', async () => {
  const c = fake();
  const f = facilitatorFor(c);
  expect((await f(body({ validBefore: '1059' }), o())).errorReason).toBe('payment_expired');
  expect(c.sign).not.toHaveBeenCalled();
  expect(c.simulate).not.toHaveBeenCalled();
  vi.mocked(c.balance).mockResolvedValue(0n);
  expect((await f(body(), o())).errorReason).toBe('invalid_authorization');
  expect(c.sign).not.toHaveBeenCalled();
  expect(c.simulate).not.toHaveBeenCalled();
  vi.mocked(c.balance).mockResolvedValue(1n);
  await f(body({ validBefore: '1060' }), o());
  expect(c.simulate).toHaveBeenCalledWith(
    expect.objectContaining({ validBefore: 1060n }),
    expect.any(String),
    1030,
  );
});
it('checks independent requests concurrently and bounds only the sign/send queue', async () => {
  const c = fake();
  let release!: () => void;
  vi.mocked(c.send).mockImplementation(
    () =>
      new Promise((r) => {
        release = () => r('hash');
      }),
  );
  const f = facilitatorFor(c, 10, Date.now, { maxWaiting: 1 });
  const first = f(body(), o());
  await vi.waitFor(() => expect(c.send).toHaveBeenCalledOnce());
  const second = f(body({ from: `0x${'55'.repeat(20)}` }), o());
  await vi.waitFor(() => expect(c.simulate).toHaveBeenCalledTimes(2));
  expect((await f(body({ from: `0x${'66'.repeat(20)}` }), o())).errorReason).toBe(
    'facilitator_busy',
  );
  release();
  await first;
  await second;
  expect(c.send).toHaveBeenCalledOnce();
});
it('reserves the full execution plus L1 cost before send and persists the budget', async () => {
  const c = fake();
  const store = memoryStore<FacilitatorState>();
  const f = facilitatorFor(c, 10, () => 0, { store: store as never, dailyGasBudgetWei: 19n });
  expect((await f(body(), o())).errorReason).toBe('unavailable');
  expect(c.send).not.toHaveBeenCalled();
  const allowed = facilitatorFor(c, 10, () => 0, { store: store as never, dailyGasBudgetWei: 20n });
  await allowed(body(), o());
  vi.mocked(c.receipt).mockResolvedValue({ reverted: false, costWei: 20n });
  const restart = facilitatorFor(c, 10, () => 31_000, {
    store: store as never,
    dailyGasBudgetWei: 20n,
  });
  expect((await restart(body({ nonce: `0x${'66'.repeat(32)}` }), o())).errorReason).toBe(
    'unavailable',
  );
  expect(c.send).toHaveBeenCalledOnce();
});
it('stops a reverted payer and stops globally at the daily revert limit across restart', async () => {
  const c = fake();
  const store = memoryStore<FacilitatorState>();
  let now = 0;
  const options = { store: store as never, revertsPerDay: 2 };
  const f = facilitatorFor(c, 10, () => now, options);
  await f(body(), o());
  vi.mocked(c.receipt).mockResolvedValue({ reverted: true, costWei: 3n });
  now += 31_000;
  expect((await f(body({ nonce: `0x${'66'.repeat(32)}` }), o())).errorReason).toBe(
    'payment_rejected',
  );
  await f(body({ from: `0x${'55'.repeat(20)}` }), o());
  const restart = facilitatorFor(c, 10, () => now, options);
  expect((await restart(body({ from: `0x${'77'.repeat(20)}` }), o())).errorReason).toBe(
    'unavailable',
  );
  expect(c.send).toHaveBeenCalledTimes(2);
  now += 86_400_000;
  vi.mocked(c.receipt).mockResolvedValue(null);
  await restart(body({ from: `0x${'88'.repeat(20)}` }), o());
  expect(c.send).toHaveBeenCalledTimes(3);
});
it('never sends behind a lost broadcast and alerts about stuck transactions and low ETH', async () => {
  const c = fake();
  const alert = vi.fn();
  let now = 0;
  vi.mocked(c.send).mockRejectedValue(new Error('lost'));
  vi.mocked(c.ethBalance).mockResolvedValue(0n);
  const f = facilitatorFor(c, 10, () => now, { alert });
  await expect(f(body(), o())).rejects.toThrow('lost');
  now = 121_000;
  expect((await f(body({ from: `0x${'55'.repeat(20)}` }), o())).errorReason).toBe(
    'facilitator_busy',
  );
  expect(c.send).toHaveBeenCalledOnce();
  expect(alert).toHaveBeenCalledWith(expect.objectContaining({ type: 'facilitator_stuck' }));
  expect(alert).toHaveBeenCalledWith(expect.objectContaining({ type: 'facilitator_low_eth' }));
});
it('uses a sliding send window across a minute boundary', async () => {
  const c = fake();
  let now = 59_000;
  const f = facilitatorFor(c, 1, () => now);
  await f(body(), o());
  vi.mocked(c.receipt).mockResolvedValue({ reverted: false, costWei: 1n });
  now = 60_001;
  expect((await f(body({ from: `0x${'55'.repeat(20)}` }), o())).errorReason).toBe(
    'facilitator_busy',
  );
  now = 119_000;
  await f(body({ from: `0x${'55'.repeat(20)}` }), o());
  expect(c.send).toHaveBeenCalledTimes(2);
});
it('rejects future validAfter and rechecks validity after waiting to sign', async () => {
  const c = fake();
  const f = facilitatorFor(c);
  expect((await f(body({ validAfter: '1001' }), o())).errorReason).toBe('invalid_authorization');
  expect(c.sign).not.toHaveBeenCalled();
});
it('keeps unresolved nonce evidence after authorization expiry and refuses an externally blocked wallet', async () => {
  const c = fake();
  let now = 0;
  const f = facilitatorFor(c, 10, () => now);
  await f(body(), o());
  now = 2000000;
  expect((await f(body({ from: `0x${'55'.repeat(20)}` }), o())).errorReason).toBe(
    'facilitator_busy',
  );
  expect(c.send).toHaveBeenCalledOnce();
  const external = fake();
  vi.mocked(external.nonceClear).mockResolvedValue(false);
  expect((await facilitatorFor(external)(body(), o())).errorReason).toBe('facilitator_busy');
  expect(external.sign).not.toHaveBeenCalled();
});
it('does not sign an already used nonce, a refused simulation or an excessive fee', async () => {
  for (const stage of ['used', 'simulate', 'sign'] as const) {
    const c = fake();
    if (stage === 'used') vi.mocked(c.used).mockResolvedValue(true);
    if (stage === 'simulate') vi.mocked(c.simulate).mockResolvedValue(false);
    if (stage === 'sign') vi.mocked(c.sign).mockResolvedValue(null);
    await facilitatorFor(c)(body(), o());
    expect(c.send).not.toHaveBeenCalled();
    if (stage !== 'sign') expect(c.sign).not.toHaveBeenCalled();
  }
});
it('rechecks the validity margin after queue waiting', async () => {
  const c = fake();
  let now = 0;
  let release!: () => void;
  vi.mocked(c.send).mockImplementation(
    () =>
      new Promise((r) => {
        release = () => r('hash');
      }),
  );
  const f = facilitatorFor(c, 10, () => now);
  const first = f(body(), o());
  await vi.waitFor(() => expect(c.send).toHaveBeenCalledOnce());
  const second = f(body({ from: `0x${'55'.repeat(20)}`, validBefore: '1060' }), o());
  await vi.waitFor(() => expect(c.simulate).toHaveBeenCalledTimes(2));
  now = 2000;
  release();
  await first;
  expect((await second).errorReason).toBe('payment_expired');
});
it('returns the known signed hash without another authorization preflight and detects wrong send replies', async () => {
  const c = fake();
  const f = facilitatorFor(c);
  await f(body(), o());
  await f(body(), o());
  expect(c.simulate).toHaveBeenCalledOnce();
  const wrong = fake();
  vi.mocked(wrong.send).mockResolvedValue('wrong');
  await expect(facilitatorFor(wrong)(body(), o())).rejects.toThrow('transaction hash mismatch');
  const missing = facilitatorFor(fake(), 10, Date.now, {
    store: memoryStore(),
    requireState: true,
  });
  await expect(missing.sample()).rejects.toThrow('state is missing');
});
it('alerts when a transaction waits more than fifteen seconds for the wallet queue', async () => {
  const c = fake();
  let now = 0;
  let release!: () => void;
  const alert = vi.fn();
  vi.mocked(c.send).mockImplementation(
    () =>
      new Promise((r) => {
        release = () => r('hash');
      }),
  );
  const f = facilitatorFor(c, 10, () => now, { alert });
  const first = f(body(), o());
  await vi.waitFor(() => expect(c.send).toHaveBeenCalledOnce());
  const second = f(body({ from: `0x${'55'.repeat(20)}` }), o());
  await vi.waitFor(() => expect(c.simulate).toHaveBeenCalledTimes(2));
  now = 16000;
  release();
  await first;
  await second;
  expect(alert).toHaveBeenCalledWith({ type: 'facilitator_wait', seconds: 16 });
});

it('releases a crash-before-send reservation only after expiry plus margin with unused nonce and no transaction', async () => {
  for (const blocked of ['time', 'nonce', 'transaction', 'used', 'none']) {
    const c = fake();
    const store = memoryStore<FacilitatorState>();
    const alert = vi.fn();
    let now = 1_000_000;
    vi.mocked(c.send).mockRejectedValueOnce(new Error('crash before broadcast'));
    const options = { store: store as never, alert };
    await expect(facilitatorFor(c, 10, () => now, options)(body(), o())).rejects.toThrow();
    now = blocked === 'time' ? 1_720_000 : 1_720_001;
    vi.mocked(c.transaction).mockResolvedValue(blocked === 'transaction');
    vi.mocked(c.nonceClear).mockResolvedValue(blocked !== 'nonce');
    vi.mocked(c.used).mockResolvedValue(blocked === 'used');
    const restart = facilitatorFor(c, 10, () => now, options);
    await restart.sample();
    const state = (await store.load('facilitator')) as {
      sends: Record<string, { done: boolean; cost: string }>;
      days: Record<string, { cost: string }>;
    } | null;
    const send = Object.values(state?.sends ?? {})[0];
    expect(send?.done).toBe(blocked === 'none');
    expect(send?.cost).toBe(blocked === 'none' ? '0' : '20');
    expect(state?.days[0]?.cost).toBe(blocked === 'none' ? '0' : '20');
    expect(alert.mock.calls.some(([a]) => a.type === 'facilitator_dropped')).toBe(
      blocked === 'none',
    );
    if (blocked === 'none') {
      await restart(body({ nonce: `0x${'77'.repeat(32)}` }), o());
      expect(c.send).toHaveBeenCalledTimes(2);
    }
  }
});
it('returns the exact remaining UTC budget wait', async () => {
  const c = fake();
  const f = facilitatorFor(c, 10, () => 86_398_001, { dailyGasBudgetWei: 0n });
  expect(await f(body(), o())).toMatchObject({ errorReason: 'unavailable', retryAfterSeconds: 2 });
});

it('seeds facilitator state without a key and refuses missing or malformed initialized state', async () => {
  const { initFacilitatorState } = await import('./facilitator.ts');
  const store = memoryStore<FacilitatorState>();
  await expect(initFacilitatorState(store as never, true)).rejects.toMatchObject({
    reason: 'state_missing',
  });
  await initFacilitatorState(store as never);
  expect(await store.load('facilitator')).toMatchObject({
    id: 'facilitator',
    revision: 0,
    sends: {},
    days: {},
    times: [],
  });
  for (const over of [
    { id: 'wrong' },
    { revision: -1 },
    { revision: 0.5 },
    { sends: null },
    { days: null },
    { times: null },
  ]) {
    const broken = {
      load: async () => ({
        id: 'facilitator',
        revision: 0,
        sends: {},
        days: {},
        times: [],
        ...over,
      }),
      compareAndSet: vi.fn(),
    };
    await expect(initFacilitatorState(broken as never, true)).rejects.toMatchObject({
      reason: 'state_invalid',
    });
    expect(broken.compareAndSet).not.toHaveBeenCalled();
  }
});
it('refuses corrupted durable split reservations and counters instead of resetting their spend', async () => {
  const { initFacilitatorState } = await import('./facilitator.ts');
  const store = memoryStore<FacilitatorState>();
  const valid = { id: 'facilitator', revision: 0, sends: {}, days: {}, times: [] };
  for (const patch of [
    { days: { '0': { cost: '0', reverts: 0, payers: {}, splitCost: '-1' } } },
    { days: { '0': { cost: '0', reverts: 0, payers: {}, deployments: -1 } } },
    {
      sends: {
        'split:test': {
          operation: 'split',
          hash: `0x${'11'.repeat(32)}`,
          payer: `0x${'22'.repeat(20)}`,
          at: 0,
          until: 1000,
          day: 0,
          cost: '10',
          done: false,
        },
      },
    },
  ]) {
    const state = { ...valid, ...patch };
    const broken = { load: async () => state, compareAndSet: vi.fn() };
    await expect(initFacilitatorState(broken as never, true)).rejects.toMatchObject({
      reason: 'state_invalid',
    });
  }
  await initFacilitatorState(store);
});
