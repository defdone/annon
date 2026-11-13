import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { purchase as sample } from '../../test/fixtures.js';
import { getFile, getGrant, getPurchase, rpcReply } from '../near/rpc.js';
import { memoryStore } from '../pay/store.js';
import { buildPurchaseMessage } from '../settle-near/purchase.js';
import { RelayLedger, type RelayState } from './ledger.js';
import { type CheckOptions, reconcileRelayStorage } from './relay.js';
import { relayLimits } from './sponsorship.js';

vi.mock('../near/rpc.js', async (original) => ({
  ...(await original<typeof import('../near/rpc.js')>()),
  rpcReply: vi.fn(),
  getFile: vi.fn(async () => null),
  getGrant: vi.fn(async () => null),
  getPurchase: vi.fn(async () => null),
}));
beforeEach(() => {
  vi.mocked(getFile).mockResolvedValue(null);
  vi.mocked(getPurchase).mockResolvedValue(null);
  vi.mocked(getGrant).mockReset().mockResolvedValue(null);
  vi.spyOn(Date, 'now').mockReturnValue(1000);
});
afterEach(() => vi.restoreAllMocks());
it.each([
  'protocol error',
  'head error',
  'reference error',
  'fractional period',
  'fractional head',
  'fractional reference',
  'zero period',
  'negative reference',
  'window boundary',
  'lookup error',
  'included',
] as const)('preserves signed work without conclusive expiry evidence: %s', async (mode) => {
  const ledger = new RelayLedger(memoryStore<RelayState>(), 'scope');
  await ledger.prepare({
    id: 'unlock:p',
    requestHash: 'hash',
    method: 'unlock',
    fileId: `0x${'22'.repeat(32)}`,
    termsHash: `0x${'33'.repeat(32)}`,
    seller: 'seller',
    listed: false,
    ip: '192.0.2.1',
    storage: '100',
    allocation: '0',
    limits: relayLimits({ policy: { minPrice: 1n, maxDeadlineSeconds: 600 } } as CheckOptions),
  });
  await ledger.signed('unlock:p', {
    txHash: 'T',
    signed: 'same-bytes',
    signer: 'relay.test',
    referenceHash: 'reference',
    args: { args: {} },
  });
  vi.mocked(rpcReply).mockImplementation(async (_url, method, params) => {
    if (method === 'tx')
      return mode === 'included'
        ? { result: { final_execution_status: 'INCLUDED' } }
        : {
            error: {
              cause: { name: mode === 'lookup error' ? 'UNAVAILABLE' : 'UNKNOWN_TRANSACTION' },
            },
          };
    if (method === 'send_tx') return { result: { final_execution_status: 'INCLUDED' } };
    if (method === 'EXPERIMENTAL_protocol_config')
      return {
        result: {
          transaction_validity_period:
            mode === 'fractional period' ? 86400.5 : mode === 'zero period' ? 0 : 86400,
        },
        ...(mode === 'protocol error' ? { error: {} } : {}),
      };
    const reference = (params as { block_id?: string }).block_id === 'reference';
    return {
      result: {
        header: {
          height: reference
            ? mode === 'negative reference'
              ? -1
              : mode === 'fractional reference'
                ? 100.5
                : 100
            : ['window boundary', 'lookup error', 'included'].includes(mode)
              ? 86500
              : mode === 'fractional head'
                ? 100000.5
                : 100000,
        },
      },
      ...((reference && mode === 'reference error') || (!reference && mode === 'head error')
        ? { error: {} }
        : {}),
    };
  });
  await reconcileRelayStorage({
    ledger,
    nearRpc: 'https://rpc.test',
    contractId: 'market.test',
    sender: { accountId: 'relay.test', key: 'test-double' },
  });
  expect((await ledger.operation('unlock:p'))?.stage).toBe('submitted');
  expect(await ledger.pendingStorage()).toBe(100n);
  expect((await ledger.read()).work).toEqual({});
  expect(vi.mocked(rpcReply).mock.calls.filter(([, method]) => method === 'send_tx')).toHaveLength(
    ['lookup error', 'included'].includes(mode) ? 0 : 1,
  );
});

it.each(['register', 'claim_key', 'reopen', 'stop_sales'])(
  'rejects never-landed %s and releases its storage after a FINAL unknown and resend refusal',
  async (method) => {
    const ledger = new RelayLedger(memoryStore<RelayState>(), 'scope');
    await ledger.prepare({
      id: 'op',
      requestHash: 'h',
      method,
      fileId: `0x${'22'.repeat(32)}`,
      termsHash: `0x${'33'.repeat(32)}`,
      seller: 'seller',
      listed: false,
      ip: '192.0.2.1',
      storage: '100',
      allocation: '0',
      limits: relayLimits({ policy: { minPrice: 1n, maxDeadlineSeconds: 600 } } as CheckOptions),
    });
    await ledger.signed('op', {
      txHash: 'T',
      signed: 'original-bytes',
      signer: 'relay.test',
      args: { args: { purchase_id: `0x${'22'.repeat(32)}`, fresh_key: 'fresh' } },
    });
    vi.mocked(rpcReply).mockImplementation(async (_url, name) =>
      name === 'tx'
        ? { error: { cause: { name: 'UNKNOWN_TRANSACTION' } } }
        : { error: { cause: { info: { InvalidTxError: 'Expired' } } } },
    );
    await reconcileRelayStorage({
      ledger,
      nearRpc: 'https://rpc.test',
      contractId: 'market.test',
      sender: { accountId: 'relay.test', key: 'test-double' },
    });
    expect((await ledger.operation('op'))?.stage).toBe('rejected');
    expect(await ledger.pendingStorage()).toBe(0n);
    expect((await ledger.read()).counters['0|all']).toBe('0');
    expect((await ledger.read()).work).toEqual({});
  },
);

it.each([
  'original key',
  'later grant',
  'large grant set',
  'exact grant window',
  '34 grants',
  'newest grant',
  'last grant in window',
  'file unavailable',
  'different terms',
  'not stopped',
])('checks visible state before rejection: %s', async (mode) => {
  const method =
    mode.includes('key') || mode.includes('grant')
      ? 'reopen'
      : mode === 'not stopped'
        ? 'stop_sales'
        : 'register';
  const ledger = new RelayLedger(memoryStore<RelayState>(), 'visible');
  await ledger.prepare({
    id: 'op',
    requestHash: 'h',
    method,
    fileId: `0x${'22'.repeat(32)}`,
    termsHash: `0x${'33'.repeat(32)}`,
    seller: 'seller',
    listed: false,
    ip: '192.0.2.1',
    storage: '100',
    allocation: '0',
    limits: relayLimits({ policy: { minPrice: 1n, maxDeadlineSeconds: 600 } } as CheckOptions),
  });
  await ledger.signed('op', {
    txHash: 'T',
    signed: 'same',
    signer: 'relay.test',
    args: { args: { purchase_id: `0x${'44'.repeat(32)}`, fresh_key: 'fresh' } },
  });
  vi.mocked(getFile).mockResolvedValue({ termsHash: 'different', salesStoppedAt: null } as never);
  if (mode === 'file unavailable') vi.mocked(getFile).mockRejectedValue(new Error('unavailable'));
  vi.mocked(getPurchase).mockResolvedValue({
    buyer_key: mode === 'original key' ? 'fresh' : 'other',
    grants: ['large grant set', 'newest grant', 'last grant in window'].includes(mode)
      ? 100
      : mode === '34 grants'
        ? 34
        : mode === 'exact grant window'
          ? 33
          : 2,
  } as never);
  vi.mocked(getGrant).mockImplementation(
    async (_rpc, _contract, _id, grant) =>
      ({
        buyer_key:
          mode === 'later grant' ||
          (mode === 'newest grant' && grant === 99) ||
          (mode === 'last grant in window' && grant === 68)
            ? 'fresh'
            : 'other',
      }) as never,
  );
  vi.mocked(rpcReply).mockImplementation(async (_rpc, name) =>
    name === 'tx'
      ? { error: { cause: { name: 'UNKNOWN_TRANSACTION' } } }
      : { error: { cause: { info: { InvalidTxError: 'Expired' } } } },
  );
  const alert = vi.fn();
  await reconcileRelayStorage({
    ledger,
    alert,
    nearRpc: 'https://rpc.test',
    contractId: 'market.test',
    sender: { accountId: 'relay.test', key: 'test-double' },
  });
  const operation = await ledger.operation('op');
  const grants = vi.mocked(getGrant).mock.calls.map((call) => call[3]);
  if (mode === '34 grants') expect(grants).toEqual(Array.from({ length: 32 }, (_, i) => 33 - i));
  if (mode === 'newest grant') expect(grants).toEqual([99]);
  if (mode === 'large grant set' || mode === 'last grant in window')
    expect(grants).toEqual(Array.from({ length: 32 }, (_, i) => 99 - i));
  if (mode === 'different terms' || mode === 'not stopped' || mode === 'exact grant window')
    expect(operation?.stage).toBe('rejected');
  else if (mode === '34 grants' || mode === 'large grant set' || mode === 'file unavailable') {
    expect(alert).toHaveBeenCalledWith('reconcile_held');
    expect(operation?.stage).toBe('submitted');
    expect(operation?.storageFinalized).toBeUndefined();
    expect(await ledger.pendingStorage()).toBe(100n);
  } else
    expect(operation).toMatchObject({
      stage: 'submitted',
      storageFinalized: true,
      finalState: 'done',
    });
});

// A forgotten transaction and an Expired resend are not proof that the original call failed.
it.each(['reopen_seller', 'claim_key', 'fund_file_storage'] as const)(
  'retains accounting when %s landed but its transaction was forgotten',
  async (method) => {
    const ledger = new RelayLedger(memoryStore<RelayState>(), 'landed');
    const fileId = `0x${'22'.repeat(32)}`;
    const purchaseId = `0x${'44'.repeat(32)}`;
    const key = `0x${'55'.repeat(48)}`;
    await ledger.prepare({
      id: 'op',
      requestHash: 'h',
      method,
      fileId,
      termsHash: `0x${'33'.repeat(32)}`,
      seller: 'seller',
      listed: false,
      ip: '192.0.2.1',
      storage: '100',
      allocation: '100',
      fundingBalanceBefore: '20',
      limits: relayLimits({ policy: { minPrice: 1n, maxDeadlineSeconds: 600 } } as CheckOptions),
    });
    await ledger.signed('op', {
      txHash: 'T',
      signed: 'original',
      signer: 'relay.test',
      args:
        method === 'claim_key'
          ? { purchase_id: purchaseId, grant: 2 }
          : method === 'fund_file_storage'
            ? { file_id: fileId, amount: '100' }
            : { args: { file_id: fileId, key } },
    });
    vi.mocked(getFile).mockResolvedValue({ purchaseStorageBalance: 120n } as never);
    vi.mocked(getGrant).mockResolvedValue({
      purchase_id: purchaseId,
      grant: 2,
      buyer_key: key,
    } as never);
    vi.mocked(rpcReply).mockImplementation(async (_url, name, params) => {
      if (name === 'tx') return { error: { cause: { name: 'UNKNOWN_TRANSACTION' } } };
      if (name === 'query')
        return {
          result: {
            values: [{ key: (params as { prefix_base64: string }).prefix_base64, value: '' }],
          },
        };
      return { error: { cause: { info: { InvalidTxError: 'Expired' } } } };
    });
    await reconcileRelayStorage({
      ledger,
      nearRpc: 'https://rpc.test',
      contractId: 'market.test',
      sender: { accountId: 'relay.test', key: 'test-double' },
    });
    expect(await ledger.operation('op')).toMatchObject({
      stage: 'submitted',
      storageFinalized: true,
      finalState: 'done',
    });
    expect((await ledger.read()).counters['0|all']).toBe('1');
    expect(await ledger.pendingStorage()).toBe(0n);
    expect(vi.mocked(rpcReply).mock.calls.filter(([, name]) => name === 'send_tx')).toHaveLength(1);
    if (method === 'claim_key')
      expect(getGrant).toHaveBeenCalledWith('https://rpc.test', 'market.test', purchaseId, 2);
    if (method === 'reopen_seller')
      expect(rpcReply).toHaveBeenCalledWith(
        'https://rpc.test',
        'query',
        expect.objectContaining({
          prefix_base64: 'coZK5jtMGmmpJiI6ET6euxMSZCsAdGm1SB6mL+yTiTCL',
          request_type: 'view_state',
          account_id: 'market.test',
          finality: 'final',
        }),
      );
  },
);
it.each(['missing baseline', 'balance consumed', 'balance unchanged', 'RPC unavailable'])(
  'keeps an ambiguous funding allocation charged: %s',
  async (mode) => {
    const ledger = new RelayLedger(memoryStore<RelayState>(), 'funding');
    await ledger.prepare({
      id: 'op',
      requestHash: 'h',
      method: 'fund_file_storage',
      fileId: `0x${'22'.repeat(32)}`,
      termsHash: `0x${'33'.repeat(32)}`,
      seller: 'seller',
      listed: false,
      ip: '192.0.2.1',
      storage: '100',
      allocation: '100',
      ...(mode === 'missing baseline' ? {} : { fundingBalanceBefore: '20' }),
      limits: relayLimits({ policy: { minPrice: 1n, maxDeadlineSeconds: 600 } } as CheckOptions),
    });
    await ledger.signed('op', {
      txHash: 'T',
      signed: 'original',
      signer: 'relay.test',
      args: { file_id: `0x${'22'.repeat(32)}`, amount: '100' },
    });
    vi.mocked(getFile).mockResolvedValue({
      purchaseStorageBalance:
        mode === 'missing baseline' ? 1000n : mode === 'balance unchanged' ? 20n : 0n,
    } as never);
    if (mode === 'RPC unavailable') vi.mocked(getFile).mockRejectedValue(new Error('unavailable'));
    vi.mocked(rpcReply).mockImplementation(async (_url, name) =>
      name === 'tx'
        ? { error: { cause: { name: 'UNKNOWN_TRANSACTION' } } }
        : { error: { cause: { info: { InvalidTxError: 'Expired' } } } },
    );
    const alert = vi.fn();
    await reconcileRelayStorage({
      ledger,
      nearRpc: 'https://rpc.test',
      contractId: 'market.test',
      sender: { accountId: 'relay.test', key: 'test-double' },
      alert,
    });
    expect(alert).toHaveBeenCalledWith('reconcile_held');
    expect(await ledger.operation('op')).toMatchObject({ stage: 'submitted' });
    expect((await ledger.operation('op'))?.storageFinalized).toBeUndefined();
    expect((await ledger.read()).counters['0|all']).toBe('1');
    expect(await ledger.pendingStorage()).toBe(100n);
  },
);

it.each([
  'absent',
  'wrong key',
  'wrong value',
  'duplicate',
  'RPC error',
  'state too large',
  'thrown error',
] as const)('checks exact final seller-reopen storage evidence: %s', async (mode) => {
  const ledger = new RelayLedger(memoryStore<RelayState>(), 'seller-marker');
  const fileId = `0x${'22'.repeat(32)}`;
  await ledger.prepare({
    id: 'op',
    requestHash: 'h',
    method: 'reopen_seller',
    fileId,
    termsHash: `0x${'33'.repeat(32)}`,
    seller: 'seller',
    listed: false,
    ip: '192.0.2.1',
    storage: '100',
    allocation: '0',
    limits: relayLimits({ policy: { minPrice: 1n, maxDeadlineSeconds: 600 } } as CheckOptions),
  });
  await ledger.signed('op', {
    txHash: 'T',
    signed: 'original',
    signer: 'relay.test',
    args: { args: { file_id: fileId, key: `0x${'55'.repeat(48)}` } },
  });
  vi.mocked(rpcReply).mockImplementation(async (_url, name, params) => {
    if (name === 'tx') return { error: { cause: { name: 'UNKNOWN_TRANSACTION' } } };
    if (name === 'query') {
      if (mode === 'thrown error') throw new Error('UPSTREAM_PRIVATE');
      if (mode === 'state too large') return { error: { cause: { name: 'AccountStateTooLarge' } } };
      if (mode === 'RPC error') return { error: { cause: { name: 'UNAVAILABLE' } } };
      const key = (params as { prefix_base64: string }).prefix_base64;
      const value = {
        key: mode === 'wrong key' ? 'other' : key,
        value: mode === 'wrong value' ? 'AA==' : '',
      };
      return {
        result: {
          values: mode === 'absent' ? [] : mode === 'duplicate' ? [value, value] : [value],
        },
      };
    }
    return { error: { cause: { info: { InvalidTxError: 'Expired' } } } };
  });
  await reconcileRelayStorage({
    ledger,
    nearRpc: 'https://rpc.test',
    contractId: 'market.test',
    sender: { accountId: 'relay.test', key: 'test-double' },
  });
  const alert = vi.fn();
  await reconcileRelayStorage({
    ledger,
    nearRpc: 'https://rpc.test',
    contractId: 'market.test',
    sender: { accountId: 'relay.test', key: 'test-double' },
    alert,
  });
  if (mode !== 'absent') expect(alert).toHaveBeenCalledWith('reconcile_held');
  else expect(alert).not.toHaveBeenCalled();
  const rejected = mode === 'absent';
  expect((await ledger.operation('op'))?.stage).toBe(rejected ? 'rejected' : 'submitted');
  expect(await ledger.pendingStorage()).toBe(rejected ? 0n : 100n);
});

it.each(['full', 'other'] as const)('reports the specific reconcile failure: %s', async (mode) => {
  const ledger = new RelayLedger(memoryStore<RelayState>(), 'scope');
  await ledger.prepare({
    id: 'op',
    requestHash: 'h',
    method: 'unlock',
    fileId: `0x${'22'.repeat(32)}`,
    termsHash: `0x${'33'.repeat(32)}`,
    seller: 'seller',
    listed: false,
    ip: '192.0.2.1',
    storage: '100',
    allocation: '0',
    limits: relayLimits({ policy: { minPrice: 1n, maxDeadlineSeconds: 600 } } as CheckOptions),
  });
  await ledger.signed('op', {
    txHash: 'T',
    signed: 'original',
    signer: 'relay.test',
    args: { args: { purchase: buildPurchaseMessage(sample) } },
  });
  if (mode === 'full') {
    for (let i = 0; i < 32; i++) await ledger.defer(`work:${i}`, {}, 'h', 0);
  } else vi.spyOn(ledger, 'defer').mockRejectedValue(new Error('unavailable'));
  vi.mocked(rpcReply).mockImplementation(async (_url, name) =>
    name === 'tx'
      ? { error: { cause: { name: 'UNKNOWN_TRANSACTION' } } }
      : { error: { cause: { info: { InvalidTxError: 'Expired' } } } },
  );
  const alert = vi.fn();
  await reconcileRelayStorage({
    ledger,
    nearRpc: 'https://rpc.test',
    contractId: 'market.test',
    sender: { accountId: 'relay.test', key: 'test-double' },
    alert,
  });
  expect(alert).toHaveBeenCalledExactlyOnceWith(
    mode === 'full' ? 'paid_work_full' : 'reconcile_held',
  );
  expect((await ledger.operation('op'))?.stage).toBe('submitted');
  expect(await ledger.pendingStorage()).toBe(100n);
});
