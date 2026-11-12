import { expect, it, vi } from 'vitest';
import { requireEligibility } from './eligibility.ts';

const file = { termsHash: `0x${'11'.repeat(32)}`, terms: { network: 'near:mainnet' } } as never;
it('fails closed before settlement and accepts only a bound fresh eligible decision', async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          network: 'near:mainnet',
          contract: 'contract.near',
          fileId: `0x${'22'.repeat(32)}`,
          termsHash: `0x${'11'.repeat(32)}`,
          eligible: true,
          tier: 'pool',
          policyVersion: 'v1',
          minPrice: '100000',
          fee: { fixed: '30000', bps: 100 },
          decidedAt: 1,
          checkedAt: 1000,
        }),
      ),
  );
  const options = {
    origin: 'https://relay.example',
    contract: 'contract.near',
    fileId: `0x${'22'.repeat(32)}`,
    now: () => 1000,
    fetcher: fetcher as typeof fetch,
  };
  await expect(requireEligibility(file, options)).resolves.toBeUndefined();
  expect(fetcher.mock.calls[0]?.[0]).toBe('https://relay.example/v1/base-eligibility');
  const valid = {
    network: 'near:mainnet',
    contract: 'contract.near',
    fileId: `0x${'22'.repeat(32)}`,
    termsHash: `0x${'11'.repeat(32)}`,
    eligible: true,
    tier: 'pool',
    policyVersion: 'v1',
    minPrice: '100000',
    fee: { fixed: '30000', bps: 100 },
    decidedAt: 1,
    checkedAt: 1000,
  };
  for (const over of [
    { network: 'other' },
    { contract: 'other' },
    { fileId: 'other' },
    { termsHash: 'other' },
    { checkedAt: 969 },
    { checkedAt: 1006 },
    { checkedAt: -1 },
    { checkedAt: 1.5 },
    { tier: 'other' },
    { policyVersion: '' },
    { minPrice: 'bad' },
    { fee: { fixed: 'bad', bps: 100 } },
    { fee: { fixed: '1', bps: 10001 } },
    { fee: { fixed: '1', bps: -1 } },
    { fee: { fixed: '1', bps: 0.5 } },
    { decidedAt: -1 },
    { decidedAt: 0.5 },
  ]) {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ...valid, ...over })));
    await expect(requireEligibility(file, options)).rejects.toMatchObject({
      code: 'relayer_unavailable',
    });
  }
  fetcher.mockResolvedValueOnce(new Response(' '.repeat(65537) + JSON.stringify(valid)));
  await expect(requireEligibility(file, options)).rejects.toMatchObject({
    code: 'relayer_unavailable',
  });
  for (const value of [
    {
      network: 'near:mainnet',
      contract: 'contract.near',
      fileId: `0x${'22'.repeat(32)}`,
      termsHash: `0x${'11'.repeat(32)}`,
      eligible: false,
    },
    { eligible: true },
    { eligible: true, checkedAt: 1 },
  ]) {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(value)));
    await expect(requireEligibility(file, options)).rejects.toMatchObject({
      code: value.eligible === false ? 'not_sponsored' : 'relayer_unavailable',
    });
  }
  fetcher.mockResolvedValueOnce(
    new Response('{}', { status: 503, headers: { 'Retry-After': '17' } }),
  );
  await expect(requireEligibility(file, options)).rejects.toMatchObject({
    code: 'relayer_unavailable',
    retryAfterSeconds: 17,
  });
});
