import { afterEach as clockAfter, beforeEach as clockBefore, vi as clockMock } from 'vitest';

clockBefore(() => clockMock.spyOn(Date, 'now').mockReturnValue(1000));
clockAfter(() => clockMock.restoreAllMocks());

import { expect, it } from 'vitest';
import { terms } from '../../test/fixtures.js';
import { memoryStore } from '../pay/store.js';
import { identityJson } from '../settle-near/identity.js';
import { termsHash } from '../settle-near/terms.js';
import { type Admission, RelayLedger, type RelayLimits, type RelayState } from './ledger.js';

const limits: RelayLimits = {
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
const admission = (id: string, over: Partial<Admission> = {}): Admission => ({
  id,
  requestHash: id,
  method: 'unlock',
  fileId: terms.file_id,
  termsHash: termsHash(terms),
  seller: identityJson(terms.seller),
  listed: false,
  ip: '192.0.2.1',
  storage: '0',
  allocation: '0',
  limits,
  ...over,
});
it.each([
  ['all', { perDay: 1, unlockReserved: 0 }, 'claim_key', false, false],
  ['IP hour', { perIpHour: 1 }, 'claim_key', false, false],
  ['unlock', { unlock: 1, unlockListedReserved: 0 }, 'unlock', true, false],
  ['file unlock', { unlocksPerFile: 1 }, 'unlock', false, false],
  ['seller unlock', { unlocksPerSeller: 1 }, 'unlock', false, true],
  ['listed file unlock', { listedUnlocksPerFile: 1 }, 'unlock', true, false],
  ['listed seller unlock', { listedUnlocksPerSeller: 1 }, 'unlock', true, true],
  ['unlisted unlock share', { unlock: 2, unlockListedReserved: 1 }, 'unlock', false, false],
  ['non-unlock share', { perDay: 3, unlockReserved: 2 }, 'claim_key', false, false],
  ['open files', { files: 1 }, 'register', false, true],
  ['files per IP', { filesPerIp: 1 }, 'register', false, true],
  ['seller registrations', { registrationsPerSeller: 1 }, 'register', false, true],
  ['listed registrations', { listedRegistrationsPerSeller: 1 }, 'register', true, true],
  ['method', { methods: { claim_key: 1 } }, 'claim_key', false, false],
] as const)(
  'enforces the %s quota atomically',
  async (_name, patch, method, listed, differentFile) => {
    const ledger = new RelayLedger(memoryStore<RelayState>(), 'scope');
    const p = { ...limits, ...patch };
    await ledger.prepare(admission('first', { limits: p, method, listed }), 1000);
    if (method === 'unlock')
      expect(
        await ledger.unlockAvailable(
          {
            fileId: terms.file_id,
            listed,
            terms,
          } as import('./ledger.js').SponsorshipDecision,
          p,
          1000,
        ),
      ).toBe(false);
    await expect(
      ledger.prepare(
        admission('second', {
          limits: p,
          method,
          listed,
          ...(differentFile ? { fileId: `0x${'33'.repeat(32)}` } : {}),
        }),
        1000,
      ),
    ).rejects.toMatchObject({ code: 'limited' });
    expect(await ledger.operation('second')).toBeNull();
  },
);
it.each([
  ['lifetime', { lifetime: '2' }],
  ['file day', { fileDay: '1' }],
  ['global day', { totalDay: '1' }],
  ['listed reserve', { totalDay: '2', listedReserved: '1' }],
] as const)('reserves and bounds top-up %s allocation', async (_name, patch) => {
  const listed = _name === 'global day';
  const ledger = new RelayLedger(memoryStore<RelayState>(), 'scope');
  await ledger.remember({
    network: terms.network,
    contract: terms.contract,
    fileId: terms.file_id,
    termsHash: termsHash(terms),
    terms,
    eligible: true,
    tier: listed ? 'listed' : 'pool',
    listed,
    policyVersion: 'v1',
    minPrice: '100000',
    fee: { fixed: '0', bps: 0, treasuryNear: null, treasuryEvm: null },
    decidedAt: 1,
    allocated: '1',
    outcome: 'registered',
  });
  const topup = { lifetime: '100', fileDay: '100', totalDay: '100', listedReserved: '0', ...patch };
  await ledger.prepare(
    admission('first', { method: 'fund_file_storage', listed, allocation: '1', topup }),
    1000,
  );
  await expect(
    ledger.prepare(
      admission('second', { method: 'fund_file_storage', listed, allocation: '1', topup }),
      1000,
    ),
  ).rejects.toMatchObject({ code: 'limited' });
  expect((await ledger.decision(terms.file_id, termsHash(terms)))?.allocated).toBe('2');
});

it('keeps the aggregate cap when tightened method pools overlap', async () => {
  const ledger = new RelayLedger(memoryStore<RelayState>(), 'scope');
  const p = { ...limits, perDay: 2, unlock: 2, unlockReserved: 1, unlockListedReserved: 0 };
  await ledger.prepare(admission('other', { method: 'claim_key', limits: p }), 1000);
  await ledger.prepare(admission('unlock1', { listed: true, limits: p }), 1000);
  await expect(
    ledger.prepare(admission('unlock2', { listed: true, limits: p }), 1000),
  ).rejects.toMatchObject({ code: 'limited' });
});
it('charges a grant quota once per unique operation', async () => {
  const ledger = new RelayLedger(memoryStore<RelayState>(), 'scope');
  const quota = { key: 'grant', limit: 1 };
  await ledger.prepare(admission('first', { method: 'claim_key', quota }), 1000);
  expect(
    (await ledger.prepare(admission('first', { method: 'claim_key', quota }), 1000)).fresh,
  ).toBe(false);
  await expect(
    ledger.prepare(admission('second', { method: 'claim_key', quota }), 1000),
  ).rejects.toMatchObject({ code: 'limited' });
});
