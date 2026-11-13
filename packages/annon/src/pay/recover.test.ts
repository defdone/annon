import { expect, it, vi } from 'vitest';
import { must, purchase } from '../../test/fixtures.js';
import { getPurchase } from '../near/rpc.js';
import { hex, usdc } from '../settle-near/codec.js';
import { baseNonceV2, buildPurchaseMessage, purchaseId } from '../settle-near/purchase.js';
import {
  type EncryptedRecord,
  encryptedPurchaseStore,
  exportPurchase,
  importPurchase,
  newBackupSecret,
} from './backup.js';
import { status } from './pay.js';
import { type PurchaseRecord, purchaseKey } from './purchase.js';
import { nextStep } from './recover.js';
import { memoryStore } from './store.js';

vi.mock('../near/rpc.js', () => ({ getPurchase: vi.fn(), blockHeader: vi.fn() }));
vi.mock('./pay.js', () => ({ status: vi.fn() }));
it.each(['expired', 'canceled'] as const)(
  'marks a %s purchase and retains its encrypted recovery record and backup',
  async (state) => {
    vi.mocked(getPurchase).mockResolvedValue(null);
    vi.mocked(status).mockResolvedValue({ state });
    const id = purchaseId(purchase);
    const hash = `0x${'55'.repeat(32)}`;
    const record: PurchaseRecord = {
      schemaVersion: 2,
      recoveryProved: false,
      payment: {
        route: purchase.route === 'base-usdc' ? 'base' : 'near',
        amountUsdc: usdc(BigInt(purchase.price)),
        amountBaseUnits: purchase.price,
        asset: { symbol: 'USDC', id: purchase.asset },
        network: purchase.network,
      },
      id,
      revision: 0,
      purchase,
      message: buildPurchaseMessage(purchase),
      buyerSecret: hex(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 1 : 0))),
      quote: null,
      recovery: purchase.recovery,
      checkedHeaderHash: hash,
      attempts: [],
      terms: {
        network: purchase.network,
        contractId: purchase.contract,
        fileId: purchase.file_id,
        buyer: purchase.refund.id,
        seller: purchase.recovery,
        to: purchase.refund.id,
        usdc: purchase.asset,
        price: purchase.price,
        buyerKey: purchase.buyer_key,
        nonce: baseNonceV2(id),
        headerHash: hash,
        cipherHash: hash,
        moderator: null,
      },
    };
    const secret = newBackupSecret();
    const store = encryptedPurchaseStore(memoryStore<EncryptedRecord>(), secret);
    await store.compareAndSet(purchaseKey(id), null, record);
    expect(
      await nextStep(record, {
        nearRpc: 'https://near.example',
        baseRpc: 'https://base.example',
        store,
      }),
    ).toEqual({ step: 'buy' });
    const saved = await store.load(purchaseKey(id));
    expect(saved).toMatchObject({
      id,
      revision: 1,
      paymentState: state,
      buyerSecret: record.buyerSecret,
    });
    expect(await importPurchase(await exportPurchase(must(saved), secret), secret)).toEqual(saved);
  },
);
