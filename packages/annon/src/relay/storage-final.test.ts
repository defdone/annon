import { afterEach as clockAfter, beforeEach as clockBefore, vi as clockMock } from 'vitest';

clockBefore(() => clockMock.spyOn(Date, 'now').mockReturnValue(1000));
clockAfter(() => clockMock.restoreAllMocks());

import { expect, it, vi } from 'vitest';
import { rpcReply } from '../near/rpc.js';
import { memoryStore } from '../pay/store.js';
import { RelayLedger, type RelayState } from './ledger.js';
import { reconcileRelayStorage } from './relay.js';

vi.mock('../near/rpc.js', async (original) => ({
  ...(await original<typeof import('../near/rpc.js')>()),
  rpcReply: vi.fn(),
}));
it('clears only a bound FINAL storage reservation and leaves its daily send charge', async () => {
  const ledger = new RelayLedger(memoryStore<RelayState>(), 'scope');
  const limits = {
    perDay: 1000,
    unlock: 500,
    unlockReserved: 500,
    unlockListedReserved: 250,
    unlocksPerFile: 10,
    unlocksPerSeller: 20,
    listedUnlocksPerFile: 100,
    listedUnlocksPerSeller: 250,
    files: 100,
    filesPerIp: 5,
    registrationsPerSeller: 5,
    listedRegistrationsPerSeller: 20,
  };
  await ledger.prepare(
    {
      id: 'op',
      requestHash: 'h',
      method: 'fund_file_storage',
      fileId: `0x${'22'.repeat(32)}`,
      termsHash: `0x${'33'.repeat(32)}`,
      seller: 'seller',
      listed: true,
      ip: '192.0.2.1',
      storage: '100',
      allocation: '100',
      limits,
    },
    1000,
  );
  await ledger.signed('op', {
    txHash: 'T',
    signed: 'bytes',
    signer: 'relay.test',
    args: { file_id: `0x${'22'.repeat(32)}`, amount: '100' },
  });
  const args = Buffer.from(
    JSON.stringify({ file_id: `0x${'22'.repeat(32)}`, amount: '100' }),
  ).toString('base64');
  const final = {
    final_execution_status: 'FINAL',
    transaction: {
      hash: 'T',
      signer_id: 'relay.test',
      receiver_id: 'market.test',
      actions: [{ FunctionCall: { method_name: 'fund_file_storage', args } }],
    },
    status: { SuccessValue: '' },
    receipts_outcome: [],
  };
  const o = { ledger, nearRpc: 'https://rpc.test', contractId: 'market.test' };
  vi.mocked(rpcReply).mockResolvedValue({
    result: { ...final, final_execution_status: 'INCLUDED' },
  });
  await reconcileRelayStorage(o);
  expect(await ledger.pendingStorage()).toBe(100n);
  vi.mocked(rpcReply).mockResolvedValue({
    result: { ...final, transaction: { ...final.transaction, receiver_id: 'other.test' } },
  });
  await reconcileRelayStorage(o);
  expect(await ledger.pendingStorage()).toBe(100n);
  vi.mocked(rpcReply).mockResolvedValue({ result: final });
  await reconcileRelayStorage(o);
  expect(await ledger.pendingStorage()).toBe(0n);
  expect((await ledger.read()).counters['0|all']).toBe('1');
});

it('eventually reconciles later transactions when the first batch stays unresolved', async () => {
  const ledger = new RelayLedger(memoryStore<RelayState>(), 'scope');
  const prepare = {
    requestHash: 'h',
    method: 'claim_key',
    fileId: `0x${'22'.repeat(32)}`,
    termsHash: `0x${'33'.repeat(32)}`,
    seller: 'seller',
    listed: true,
    ip: '192.0.2.1',
    storage: '100',
    allocation: '0',
    limits: {
      perDay: 1000,
      unlock: 500,
      unlockReserved: 500,
      unlockListedReserved: 250,
      unlocksPerFile: 10,
      unlocksPerSeller: 20,
      listedUnlocksPerFile: 100,
      listedUnlocksPerSeller: 250,
      files: 100,
      filesPerIp: 5,
      registrationsPerSeller: 5,
      listedRegistrationsPerSeller: 20,
    },
  };
  for (let i = 0; i < 33; i++) {
    await ledger.prepare({ ...prepare, id: `op${i}` }, 1000);
    await ledger.signed(`op${i}`, {
      txHash: `T${i}`,
      signed: 'bytes',
      signer: 'relay.test',
      args: {},
    });
  }
  vi.mocked(rpcReply)
    .mockReset()
    .mockResolvedValue({ error: { cause: { name: 'UNKNOWN_TRANSACTION' } } });
  const o = { ledger, nearRpc: 'https://rpc.test', contractId: 'market.test' };
  await reconcileRelayStorage(o);
  expect(vi.mocked(rpcReply).mock.calls.length).toBeLessThanOrEqual(32);
  await reconcileRelayStorage(o);
  expect(
    vi
      .mocked(rpcReply)
      .mock.calls.some((call) => (call[2] as { tx_hash?: string }).tx_hash === 'T32'),
  ).toBe(true);
});
