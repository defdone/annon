import { afterEach, expect, it, vi } from 'vitest';
import { getFile } from '../near/rpc.js';
import { PayError } from '../pay/base.js';
import { settle } from '../pay/settle.js';
import { type FileHostOptions, serveFile } from './host.js';

vi.mock('../near/rpc.js', () => ({ getFile: vi.fn(), getGrant: vi.fn(), getPurchase: vi.fn() }));
vi.mock('../pay/settle.js', () => ({ settle: vi.fn(), paymentResponse: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it.each([
  ['transport', 502, {}],
  ['payment_id_conflict', 409, {}],
  ['bad_requirements', 400, {}],
  ['settlement_processing', 503, { 'Retry-After': '10' }],
] as const)('reports %s only to the host callback', async (code, status, headers) => {
  vi.mocked(getFile).mockResolvedValue({ takenDown: null } as never);
  const error = new PayError(code, 'private diagnostic');
  vi.mocked(settle).mockRejectedValue(error);
  const onPaymentError = vi.fn();
  const options = { onPaymentError } as unknown as FileHostOptions;
  const req = { headers: new Headers({ 'PAYMENT-SIGNATURE': 'payload' }) };
  const expected = {
    status,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json', ...headers },
  };
  const result = await serveFile(req, options);
  expect(result).toMatchObject(expected);
  expect(await new Response(result.body).json()).toMatchObject({
    error: code === 'settlement_processing' ? 'settlement_pending' : code,
  });
  expect(onPaymentError).toHaveBeenCalledExactlyOnceWith(error);
  expect(await serveFile(req, {} as FileHostOptions)).toMatchObject(expected);
});

it.each(['throwing', 'rejecting'] as const)(
  '%s diagnostics cannot change the payment response',
  async (mode) => {
    vi.mocked(getFile).mockResolvedValue({ takenDown: null } as never);
    const req = { headers: new Headers({ 'PAYMENT-SIGNATURE': 'payload' }) };
    for (const code of [
      'transport',
      'payment_id_conflict',
      'bad_requirements',
      'settlement_processing',
    ] as const) {
      vi.mocked(settle).mockRejectedValue(new PayError(code));
      const baseline = await serveFile(req, {} as FileHostOptions);
      const onPaymentError = vi.fn(() => {
        if (mode === 'throwing') throw new Error('diagnostic failed');
        return Promise.reject(new Error('diagnostic failed'));
      });
      const result = await serveFile(req, { onPaymentError } as unknown as FileHostOptions);
      expect({ ...result, body: undefined }).toEqual({ ...baseline, body: undefined });
      expect(await new Response(result.body).json()).toEqual(
        await new Response(baseline.body).json(),
      );
      expect(onPaymentError).toHaveBeenCalledTimes(1);
    }
    // Allow rejected hooks to surface as unhandled rejections if the host did not guard them.
    await new Promise((resolve) => setTimeout(resolve, 0));
  },
);

it('invalid proofs and malformed ranges never reserve a download', async () => {
  const { getPurchase, getGrant } = await import('../near/rpc.js');
  const { purchaseProof } = await import('./proof.js');
  const { keyFromSecret } = await import('../keys/near-ckd.js');
  const key = keyFromSecret(new Uint8Array(32).fill(7));
  const id = `0x${'11'.repeat(32)}`;
  const fileId = `0x${'22'.repeat(32)}`;
  const url = 'https://example.com/file';
  vi.mocked(getFile).mockResolvedValue({
    takenDown: null,
    terms: { network: 'near:mainnet', near: { price: '1', token: 'usdc' }, base: null },
    price: 1n,
    payTo: 'payee',
    salesStoppedAt: null,
  } as never);
  vi.mocked(getPurchase).mockResolvedValue({ file_id: fileId, grants: 2 } as never);
  vi.mocked(getGrant).mockResolvedValue({
    buyer_key: `0x${Buffer.from(key.publicKeyBytes).toString('hex')}`,
  } as never);
  const reserve = vi.fn(async () => ({
    ok: false,
    status: 429,
    code: 'download_limited',
    retryAfterSeconds: 17,
  }));
  const o = {
    url,
    fileId,
    contractId: 'contract.near',
    header: 'https://example.com/header',
    file: { size: 1000, headerLength: 100, read: vi.fn() },
    downloads: { reserve },
    headerHash: 'version',
  } as unknown as FileHostOptions;
  const proof = purchaseProof(new Uint8Array(32).fill(7), url, id, 1);
  for (const bad of [
    'invalid',
    purchaseProof(new Uint8Array(32).fill(8), url, id, 1),
    purchaseProof(new Uint8Array(32).fill(7), 'https://example.com/other', id, 1),
    purchaseProof(new Uint8Array(32).fill(7), url, id, 2),
  ]) {
    expect(
      (await serveFile({ headers: new Headers({ 'Annon-Buyer-Proof': bad }) }, o)).status,
    ).toBe(402);
  }
  vi.mocked(getPurchase).mockResolvedValueOnce({ file_id: 'wrong', grants: 2 } as never);
  expect(
    (await serveFile({ headers: new Headers({ 'Annon-Buyer-Proof': proof }) }, o)).status,
  ).toBe(402);
  expect(reserve).not.toHaveBeenCalled();
  for (const range of ['bytes=100-200', 'bytes=0-,200-', 'bytes=1000-']) {
    const r = await serveFile(
      { headers: new Headers({ 'Annon-Buyer-Proof': proof, Range: range }) },
      o,
    );
    expect(r.status).toBe(416);
  }
  expect(reserve).not.toHaveBeenCalled();
  const r = await serveFile(
    { headers: new Headers({ 'Annon-Buyer-Proof': proof, Range: 'bytes=100-' }) },
    o,
  );
  expect(reserve).toHaveBeenCalledOnce();
  expect(r).toMatchObject({
    status: 429,
    headers: {
      'Retry-After': '17',
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
  expect(await new Response(r.body).json()).toMatchObject({
    error: 'download_limited',
    retryAfterSeconds: 17,
    purchaseId: id,
    fileId,
  });
});

it('returns a precise UTC gas budget retry hint in the HTTP response', async () => {
  vi.mocked(getFile).mockResolvedValue({ takenDown: null } as never);
  const e = new PayError('unavailable');
  e.retryAfterSeconds = 43201;
  vi.mocked(settle).mockRejectedValue(e);
  const res = await serveFile(
    { headers: new Headers({ 'PAYMENT-SIGNATURE': 'payload' }) },
    {} as FileHostOptions,
  );
  expect(res.status).toBe(503);
  expect(res.headers['Retry-After']).toBe('43201');
  expect(await new Response(res.body).json()).toMatchObject({ retryAfterSeconds: 43201 });
});
