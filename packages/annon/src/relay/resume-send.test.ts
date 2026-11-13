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
it('resubmits the same durable bytes after a crash before broadcast without another admission', async () => {
  const ledger = new RelayLedger(memoryStore<RelayState>(), 'scope');
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
    },
    1000,
  );
  await ledger.signed('op', {
    txHash: 'T',
    signed: 'same-signed-bytes',
    signer: 'relay.test',
    args: { file_id: `0x${'22'.repeat(32)}`, amount: '100' },
  });
  vi.mocked(rpcReply).mockImplementation(async (_url, method) =>
    method === 'tx'
      ? { error: { cause: { name: 'UNKNOWN_TRANSACTION' } } }
      : { result: { final_execution_status: 'INCLUDED' } },
  );
  await reconcileRelayStorage({
    ledger,
    nearRpc: 'https://rpc.test',
    contractId: 'market.test',
    sender: { accountId: 'relay.test', key: 'test-double' },
  });
  expect(vi.mocked(rpcReply).mock.calls.filter(([, method]) => method === 'send_tx')).toHaveLength(
    1,
  );
  expect(
    vi.mocked(rpcReply).mock.calls.find(([, method]) => method === 'send_tx')?.[2],
  ).toMatchObject({ signed_tx_base64: 'same-signed-bytes' });
  expect((await ledger.read()).counters['0|all']).toBe('1');
  expect(await ledger.pendingStorage()).toBe(100n);
  vi.mocked(rpcReply).mockClear();
  await reconcileRelayStorage({
    ledger,
    nearRpc: 'https://rpc.test',
    contractId: 'market.test',
    ...{ sender: { accountId: 'relay.test', key: 'test-double' }, disabled: true },
  });
  expect(vi.mocked(rpcReply).mock.calls.filter(([, method]) => method === 'send_tx')).toHaveLength(
    0,
  );
});
