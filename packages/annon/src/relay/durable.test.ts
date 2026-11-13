import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { terms as initial, must, purchase as sample } from '../../test/fixtures.js';
import { getFile, getPurchase, NearError, rpcReply, view } from '../near/rpc.js';
import { fileFundingText, registerText } from '../near/texts.js';
import { block, getReceipt, paymentLogs } from '../pay/base.js';
import { createSplit } from '../pay/split.js';
import { memoryStore } from '../pay/store.js';
import { buildPurchaseMessage } from '../settle-near/purchase.js';
import { termsHash } from '../settle-near/terms.js';
import { RelayLedger, type RelayState } from './ledger.js';
import {
  type CheckOptions,
  canonicalRequest,
  contractArgs,
  reconcileRelayStorage,
  relay,
  relayStatus,
  resetRelayState,
  retryPaidUnlocks,
} from './relay.js';

vi.mock('../near/rpc.js', async (original) => ({
  ...(await original<typeof import('../near/rpc.js')>()),
  getFile: vi.fn(),
  getPurchase: vi.fn(),
  rpcReply: vi.fn(),
  view: vi.fn(),
}));
vi.mock('../pay/base.js', async (original) => ({
  ...(await original<typeof import('../pay/base.js')>()),
  block: vi.fn(),
  getReceipt: vi.fn(),
  paymentLogs: vi.fn(),
}));
vi.mock('../pay/split.js', async (original) => ({
  ...(await original<typeof import('../pay/split.js')>()),
  readSplitState: vi.fn(),
}));
const created = vi.hoisted(() => vi.fn());
vi.mock('near-api-js', async (original) => ({
  ...(await original<typeof import('near-api-js')>()),
  Account: class {
    createSignedTransaction = created;
  },
  encodeTransaction: () => new Uint8Array([1, 2, 3]),
}));
const wallet = privateKeyToAccount(`0x${'44'.repeat(32)}`);
const baseSplit = { kind: 'push' as const, salt: `0x${'01'.repeat(32)}` };
const split = createSplit(
  'push',
  {
    recipients: initial.near.recipients.map((r) => r.identity.id),
    allocations: initial.near.recipients.map((r) => BigInt(r.bps)),
    totalAllocation: 10000n,
    distributionIncentive: 0,
  },
  baseSplit.salt,
);
const terms = {
  ...initial,
  seller: { kind: 'evm' as const, id: wallet.address.toLowerCase() },
  base: { ...must(initial.base), pay_to: split.address },
};
const file = {
  terms,
  termsHash: termsHash(terms),
  seller: terms.seller,
  purchaseStorageBalance: 0n,
  price: 200000n,
  payTo: split.address,
  cipherHash: terms.cipher_hash,
  moderator: null,
  headerHash: null,
  salesStoppedAt: null,
  takenDown: null,
};
const sender = { accountId: 'relay.test', key: 'ed25519:test' };
const options = async () => {
  const store = memoryStore<RelayState>();
  const ledger = new RelayLedger(store, `${terms.network}|${terms.contract}`);
  await ledger.seal(
    {
      policyVersion: 'legacy-v0',
      blockHash: 'cutover',
      blockHeight: 1,
      scannedThrough: 1,
      minPrice: '100000',
      fee: { fixed: '30000', bps: 100, treasuryNear: null, treasuryEvm: null },
      inventory: [],
    },
    [],
  );
  const o: CheckOptions & { sender: typeof sender } = {
    nearRpc: 'https://near.test',
    baseRpc: 'https://base.test',
    contractId: terms.contract,
    usdc: terms.base.usdc,
    ledger,
    sender,
    now: 1000,
    policy: {
      minPrice: 100000n,
      maxDeadlineSeconds: 600,
      sellerAllowed: () => true,
      prepaidUnlockFloor: 10n ** 24n,
    },
    historicalFile: async () => null,
  };
  return { o, store, ledger };
};
const registration = async () => {
  const args = { terms, seller_key: sample.buyer_key, deadline: 1600 };
  return {
    method: 'register',
    args,
    baseSplit,
    auth: {
      kind: 'evm',
      sig: await wallet.signMessage({ message: registerText(terms.contract, args) }),
    },
  };
};
const funding = async (amount = '1', nonce = `0x${'66'.repeat(32)}`, deadline = 1600) => {
  const args = { file_id: terms.file_id, amount, nonce, deadline };
  return {
    method: 'fund_file_storage',
    args,
    auth: {
      kind: 'evm',
      sig: await wallet.signMessage({
        message: fileFundingText({
          ...args,
          network: terms.network,
          contract: terms.contract,
          seller: terms.seller,
        }),
      }),
    },
  };
};
beforeEach(() => {
  vi.resetAllMocks();
  resetRelayState();
  created.mockResolvedValue({ transaction: { encode: () => new Uint8Array([1, 2, 3]) } });
  vi.mocked(getFile).mockResolvedValue(null);
  vi.mocked(getPurchase).mockResolvedValue(null);
  vi.mocked(rpcReply).mockImplementation(
    async (_rpc, method) =>
      ({
        result:
          method === 'EXPERIMENTAL_protocol_config'
            ? { runtime_config: { storage_amount_per_byte: '10000000000000000000' } }
            : { final_execution_status: 'INCLUDED' },
      }) as never,
  );
  vi.mocked(view).mockImplementation(async (_rpc, _contract, method) =>
    method === 'file_storage_balance'
      ? { admission_requirement: '40960000000000000000000' }
      : '10000000000000000000000000',
  );
});
afterEach(() => vi.restoreAllMocks());
it('persists registration before signing and reconciles successful registration despite a failed key callback', async () => {
  const { o, ledger, store } = await options();
  created.mockImplementation(async () => {
    const d = await ledger.decision(terms.file_id, termsHash(terms));
    expect(d).toMatchObject({
      outcome: 'prepared',
      allocated: '50000000000000000000000',
      tier: 'listed',
    });
    expect((await ledger.operation(`register:${terms.file_id}`))?.stage).toBe('prepared');
    return { transaction: { encode: () => new Uint8Array([1, 2, 3]) } };
  });
  const request = await registration();
  const result = await relay(request, o);
  vi.mocked(getFile).mockResolvedValue(file);
  const restarted = {
    ...o,
    ledger: new RelayLedger(store, `${terms.network}|${terms.contract}`),
    policy: {
      ...o.policy,
      minPrice: 999999999n,
      baseSponsorship: false,
      sellerAllowed: () => false,
    },
  };
  expect(await relayStatus(request, restarted)).toEqual(result);
  expect(await restarted.ledger.decision(terms.file_id, termsHash(terms))).toMatchObject({
    outcome: 'registered',
    minPrice: '100000',
    listed: true,
  });
  expect(created).toHaveBeenCalledTimes(1);
});
it('reserves the prepaid floor before non-unlock allocation and checks the current admission requirement', async () => {
  const { o } = await options();
  vi.mocked(view).mockResolvedValue('1000000000000000000000000');
  await expect(relay(await registration(), o)).rejects.toMatchObject({
    code: 'relayer_unavailable',
  });
  expect(created).not.toHaveBeenCalled();
});
it('accepts only registered seller funding, strips HTTP proof, and binds nonces durably', async () => {
  const { o, ledger, store } = await options();
  // A checked historic allocation permits signed top-ups without a new registration.
  await ledger.remember({
    network: terms.network,
    contract: terms.contract,
    fileId: terms.file_id,
    termsHash: termsHash(terms),
    terms,
    eligible: true,
    tier: 'listed',
    listed: true,
    policyVersion: 'v1',
    minPrice: '100000',
    fee: { fixed: '0', bps: 0, treasuryNear: null, treasuryEvm: null },
    decidedAt: 1000,
    allocated: '50000000000000000000000',
    outcome: 'registered',
  });
  vi.mocked(getFile).mockResolvedValue(file);
  const request = await funding();
  expect(contractArgs(canonicalRequest(request))).toEqual({ file_id: terms.file_id, amount: '1' });
  await expect(
    relay({ ...request, auth: { kind: 'evm', sig: `0x${'00'.repeat(65)}` } }, o),
  ).rejects.toMatchObject({ code: 'bad_signature' });
  const result = await relay(request, o);
  expect(
    await relay(request, {
      ...o,
      ledger: new RelayLedger(store, `${terms.network}|${terms.contract}`),
    }),
  ).toEqual(result);
  await expect(relay(await funding('2'), o)).rejects.toMatchObject({ code: 'bad_request' });
  await expect(
    relay({ ...request, args: { ...request.args, deadline: 1601 } }, o),
  ).rejects.toMatchObject({ code: 'bad_request' });
  expect(created).toHaveBeenCalledTimes(1);
});
it('requires an authenticated live host reservation for open registration', async () => {
  const { o } = await options();
  await expect(
    relay(await registration(), { ...o, policy: { ...o.policy, sellerAllowed: () => false } }),
  ).rejects.toMatchObject({ code: 'not_sponsored' });
  expect(created).not.toHaveBeenCalled();
});

it('retries a quota-delayed paid unlock after restart under its frozen policy', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const { o, store, ledger } = await options();
  await ledger.remember({
    network: terms.network,
    contract: terms.contract,
    fileId: terms.file_id,
    termsHash: termsHash(terms),
    terms,
    eligible: true,
    tier: 'external',
    listed: false,
    policyVersion: 'v1',
    minPrice: '100000',
    fee: { fixed: '0', bps: 0, treasuryNear: null, treasuryEvm: null },
    decidedAt: 1000,
    allocated: null,
    outcome: 'registered',
  });
  vi.mocked(getFile).mockResolvedValue(file);
  vi.mocked(block).mockResolvedValue({ number: 42, timestamp: 1000, hash: `0x${'aa'.repeat(32)}` });
  const log = {
    address: sample.asset.slice(2),
    block_hash: 'aa'.repeat(32),
    block_number: 42,
    data: '0x',
    log_index: 0,
    removed: false,
    topics: ['bb'.repeat(32), 'cc'.repeat(32), 'dd'.repeat(32)],
    transaction_hash: 'ee'.repeat(32),
    transaction_index: 0,
  };
  const logs = [log, { ...log, log_index: 1 }];
  vi.mocked(paymentLogs).mockReturnValue(logs);
  const request = (nonce: string) =>
    canonicalRequest({
      method: 'unlock',
      args: {
        purchase: buildPurchaseMessage({
          ...sample,
          terms_hash: termsHash(terms),
          nonce: `0x${nonce.repeat(32)}`,
        }),
        logs,
        header: null,
      },
    });
  const capped = { ...o, admissionLimits: { unlocksPerFile: 1 } };
  await relay(request('44'), capped);
  await expect(relay(request('55'), capped)).rejects.toMatchObject({
    code: 'settlement_pending',
    retryAt: 86400000,
  });
  expect(Object.keys((await ledger.read()).work)).toHaveLength(1);
  resetRelayState();
  clock.mockReturnValue(86400001);
  const restarted = {
    ...capped,
    ledger: new RelayLedger(store, `${terms.network}|${terms.contract}`),
    policy: {
      ...o.policy,
      minPrice: 99999999n,
      baseSponsorship: false,
      sellerAllowed: () => false,
    },
  };
  await retryPaidUnlocks(restarted);
  expect(created).toHaveBeenCalledTimes(2);
  expect(getReceipt).toHaveBeenCalled();
  expect((await ledger.read()).work).toEqual({});
  await relay(request('55'), restarted);
  expect(created).toHaveBeenCalledTimes(2);
});

it.each(['queue', 'chain', 'cutover', 'archival', 'base'] as const)(
  'retains paid work after an early %s delay',
  async (failure) => {
    const { o, ledger, store } = await options();
    const log = {
      address: sample.asset.slice(2),
      block_hash: 'aa'.repeat(32),
      block_number: 42,
      data: '0x',
      log_index: 0,
      removed: false,
      topics: ['bb'.repeat(32), 'cc'.repeat(32), 'dd'.repeat(32)],
      transaction_hash: 'ee'.repeat(32),
      transaction_index: 0,
    };
    const request = canonicalRequest({
      method: 'unlock',
      args: {
        purchase: buildPurchaseMessage({ ...sample, terms_hash: termsHash(terms) }),
        logs: [log, { ...log, log_index: 1 }],
        header: null,
      },
    });
    if (request.method === 'unlock') vi.mocked(paymentLogs).mockReturnValue(request.args.logs);
    if (failure === 'queue') o.policy.maxChecking = 0;
    else if (failure === 'cutover') o.ledger = new RelayLedger(store, 'unsealed');
    else if (failure === 'archival' || failure === 'base') {
      vi.mocked(getFile).mockResolvedValue(file);
      if (failure === 'archival')
        o.historicalFile = async () => {
          throw new NearError('transport', 'unavailable');
        };
      else
        vi.mocked(block).mockRejectedValue(
          Object.assign(new Error('unavailable'), { code: 'transport' }),
        );
    } else vi.mocked(getFile).mockRejectedValue(new NearError('transport', 'upstream unavailable'));
    await expect(relay(request, o)).rejects.toMatchObject({ code: 'settlement_pending' });
    expect(Object.values((await (o.ledger ?? ledger).read()).work)).toHaveLength(1);
    expect(created).not.toHaveBeenCalled();
  },
);

it.each([999, 1000, 1601])(
  'refuses a seller-signed top-up outside its validity window: %s',
  async (deadline) => {
    const { o } = await options();
    vi.mocked(getFile).mockResolvedValue(file);
    await expect(
      relay(await funding('1', `0x${'88'.repeat(32)}`, deadline), o),
    ).rejects.toMatchObject({ code: 'bad_deadline' });
    expect(created).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  'retries a final failed unlock but keeps an unresolved submission (final=%s)',
  async (final) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const { o, ledger } = await options();
    await ledger.remember({
      network: terms.network,
      contract: terms.contract,
      fileId: terms.file_id,
      termsHash: termsHash(terms),
      terms,
      eligible: true,
      tier: 'external',
      listed: false,
      policyVersion: 'v1',
      minPrice: '100000',
      fee: { fixed: '0', bps: 0, treasuryNear: null, treasuryEvm: null },
      decidedAt: 1000,
      allocated: null,
      outcome: 'registered',
    });
    vi.mocked(getFile).mockResolvedValue(file);
    vi.mocked(block).mockResolvedValue({
      number: 42,
      timestamp: 1000,
      hash: `0x${'aa'.repeat(32)}`,
    });
    const log = {
      address: sample.asset.slice(2),
      block_hash: 'aa'.repeat(32),
      block_number: 42,
      data: '0x',
      log_index: 0,
      removed: false,
      topics: ['bb'.repeat(32), 'cc'.repeat(32), 'dd'.repeat(32)],
      transaction_hash: 'ee'.repeat(32),
      transaction_index: 0,
    };
    const logs = [log, { ...log, log_index: 1 }];
    vi.mocked(paymentLogs).mockReturnValue(logs);
    const request = canonicalRequest({
      method: 'unlock',
      args: {
        purchase: buildPurchaseMessage({ ...sample, terms_hash: termsHash(terms) }),
        logs,
        header: null,
      },
    });
    await relay(request, o);
    const op = Object.values((await ledger.read()).operations)[0];
    if (final && op?.tx) await ledger.finalizeStorage(op.id, op.tx.txHash);
    clock.mockReturnValue(1000000);
    await relay(request, o);
    expect(created).toHaveBeenCalledTimes(final ? 2 : 1);
    expect((await ledger.read()).counters['0|all']).toBe(final ? '2' : '1');
  },
);

it('refuses new registration when the live contract storage requirement exceeds the frozen allocation', async () => {
  const { o } = await options();
  vi.mocked(rpcReply).mockImplementation(
    async (_rpc, method) =>
      ({
        result:
          method === 'EXPERIMENTAL_protocol_config'
            ? { runtime_config: { storage_amount_per_byte: '20000000000000000000' } }
            : { final_execution_status: 'INCLUDED' },
      }) as never,
  );
  await expect(relay(await registration(), o)).rejects.toMatchObject({
    code: 'relayer_unavailable',
  });
  expect(created).not.toHaveBeenCalled();
});

it('never signs a sponsored send without durable admission state', async () => {
  const { o } = await options();
  const { ledger: _ledger, ...withoutLedger } = o;
  await expect(relay(await registration(), withoutLedger)).rejects.toMatchObject({
    code: 'relayer_unavailable',
  });
  expect(created).not.toHaveBeenCalled();
});

it.each(['Expired', 'InvalidNonce', 'old', 'outage', 'race', 'capacity', 'live capacity'] as const)(
  'recovers a never-landed paid unlock after %s without signing twice for a landed send',
  async (reason) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const { o, store, ledger } = await options();
    await ledger.remember({
      network: terms.network,
      contract: terms.contract,
      fileId: terms.file_id,
      termsHash: termsHash(terms),
      terms,
      eligible: true,
      tier: 'external',
      listed: false,
      policyVersion: 'v1',
      minPrice: '100000',
      fee: { fixed: '0', bps: 0, treasuryNear: null, treasuryEvm: null },
      decidedAt: 1000,
      allocated: null,
      outcome: 'registered',
    });
    vi.mocked(getFile).mockResolvedValue(file);
    vi.mocked(block).mockResolvedValue({
      number: 42,
      timestamp: 1000,
      hash: `0x${'aa'.repeat(32)}`,
    });
    const log = {
      address: sample.asset.slice(2),
      block_hash: 'aa'.repeat(32),
      block_number: 42,
      data: '0x',
      log_index: 0,
      removed: false,
      topics: ['bb'.repeat(32), 'cc'.repeat(32), 'dd'.repeat(32)],
      transaction_hash: 'ee'.repeat(32),
      transaction_index: 0,
    };
    const logs = [log, { ...log, log_index: 1 }];
    vi.mocked(paymentLogs).mockReturnValue(logs);
    const request = (nonce: string) =>
      canonicalRequest({
        method: 'unlock',
        args: {
          purchase: buildPurchaseMessage({
            ...sample,
            terms_hash: termsHash(terms),
            nonce: `0x${nonce.repeat(32)}`,
          }),
          logs,
          header: null,
        },
      });

    const paid = request('88');
    if (reason === 'capacity' || reason === 'live capacity') {
      o.alert = vi.fn();
      const state = await ledger.read();
      const next = structuredClone(state);
      for (let i = 0; i < 4096; i++)
        next.operations[`finished:${i}`] = {
          id: `finished:${i}`,
          requestHash: String(i),
          method: 'claim_key',
          fileId: terms.file_id,
          termsHash: termsHash(terms),
          seller: 'seller',
          listed: false,
          ip: '192.0.2.1',
          storage: '0',
          allocation: '0',
          limits: (await import('./sponsorship.js')).relayLimits(o),
          at: Date.now() - 10 * 86400000,
          compact: true,
          stage: 'submitted',
          charges: [],
          storageFinalized: reason === 'capacity',
          finalState: 'released',
          tx: { txHash: `old:${i}`, signed: '', signer: sender.accountId, args: {} },
        };
      next.revision++;
      await store.compareAndSet(`${terms.network}|${terms.contract}`, state, next);
      await relay(paid, o);
      expect(created).toHaveBeenCalledTimes(1);
      expect(Object.keys((await ledger.read()).operations)).toHaveLength(
        reason === 'capacity' ? 1 : 4097,
      );
      if (reason === 'live capacity') expect(o.alert).toHaveBeenCalledWith('ledger_capacity');
      return;
    }
    if (reason === 'outage')
      vi.mocked(rpcReply).mockResolvedValue({ error: { cause: { name: 'UNKNOWN_TRANSACTION' } } });
    await relay(paid, o);
    const op = Object.values((await ledger.read()).operations)[0];
    if (!op?.tx) throw new Error('missing signed operation');
    // Simulate restart after persist and before broadcast, including loss of its result.
    const raw = await ledger.read();
    const changed = structuredClone(raw);
    if (reason !== 'outage') delete changed.operations[op.id]?.result;
    if (reason === 'old' && changed.operations[op.id]?.tx)
      Object.assign(changed.operations[op.id]?.tx ?? {}, { referenceHash: 'reference' });
    changed.revision++;
    await store.compareAndSet(`${terms.network}|${terms.contract}`, raw, changed);
    vi.mocked(rpcReply).mockClear();
    let lookups = 0;
    vi.mocked(rpcReply).mockImplementation(async (_rpc, method, params) =>
      reason === 'old' && method === 'EXPERIMENTAL_protocol_config'
        ? { result: { transaction_validity_period: 86400 } }
        : reason === 'old' && method === 'block'
          ? {
              result: {
                header: { height: (params as { block_id?: string }).block_id ? 100 : 86501 },
              },
            }
          : method === 'tx'
            ? reason === 'race' && ++lookups > 1
              ? { result: { final_execution_status: 'INCLUDED' } }
              : { error: { cause: { name: 'UNKNOWN_TRANSACTION' } } }
            : {
                error: {
                  cause: {
                    info: {
                      InvalidTxError: ['old', 'outage', 'race'].includes(reason)
                        ? 'Expired'
                        : reason,
                    },
                  },
                },
              },
    );
    if (reason === 'old') clock.mockReturnValue(3 * 86400000);
    await reconcileRelayStorage(o);
    if (reason === 'race') {
      expect((await ledger.operation(op.id))?.stage).toBe('submitted');
      expect((await ledger.operation(op.id))?.result).toEqual({
        txHash: op.tx.txHash,
        uncertain: true,
      });
      expect(Object.keys((await ledger.read()).work)).toHaveLength(0);
      await relay(paid, o);
      expect(created).toHaveBeenCalledTimes(1);
      return;
    }
    if (reason === 'old')
      expect(
        vi.mocked(rpcReply).mock.calls.filter(([, method]) => method === 'send_tx'),
      ).toHaveLength(0);
    expect((await ledger.operation(op.id))?.stage).toBe('rejected');
    expect(await ledger.pendingStorage()).toBe(0n);
    expect(Object.keys((await ledger.read()).work)).toEqual([op.id]);
    expect(
      vi
        .mocked(rpcReply)
        .mock.calls.some(
          ([, method, params]) =>
            method === 'tx' && (params as { wait_until?: string }).wait_until === 'FINAL',
        ),
    ).toBe(true);
    clock.mockReturnValue(reason === 'old' ? 3 * 86400000 + 30001 : 31001);
    vi.mocked(rpcReply).mockResolvedValue({ result: { final_execution_status: 'INCLUDED' } });
    await retryPaidUnlocks({
      ...o,
      policy: { ...o.policy, baseSponsorship: false, minPrice: 999999999n },
    });
    expect(created).toHaveBeenCalledTimes(2);
    await relay(paid, o);
    expect(created).toHaveBeenCalledTimes(2);
  },
);

it('alerts and refuses when the durable paid queue is full', async () => {
  const { o, ledger } = await options();
  o.policy.maxWaiting = 1;
  o.alert = vi.fn();
  await ledger.defer('existing', {}, 'existing', 0, 1);
  const log = {
    address: sample.asset.slice(2),
    block_hash: 'aa'.repeat(32),
    block_number: 42,
    data: '0x',
    log_index: 0,
    removed: false,
    topics: ['bb'.repeat(32), 'cc'.repeat(32), 'dd'.repeat(32)],
    transaction_hash: 'ee'.repeat(32),
    transaction_index: 0,
  };
  const request = canonicalRequest({
    method: 'unlock',
    args: {
      purchase: buildPurchaseMessage({ ...sample, terms_hash: termsHash(terms) }),
      logs: [log, { ...log, log_index: 1 }],
      header: null,
    },
  });
  vi.mocked(getFile).mockRejectedValue(new NearError('transport', 'unavailable'));
  await expect(relay(request, o)).rejects.toMatchObject({ code: 'settlement_pending' });
  expect(o.alert).toHaveBeenCalledWith('paid_work_full');
  expect(Object.keys((await ledger.read()).work)).toEqual(['existing']);
});
it('removes permanently invalid deferred work instead of polling it forever', async () => {
  const { o, ledger } = await options();
  const log = {
    address: sample.asset.slice(2),
    block_hash: 'aa'.repeat(32),
    block_number: 42,
    data: '0x',
    log_index: 0,
    removed: false,
    topics: ['bb'.repeat(32), 'cc'.repeat(32), 'dd'.repeat(32)],
    transaction_hash: 'ee'.repeat(32),
    transaction_index: 0,
  };
  const request = canonicalRequest({
    method: 'unlock',
    args: {
      purchase: buildPurchaseMessage({ ...sample, terms_hash: termsHash(terms) }),
      logs: [log, { ...log, log_index: 1 }],
      header: null,
    },
  });
  const { deferPaidUnlock } = await import('./relay.js');
  await deferPaidUnlock(request, o, 0);
  vi.mocked(getFile).mockResolvedValue(null);
  await retryPaidUnlocks(o);
  expect((await ledger.read()).work).toEqual({});
  expect(created).not.toHaveBeenCalled();
});
it('refuses registration with a pending response before a cutover is sealed', async () => {
  const { o, store } = await options();
  o.ledger = new RelayLedger(store, 'unsealed');
  o.alert = vi.fn();
  await expect(relay(await registration(), o)).rejects.toMatchObject({
    code: 'settlement_pending',
  });
  expect(o.alert).toHaveBeenCalledWith('cutover_unsealed');
  expect(created).not.toHaveBeenCalled();
});

it.each(['Expired', 'InvalidNonce', 'old'] as const)(
  'releases never-landed registration holds after %s and permits a fresh request',
  async (reason) => {
    const { o, ledger, store } = await options();
    const request = await registration();
    await relay(request, o);
    const op = Object.values((await ledger.read()).operations)[0];
    if (!op?.tx) throw new Error('missing operation');
    if (reason === 'old') {
      const state = await ledger.read();
      const next = structuredClone(state);
      Object.assign(next.operations[op.id]?.tx ?? {}, { referenceHash: 'reference' });
      next.revision++;
      await store.compareAndSet(`${terms.network}|${terms.contract}`, state, next);
    }
    vi.mocked(rpcReply).mockImplementation(async (_rpc, method, params) => {
      if (method === 'tx') return { error: { cause: { name: 'UNKNOWN_TRANSACTION' } } };
      if (method === 'EXPERIMENTAL_protocol_config')
        return { result: { transaction_validity_period: 100 } };
      if (method === 'block')
        return {
          result: { header: { height: (params as { block_id?: string }).block_id ? 100 : 201 } },
        };
      return { error: { cause: { info: { InvalidTxError: reason } } } };
    });
    await reconcileRelayStorage(o);
    expect((await ledger.operation(op.id))?.stage).toBe('rejected');
    expect(await ledger.pendingStorage()).toBe(0n);
    expect(await ledger.decision(terms.file_id, termsHash(terms))).toBeNull();
    expect((await ledger.read()).work).toEqual({});
    vi.mocked(rpcReply).mockResolvedValue({
      result: {
        runtime_config: { storage_amount_per_byte: '10000000000000000000' },
        final_execution_status: 'INCLUDED',
      },
    });
    await relay(request, o);
    expect(created).toHaveBeenCalledTimes(2);
  },
);

it('preserves a signed operation when its durable write reports failure after committing', async () => {
  const { o, ledger } = await options();
  const request = await registration();
  const original = ledger.signed.bind(ledger);
  const persist = vi.spyOn(ledger, 'signed').mockImplementation(async (...args) => {
    await original(...args);
    throw new Error('sync unavailable after commit');
  });
  await expect(relay(request, o)).rejects.toThrow();
  persist.mockRestore();
  expect((await ledger.operation(`register:${terms.file_id}`))?.stage).toBe('submitted');
  expect(await ledger.pendingStorage()).toBeGreaterThan(0n);
  await relay(request, o);
  expect(created).toHaveBeenCalledTimes(1);
});

it.each([true, false])(
  'resolves prepared registration inventory from FINAL chain state, registered=%s',
  async (registered) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const { o, ledger } = await options();
    await relay(await registration(), o);
    const op = await ledger.operation(`register:${terms.file_id}`);
    if (!op?.tx) throw new Error('missing signed registration');
    vi.mocked(getFile).mockResolvedValue(registered ? file : null);
    vi.mocked(rpcReply).mockResolvedValue({
      result: {
        final_execution_status: 'FINAL',
        transaction: {
          hash: op.tx.txHash,
          signer_id: sender.accountId,
          receiver_id: terms.contract,
          actions: [
            {
              FunctionCall: {
                method_name: 'register',
                args: Buffer.from(JSON.stringify(op.tx.args)).toString('base64'),
              },
            },
          ],
        },
        status: { Failure: {} },
        receipts_outcome: [],
      },
    });
    await reconcileRelayStorage(o);
    if (registered)
      expect(await ledger.decision(terms.file_id, termsHash(terms))).toMatchObject({
        outcome: 'registered',
      });
    else expect(await ledger.decision(terms.file_id, termsHash(terms))).toBeNull();
    expect(await ledger.pendingStorage()).toBe(0n);
    expect((await ledger.read()).counters['0|all']).toBe('1');
    clock.mockReturnValue(901000);
    await ledger.defer('maintenance', {}, 'h', 0);
    expect((await ledger.read()).decisions).toEqual({});
    expect(await ledger.operation(op.id)).toBeNull();
    expect(created).toHaveBeenCalledTimes(1);
  },
);

it.each(['register', 'unlock', 'stop_sales'] as const)(
  'preserves landed %s when transaction history has been forgotten',
  async (method) => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const { o, ledger } = await options();
    await relay(await registration(), o);
    const registered = Object.values((await ledger.read()).operations)[0];
    if (!registered?.tx) throw new Error('missing operation');
    if (method !== 'register') {
      vi.mocked(getFile).mockResolvedValue(file);
      await ledger.registered(terms.file_id, file.termsHash);
      await ledger.finalizeStorage(registered.id, registered.tx.txHash, 'done');
      const { decision: _decision, ...admission } = registered;
      await ledger.prepare({ ...admission, id: 'landed', method });
      await ledger.signed('landed', {
        ...registered.tx,
        args: {
          args: { purchase: buildPurchaseMessage({ ...sample, terms_hash: file.termsHash }) },
        },
      });
    }
    const id = method === 'register' ? registered.id : 'landed';
    vi.mocked(getFile).mockResolvedValue(
      method === 'stop_sales' ? { ...file, salesStoppedAt: 1001 } : file,
    );
    vi.mocked(getPurchase).mockResolvedValue({} as never);
    vi.mocked(rpcReply).mockImplementation(async (_rpc, name) =>
      name === 'tx'
        ? { error: { cause: { name: 'UNKNOWN_TRANSACTION' } } }
        : { error: { cause: { info: { InvalidTxError: 'Expired' } } } },
    );
    clock.mockReturnValue(1000 + 4 * 86400000);
    await reconcileRelayStorage(o);
    expect(await ledger.decision(terms.file_id, file.termsHash)).toMatchObject({
      outcome: 'registered',
      allocated: '50000000000000000000000',
    });
    expect(await ledger.operation(id)).toMatchObject({
      stage: 'submitted',
      storageFinalized: true,
      finalState: 'done',
    });
    expect(await ledger.pendingStorage()).toBe(0n);
    expect((await ledger.read()).work).toEqual({});
    expect(created).toHaveBeenCalledTimes(1);
  },
);
it('retires a deferred unlock whose purchase already exists without signing', async () => {
  const { o, ledger } = await options();
  vi.mocked(getFile).mockResolvedValue(file);
  await ledger.remember({
    network: terms.network,
    contract: terms.contract,
    fileId: terms.file_id,
    termsHash: file.termsHash,
    terms,
    eligible: true,
    tier: 'external',
    listed: false,
    policyVersion: 'v1',
    minPrice: '100000',
    fee: { fixed: '0', bps: 0, treasuryNear: null, treasuryEvm: null },
    decidedAt: 1000,
    allocated: null,
    outcome: 'registered',
  });
  const { deferPaidUnlock } = await import('./relay.js');
  const request = {
    method: 'unlock',
    args: {
      purchase: buildPurchaseMessage({ ...sample, terms_hash: file.termsHash }),
      logs: [
        {
          address: sample.asset.slice(2),
          block_hash: 'aa'.repeat(32),
          block_number: 42,
          data: '0x',
          log_index: 0,
          removed: false,
          topics: ['bb'.repeat(32), 'cc'.repeat(32), 'dd'.repeat(32)],
          transaction_hash: 'ee'.repeat(32),
          transaction_index: 0,
        },
      ],
      header: null,
    },
  };
  request.args.logs.push({ ...must(request.args.logs[0]), log_index: 1 });
  await deferPaidUnlock(request, o, 0);
  expect(Object.keys((await ledger.read()).work)).toHaveLength(1);
  vi.mocked(getPurchase).mockResolvedValue({} as never);
  await retryPaidUnlocks(o);
  expect((await ledger.read()).work).toEqual({});
  expect(created).not.toHaveBeenCalled();
});
