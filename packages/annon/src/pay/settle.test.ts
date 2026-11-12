import { afterEach, expect, it, vi } from 'vitest';
import { getConfig, getFile } from '../near/rpc.js';
import { authorizationState, balanceOf, hasCode, head, paymentStatus } from './base.js';
import { checkTerms, verifyPayment } from './seller.js';
import { settle } from './settle.js';
import { memoryStore } from './store.js';

vi.mock('../near/rpc.js', () => ({ getConfig: vi.fn(), getFile: vi.fn() }));
vi.mock('./base.js', async (load) => ({
  ...(await load<typeof import('./base.js')>()),
  head: vi.fn(),
  block: vi.fn(async () => ({ number: 0, timestamp: 0 })),
  paymentStatus: vi.fn(),
  balanceOf: vi.fn(),
  authorizationState: vi.fn(),
  hasCode: vi.fn(),
}));
vi.mock('./seller.js', () => ({
  checkTerms: vi.fn(),
  verifyPayment: vi.fn(),
  readPayload: vi.fn(),
  forFacilitator: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

it.each(['balance', 'nonce', 'verify'])(
  'does not bind an id or write a purchase before %s passes',
  async (failure) => {
    vi.mocked(getFile).mockResolvedValue({
      takenDown: null,
      price: 1n,
      payTo: 'payee',
      termsHash: 'terms',
    } as never);
    vi.mocked(getConfig).mockResolvedValue({ usdc: 'usdc' } as never);
    vi.mocked(checkTerms).mockReturnValue({
      payer: 'payer',
      nonce: 'nonce',
      validBefore: BigInt(Math.floor(Date.now() / 1000) + 120),
      paymentId: 'payment',
    } as never);
    vi.mocked(head).mockResolvedValue({ number: 1, timestamp: Math.floor(Date.now() / 1000) });
    vi.mocked(hasCode).mockResolvedValue(false);
    vi.mocked(balanceOf).mockResolvedValue(failure === 'balance' ? 0n : 1n);
    vi.mocked(authorizationState).mockResolvedValue(failure === 'nonce');
    vi.mocked(paymentStatus).mockResolvedValue({ state: 'pending' });
    if (failure === 'verify')
      vi.mocked(verifyPayment).mockRejectedValue(new Error('bad signature'));
    const store = memoryStore();
    const write = vi.spyOn(store, 'compareAndSet');
    const facilitator = vi.fn();
    await expect(
      settle(btoa('{}'), {
        nearRpc: '',
        baseRpc: '',
        contractId: 'contract',
        fileId: 'file',
        url: 'https://example.com',
        header: 'https://example.com/header',
        store,
        facilitator,
      } as never),
    ).rejects.toThrow();
    expect(write).not.toHaveBeenCalled();
    expect(facilitator).not.toHaveBeenCalled();
  },
);
it('runs host eligibility before recording or facilitating a new payment', async () => {
  vi.mocked(getFile).mockResolvedValue({
    takenDown: null,
    price: 1n,
    payTo: 'payee',
    termsHash: 'terms',
  } as never);
  vi.mocked(getConfig).mockResolvedValue({ usdc: 'usdc' } as never);
  vi.mocked(checkTerms).mockReturnValue({
    payer: 'payer',
    nonce: 'nonce',
    validBefore: 1000n,
    paymentId: 'payment',
  } as never);
  vi.mocked(head).mockResolvedValue({ number: 1, timestamp: 0 });
  vi.mocked(paymentStatus).mockResolvedValue({ state: 'pending' });
  vi.mocked(balanceOf).mockResolvedValue(1n);
  vi.mocked(authorizationState).mockResolvedValue(false);
  const store = memoryStore();
  const write = vi.spyOn(store, 'compareAndSet');
  const facilitator = vi.fn();
  await expect(
    settle(btoa('{}'), {
      nearRpc: '',
      baseRpc: '',
      contractId: 'contract',
      fileId: 'file',
      url: 'https://example.com',
      header: 'https://example.com/header',
      store,
      facilitator,
      beforeSettle: async () => {
        throw new Error('not eligible');
      },
    } as never),
  ).rejects.toThrow('not eligible');
  expect(write).not.toHaveBeenCalled();
  expect(facilitator).not.toHaveBeenCalled();
});
it('marks a definite facilitator refusal as never submitted for later cleanup', async () => {
  const { readPayload } = await import('./seller.js');
  vi.mocked(getFile).mockResolvedValue({
    takenDown: null,
    price: 1n,
    payTo: 'payee',
    termsHash: 'terms',
  } as never);
  vi.mocked(getConfig).mockResolvedValue({ usdc: 'usdc' } as never);
  vi.mocked(checkTerms).mockReturnValue({
    payer: 'payer',
    nonce: 'nonce',
    validBefore: 1000n,
  } as never);
  vi.mocked(head).mockResolvedValue({ number: 1, timestamp: 0 });
  vi.mocked(paymentStatus).mockResolvedValue({ state: 'pending' });
  vi.mocked(balanceOf).mockResolvedValue(1n);
  vi.mocked(authorizationState).mockResolvedValue(false);
  vi.mocked(readPayload).mockReturnValue({ accepted: {} } as never);
  const store = memoryStore();
  await expect(
    settle(btoa('{}'), {
      nearRpc: '',
      baseRpc: '',
      contractId: 'contract',
      fileId: 'file',
      url: 'https://example.com',
      header: 'https://example.com/header',
      store,
      facilitator: async () => ({
        success: false,
        errorReason: 'invalid_authorization',
        submissionAttempted: false,
      }),
    } as never),
  ).rejects.toMatchObject({ code: 'payment_rejected' });
  expect(await store.load('annon/seller/purchase/eip155:8453/usdc/payer/nonce')).toMatchObject({
    submissionAttempted: false,
  });
});

it.each([
  [43201, 43201],
  [0, 0],
  [-1, undefined],
  [1.5, undefined],
  [Infinity, undefined],
  ['private', undefined],
])('preserves only valid facilitator UTC budget retry hints (%s)', async (hint, expected) => {
  const { readPayload } = await import('./seller.js');
  vi.mocked(getFile).mockResolvedValue({
    takenDown: null,
    price: 1n,
    payTo: 'payee',
    termsHash: 'terms',
  } as never);
  vi.mocked(getConfig).mockResolvedValue({ usdc: 'usdc' } as never);
  vi.mocked(checkTerms).mockReturnValue({
    payer: 'payer',
    nonce: 'nonce',
    validBefore: 1000n,
  } as never);
  vi.mocked(head).mockResolvedValue({ number: 1, timestamp: 0 });
  vi.mocked(paymentStatus).mockResolvedValue({ state: 'pending' });
  vi.mocked(balanceOf).mockResolvedValue(1n);
  vi.mocked(authorizationState).mockResolvedValue(false);
  vi.mocked(readPayload).mockReturnValue({ accepted: {} } as never);
  const store = memoryStore();
  await expect(
    settle(btoa('{}'), {
      nearRpc: '',
      baseRpc: '',
      contractId: 'contract',
      fileId: 'file',
      url: 'https://example.com',
      header: 'https://example.com/header',
      store,
      facilitator: async () => ({
        success: false,
        errorReason: 'unavailable',
        retryAfterSeconds: hint,
        submissionAttempted: false,
      }),
    } as never),
  ).rejects.toMatchObject({ code: 'unavailable', retryAfterSeconds: expected });
  expect(await store.load('annon/seller/purchase/eip155:8453/usdc/payer/nonce')).toMatchObject({
    submissionAttempted: false,
  });
});
