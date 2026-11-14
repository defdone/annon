import { afterEach, describe, expect, it, vi } from 'vitest';
import { now, setup, wallet } from '../../test/browser-purchase.js';
import { purchase as fixture } from '../../test/fixtures.js';
import type { OneClick, SwapStatus } from '../oneclick/oneclick.js';
import { BrowserPurchaseController, PurchaseLeaseBusy } from './purchases.js';

type Status = SwapStatus['status'];
type Harness = ReturnType<typeof setup>;
const terminal = (status: Status) => ({
  poll: vi.fn<OneClick['poll']>(async (address, o) => {
    await o?.onProgress?.({
      address,
      memo: 'synthetic-memo',
      attempts: 1,
      errors: 0,
      lastStatus: { status },
    });
    return { status };
  }),
});
const reads = (...answers: (Status | Error)[]) =>
  vi.fn<OneClick['status']>(async () => {
    const next = answers.shift();
    if (!next || next instanceof Error) throw next ?? new Error('no stub answer');
    return { status: next };
  });

/** A purchase that 1Click reported FAILED, reached through the public start and poll path. */
async function failedPurchase() {
  const h = setup();
  const c = await h.create();
  await c.start({ recovery: wallet, refund: fixture.refund });
  await c.poll({ oneClick: terminal('FAILED'), maxPolls: 1 });
  const before = await c.storage.load('synthetic-checkout');
  expect(before?.state).toBe('failed');
  const create = vi.spyOn(BrowserPurchaseController, 'create');
  const start = vi.spyOn(BrowserPurchaseController.prototype, 'start');
  /** Same purchase ID, deposit and recovery identity; never a second purchase, start or payment. */
  const unchangedIdentity = async () => {
    const after = await c.storage.load('synthetic-checkout');
    expect(after?.purchase?.id).toBe(before?.purchase?.id);
    expect(after?.purchase?.buyerSecret).toBe(before?.purchase?.buyerSecret);
    expect(after?.purchase?.recovery).toEqual(before?.purchase?.recovery);
    expect(after?.purchase?.quote).toEqual(before?.purchase?.quote);
    expect(await c.storage.list()).toHaveLength(1);
    expect(create).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(h.sdk.buy).toHaveBeenCalledTimes(1);
    expect(h.sdk.recover).not.toHaveBeenCalled();
    expect(h.sdk.proveRecovery).not.toHaveBeenCalled();
    return after;
  };
  return { h, c, before, unchangedIdentity };
}

describe('reconciling a failed browser purchase', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it('moves to accepted when NEAR already accepted it, without reading 1Click', async () => {
    const { h, c, before, unchangedIdentity } = await failedPurchase();
    h.sdk.accept = vi.fn(async () => true);
    const status = reads();
    expect(await c.reconcile({ oneClick: { status } })).toEqual({ state: 'accepted' });
    expect(h.sdk.accept).toHaveBeenCalledWith(
      expect.objectContaining({ id: before?.purchase?.id }),
    );
    expect(status).not.toHaveBeenCalled();
    const after = await unchangedIdentity();
    expect(after?.state).toBe('accepted');
    expect(after?.lease).toBeUndefined();
    expect((await c.open(new Uint8Array([7]))).data).toEqual(new Uint8Array([1]));
    expect((await c.snapshot()).state).toBe('file_ready');
    const recovered = {
      kind: 'recovery' as const,
      id: `recovery:${h.r.id}`,
      revision: 0,
      purchase_id: h.r.id,
      file_id: fixture.file_id,
      recovery: fixture.recovery,
      buyerSecret: h.r.buyerSecret,
      fresh_key: h.r.purchase.buyer_key,
      nonce: h.r.purchase.nonce,
      deadline: now + 500,
      grant: 1,
    };
    h.sdk.recover = vi.fn(async () => [recovered]);
    await c.recover(wallet);
    expect(h.sdk.recover).toHaveBeenCalledWith({ wallet, purchaseId: before?.purchase?.id });
    expect((await c.snapshot()).state).toBe('accepted');
  });

  it.each([
    ['REFUNDED', 'refunded'],
    ['SUCCESS', 'accepting'],
    ['FAILED', 'failed'],
    ['PROCESSING', 'failed'],
    ['PENDING_DEPOSIT', 'failed'],
  ] as const)('reads %s once for the saved deposit and persists %s', async (answer, expected) => {
    const { h, c, before, unchangedIdentity } = await failedPurchase();
    const status = reads(answer);
    expect(await c.reconcile({ oneClick: { status } })).toEqual({
      state: expected,
      swapStatus: answer,
    });
    expect(status).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith('synthetic-deposit', { memo: 'synthetic-memo' });
    expect(h.sdk.accept).toHaveBeenCalledTimes(1);
    const after = await unchangedIdentity();
    expect(after?.state).toBe(expected);
    expect(after?.checkpoint).toEqual({
      address: 'synthetic-deposit',
      memo: 'synthetic-memo',
      attempts: (before?.checkpoint?.attempts ?? 0) + 1,
      errors: 0,
      lastStatus: { status: answer },
    });
    expect((await c.snapshot()).swapStatus).toBe(answer);
  });

  it.each([
    ['the 1Click read', () => reads(new Error('1Click HTTP 503'))],
    [
      'the NEAR read',
      (h: Harness) => {
        h.sdk.accept = vi.fn(async () => {
          throw new Error('NEAR RPC unavailable');
        });
        return reads('REFUNDED');
      },
    ],
  ])('keeps the failed state and checkpoint when %s fails', async (_name, prepare) => {
    const { h, c, before, unchangedIdentity } = await failedPurchase();
    const status = prepare(h);
    await expect(c.reconcile({ oneClick: { status } })).rejects.toThrow(/503|unavailable/);
    const after = await unchangedIdentity();
    expect(after?.state).toBe('failed');
    expect(after?.checkpoint).toEqual(before?.checkpoint);
    expect(after?.lease).toBeUndefined();
    h.sdk.accept = vi.fn(async () => false);
    expect(await c.reconcile({ oneClick: { status: reads('FAILED') } })).toMatchObject({
      state: 'failed',
    });
  });

  it('refuses while another tab holds the lease and reads nothing', async () => {
    const { h, c, unchangedIdentity } = await failedPurchase();
    let release = () => {};
    const status = vi.fn<OneClick['status']>(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: 'REFUNDED' });
        }),
    );
    const first = c.reconcile({ oneClick: { status } });
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(1));
    const other = await h.make('synthetic-checkout');
    const second = reads('FAILED');
    await expect(other.reconcile({ oneClick: { status: second } })).rejects.toBeInstanceOf(
      PurchaseLeaseBusy,
    );
    expect(second).not.toHaveBeenCalled();
    expect(h.sdk.accept).toHaveBeenCalledTimes(1);
    release();
    expect(await first).toEqual({ state: 'refunded', swapStatus: 'REFUNDED' });
    await unchangedIdentity();
  });

  it('only checks failed purchases and never touches other states', async () => {
    const h = setup();
    const c = await h.create();
    const status = reads('REFUNDED');
    await expect(c.reconcile({ oneClick: { status } })).rejects.toThrow(/failed saved purchase/);
    await c.start({ recovery: wallet, refund: fixture.refund });
    await expect(c.reconcile({ oneClick: { status } })).rejects.toThrow(/failed saved purchase/);
    expect((await c.snapshot()).state).toBe('awaiting_deposit');
    expect(status).not.toHaveBeenCalled();
    expect(h.sdk.accept).not.toHaveBeenCalled();
    expect(h.sdk.buy).toHaveBeenCalledTimes(1);
  });
});
