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
  ['settlement_processing', 503, { 'Retry-After': '5' }],
] as const)('reports %s only to the host callback', async (code, status, headers) => {
  vi.mocked(getFile).mockResolvedValue({ takenDown: null } as never);
  const error = new PayError(code, 'private diagnostic');
  vi.mocked(settle).mockRejectedValue(error);
  const onPaymentError = vi.fn();
  const options = { onPaymentError } as unknown as FileHostOptions;
  const req = { headers: new Headers({ 'PAYMENT-SIGNATURE': 'payload' }) };
  const expected = { status, headers: { 'Cache-Control': 'no-store', ...headers } };
  expect(await serveFile(req, options)).toEqual(expected);
  expect(onPaymentError).toHaveBeenCalledExactlyOnceWith(error);
  expect(await serveFile(req, {} as FileHostOptions)).toEqual(expected);
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
      expect(result).toEqual(baseline);
      expect(result.body).toBe(baseline.body);
      expect(onPaymentError).toHaveBeenCalledTimes(1);
    }
    // Allow rejected hooks to surface as unhandled rejections if the host did not guard them.
    await new Promise((resolve) => setTimeout(resolve, 0));
  },
);
