import { beforeEach, describe, expect, it, vi } from 'vitest';
import { terms as initial, must } from '../../test/fixtures.js';
import { getFile } from '../near/rpc.js';
import { readSplitState } from '../pay/split.js';
import { memoryStore } from '../pay/store.js';
import { termsHash } from '../settle-near/terms.js';
import { RelayLedger, type RelayState } from './ledger.js';
import type { CheckOptions } from './relay.js';
import { admitTerms, baseEligibility } from './sponsorship.js';

vi.mock('../near/rpc.js', async (original) => ({
  ...(await original<typeof import('../near/rpc.js')>()),
  getFile: vi.fn(),
}));
vi.mock('../pay/split.js', async (original) => ({
  ...(await original<typeof import('../pay/split.js')>()),
  readSplitState: vi.fn(),
}));
const file = {
  terms: initial,
  termsHash: termsHash(initial),
  seller: initial.seller,
  purchaseStorageBalance: 0n,
  price: BigInt(initial.base?.price ?? '0'),
  payTo: initial.base?.pay_to ?? '',
  cipherHash: initial.cipher_hash,
  moderator: null,
  headerHash: null,
  salesStoppedAt: null,
  takenDown: null,
};
const options = (): CheckOptions => ({
  nearRpc: 'https://near.example',
  baseRpc: 'https://base.example',
  contractId: initial.contract,
  usdc: initial.base?.usdc ?? '',
  nearUsdc: initial.near.token,
  network: initial.network,
  now: 1000,
  policy: {
    minPrice: 1n,
    maxDeadlineSeconds: 600,
    fee: { fixed: '0', bps: 0, treasuryNear: null, treasuryEvm: null },
  },
  ledger: new RelayLedger(memoryStore<RelayState>(), `${initial.network}|${initial.contract}`),
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getFile).mockResolvedValue(file);
  vi.mocked(readSplitState).mockResolvedValue({ kind: 'push', shares: [], distributorPercent: 0 });
});
const seal = async (o: CheckOptions) =>
  o.ledger?.seal(
    {
      policyVersion: 'legacy-v0',
      blockHash: 'cutover',
      blockHeight: 5,
      scannedThrough: 5,
      minPrice: '100000',
      fee: { fixed: '30000', bps: 100, treasuryNear: null, treasuryEvm: null },
      inventory: [],
    },
    [],
  );

describe('frozen Base eligibility', () => {
  it('freezes policy but refreshes checkedAt on every response and survives registry recreation', async () => {
    const o = options();
    await seal(o);
    // This file did not exist at cutover.
    o.historicalFile = async () => null;
    const first = await baseEligibility(initial.file_id, termsHash(initial), o);
    expect(first).toMatchObject({
      eligible: true,
      tier: 'external',
      decidedAt: 1000,
      checkedAt: 1000,
    });
    const changed = {
      ...o,
      now: 2000,
      policy: { ...o.policy, baseSponsorship: false, minPrice: 999999999n },
    };
    expect(await baseEligibility(initial.file_id, termsHash(initial), changed)).toMatchObject({
      eligible: true,
      decidedAt: 1000,
      checkedAt: 2000,
      minPrice: '1',
    });
    expect(readSplitState).toHaveBeenCalledTimes(1);
  });
  it('never persists refusal and separates malformed terms from dependency failures', async () => {
    const o = options();
    await seal(o);
    o.historicalFile = async () => null;
    expect(
      await baseEligibility(initial.file_id, termsHash(initial), {
        ...o,
        policy: { ...o.policy, minPrice: 9999999n },
      }),
    ).toMatchObject({ eligible: false, reason: 'not_sponsored' });
    expect(await o.ledger?.decision(initial.file_id, termsHash(initial))).toBeNull();
    vi.mocked(readSplitState).mockRejectedValueOnce({ code: 'transport' });
    await expect(baseEligibility(initial.file_id, termsHash(initial), o)).rejects.toMatchObject({
      code: 'relayer_unavailable',
    });
    expect(await baseEligibility(initial.file_id, termsHash(initial), o)).toMatchObject({
      eligible: true,
    });
  });
  it('requires sealed history and never permanently refuses a historical paid purchase without evidence', async () => {
    const o = options();
    await expect(baseEligibility(initial.file_id, termsHash(initial), o)).rejects.toMatchObject({
      code: 'relayer_unavailable',
    });
    await seal(o);
    await expect(baseEligibility(initial.file_id, termsHash(initial), o)).rejects.toMatchObject({
      code: 'relayer_unavailable',
    });
    await expect(
      baseEligibility(initial.file_id, termsHash(initial), o, true),
    ).rejects.toMatchObject({ code: 'settlement_pending' });
  });
  it('uses sealed inventory as the listed legacy tier and skips only its fee check', async () => {
    const o = options();
    await o.ledger?.seal(
      {
        policyVersion: 'legacy-v0',
        blockHash: 'cutover',
        blockHeight: 5,
        scannedThrough: 5,
        minPrice: '100000',
        fee: { fixed: '30000', bps: 100, treasuryNear: null, treasuryEvm: null },
        inventory: [initial.file_id],
      },
      [],
    );
    o.historicalFile = async () => file;
    expect(await baseEligibility(initial.file_id, termsHash(initial), o)).toMatchObject({
      eligible: true,
      tier: 'legacy',
    });
    expect((await o.ledger?.decision(initial.file_id, termsHash(initial)))?.listed).toBe(true);
    expect((await baseEligibility(initial.file_id, termsHash(initial), o)).fee).toMatchObject({
      fixed: '0',
      bps: 0,
    });
  });
  it('checks real split state before admitting registration terms', async () => {
    const o = options();
    vi.mocked(readSplitState).mockRejectedValueOnce(new Error('bad split'));
    await expect(admitTerms(initial, o, 'pool')).rejects.toMatchObject({ code: 'not_sponsored' });
  });
});

it('reports the actual UTC reset when pre-sign unlock capacity is exhausted', async () => {
  const o = options();
  await seal(o);
  o.historicalFile = async () => null;
  o.admissionLimits = { unlock: 0 };
  await expect(baseEligibility(initial.file_id, termsHash(initial), o)).rejects.toMatchObject({
    code: 'relayer_unavailable',
    retryAt: 86400000,
  });
});

it.each([
  { ...initial, network: 'near:testnet' },
  { ...initial, contract: 'other.test' },
  { ...initial, near: { ...initial.near, price: '1' } },
  { ...initial, base: { ...must(initial.base), price: '1' } },
])('refuses registration terms outside deployment or either route minimum', async (terms) => {
  const o = options();
  o.policy.minPrice = 100000n;
  await expect(admitTerms(terms, o, 'pool')).rejects.toMatchObject({ code: 'not_sponsored' });
});
it('requires the policy treasury share before admitting terms', async () => {
  const o = options();
  o.policy.fee = { fixed: '30000', bps: 100, treasuryNear: null, treasuryEvm: null };
  await expect(admitTerms(initial, o, 'pool')).rejects.toMatchObject({ code: 'not_sponsored' });
});
it('never treats different cutover terms as the current listing', async () => {
  const o = options();
  await seal(o);
  const terms = { ...initial, cipher_hash: `0x${'77'.repeat(32)}` };
  o.historicalFile = async () => ({ ...file, terms, termsHash: termsHash(terms) });
  expect(await baseEligibility(initial.file_id, termsHash(initial), o)).toMatchObject({
    eligible: true,
    tier: 'external',
  });
});

it('requires a sealed cutover even when a historical reader is configured', async () => {
  const o = options();
  o.historicalFile = async () => null;
  await expect(baseEligibility(initial.file_id, termsHash(initial), o)).rejects.toMatchObject({
    code: 'relayer_unavailable',
  });
});
it('refuses new payment admission while paused and requires EVM Base recipients', async () => {
  const o = options();
  await seal(o);
  o.historicalFile = async () => null;
  await expect(
    baseEligibility(initial.file_id, termsHash(initial), { ...o, acceptingNewBasePayments: false }),
  ).rejects.toMatchObject({ code: 'relayer_unavailable' });
  const terms = {
    ...initial,
    near: {
      ...initial.near,
      recipients: [{ identity: { kind: 'near' as const, id: 'seller.test' }, bps: 10000 }],
    },
  };
  await expect(admitTerms(terms, o, 'pool')).rejects.toMatchObject({ code: 'not_sponsored' });
});

it('keeps a historical paid purchase pending when its old policy cannot be verified', async () => {
  const o = options();
  await seal(o);
  o.historicalFile = async () => file;
  await expect(baseEligibility(initial.file_id, termsHash(initial), o, true)).rejects.toMatchObject(
    { code: 'settlement_pending' },
  );
});
it('refuses stopped listings before a new purchase but honours a paid frozen decision', async () => {
  const o = options();
  await seal(o);
  o.historicalFile = async () => null;
  await baseEligibility(initial.file_id, termsHash(initial), o);
  vi.mocked(getFile).mockResolvedValue({ ...file, salesStoppedAt: 1 });
  expect(await baseEligibility(initial.file_id, termsHash(initial), o)).toMatchObject({
    eligible: false,
  });
  expect(await baseEligibility(initial.file_id, termsHash(initial), o, true)).toMatchObject({
    eligible: true,
  });
});
it('alerts when the archival reader is missing', async () => {
  const o = options();
  await seal(o);
  o.alert = vi.fn();
  await expect(baseEligibility(initial.file_id, termsHash(initial), o, true)).rejects.toMatchObject(
    { code: 'settlement_pending' },
  );
  expect(o.alert).toHaveBeenCalledWith('historical_unavailable');
});
it('uses the final shared admission defaults for unlisted sellers', async () => {
  const { relayLimits } = await import('./sponsorship.js');
  expect(relayLimits({ policy: {} } as CheckOptions)).toMatchObject({
    files: 60,
    filesPerIp: 1,
    registrationsPerSeller: 1,
  });
});
