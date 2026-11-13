import { afterEach as clockAfter, beforeEach as clockBefore, vi as clockMock } from 'vitest';

clockBefore(() => clockMock.spyOn(Date, 'now').mockReturnValue(1000));
clockAfter(() => clockMock.restoreAllMocks());

import { expect, it } from 'vitest';
import { memoryStore } from '../pay/store.js';
import { RelayLedger, type RelayState } from './ledger.js';

const admission = {
  id: 'op',
  requestHash: 'hash',
  method: 'unlock',
  fileId: `0x${'22'.repeat(32)}`,
  termsHash: `0x${'33'.repeat(32)}`,
  seller: 'seller',
  listed: false,
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
it('retains prepaid reservations beyond two minutes until a bound FINAL outcome', async () => {
  const ledger = new RelayLedger(memoryStore<RelayState>(), 'scope');
  await ledger.prepare(admission, 1000);
  await ledger.signed('op', { txHash: 'hash', signed: 'bytes', signer: 'relay.test', args: {} });
  await ledger.result('op', { txHash: 'hash' });
  expect(await ledger.pendingStorage(9999999)).toBe(100n);
});

it.each(['counter', 'storage', 'funding baseline'] as const)(
  'fails closed on a corrupt negative %s reservation',
  async (kind) => {
    const store = memoryStore<RelayState>(),
      ledger = new RelayLedger(store, 'scope');
    await ledger.prepare(admission, 1000);
    const old = await ledger.read(),
      next = structuredClone(old);
    next.revision++;
    if (kind === 'counter') next.counters['0|all'] = '-1';
    else {
      const op = next.operations.op;
      if (op) {
        if (kind === 'funding baseline') op.fundingBalanceBefore = '-1';
        else op.storage = '-100';
      }
    }
    await store.compareAndSet('scope', old, next);
    await expect(ledger.read()).rejects.toMatchObject({ code: 'unavailable' });
  },
);

it('retains signed evidence when a proven failed attempt is retried', async () => {
  const ledger = new RelayLedger(memoryStore<RelayState>(), 'scope');
  await ledger.prepare(admission, 1000);
  await ledger.signed('op', {
    txHash: 'first',
    signed: 'first-bytes',
    signer: 'relay.test',
    args: {},
  });
  await ledger.finalizeStorage('op', 'first');
  await ledger.retire('op', 'first');
  await ledger.prepare(admission, 2000);
  expect(
    Object.values((await ledger.read()).history).some((op) => op.tx?.signed === 'first-bytes'),
  ).toBe(true);
  expect((await ledger.read()).counters['0|all']).toBe('2');
});

it('ignores a late submission result for a different signed transaction', async () => {
  const ledger = new RelayLedger(memoryStore<RelayState>(), 'scope');
  await ledger.prepare(admission, 1000);
  await ledger.signed('op', { txHash: 'current', signed: 'bytes', signer: 'relay.test', args: {} });
  await ledger.result('op', { txHash: 'current' });
  await ledger.result('op', { txHash: 'old' });
  expect((await ledger.operation('op'))?.result?.txHash).toBe('current');
});

it('does not let stale final evidence release a newer transaction hold', async () => {
  const ledger = new RelayLedger(memoryStore<RelayState>(), 'scope');
  await ledger.prepare(admission, 1000);
  await ledger.signed('op', { txHash: 'current', signed: 'bytes', signer: 'relay.test', args: {} });
  await ledger.finalizeStorage('op', 'old');
  expect(await ledger.pendingStorage()).toBe(100n);
  expect(await ledger.retire('op', 'old')).toBe(false);
  expect((await ledger.operation('op'))?.stage).toBe('submitted');
});

it.each(['submitted', 'prepared'] as const)(
  'restart recovery preserves signed evidence even in stage %s',
  async (stage) => {
    const store = memoryStore<RelayState>();
    const ledger = new RelayLedger(store, 'scope');
    await ledger.prepare(admission);
    await ledger.signed('op', { txHash: 'T', signed: 'bytes', signer: 'relay.test', args: {} });
    const raw = await ledger.read();
    const changed = structuredClone(raw);
    const op = changed.operations.op;
    if (op) op.stage = stage;
    changed.revision++;
    await store.compareAndSet('scope', raw, changed);
    const before = await ledger.read();
    await new RelayLedger(store, 'scope').recoverPrepared();
    expect((await ledger.operation('op'))?.stage).toBe(stage);
    expect(await ledger.pendingStorage()).toBe(100n);
    expect((await ledger.read()).counters).toEqual(before.counters);
  },
);
it('refuses a full durable work queue instead of silently dropping a paid request', async () => {
  const ledger = new RelayLedger(memoryStore<RelayState>(), 'scope');
  await ledger.defer('one', {}, 'one', 0, 1);
  await expect(ledger.defer('two', {}, 'two', 0, 1)).rejects.toMatchObject({
    code: 'settlement_pending',
  });
  expect(Object.keys((await ledger.read()).work)).toEqual(['one']);
});
it('prunes old counters without recreating refunded counters or releasing unresolved holds', async () => {
  const ledger = new RelayLedger(memoryStore<RelayState>(), 'scope');
  await ledger.prepare(admission, 0);
  await ledger.signed('op', { txHash: 'T', signed: 'bytes', signer: 'relay.test', args: {} });
  clockMock.mocked(Date.now).mockReturnValue(3 * 86400000);
  await ledger.defer('work', {}, 'h', 0);
  const state = await ledger.read();
  expect(Object.keys(state.counters)).toEqual([]);
  expect(await ledger.pendingStorage()).toBe(100n);
  expect((await ledger.operation('op'))?.tx?.signed).toBe('bytes');
  expect((await ledger.operation('op'))?.compact).toBeUndefined();
  clockMock.mocked(Date.now).mockReturnValue(0);
  await ledger.reject('op');
  expect(Object.keys((await ledger.read()).counters)).toEqual([]);
});

it('deletes terminal operations only after FINAL plus the hold, keeping unresolved evidence', async () => {
  const ledger = new RelayLedger(memoryStore<RelayState>(), 'scope');
  await ledger.prepare(admission, 1000);
  await ledger.signed('op', { txHash: 'landed', signed: 'bytes', signer: 'relay.test', args: {} });
  clockMock.mocked(Date.now).mockReturnValue(2000000);
  await ledger.finalizeStorage('op', 'landed', 'released');
  await ledger.defer('maintenance', {}, 'h', 0);
  expect((await ledger.operation('op'))?.tx?.signed).toBe('bytes');
  clockMock.mocked(Date.now).mockReturnValue(2900000);
  await ledger.defer('maintenance', {}, 'h', 0);
  expect(await ledger.operation('op')).toBeNull();
  expect(await ledger.pendingStorage()).toBe(0n);
});

it('refuses new non-unlock work at capacity while preserving eligible paid unlock capacity', async () => {
  const store = memoryStore<RelayState>();
  const ledger = new RelayLedger(store, 'scope');
  const state = await ledger.read();
  state.revision = 0;
  for (let i = 0; i < 4096; i++)
    state.operations[`live:${i}`] = {
      ...admission,
      id: `live:${i}`,
      at: 1000,
      stage: 'submitted',
      charges: [],
      tx: { txHash: String(i), signed: 'bytes', signer: 'relay.test', args: {} },
    };
  await store.compareAndSet('scope', null, state);
  await expect(
    ledger.prepare({ ...admission, id: 'claim', method: 'claim_key' }),
  ).rejects.toMatchObject({ code: 'relayer_unavailable' });
  const { terms } = await import('../../test/fixtures.js');
  expect(
    await ledger.unlockAvailable(
      { fileId: terms.file_id, listed: false, terms } as import('./ledger.js').SponsorshipDecision,
      admission.limits,
    ),
  ).toBe(true);
  expect((await ledger.prepare(admission)).fresh).toBe(true);
  expect(Object.keys((await ledger.read()).operations)).toHaveLength(4097);
});

it('expires nonce bindings at the authorization deadline and reservation bindings after staging', async () => {
  const ledger = new RelayLedger(memoryStore<RelayState>(), 'scope');
  await ledger.prepare({
    ...admission,
    nonce: 'nonce',
    nonceDeadline: 600,
    reservation: { key: 'upload', binding: 'hash' },
  });
  clockMock.mocked(Date.now).mockReturnValue(599999);
  await ledger.defer('maintenance', {}, 'h', 0);
  expect((await ledger.read()).nonces.nonce).toBeDefined();
  expect((await ledger.read()).reservations.upload).toBeDefined();
  clockMock.mocked(Date.now).mockReturnValue(600000);
  await ledger.defer('maintenance', {}, 'h', 0);
  expect((await ledger.read()).nonces.nonce).toBeDefined();
  clockMock.mocked(Date.now).mockReturnValue(601000);
  await ledger.defer('maintenance', {}, 'h', 0);
  expect((await ledger.read()).nonces.nonce).toBeUndefined();
  expect((await ledger.read()).reservations.upload).toBeDefined();
  clockMock.mocked(Date.now).mockReturnValue(86401000);
  await ledger.defer('maintenance', {}, 'h', 0);
  expect((await ledger.read()).reservations.upload).toBeUndefined();
});

it('bounds retired history independently of live operations', async () => {
  const ledger = new RelayLedger(memoryStore<RelayState>(), 'scope');
  for (let i = 0; i < 132; i++) {
    await ledger.prepare(admission);
    await ledger.reject('op');
  }
  expect(Object.keys((await ledger.read()).history)).toHaveLength(128);
});

it('honors the configured retention hold from the final outcome', async () => {
  const ledger = new RelayLedger(memoryStore<RelayState>(), 'scope', 5000);
  await ledger.prepare(admission);
  await ledger.signed('op', { txHash: 'T', signed: 'bytes', signer: 'relay.test', args: {} });
  await ledger.finalizeStorage('op', 'T', 'done');
  clockMock.mocked(Date.now).mockReturnValue(5999);
  await ledger.defer('w', {}, 'h', 0);
  expect(await ledger.operation('op')).not.toBeNull();
  clockMock.mocked(Date.now).mockReturnValue(6000);
  await ledger.defer('w', {}, 'h', 0);
  expect(await ledger.operation('op')).toBeNull();
});
