import { afterEach, expect, it, vi } from 'vitest';
import { terms as initial, must } from '../../test/fixtures.js';
import { AnnonError } from '../errors.js';
import type { FileInfo } from '../near/rpc.js';
import { PayError } from '../pay/base.js';
import * as splits from '../pay/split.js';
import { termsHash } from '../settle-near/terms.js';
import { checkBaseSponsorship, validBaseSponsorship } from './capabilities.js';
import { applySponsoredFee } from './fees.js';

afterEach(() => vi.restoreAllMocks());
function fixture() {
  const fee = {
    fixed: '30000',
    bps: 100,
    treasuryNear: null,
    treasuryEvm: { kind: 'evm' as const, id: `0x${'55'.repeat(20)}` },
  };
  const terms = {
    ...initial,
    near: applySponsoredFee(initial.near, fee, must(initial.base).price),
  };
  const file: FileInfo = {
    terms,
    termsHash: termsHash(terms),
    seller: terms.seller,
    price: BigInt(must(terms.base).price),
    payTo: must(terms.base).pay_to,
    cipherHash: terms.cipher_hash,
    moderator: null,
    headerHash: null,
    takenDown: null,
    salesStoppedAt: null,
    purchaseStorageBalance: 0n,
  };
  const deployment = {
    network: terms.network,
    contractId: terms.contract,
    nearUsdc: terms.near.token,
    baseUsdc: must(terms.base).usdc,
  };
  const cap = {
    network: terms.network,
    contract: terms.contract,
    nearUsdc: terms.near.token,
    baseUsdc: must(terms.base).usdc,
    disabled: false,
    baseSponsorship: true,
    acceptingNewBasePayments: true,
    methods: ['unlock'],
  };
  const decision = {
    network: terms.network,
    contract: terms.contract,
    fileId: terms.file_id,
    termsHash: file.termsHash,
    eligible: true,
    tier: 'legacy',
    policyVersion: '1',
    minPrice: must(terms.base).price,
    fee,
    decidedAt: 1,
    checkedAt: 1000,
  };
  const read = vi
    .spyOn(splits, 'readSplitState')
    .mockResolvedValue({ kind: 'push', shares: [], distributorPercent: 0 });
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    Response.json(String(url).endsWith('/v1/capabilities') ? cap : decision),
  );
  const options = {
    deployment,
    file,
    baseRpc: 'https://base.test',
    relayer: 'https://relay.test',
    fetch: fetcher,
    now: () => 1000,
  };
  return { options, cap, decision, read, fetcher };
}
it('checks frozen eligibility at the inclusive minimum and binds a fresh client split read', async () => {
  const h = fixture();
  const checked = await checkBaseSponsorship(h.options);
  expect(h.read).toHaveBeenCalledTimes(1);
  expect(h.fetcher.mock.calls[1]?.[1]).toMatchObject({
    method: 'POST',
    body: JSON.stringify({
      fileId: h.options.file.terms.file_id,
      termsHash: h.options.file.termsHash,
    }),
  });
  expect(validBaseSponsorship(checked, h.options)).toBe(true);
  expect(validBaseSponsorship(checked, { ...h.options, now: () => 1031 })).toBe(false);
  expect(validBaseSponsorship({ ...checked, splitCheckedAt: 969 }, h.options)).toBe(false);
  expect(
    validBaseSponsorship(checked, {
      ...h.options,
      deployment: { ...h.options.deployment, contractId: 'other.near' },
    }),
  ).toBe(false);
  expect(
    validBaseSponsorship(checked, {
      ...h.options,
      file: { ...h.options.file, termsHash: `0x${'00'.repeat(32)}` },
    }),
  ).toBe(false);
});
it.each([
  'network',
  'contract',
  'nearUsdc',
  'baseUsdc',
  'methods',
  'acceptingNewBasePayments',
  'disabled',
  'baseSponsorship',
] as const)('fails closed on missing capability %s', async (field) => {
  const h = fixture();
  delete (h.cap as Record<string, unknown>)[field];
  const result = checkBaseSponsorship(h.options);
  await expect(result).rejects.toBeInstanceOf(AnnonError);
  await expect(result).rejects.toMatchObject({ code: 'relayer_unavailable' });
  expect(h.read).not.toHaveBeenCalled();
});
it.each([
  'network',
  'contract',
  'fileId',
  'termsHash',
  'eligible',
  'tier',
  'policyVersion',
  'minPrice',
  'fee',
  'checkedAt',
  'decidedAt',
] as const)('fails closed on missing decision %s', async (field) => {
  const h = fixture();
  delete (h.decision as Record<string, unknown>)[field];
  await expect(checkBaseSponsorship(h.options)).rejects.toMatchObject({
    code: 'relayer_unavailable',
  });
});
it.each([
  'stale',
  'future',
  'wrong-file',
  'wrong-terms',
  'wrong-network',
  'wrong-contract',
  'rpc',
  'disabled',
  'stopped',
  'takedown',
  'price',
  'fee',
  'recipients',
  'split',
  'no-rpc',
  'http',
  'path',
  'oversized',
] as const)('refuses unsafe pre-sign eligibility: %s', async (mode) => {
  const h = fixture();
  let code = 'relayer_unavailable';
  if (mode === 'stale') h.decision.checkedAt = 969;
  if (mode === 'future') h.decision.checkedAt = 1031;
  if (mode === 'wrong-file') h.decision.fileId = `0x${'00'.repeat(32)}`;
  if (mode === 'wrong-terms') h.decision.termsHash = `0x${'00'.repeat(32)}`;
  if (mode === 'wrong-network') h.cap.network = 'near:testnet';
  if (mode === 'wrong-contract') h.cap.contract = 'other.near';
  if (mode === 'rpc') h.read.mockRejectedValue(new PayError('transport'));
  if (mode === 'disabled') h.cap.acceptingNewBasePayments = false;
  if (mode === 'stopped') {
    h.options.file.salesStoppedAt = 1;
    code = 'not_sponsored';
  }
  if (mode === 'takedown') {
    h.options.file.takenDown = 'court_order';
    code = 'not_sponsored';
  }
  if (mode === 'price') {
    h.decision.minPrice = String(BigInt(h.decision.minPrice) + 1n);
    code = 'not_sponsored';
  }
  if (mode === 'fee') {
    h.decision.fee.fixed = '999999';
    code = 'not_sponsored';
  }
  if (mode === 'recipients') {
    must(h.options.file.terms.near.recipients[0]).identity = { kind: 'near', id: 'seller.near' };
    code = 'not_sponsored';
  }
  if (mode === 'split') {
    h.read.mockRejectedValue(new PayError('bad_requirements'));
    code = 'not_sponsored';
  }
  if (mode === 'no-rpc') h.options.baseRpc = '';
  if (mode === 'http') h.options.relayer = 'http://relay.test';
  if (mode === 'path') h.options.relayer = 'https://relay.test/path';
  if (mode === 'oversized')
    h.fetcher.mockImplementation(async (url) =>
      Response.json(
        String(url).endsWith('/v1/capabilities')
          ? { ...h.cap, padding: 'x'.repeat(65536) }
          : h.decision,
      ),
    );
  await expect(checkBaseSponsorship(h.options)).rejects.toMatchObject({ code });
});

it.each([
  'network',
  'contract',
  'nearUsdc',
  'baseUsdc',
  'methods',
  'disabled',
  'baseSponsorship',
  'acceptingNewBasePayments',
] as const)('rejects a mismatched or closed capability %s', async (field) => {
  const h = fixture();
  const value = h.cap as Record<string, unknown>;
  value[field] =
    field === 'methods'
      ? []
      : field === 'disabled'
        ? true
        : field === 'baseSponsorship' || field === 'acceptingNewBasePayments'
          ? false
          : 'wrong';
  await expect(checkBaseSponsorship(h.options)).rejects.toMatchObject({
    code: 'relayer_unavailable',
  });
});
it.each([
  'network',
  'contract',
  'eligible',
  'tier',
  'policyVersion',
  'minPrice',
  'fee.fixed',
  'fee.bps',
  'fee.treasuryEvm',
  'decidedAt',
] as const)('rejects a malformed or refused durable decision %s', async (field) => {
  const h = fixture();
  let code = 'relayer_unavailable';
  if (field === 'network') h.decision.network = 'near:testnet';
  if (field === 'contract') h.decision.contract = 'other.near';
  if (field === 'eligible') {
    h.decision.eligible = false;
    code = 'not_sponsored';
  }
  if (field === 'tier') h.decision.tier = 'unknown';
  if (field === 'policyVersion') h.decision.policyVersion = '';
  if (field === 'minPrice') h.decision.minPrice = '-1';
  if (field === 'fee.fixed') h.decision.fee.fixed = '-1';
  if (field === 'fee.bps') h.decision.fee.bps = 10001;
  if (field === 'fee.treasuryEvm') delete (h.decision.fee as Record<string, unknown>).treasuryEvm;
  if (field === 'decidedAt') h.decision.decidedAt = 1001;
  await expect(checkBaseSponsorship(h.options)).rejects.toMatchObject({ code });
});
it.each(['empty', 'array', 'null', 'http-error'] as const)(
  'rejects a bad bounded HTTP capability response: %s',
  async (mode) => {
    const h = fixture();
    h.fetcher.mockResolvedValue(
      mode === 'empty'
        ? new Response(null)
        : mode === 'http-error'
          ? Response.json({ error: 'busy' }, { status: 429, headers: { 'Retry-After': '60' } })
          : Response.json(mode === 'array' ? [] : null),
    );
    await expect(checkBaseSponsorship(h.options)).rejects.toMatchObject({
      code: 'relayer_unavailable',
      ...(mode === 'http-error' ? { retryAfterSeconds: 60 } : {}),
    });
  },
);
it('does not reuse forged, edited or older split evidence and accepts exactly 30 seconds', async () => {
  const h = fixture();
  const checked = await checkBaseSponsorship(h.options);
  expect(validBaseSponsorship(checked, { ...h.options, now: () => 1030 })).toBe(true);
  expect(validBaseSponsorship({ ...checked }, h.options)).toBe(false);
  checked.fee.bps += 1;
  expect(validBaseSponsorship(checked, h.options)).toBe(false);
  checked.splitCheckedAt = 969;
  expect(validBaseSponsorship(checked, h.options)).toBe(false);
});

it('rejects a decision that ages while the split read is in flight', async () => {
  const h = fixture();
  let now = 1000;
  h.options.now = () => now;
  h.read.mockImplementation(async () => {
    now = 1031;
    return { kind: 'push', shares: [], distributorPercent: 0 };
  });
  await expect(checkBaseSponsorship(h.options)).rejects.toMatchObject({
    code: 'relayer_unavailable',
  });
});
it('rejects cached split evidence after the local clock moves behind its read time', async () => {
  const h = fixture();
  let now = 1000;
  h.options.now = () => now;
  h.read.mockImplementation(async () => {
    now = 1030;
    return { kind: 'push', shares: [], distributorPercent: 0 };
  });
  const checked = await checkBaseSponsorship(h.options);
  now = 1010;
  expect(validBaseSponsorship(checked, h.options)).toBe(false);
});

it.each([970, 999, 1001, 1030])('accepts bounded relayer clock skew at %s', async (checkedAt) => {
  const h = fixture();
  h.decision.checkedAt = checkedAt;
  const checked = await checkBaseSponsorship(h.options);
  expect(validBaseSponsorship(checked, h.options)).toBe(true);
});
it.each(['disabled', 'baseSponsorship', 'acceptingNewBasePayments'] as const)(
  'returns a positive retry hint for closed admission: %s',
  async (field) => {
    const h = fixture();
    h.cap[field] = field === 'disabled';
    await expect(checkBaseSponsorship(h.options)).rejects.toMatchObject({
      code: 'relayer_unavailable',
      retryAfterSeconds: 5,
    });
  },
);
it('never returns a zero admission retry hint', async () => {
  const h = fixture();
  h.fetcher.mockResolvedValue(new Response(null, { status: 503, headers: { 'Retry-After': '0' } }));
  await expect(checkBaseSponsorship(h.options)).rejects.toMatchObject({
    code: 'relayer_unavailable',
    retryAfterSeconds: 1,
  });
});
it('keeps only frozen eligibility fields including nested fee fields', async () => {
  const h = fixture();
  Object.assign(h.decision, { upstreamDiagnostic: 'private' });
  Object.assign(h.decision.fee, { upstreamDiagnostic: 'private' });
  const checked = await checkBaseSponsorship(h.options);
  expect(checked).not.toHaveProperty('upstreamDiagnostic');
  expect(checked.fee).not.toHaveProperty('upstreamDiagnostic');
  expect(checked.fee.treasuryEvm).not.toHaveProperty('upstreamDiagnostic');
});
it('rejects extra treasury identity fields even with a zero fee', async () => {
  const h = fixture();
  h.decision.fee.fixed = '0';
  h.decision.fee.bps = 0;
  Object.assign(h.decision.fee.treasuryEvm, { upstreamDiagnostic: 'private' });
  await expect(checkBaseSponsorship(h.options)).rejects.toMatchObject({
    code: 'relayer_unavailable',
  });
});
it('preserves split RPC network mismatch as a configuration failure', async () => {
  const h = fixture();
  h.read.mockRejectedValue(new PayError('network_mismatch'));
  await expect(checkBaseSponsorship(h.options)).rejects.toMatchObject({ code: 'network_mismatch' });
});

it('treats a Base RPC rate limit as temporary eligibility failure', async () => {
  const h = fixture();
  const { BaseRpcRateLimited } = await import('../pay/base.js');
  h.read.mockRejectedValue(new BaseRpcRateLimited());
  await expect(checkBaseSponsorship(h.options)).rejects.toMatchObject({
    code: 'relayer_unavailable',
  });
});
