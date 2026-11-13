import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { must, purchase as sample, terms } from '../../test/fixtures.js';
import finalizedSettle from '../../test/keeper-final.json' with { type: 'json' };
import type { BudgetRecord } from '../node/budget.js';
import { memoryStore } from '../pay/store.js';
import { termsHash } from '../settle-near/terms.js';
import type { KeeperRecord } from './keeper-runner.js';
import { keep, resetRelayState } from './relay.js';

it('near-api-js decodes blockHash as a plain array, which the keeper must convert', async () => {
  const real = await vi.importActual<typeof import('near-api-js')>('near-api-js');
  const kp = real.KeyPair.fromRandom('ed25519');
  const tx = real.createTransaction(
    'a.near',
    kp.getPublicKey(),
    'b.near',
    1n,
    [real.actions.functionCall('m', {}, 1n, 0n)],
    new Uint8Array(32).fill(7),
  );
  const signed = new real.SignedTransaction({
    transaction: tx,
    signature: new real.Signature({ keyType: 0, data: new Uint8Array(64) }),
  });
  const hash = real.decodeSignedTransaction(real.encodeTransaction(signed)).transaction.blockHash;
  expect(hash instanceof Uint8Array).toBe(false);
  expect(Uint8Array.from(hash)).toEqual(new Uint8Array(32).fill(7));
});

const created = vi.hoisted(() => vi.fn());
vi.mock('near-api-js', async (original) => ({
  ...(await original<typeof import('near-api-js')>()),
  Account: class {
    createSignedTransaction = created;
  },
  decodeSignedTransaction: () => ({
    transaction: {
      nonce: 1n,
      publicKey: { toString: () => 'ed25519:fake' },
      // Real near-api-js 7 decodes the hash as a plain number[] (mainnet keeper failed on it).
      blockHash: Array.from(new Uint8Array(32)),
    },
  }),
  encodeTransaction: () => new Uint8Array([1, 2, 3]),
}));
const d = (id = 0, fund: 0 | 1 | 2 = 0, slots: (0 | 1 | 2)[] = [0]) => ({
  id,
  amount: '10',
  sender: 'intents.near',
  purchase: null as string | null,
  reason: 0,
  fund: { state: fund, attempt: 0 },
  funded: fund === 2 ? '10' : '0',
  slots: slots.map((state) => ({
    to: { kind: 'near', id: 'seller.near' },
    amount: '10',
    step: { state, attempt: 0 },
  })),
});
let all = [d()];
let final = false;
let reason = '';
let failSend = false;
let sendRejection: unknown;
let accountAmount = '10000000000000000000000000';
let unknown = false;
let keyNonce = 0;
let referenceHeight = 99999;
let finalHeight = 100000;
let referenceUnavailable = false;
let failureExecutor = 'intents.near';
let queries: { method: string; params: Record<string, unknown> }[];
const opts = () => ({
  nearRpc: 'https://rpc',
  network: 'near:mainnet',
  contractId: 'annon.near',
  sender: { accountId: 'keeper.near', key: 'ed25519:fake' },
  store: memoryStore<KeeperRecord>(),
  budgetStore: memoryStore<BudgetRecord>(),
  hourlyBudget: 10n ** 24n,
  dailyBudget: 10n ** 24n,
  gasPrice: 100000000n,
  now: () => 100000,
  jitter: () => 0.5,
});
beforeEach(() => {
  resetRelayState();
  created.mockReset();
  let nonce = 0;
  created.mockImplementation(async () => {
    const n = ++nonce;
    return { transaction: { encode: () => new Uint8Array([1, 2, n]) } };
  });
  all = [d()];
  final = false;
  reason = '';
  failSend = false;
  sendRejection = undefined;
  accountAmount = '10000000000000000000000000';
  unknown = false;
  keyNonce = 0;
  referenceHeight = 99999;
  finalHeight = 100000;
  referenceUnavailable = false;
  failureExecutor = 'intents.near';
  queries = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_u, init) => {
      const q = JSON.parse(String(init?.body));
      queries.push({ method: q.method, params: q.params });
      let result: unknown;
      if (q.method === 'block' && q.params.block_id && referenceUnavailable)
        return Response.json({ id: q.id, error: { cause: { name: 'UNKNOWN_BLOCK' } } });
      if (q.method === 'block')
        result = {
          header: {
            hash: q.params.block_id ?? 'FINAL-BLOCK',
            height: q.params.block_id ? referenceHeight : finalHeight,
          },
        };
      else if (q.method === 'EXPERIMENTAL_protocol_config')
        result = {
          transaction_validity_period: 86400,
          runtime_config: {
            storage_amount_per_byte: '10000000000000000000',
            min_gas_purchase_price: '1000000000',
            transaction_costs: {
              action_receipt_creation_config: {
                send_sir: 108059500000,
                send_not_sir: 108059500000,
                execution: 108059500000,
              },
              action_creation_config: {
                function_call_cost: {
                  send_sir: 200000000000,
                  send_not_sir: 200000000000,
                  execution: 780000000000,
                },
                function_call_cost_per_byte: {
                  send_sir: 2235934,
                  send_not_sir: 47683715,
                  execution: 2235934,
                },
              },
            },
          },
        };
      else if (q.method === 'query' && q.params.request_type === 'view_account')
        result = { amount: accountAmount, locked: '0', storage_usage: 1000 };
      else if (q.method === 'query' && q.params.request_type === 'view_access_key')
        result = { nonce: keyNonce, permission: 'FullAccess' };
      else if (q.method === 'gas_price') result = { gas_price: '100000000' };
      else if (q.method === 'query') {
        const a = JSON.parse(Buffer.from(q.params.args_base64, 'base64').toString());
        const value =
          q.params.method_name === 'open_delivery_count'
            ? all.length
            : q.params.method_name === 'list_open_deliveries'
              ? all.slice(a.from, a.from + a.limit)
              : q.params.method_name === 'get_delivery'
                ? (all.find((x) => x.id === a.delivery_id) ?? null)
                : q.params.method_name === 'get_purchase'
                  ? {
                      purchase_id: a.purchase_id,
                      file_id: terms.file_id,
                      terms_hash: termsHash(terms),
                      buyer_key: sample.buyer_key,
                      recovery: sample.recovery,
                      route: 'near-usdc',
                      delivery: 0,
                      accepted_at: 1,
                      grants: 1,
                    }
                  : q.params.method_name === 'get_file'
                    ? {
                        terms: { ...terms, near: { ...terms.near, price: '10' } },
                        terms_hash: termsHash({ ...terms, near: { ...terms.near, price: '10' } }),
                        header_hash: null,
                        sales_stopped_at: null,
                        taken_down: null,
                      }
                    : '0';
        result = { result: [...Buffer.from(JSON.stringify(value))] };
      } else if (q.method === 'send_tx') {
        if (failSend) throw new Error('transport');
        if (sendRejection) return Response.json({ id: q.id, error: sendRejection });
        result = { final_execution_status: 'INCLUDED' };
      } else if (unknown)
        return Response.json({ id: q.id, error: { cause: { name: 'UNKNOWN_TRANSACTION' } } });
      else
        result = final
          ? {
              ...structuredClone(finalizedSettle),
              transaction: { ...finalizedSettle.transaction, hash: q.params.tx_hash },
              transaction_outcome: { ...finalizedSettle.transaction_outcome, id: q.params.tx_hash },
              receipts_outcome: reason
                ? [
                    {
                      id: 'receipt-1',
                      block_hash: 'FINAL-BLOCK',
                      outcome: {
                        executor_id: failureExecutor,
                        status: { Failure: reason },
                        logs: [],
                      },
                    },
                    {
                      outcome: {
                        executor_id: 'annon.near',
                        status: { SuccessValue: '' },
                        logs: [
                          'EVENT_JSON:' +
                            JSON.stringify({
                              standard: 'annon',
                              version: '2.0.0',
                              event: 'funding_failed',
                              data: [
                                {
                                  delivery_id: 0,
                                  attempt: 1,
                                  state: 'Pending',
                                  reason: 'incomplete_deposit',
                                },
                              ],
                            }),
                        ],
                      },
                    },
                  ]
                : structuredClone(finalizedSettle.receipts_outcome),
            }
          : { final_execution_status: 'INCLUDED' };
      return Response.json({ id: q.id, result });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
describe('durable settle keeper', () => {
  it('pins count/pages to a finalized block and settles with 600/450 Tgas, never funding InFlight', async () => {
    all = [d(0), d(1, 1), d(2, 2, [0, 1, 2])];
    const r = await keep(opts());
    expect(r.sent).toHaveLength(2);
    expect(created.mock.calls.map(([tx]) => tx.actions[0].functionCall.methodName)).toEqual([
      'settle',
      'settle',
    ]);
    expect(created.mock.calls.map(([tx]) => tx.actions[0].functionCall.gas)).toEqual([
      600000000000000n,
      450000000000000n,
    ]);
    const views = queries.filter((x) =>
      ['open_delivery_count', 'list_open_deliveries'].includes(String(x.params.method_name)),
    );
    expect(
      views.every((x) => x.params.block_id === 'FINAL-BLOCK' && !('finality' in x.params)),
    ).toBe(true);
  });
  it('persists uncertain submissions across restart and never signs again on INCLUDED or InFlight', async () => {
    const o = opts();
    await keep(o);
    await keep({ ...o });
    expect(created).toHaveBeenCalledTimes(1);
    final = true;
    all = [d(0, 1)];
    await keep(o);
    await keep(o);
    expect(created).toHaveBeenCalledTimes(1);
  });
  it('backs off finalized failure 1,2,4 minutes and does not reset on RPC outage/inclusion', async () => {
    const o = opts();
    let now = 100000;
    o.now = () => now;
    await keep(o);
    final = true;
    reason = 'transfer failed';
    await keep(o);
    now += 59999;
    await keep(o);
    expect(created).toHaveBeenCalledTimes(1);
    now += 1;
    await keep(o);
    expect(created).toHaveBeenCalledTimes(2);
    await keep(o);
    now += 60000;
    await keep(o);
    expect(created).toHaveBeenCalledTimes(2);
    now += 60000;
    await keep(o);
    expect(created).toHaveBeenCalledTimes(3);
  });
  it('enforces persistent gas reservations before signing and reports reserve low-water alerts', async () => {
    const o = { ...opts(), hourlyBudget: 1n, reserveLowWater: 5n, alert: vi.fn() };
    const r = await keep(o);
    expect(created).not.toHaveBeenCalled();
    expect(r.errors[0]?.error).toMatchObject({ code: 'budget_exceeded' });
    expect(o.alert).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reserve_low', reserve: '0' }),
    );
  });
  it('opens one shared breaker for locked/paused dependencies', async () => {
    const o = opts();
    await keep(o);
    final = true;
    reason = 'sender is locked';
    all = [d(), d(1)];
    await keep(o);
    expect(created).toHaveBeenCalledTimes(1);
  });
  it('materializes pluggable refund leaves with zero deposit and prepaid storage', async () => {
    all = [];
    const leaf = {
      leaf: { delivery_id: 7, refund: { kind: 'near' as const, id: 'buyer.near' }, amount: '1' },
      index: 0,
      proof: Array(32).fill(`0x${'00'.repeat(32)}`),
    };
    const o = { ...opts(), refunds: { leaves: async () => [leaf] } };
    const r = await keep(o);
    expect(r.sent[0]?.method).toBe('materialize_refund');
    expect(created.mock.calls[0]?.[0].actions[0].functionCall.deposit).toBe(0n);
  });
  it('rotates snapshot pages across restarts without a 10000 eligibility cap', async () => {
    all = Array.from({ length: 10001 }, (_, i) => d(i, i === 10000 ? 0 : 1));
    const o = { ...opts(), maxPages: 100 };
    await keep(o);
    expect(created).not.toHaveBeenCalled();
    await keep({ ...o });
    expect(created).not.toHaveBeenCalled();
    await keep({ ...o });
    expect(created).toHaveBeenCalledTimes(1);
  });
});

it('recovers a crash before the durable signed hash without allowing an older signer to send', async () => {
  const o = opts();
  const id = 'near:mainnet|annon.near|delivery:0|submission';
  await o.store.compareAndSet(id, null, { id, revision: 0, stage: 'preparing' });
  const active = 'near:mainnet|annon.near|active:keeper.near';
  await o.store.compareAndSet(active, null, {
    id: active,
    revision: 0,
    active: [{ id, deliveryId: 0 }],
  });
  await keep(o);
  expect(created).toHaveBeenCalledTimes(1);
});

it('recovers never-broadcast signed bytes by resending the same transaction, but never during InFlight', async () => {
  const o = opts();
  unknown = true;
  const id = 'near:mainnet|annon.near|delivery:0|submission';
  await o.store.compareAndSet(id, null, {
    id,
    revision: 0,
    stage: 'submitted',
    tx: {
      hash: 'SAME-HASH',
      signer: o.sender.accountId,
      signed: 'U0FNRS1CWVRFUw==',
      method: 'settle',
      args: { delivery_id: 0 },
      phases: ['fund'],
    },
  });
  const active = 'near:mainnet|annon.near|active:keeper.near';
  await o.store.compareAndSet(active, null, {
    id: active,
    revision: 0,
    active: [{ id, deliveryId: 0 }],
  });
  await keep(o);
  expect(
    queries.filter((q) => q.method === 'send_tx').map((q) => q.params.signed_tx_base64),
  ).toEqual(['U0FNRS1CWVRFUw==']);
  expect(created).not.toHaveBeenCalled();
  all = [d(0, 1)];
  await keep(o);
  expect(queries.filter((q) => q.method === 'send_tx')).toHaveLength(1);
});

it('a signer that loses the durable hash CAS never broadcasts', async () => {
  const { runKeeper } = await import('./keeper-runner.js');
  const o = opts();
  let finish: (tx: { txHash: string; signed: string }) => void = () => {};
  let started: () => void = () => {};
  const signing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const first = {
    sign: async () => {
      started();
      return new Promise<{ txHash: string; signed: string }>((resolve) => {
        finish = resolve;
      });
    },
    send: vi.fn(async () => ({ txHash: 'old' })),
  };
  const pass = runKeeper(o, first);
  await signing;
  const second = {
    sign: vi.fn(async () => ({ txHash: 'new', signed: 'bmV3LWJ5dGVz' })),
    send: vi.fn(async () => ({ txHash: 'new' })),
  };
  await runKeeper({ ...o, sender: { ...o.sender, accountId: 'other-keeper.near' } }, second);
  finish({ txHash: 'old', signed: 'b2xkLWJ5dGVz' });
  await pass;
  expect(first.send).not.toHaveBeenCalled();
  expect(second.send).toHaveBeenCalledTimes(1);
});

it('caps retry intervals at 30 minutes with bounded jitter', async () => {
  const { retryDelay } = await import('./keeper-runner.js');
  expect([1, 2, 3, 4, 5, 6, 7].map((n) => retryDelay(n, 0.5))).toEqual(
    [1, 2, 4, 8, 16, 30, 30].map((n) => n * 60000),
  );
  expect(retryDelay(6, 0)).toBe(27 * 60000);
  expect(retryDelay(6, 1)).toBe(33 * 60000);
});

it('admits only one shared breaker probe after the deadline', async () => {
  const o = opts();
  let now = 100000;
  o.now = () => now;
  await keep(o);
  final = true;
  reason = 'sender is locked';
  all = [d(), d(1), d(2)];
  await keep(o);
  expect(created).toHaveBeenCalledTimes(1);
  now += 60000;
  await keep(o);
  expect(created).toHaveBeenCalledTimes(2);
});

it('a real finalized result with block_hash never trips the breaker and verified progress closes it', async () => {
  const o = opts();
  await keep(o);
  final = true;
  all = [d(0, 2, [2]), d(1)];
  await keep(o);
  expect(created).toHaveBeenCalledTimes(2);
  expect((await o.store.load('near:mainnet|annon.near|breaker'))?.tries ?? 0).toBe(0);
});

it('ignores lock text in failures from untrusted executors', async () => {
  const o = opts();
  await keep(o);
  final = true;
  reason = 'locked';
  failureExecutor = 'attacker.near';
  all = [d(), d(1)];
  await keep(o);
  expect(created).toHaveBeenCalledTimes(2);
});

it.each(['nonce', 'age'] as const)(
  'retires UNKNOWN_TRANSACTION that cannot land by final %s and releases unresolved capacity',
  async (why) => {
    const o = { ...opts(), maxUnresolved: 1 };
    await keep(o);
    unknown = true;
    if (why === 'nonce') keyNonce = 1;
    else finalHeight = referenceHeight + 86403;
    all = [d(), d(1)];
    const r = await keep(o);
    expect(r.sent).toHaveLength(1); // fresh second delivery, never the expired bytes
    expect(created).toHaveBeenCalledTimes(2);
    const job = await o.store.load('near:mainnet|annon.near|delivery:0|submission');
    expect(job).toMatchObject({ tx: null, stage: 'ready', tries: 1, nextAt: 160000 });
    expect(
      queries.some(
        (q) => q.params.request_type === 'view_access_key' && q.params.block_id === 'FINAL-BLOCK',
      ),
    ).toBe(true);
  },
);

it('keeps jobs and gas reservations across an RPC endpoint change', async () => {
  const o = opts();
  await keep(o);
  await keep({ ...o, nearRpc: 'https://other.rpc' });
  expect(created).toHaveBeenCalledTimes(1);
  expect(await o.budgetStore.load('near:mainnet|keeper.near|keeper-spend')).not.toBeNull();
});

it('reclaims an expired unknown transaction even after its reference block has been garbage-collected', async () => {
  const o = { ...opts(), maxUnresolved: 1 };
  await keep(o);
  unknown = true;
  referenceUnavailable = true;
  finalHeight = referenceHeight + 86403;
  all = [d(), d(1)];
  const r = await keep(o);
  const job = await o.store.load('near:mainnet|annon.near|delivery:0|submission');
  expect(job).toMatchObject({ tx: null, nextAt: 160000 });
  expect(r.sent).toHaveLength(0); // A new signed reference is unavailable too; nothing broadcasts.
  const active = await o.store.load('near:mainnet|annon.near|active:keeper.near');
  expect(active?.active).toEqual([]);
  expect(created).toHaveBeenCalledTimes(2);
});

it('queries gas price at the finalized snapshot hash', async () => {
  await keep(opts());
  expect(queries.find((q) => q.method === 'gas_price')?.params).toEqual({
    block_id: 'FINAL-BLOCK',
  });
});

it('saves phase observations so later partial funding resets a stale deadline', async () => {
  const o = opts();
  await keep(o);
  final = true;
  reason = 'transfer failed';
  await keep(o);
  const id = 'near:mainnet|annon.near|delivery:0|fund';
  expect((await o.store.load(id))?.observed).toEqual({ funded: '0', paid: [] });
  all[0] = { ...d(), funded: '1' };
  final = false;
  await keep(o);
  expect(created).toHaveBeenCalledTimes(2);
});

it('closes a half-open dependency breaker only after verified finalized progress', async () => {
  const o = opts();
  let now = 100000;
  o.now = () => now;
  await keep(o);
  final = true;
  reason = 'sender locked';
  await keep(o);
  expect((await o.store.load('near:mainnet|annon.near|breaker'))?.tries).toBe(1);
  now += 60000;
  final = false;
  reason = '';
  await keep(o);
  final = true;
  all = [d(0, 2, [2]), d(1)];
  await keep(o);
  expect((await o.store.load('near:mainnet|annon.near|breaker'))?.tries).toBe(0);
  expect(created).toHaveBeenCalledTimes(3);
});

it('still charges the same gas budget for a new delivery after an RPC switch', async () => {
  const o = { ...opts(), hourlyBudget: 120000000000000000000000n };
  await keep(o);
  final = true;
  all = [d(0, 2, [2]), d(1)];
  const result = await keep({ ...o, nearRpc: 'https://other.rpc' });
  expect(created).toHaveBeenCalledTimes(1);
  expect(result.errors.some((e) => (e.error as { code?: string }).code === 'budget_exceeded')).toBe(
    true,
  );
});

it.each([86400, 86401, 86402, 86403])(
  'keeps unknown bytes until strictly beyond the validity period plus two blocks (age=%s)',
  async (age) => {
    const o = { ...opts(), maxUnresolved: 1 };
    await keep(o);
    unknown = true;
    finalHeight = referenceHeight + age;
    all = [d(), d(1)];
    const r = await keep(o);
    const job = await o.store.load('near:mainnet|annon.near|delivery:0|submission');
    expect(job?.tx === null).toBe(age > 86402);
    expect(r.sent).toHaveLength(1); // Still-valid bytes may be resent unchanged.
    expect(created).toHaveBeenCalledTimes(age > 86402 ? 2 : 1);
  },
);

it('skips signing, budget reservation and tx persistence on low liquid balance, alerts only on transitions across restart', async () => {
  const o = { ...opts(), alert: vi.fn() };
  accountAmount = '449700000000000000000000';
  await keep(o);
  await keep({ ...o });
  expect(created).not.toHaveBeenCalled();
  expect(await o.budgetStore.load('near:mainnet|keeper.near|keeper-spend')).toBeNull();
  expect((await o.store.load('near:mainnet|annon.near|delivery:0|submission'))?.tx).toBeUndefined();
  expect(o.alert).toHaveBeenCalledTimes(1);
  expect(o.alert).toHaveBeenCalledWith({
    type: 'low_balance',
    balance: '439700000000000000000000',
    needed: '600919026549026500000000',
  });
  expect(queries.find((q) => q.params.request_type === 'view_account')?.params).toEqual({
    request_type: 'view_account',
    block_id: 'FINAL-BLOCK',
    account_id: 'keeper.near',
  });
  accountAmount = '10000000000000000000000000';
  await keep(o);
  expect(created).toHaveBeenCalledTimes(1);
  all = [d(1)];
  accountAmount = '449700000000000000000000';
  await keep(o);
  expect(o.alert.mock.calls.filter(([a]) => a.type === 'low_balance')).toHaveLength(2);
});
it('honors a configured keeper liquid balance low water even when the transaction is affordable', async () => {
  const o = { ...opts(), balanceLowWater: 20n * 10n ** 24n, alert: vi.fn() };
  await keep(o);
  expect(created).not.toHaveBeenCalled();
  expect(o.alert).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'low_balance', needed: o.balanceLowWater.toString() }),
  );
});
it.each([
  { data: { TxExecutionError: { InvalidTxError: { NotEnoughAllowance: {} } } } },
  {
    data: {
      TxExecutionError: { InvalidTxError: { NotEnoughBalance: { balance: '1', cost: '2' } } },
    },
  },
  {
    name: 'HANDLER_ERROR',
    cause: {
      name: 'INVALID_TRANSACTION',
      info: { InvalidTxError: { InvalidAccessKeyError: { NotEnoughAllowance: {} } } },
    },
  },
])(
  'retires a definite send rejection without resending identical bytes or marking uncertainty: %j',
  async (rejection) => {
    const o = opts();
    sendRejection = rejection;
    const r = await keep(o);
    expect(r.incidents).toContainEqual(
      expect.objectContaining({ classification: 'rejected', deliveryId: 0 }),
    );
    expect(r.incidents.some((i) => i.classification === 'uncertain')).toBe(false);
    expect((await o.store.load('near:mainnet|annon.near|delivery:0|submission'))?.tx).toBeNull();
    unknown = true;
    await keep(o);
    expect(queries.filter((q) => q.method === 'send_tx')).toHaveLength(1);
  },
);

it('retires a definite rejection during recovery without resending on following passes', async () => {
  const o = opts();
  failSend = true;
  await keep(o);
  const bytes = queries.filter((q) => q.method === 'send_tx').map((q) => q.params.signed_tx_base64);
  expect(new Set(bytes).size).toBe(1);
  failSend = false;
  unknown = true;
  sendRejection = { data: { TxExecutionError: { InvalidTxError: 'Expired' } } };
  const r = await keep(o);
  expect(r.incidents).toContainEqual(expect.objectContaining({ classification: 'rejected' }));
  expect(r.incidents.some((i) => i.classification === 'uncertain')).toBe(false);
  const count = queries.filter((q) => q.method === 'send_tx').length;
  await keep(o);
  expect(queries.filter((q) => q.method === 'send_tx')).toHaveLength(count);
});
it('fails closed without signing when the final balance query is unavailable', async () => {
  const original = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      const q = JSON.parse(String(init?.body));
      return q.params.request_type === 'view_account'
        ? Response.json({ id: q.id, error: { message: 'unavailable' } })
        : original(url, init);
    }),
  );
  const o = opts();
  const r = await keep(o);
  expect(r.errors).toHaveLength(1);
  expect(created).not.toHaveBeenCalled();
  expect(await o.budgetStore.load('near:mainnet|keeper.near|keeper-spend')).toBeNull();
});

it.each(['legacy', 'modern'])(
  'retains an included tx after an InvalidNonce resend (%s) and resolves its outcome',
  async (shape) => {
    const o = opts();
    await keep(o);
    const id = 'near:mainnet|annon.near|delivery:0|submission';
    const originalJob = await o.store.load(id);
    unknown = true;
    const invalid = { InvalidNonce: { tx_nonce: 1, ak_nonce: 1 } };
    sendRejection =
      shape === 'legacy'
        ? { data: { TxExecutionError: { InvalidTxError: invalid } } }
        : { cause: { name: 'INVALID_TRANSACTION', info: { InvalidTxError: invalid } } };
    const originalFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        const reply = await originalFetch(url, init);
        if (JSON.parse(String(init?.body)).method === 'send_tx') unknown = false;
        return reply;
      }),
    );
    const result = await keep(o);
    expect(result.incidents.some((i) => i.classification === 'rejected')).toBe(false);
    expect((await o.store.load(id))?.tx).toEqual(originalJob?.tx);
    expect(queries.filter((q) => q.method === 'tx')).toHaveLength(2);
    expect(created).toHaveBeenCalledTimes(1);
    final = true;
    all = [d(0, 2, [2])];
    await keep(o);
    expect((await o.store.load(id))?.tx).toBeNull();
    expect((await o.store.load('near:mainnet|annon.near|active:keeper.near'))?.active).toEqual([]);
    expect(created).toHaveBeenCalledTimes(1);
  },
);

it('keeps InvalidNonce and unrecognized invalid-transaction replies uncertain until final proof', async () => {
  for (const error of [
    { cause: { name: 'INVALID_TRANSACTION', info: { InvalidTxError: { InvalidNonce: {} } } } },
    { cause: { name: 'INVALID_TRANSACTION' } },
    { data: { TxExecutionError: { InvalidTxError: 'FutureVariant' } } },
  ]) {
    resetRelayState();
    const o = opts();
    unknown = true;
    sendRejection = error;
    const result = await keep(o);
    expect(result.sent[0]?.result).toMatchObject({ uncertain: true });
    expect((await o.store.load('near:mainnet|annon.near|delivery:0|submission'))?.tx).toBeTruthy();
    keyNonce = 1;
    const resolved = await keep(o);
    expect(resolved.incidents).toContainEqual(
      expect.objectContaining({ reason: 'nonce consumed at finality' }),
    );
    keyNonce = 0;
  }
});

it('deduplicates InFlight alerts per delivery across passes, restarts and funding/payout phases', async () => {
  const o = { ...opts(), alert: vi.fn() };
  all = [d(0, 1), d(1, 2, [1])];
  await keep(o);
  await keep({ ...o });
  all = [d(0, 2, [1]), d(1, 2, [1])];
  await keep({ ...o });
  expect(o.alert.mock.calls.map(([a]) => a)).toEqual([
    { type: 'in_flight', deliveryId: 0 },
    { type: 'in_flight', deliveryId: 1 },
  ]);
});

it.each([false, true])(
  'alerts again after a delivery leaves InFlight (removed=%s)',
  async (removed) => {
    const o = { ...opts(), alert: vi.fn() };
    const id = 'near:mainnet|annon.near|delivery:0|submission';
    all = [d(0, 1)];
    await keep(o);
    all = removed ? [] : [d(0, 2, [2])];
    // A delivery can disappear between the indexed snapshot and its fresh state read.
    if (removed) {
      const original = globalThis.fetch;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url, init) => {
          const q = JSON.parse(String(init?.body));
          const value =
            q.params.method_name === 'open_delivery_count'
              ? 1
              : q.params.method_name === 'list_open_deliveries'
                ? [d(0, 1)]
                : undefined;
          return value === undefined
            ? original(url, init)
            : Response.json({
                id: q.id,
                result: { result: [...Buffer.from(JSON.stringify(value))] },
              });
        }),
      );
      await keep({ ...o });
      vi.stubGlobal('fetch', original);
    } else await keep({ ...o });
    expect((await o.store.load(id))?.inFlightAlerted).toBe(false);
    all = [d(0, 2, [1])];
    await keep({ ...o });
    await keep({ ...o });
    expect(o.alert.mock.calls.map(([a]) => a)).toEqual([
      { type: 'in_flight', deliveryId: 0 },
      { type: 'in_flight', deliveryId: 0 },
    ]);
    expect(created).not.toHaveBeenCalled();
  },
);

it('continues runnable payout work after losing the InFlight alert CAS', async () => {
  const o = { ...opts(), alert: vi.fn() };
  all = [d(0, 2, [1, 0])];
  const cas = o.store.compareAndSet.bind(o.store);
  let raced = false;
  vi.spyOn(o.store, 'compareAndSet').mockImplementation(async (id, old, next) => {
    if (!raced && next?.inFlightAlerted) {
      raced = true;
      expect(await cas(id, old, next)).toBe(true);
      return false;
    }
    return cas(id, old, next);
  });
  const result = await keep(o);
  expect(raced).toBe(true);
  expect(o.alert).not.toHaveBeenCalled();
  expect(result.incidents).toContainEqual({ classification: 'in_flight', deliveryId: 0 });
  expect(result.errors).toEqual([]);
  expect(result.sent).toHaveLength(1);
  expect(created).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  'judges low balance once per pass using the largest cost (reverse=%s)',
  async (reverse) => {
    const o = { ...opts(), hourlyBudget: 1n, alert: vi.fn() };
    accountAmount = '550000000000000000000000';
    all = reverse ? [d(0, 2), d(1)] : [d(0), d(1, 2)];
    await keep(o);
    await keep({ ...o });
    expect(o.alert).toHaveBeenCalledTimes(1);
    expect(o.alert).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'low_balance', needed: '600919026549026500000000' }),
    );
    expect((await o.store.load('near:mainnet|keeper.near|balance'))?.balanceLow).toBe(true);
  },
);

it('does not consume a half-open breaker probe while balance is low', async () => {
  const o = opts();
  const id = 'near:mainnet|annon.near|breaker';
  const breaker = { id, revision: 0, tries: 1, nextAt: 99999 };
  await o.store.compareAndSet(id, null, breaker);
  accountAmount = '1';
  await keep(o);
  expect(await o.store.load(id)).toEqual(breaker);
  accountAmount = '10000000000000000000000000';
  await keep(o);
  expect(created).toHaveBeenCalledTimes(1);
});

it('skips delivery reads during snapshot job and phase backoff and caches reserve reads for a minute', async () => {
  const o = opts();
  const id = 'near:mainnet|annon.near|delivery:0|fund';
  await o.store.compareAndSet(id, null, { id, revision: 0, nextAt: 200000 });
  await keep(o);
  await keep({ ...o });
  expect(queries.filter((q) => q.params.method_name === 'get_delivery')).toHaveLength(0);
  expect(queries.filter((q) => q.params.method_name === 'receiver_reserve')).toHaveLength(1);
  o.now = () => 160000;
  await keep(o);
  expect(queries.filter((q) => q.params.method_name === 'receiver_reserve')).toHaveLength(2);
  expect(created).not.toHaveBeenCalled();
});
it('reconciles a FINAL reservation to tokens burnt once across restarts', async () => {
  const o = opts();
  const scope = 'near:mainnet|keeper.near|keeper-spend';
  await keep(o);
  const reserved = BigInt((await o.budgetStore.load(scope))?.daily ?? '0');
  expect(reserved).toBeGreaterThan(0n);
  await keep({ ...o });
  expect(BigInt((await o.budgetStore.load(scope))?.daily ?? '0')).toBe(reserved);
  final = true;
  all = [];
  await keep({ ...o });
  const actual =
    BigInt(finalizedSettle.transaction_outcome.outcome.tokens_burnt) +
    finalizedSettle.receipts_outcome.reduce((sum, r) => sum + BigInt(r.outcome.tokens_burnt), 0n);
  expect(BigInt((await o.budgetStore.load(scope))?.daily ?? '0')).toBe(actual);
  await keep({ ...o });
  expect(BigInt((await o.budgetStore.load(scope))?.daily ?? '0')).toBe(actual);
});

it('reports snapshot InFlight incidents during backoff without extra delivery reads or repeated alerts', async () => {
  const o = { ...opts(), alert: vi.fn() };
  all = [d(0, 2, [1, 0])];
  const id = 'near:mainnet|annon.near|delivery:0|submission';
  await o.store.compareAndSet(id, null, { id, revision: 0, nextAt: 200000 });
  for (let i = 0; i < 2; i++)
    expect((await keep(o)).incidents).toContainEqual({
      classification: 'in_flight',
      deliveryId: 0,
    });
  expect(o.alert).toHaveBeenCalledExactlyOnceWith({ type: 'in_flight', deliveryId: 0 });
  expect(queries.filter((q) => q.params.method_name === 'get_delivery')).toHaveLength(0);
  expect(created).not.toHaveBeenCalled();
});

it('skips dust purchase payouts but always sponsors dust refunds', async () => {
  all = [{ ...d(0), purchase: `0x${'12'.repeat(32)}` }, d(1)];
  const result = await keep({ ...opts(), minPayout: 10000n });
  expect(result.sent.map((s) => (s.args as { delivery_id: number }).delivery_id)).toEqual([1]);
});

it('sponsors a dust purchase with an excess refund slot', async () => {
  all = [{ ...d(0, 0, [0, 0]), purchase: `0x${'12'.repeat(32)}`, amount: '11' }];
  const result = await keep({ ...opts(), minPayout: 10000n });
  expect(result.sent).toHaveLength(1);
});

it('persists the dust verdict per delivery across passes and policy changes', async () => {
  all = [{ ...d(), purchase: `0x${'12'.repeat(32)}` }];
  const o = opts();
  await keep({ ...o, minPayout: 100000n });
  const first = queries.filter(
    (q) => q.params.method_name === 'get_purchase' || q.params.method_name === 'get_file',
  ).length;
  queries = [];
  await keep({ ...o, minPayout: 0n });
  expect(first).toBeGreaterThan(0);
  expect(
    queries.filter(
      (q) => q.params.method_name === 'get_purchase' || q.params.method_name === 'get_file',
    ),
  ).toHaveLength(0);
  expect(created).not.toHaveBeenCalled();
});

it('emits uncertainty once per persisted submission and contains it across restart', async () => {
  const o = opts();
  const alert = vi.fn();
  await keep({ ...o, alert });
  await keep({ ...o, alert });
  await keep({ ...o, alert });
  expect(alert.mock.calls.filter(([a]) => a.type === 'uncertain')).toHaveLength(1);
});

it('uses the 0.10 USDC default and retains the dust verdict after repeated passes', async () => {
  const amount = '50000';
  all = [
    {
      ...d(),
      purchase: `0x${'12'.repeat(32)}`,
      amount,
      slots: [{ ...must(d().slots[0]), amount }],
    },
  ];
  const fetcher = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    async (url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      const q = JSON.parse(String(init?.body));
      if (q.params?.method_name === 'get_file') {
        const t = { ...terms, near: { ...terms.near, price: amount } };
        return Response.json({
          id: q.id,
          result: {
            result: [
              ...Buffer.from(
                JSON.stringify({
                  terms: t,
                  terms_hash: termsHash(t),
                  header_hash: null,
                  sales_stopped_at: null,
                  taken_down: null,
                }),
              ),
            ],
          },
        });
      }
      return fetcher(url, init);
    },
  );
  const o = opts();
  await keep(o);
  queries = [];
  await keep(o);
  expect(created).not.toHaveBeenCalled();
  expect(queries.filter((q) => q.params.method_name === 'get_purchase')).toHaveLength(0);
});

it('tracks open-delivery age durably and alerts once after the configured wait', async () => {
  const o = opts(),
    alert = vi.fn();
  let now = 100000;
  await keep({ ...o, now: () => now, alert });
  now += 1800001;
  await keep({ ...o, now: () => now, alert });
  await keep({ ...o, now: () => now, alert });
  expect(alert.mock.calls.filter(([a]) => a.type === 'old_delivery')).toEqual([
    [{ type: 'old_delivery', deliveryId: 0, seconds: 1800 }],
  ]);
});

it('alerts immediately when the initial keeper send is uncertain', async () => {
  failSend = true;
  unknown = true;
  const alert = vi.fn();
  await keep({ ...opts(), alert });
  expect(alert.mock.calls.filter(([a]) => a.type === 'uncertain')).toHaveLength(1);
});

it('alerts again when the same delivery starts a new uncertain transaction', async () => {
  const o = opts(),
    alert = vi.fn();
  failSend = true;
  unknown = true;
  await keep({ ...o, alert });
  const id = 'near:mainnet|annon.near|delivery:0|submission';
  const old = await o.store.load(id);
  if (!old) throw new Error('missing submitted job');
  await o.store.compareAndSet(id, old, {
    ...old,
    revision: old.revision + 1,
    tx: null,
    stage: 'ready',
    nextAt: 0,
  });
  await keep({ ...o, alert });
  expect(alert.mock.calls.filter(([a]) => a.type === 'uncertain')).toHaveLength(2);
});

it('continues the keeper page when one dust lookup is unavailable', async () => {
  all = [{ ...d(0), purchase: `0x${'12'.repeat(32)}` }, d(1)];
  const fetcher = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    async (url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
      const q = JSON.parse(String(init?.body));
      if (q.params?.method_name === 'get_purchase')
        return Response.json({ id: q.id, error: { cause: { name: 'UNAVAILABLE' } } });
      return fetcher(url, init);
    },
  );
  const result = await keep({ ...opts(), minPayout: 100000n });
  expect(result.errors).toContainEqual(expect.objectContaining({ deliveryId: 0 }));
  expect(result.sent.map((s) => (s.args as { delivery_id: number }).delivery_id)).toContain(1);
});
