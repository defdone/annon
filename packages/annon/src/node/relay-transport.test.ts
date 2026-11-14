import { afterEach, expect, it, vi } from 'vitest';
import { backupSecretHex, contract, fileId, nearRpc, workspace } from '../../test/commands.js';
import { terms } from '../../test/fixtures.js';
import { Annon, type AnnonOptions } from '../api/annon.js';
import * as nearRpcModule from '../near/rpc.js';
import { createAdapter } from './adapter.js';
import { publicError } from './errors.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const relayer = 'https://relay.test';

/**
 * Runs `stop` with an SDK whose stop sends the given contract calls through the adapter's relay
 * transport, the same `send` option the SDK uses for every relayed call.
 */
async function relayed(
  calls: [string, object][],
  fetcher: typeof fetch,
  o: { options?: (options: AnnonOptions) => Promise<void> } = {},
) {
  const ws = await workspace('relay', { relayer });
  const wait = vi.fn(async (_ms: number) => {});
  const results: unknown[] = [];
  try {
    const run = createAdapter(
      { ANNON_CONFIG: ws.config, ANNON_BACKUP_SECRET: backupSecretHex },
      {
        fetch: fetcher,
        wait,
        wallet: async () => ({ identity: terms.seller, authorize: vi.fn() }),
        sdk(options) {
          const sdk = new Annon(options);
          vi.spyOn(sdk, 'stop').mockImplementation(async () => {
            await o.options?.(options);
            for (const [method, args] of calls) results.push(await options.send?.(method, args));
          });
          return sdk;
        },
      },
    );
    let rejected = false;
    const outcome = await run({ command: 'stop', target: fileId }).catch((e: unknown) => {
      rejected = true;
      return e;
    });
    return { outcome, rejected, results, wait };
  } finally {
    await ws.remove();
  }
}

const submitted = () =>
  vi.fn<typeof fetch>(async () =>
    Response.json({ txHash: 'synthetic-transaction', signer: 'relay.synthetic.near' }),
  );

it('maps a 425 refusal without a public code to settlement_pending and does not retry it', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({}, { status: 425 }));
  const { outcome, wait } = await relayed([['stop_sales', { args: { file_id: fileId } }]], fetcher);
  expect(publicError(outcome)).toMatchObject({
    code: 'settlement_pending',
    exitCode: 4,
    retryAfterSeconds: 30,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(wait).not.toHaveBeenCalled();
});

it('posts claim_key with nested arguments and other calls flattened, and checks only contract fields', async () => {
  const fetcher = submitted();
  const outcome = vi
    .spyOn(nearRpcModule, 'txOutcome')
    .mockResolvedValue({ state: 'done', method: 'any', value: 'final', events: [] });
  const stopArgs = { args: { file_id: fileId, key: null, deadline: 1 }, auth: { kind: 'evm' } };
  const registerArgs = {
    args: { file_id: fileId },
    baseSplit: { relayer: 'only' },
    hostingReservation: { relayer: 'only' },
  };
  const fundArgs = { args: { file_id: fileId, amount: '5' }, auth: { kind: 'evm' } };
  const { outcome: result, results } = await relayed(
    [
      ['claim_key', { purchase_id: fileId }],
      ['stop_sales', stopArgs],
      ['register', registerArgs],
      ['fund_file_storage', fundArgs],
    ],
    fetcher,
  );
  expect(result).toEqual({ fileId, stopped: true });
  expect(results).toEqual(['final', 'final', 'final', 'final']);
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(
    Array(4).fill(`${relayer}/v1/relay`),
  );
  expect(fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    { method: 'claim_key', args: { purchase_id: fileId } },
    { method: 'stop_sales', ...stopArgs },
    { method: 'register', ...registerArgs },
    { method: 'fund_file_storage', ...fundArgs },
  ]);
  expect(outcome.mock.calls).toEqual([
    [
      nearRpc,
      'synthetic-transaction',
      'relay.synthetic.near',
      contract,
      'FINAL',
      { method: 'claim_key', args: { purchase_id: fileId } },
    ],
    [
      nearRpc,
      'synthetic-transaction',
      'relay.synthetic.near',
      contract,
      'FINAL',
      {
        method: 'stop_sales',
        args: stopArgs,
      },
    ],
    [
      nearRpc,
      'synthetic-transaction',
      'relay.synthetic.near',
      contract,
      'FINAL',
      {
        method: 'register',
        args: { args: { file_id: fileId } },
      },
    ],
    [
      nearRpc,
      'synthetic-transaction',
      'relay.synthetic.near',
      contract,
      'FINAL',
      {
        method: 'fund_file_storage',
        args: { file_id: fileId, amount: '5' },
      },
    ],
  ]);
});

it.each<[nearRpcModule.Outcome, string]>([
  [
    {
      state: 'not_released',
      method: 'stop_sales',
      reason: 'Prepaid storage balance too low',
      events: [],
    },
    'storage_required',
  ],
  [
    { state: 'refused', method: 'stop_sales', reason: 'Smart contract panicked', events: [] },
    'operation_failed',
  ],
  [{ state: 'pending', method: 'stop_sales', events: [] }, 'operation_failed'],
])('reports the final transaction outcome %o as %s', async (result, code) => {
  const fetcher = submitted();
  vi.spyOn(nearRpcModule, 'txOutcome').mockResolvedValue(result);
  const { outcome, rejected, results, wait } = await relayed(
    [['stop_sales', { args: { file_id: fileId } }]],
    fetcher,
  );
  // The command fails: the call never resolved, so the SDK never saw a result.
  expect(rejected).toBe(true);
  expect(results).toEqual([]);
  expect(outcome).toBeInstanceOf(Error);
  expect(publicError(outcome)).toMatchObject({ code });
  if (code === 'storage_required')
    expect(publicError(outcome).message).toContain('storageDeposit helper');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(wait).not.toHaveBeenCalled();
});

it.each(['refused', 'pending'] as const)(
  'a %s relayed transaction is never treated as a successful contract call',
  async (state) => {
    const fetcher = submitted();
    vi.spyOn(nearRpcModule, 'txOutcome').mockResolvedValue(
      state === 'refused'
        ? { state, method: 'stop_sales', reason: 'Smart contract panicked', events: [] }
        : { state, method: 'stop_sales', events: [] },
    );
    let settled: PromiseSettledResult<unknown> | undefined;
    const { outcome, rejected } = await relayed([], fetcher, {
      options: async (options) => {
        [settled] = await Promise.allSettled([
          options.send?.('stop_sales', { args: { file_id: fileId } }),
        ]);
      },
    });
    expect(settled).toMatchObject({
      status: 'rejected',
      reason: { message: `transaction ${state}` },
    });
    // The scripted stop swallowed the rejection, so only the call itself failed.
    expect(rejected).toBe(false);
    expect(outcome).toEqual({ fileId, stopped: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ['an active policy', {}, true],
  ['a disabled policy', { disabled: true }, false],
  ['another contract', { contract: 'other.near' }, false],
  ['no fee', { fee: undefined }, false],
] as const)('accepts relayer sponsorship only from %s', async (_name, change, ok) => {
  const fee = { fixed: '30000', bps: 100, treasuryNear: null, treasuryEvm: terms.seller };
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    expect(String(url)).toBe(`${relayer}/v1/capabilities`);
    return Response.json({ contract, disabled: false, fee, ...change });
  });
  let policy: unknown;
  const { outcome } = await relayed([], fetcher, {
    options: async (options) => {
      policy = await options.sponsorship?.().catch((e: unknown) => e);
    },
  });
  expect(outcome).toEqual({ fileId, stopped: true });
  if (ok) expect(policy).toEqual({ fee });
  else expect(policy).toMatchObject({ message: 'invalid relayer sponsorship policy' });
});
