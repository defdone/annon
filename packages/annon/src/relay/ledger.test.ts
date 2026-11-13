import { afterEach as clockAfter, beforeEach as clockBefore, vi as clockMock } from 'vitest';

clockBefore(() => clockMock.spyOn(Date, 'now').mockReturnValue(1000));
clockAfter(() => clockMock.restoreAllMocks());

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { terms } from '../../test/fixtures.js';
import { memoryStore } from '../pay/store.js';
import { fileStore } from '../pay/store-node.js';
import { termsHash } from '../settle-near/terms.js';
import { RelayLedger, type RelayState } from './ledger.js';

const scope = `${terms.network}|${terms.contract}`;
const decision = () => ({
  network: terms.network,
  contract: terms.contract,
  fileId: terms.file_id,
  termsHash: termsHash(terms),
  terms,
  eligible: true as const,
  tier: 'pool' as const,
  listed: false,
  policyVersion: 'v1',
  minPrice: '100000',
  fee: { fixed: '30000', bps: 100, treasuryNear: null, treasuryEvm: null },
  decidedAt: 100,
  allocated: '41000000000000000000000',
  outcome: 'registered' as const,
});
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
const admission = (id: string, method = 'unlock', fileId = terms.file_id) => ({
  id,
  requestHash: id,
  method,
  fileId,
  termsHash: termsHash(terms),
  seller: JSON.stringify(terms.seller),
  listed: false,
  ip: '192.0.2.1',
  storage: '0',
  allocation: '0',
  limits,
});

describe('durable relay admission', () => {
  it('freezes eligible decisions across restart and keeps complete checked terms', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'annon-relay-ledger-'));
    try {
      const a = new RelayLedger(fileStore<RelayState>(dir), scope);
      await a.remember(decision());
      const b = new RelayLedger(fileStore<RelayState>(dir), scope);
      expect(await b.decision(terms.file_id, termsHash(terms))).toEqual(decision());
      await b.remember({ ...decision(), minPrice: '9999999' });
      expect((await a.decision(terms.file_id, termsHash(terms)))?.minPrice).toBe('100000');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('atomically reserves file and seller unlock quotas and deduplicates across restart', async () => {
    const store = memoryStore<RelayState>();
    const a = new RelayLedger(store, scope);
    await Promise.all(Array.from({ length: 10 }, (_, i) => a.prepare(admission(`p${i}`), 1000)));
    await expect(a.prepare(admission('p10'), 1000)).rejects.toMatchObject({
      code: 'limited',
      retryAt: 86400000,
    });
    const b = new RelayLedger(store, scope);
    expect((await b.prepare(admission('p0'), 1000)).fresh).toBe(false);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        b.prepare(admission(`b${i}`, 'unlock', `0x${'77'.repeat(32)}`), 1000),
      ),
    );
    await expect(
      b.prepare(admission('other', 'unlock', `0x${'33'.repeat(32)}`), 1000),
    ).rejects.toMatchObject({ code: 'limited' });
    expect((await b.prepare(admission('tomorrow'), 86400000)).fresh).toBe(true);
  });
  it('protects separate unlock and listed pools, and releases only rejected holds', async () => {
    const a = new RelayLedger(memoryStore<RelayState>(), scope);
    const small = { ...limits, perDay: 4, unlock: 2, unlockReserved: 2, unlockListedReserved: 1 };
    await a.prepare({ ...admission('u'), limits: small }, 1000);
    await expect(a.prepare({ ...admission('u2'), limits: small }, 1000)).rejects.toMatchObject({
      code: 'limited',
    });
    await a.prepare({ ...admission('listed'), listed: true, limits: small }, 1000);
    await expect(
      a.prepare({ ...admission('u3'), listed: true, limits: small }, 1000),
    ).rejects.toMatchObject({ code: 'limited' });
    await a.prepare({ ...admission('c1', 'claim_key'), limits: small }, 1000);
    await a.prepare({ ...admission('c2', 'claim_key'), limits: small }, 1000);
    await a.reject('c1');
    await a.prepare({ ...admission('c3', 'claim_key'), limits: small }, 1000);
    await expect(
      a.prepare({ ...admission('c4', 'claim_key'), limits: small }, 1000),
    ).rejects.toMatchObject({ code: 'limited' });
  });
  it('gives listed registrations their own allowance and keeps uncertain reservations charged', async () => {
    const a = new RelayLedger(memoryStore<RelayState>(), scope);
    const small = { ...limits, files: 1, filesPerIp: 1 };
    await a.prepare({ ...admission('r1', 'register'), limits: small, decision: decision() }, 1000);
    await a.signed('r1', { txHash: 'H', signed: 'bytes', signer: 'relay.near', args: {} });
    await expect(
      a.prepare({ ...admission('r2', 'register'), limits: small }, 1000),
    ).rejects.toMatchObject({ code: 'limited' });
    await a.prepare({ ...admission('r3', 'register'), listed: true, limits: small }, 1000);
    expect((await a.operation('r1'))?.tx?.signed).toBe('bytes');
    await expect(
      a.prepare({ ...admission('r1', 'register'), requestHash: 'different' }, 1000),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
  it('claims a host upload once and binds top-up nonces across files and amounts', async () => {
    const a = new RelayLedger(memoryStore<RelayState>(), scope);
    const reservation = { key: 'https://host.example|upload', binding: 'r1' };
    await a.prepare({ ...admission('r1', 'register'), reservation }, 1000);
    await expect(
      a.prepare({ ...admission('r2', 'register'), reservation }, 1000),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      a.prepare(
        { ...admission('r3', 'register'), reservation: { ...reservation, binding: 'r3' } },
        1000,
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await a.prepare({ ...admission('fund'), nonce: 'seller|nonce' }, 1000);
    await expect(
      a.prepare({ ...admission('fund2'), nonce: 'seller|nonce' }, 1000),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });
});

it('reserves exactly 100 open files and five per IP without spending listed allowance', async () => {
  const a = new RelayLedger(memoryStore<RelayState>(), scope);
  for (let i = 0; i < 100; i++)
    await a.prepare(
      {
        ...admission(`open-${i}`, 'register'),
        seller: `seller-${i}`,
        ip: `ip-${Math.floor(i / 5)}`,
      },
      1000,
    );
  await expect(
    a.prepare({ ...admission('open-101', 'register'), seller: 'new', ip: 'new' }, 1000),
  ).rejects.toMatchObject({ code: 'limited' });
  await a.prepare({ ...admission('listed', 'register'), listed: true }, 1000);
  const b = new RelayLedger(memoryStore<RelayState>(), scope);
  for (let i = 0; i < 5; i++)
    await b.prepare({ ...admission(`same-ip-${i}`, 'register'), seller: `seller-${i}` }, 1000);
  await expect(
    b.prepare({ ...admission('same-ip-6', 'register'), seller: 'new' }, 1000),
  ).rejects.toMatchObject({ code: 'limited' });
});
it('enforces lifetime, daily and listed top-up reservations independently and refunds only a rejected hold', async () => {
  const a = new RelayLedger(memoryStore<RelayState>(), scope);
  await a.remember({ ...decision(), allocated: '4' });
  const topup = { lifetime: '8', fileDay: '4', totalDay: '10', listedReserved: '5' };
  await a.prepare({ ...admission('t1', 'fund_file_storage'), allocation: '4', topup }, 1000);
  await expect(
    a.prepare({ ...admission('t2', 'fund_file_storage'), allocation: '1', topup }, 1000),
  ).rejects.toMatchObject({ code: 'limited' });
  await a.reject('t1');
  expect((await a.decision(terms.file_id, termsHash(terms)))?.allocated).toBe('4');
  await a.prepare({ ...admission('t3', 'fund_file_storage'), allocation: '4', topup }, 1000);
  const other = `0x${'77'.repeat(32)}`;
  await a.remember({ ...decision(), fileId: other, allocated: '0' });
  await expect(
    a.prepare({ ...admission('pool', 'fund_file_storage', other), allocation: '2', topup }, 1000),
  ).rejects.toMatchObject({ code: 'limited' });
  await a.prepare(
    {
      ...admission('listed-fund', 'fund_file_storage', other),
      listed: true,
      allocation: '6',
      topup: { ...topup, lifetime: '10', fileDay: '10' },
    },
    1000,
  );
  const unknown = `0x${'88'.repeat(32)}`;
  await a.remember({ ...decision(), fileId: unknown, allocated: null });
  await expect(
    a.prepare(
      { ...admission('unknown', 'fund_file_storage', unknown), allocation: '1', topup },
      1000,
    ),
  ).rejects.toMatchObject({ code: 'not_sponsored' });
});
it('retains bounded paid work across restart, and clears it only after a submitted result', async () => {
  const store = memoryStore<RelayState>(),
    a = new RelayLedger(store, scope);
  await a.defer('p', { purchase: 'evidence' }, 'hash', 86400000, 1);
  await expect(
    a.defer('other', { purchase: 'evidence' }, 'other', 86400000, 1),
  ).rejects.toMatchObject({ code: 'settlement_pending' });
  const b = new RelayLedger(store, scope);
  expect((await b.read()).work).toEqual({
    p: { request: { purchase: 'evidence' }, requestHash: 'hash', nextAt: 86400000 },
  });
  await expect(b.defer('p', {}, 'changed', 86400000)).rejects.toMatchObject({
    code: 'bad_request',
  });
  await b.prepare({ ...admission('p'), requestHash: 'hash' }, 86400000);
  await b.signed('p', { txHash: 'H', signed: 'bytes', signer: 'relay.test', args: {} });
  await b.result('p', { txHash: 'H', uncertain: true });
  expect((await a.read()).work).toEqual({});
});
it('persists per-IP hourly admission and returns the exact UTC reset time', async () => {
  const store = memoryStore<RelayState>(),
    a = new RelayLedger(store, scope);
  await a.prepare({ ...admission('a', 'claim_key'), limits: { ...limits, perIpHour: 1 } }, 1800000);
  const b = new RelayLedger(store, scope);
  await expect(
    b.prepare({ ...admission('b', 'claim_key'), limits: { ...limits, perIpHour: 1 } }, 3599000),
  ).rejects.toMatchObject({ code: 'limited', retryAt: 3600000 });
  await b.prepare({ ...admission('c', 'claim_key'), limits: { ...limits, perIpHour: 1 } }, 3600000);
});

it('stores frozen decisions per file without a traffic cap or a growing registry document', async () => {
  const store = memoryStore<RelayState>();
  const a = new RelayLedger(store, scope);
  const state = await a.read();
  state.revision = 0;
  for (let i = 0; i < 4096; i++)
    state.decisions[`file:${i}|${termsHash(terms)}`] = { ...decision(), fileId: `file:${i}` };
  await store.compareAndSet(scope, null, state);
  await a.remember({ ...decision(), fileId: 'file:4096' });
  expect(Object.keys((await a.read()).decisions)).toHaveLength(0);
  const b = new RelayLedger(store, scope);
  expect(await b.decision('file:4096', termsHash(terms))).toMatchObject({ minPrice: '100000' });
  await b.remember({ ...decision(), fileId: 'file:4096', minPrice: '999999' });
  expect(await a.decision('file:4096', termsHash(terms))).toMatchObject({ minPrice: '100000' });
});

it('recovers a committed decision journal after a per-file write fails without changing frozen policy', async () => {
  const backing = memoryStore<RelayState>();
  const original = backing.compareAndSet;
  const write = clockMock.spyOn(backing, 'compareAndSet');
  write.mockImplementationOnce(original).mockImplementationOnce(async () => {
    throw new Error('disk unavailable');
  });
  const a = new RelayLedger(backing, scope);
  await expect(a.remember(decision())).rejects.toThrow('disk unavailable');
  const b = new RelayLedger(backing, scope);
  expect(await b.decision(terms.file_id, termsHash(terms))).toEqual(decision());
  await b.remember({ ...decision(), minPrice: '9999999' });
  expect(await b.decision(terms.file_id, termsHash(terms))).toEqual(decision());
  expect((await b.read()).decisions).toEqual({});
});

it('does not let a delayed decision flush overwrite a newer allocation', async () => {
  const backing = memoryStore<RelayState>();
  let resume: () => void = () => {};
  let entered: () => void = () => {};
  const paused = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let block = true;
  const store = {
    load: backing.load,
    compareAndSet: async (...args: Parameters<typeof backing.compareAndSet>) => {
      if (args[0].includes('|decision|') && block) {
        block = false;
        entered();
        await gate;
      }
      return backing.compareAndSet(...args);
    },
  };
  const a = new RelayLedger(store, scope);
  const b = new RelayLedger(store, scope);
  const pending = a.remember({ ...decision(), allocated: '4' });
  await paused;
  try {
    await b.prepare({
      ...admission('fund', 'fund_file_storage'),
      allocation: '1',
      topup: { lifetime: '8', fileDay: '4', totalDay: '10', listedReserved: '5' },
    });
  } finally {
    resume();
  }
  await pending;
  expect((await a.decision(terms.file_id, termsHash(terms)))?.allocated).toBe('5');
  expect((await a.read()).decisions).toEqual({});
});

it('keeps a newer decision journal until its own per-file flush is durable', async () => {
  const backing = memoryStore<RelayState>();
  let resumeFirst: () => void = () => {};
  let resumeSecond: () => void = () => {};
  let enteredFirst: () => void = () => {};
  let enteredSecond: () => void = () => {};
  const first = new Promise<void>((resolve) => {
    enteredFirst = resolve;
  });
  const second = new Promise<void>((resolve) => {
    enteredSecond = resolve;
  });
  const gateFirst = new Promise<void>((resolve) => {
    resumeFirst = resolve;
  });
  const gateSecond = new Promise<void>((resolve) => {
    resumeSecond = resolve;
  });
  let writes = 0;
  const store = {
    load: backing.load,
    compareAndSet: async (...args: Parameters<typeof backing.compareAndSet>) => {
      if (args[0].includes('|decision|')) {
        const index = ++writes;
        if (index === 1) {
          enteredFirst();
          await gateFirst;
        }
        if (index === 2) {
          enteredSecond();
          await gateSecond;
        }
      }
      return backing.compareAndSet(...args);
    },
  };
  const a = new RelayLedger(store, scope);
  const b = new RelayLedger(store, scope);
  const pending = a.remember({ ...decision(), allocated: '4' });
  await first;
  const newer = b.prepare({
    ...admission('fund', 'fund_file_storage'),
    allocation: '1',
    topup: { lifetime: '8', fileDay: '4', totalDay: '10', listedReserved: '5' },
  });
  await second;
  resumeFirst();
  try {
    await pending;
    expect((await a.read()).decisions[`${terms.file_id}|${termsHash(terms)}`]?.allocated).toBe('5');
  } finally {
    resumeSecond();
  }
  await newer;
  expect((await a.decision(terms.file_id, termsHash(terms)))?.allocated).toBe('5');
});

it('fails closed on a corrupt per-file decision record', async () => {
  const store = memoryStore<RelayState>();
  const ledger = new RelayLedger(store, scope);
  await ledger.remember(decision());
  const key = `${scope}|decision|${terms.file_id}|${termsHash(terms)}`;
  const old = await store.load(key);
  if (!old) throw new Error('missing record');
  await store.compareAndSet(key, old, { id: key, revision: old.revision + 1 } as RelayState);
  await expect(ledger.decision(terms.file_id, termsHash(terms))).rejects.toMatchObject({
    code: 'unavailable',
  });
});
