/** Synthetic 1Click browser purchase with stub SDK and fake IndexedDB, shared by browser tests. */
import { IDBFactory } from 'fake-indexeddb';
import { vi } from 'vitest';
import {
  BrowserPurchaseController,
  browserPurchaseStorage,
  type PurchaseSdk,
} from '../src/browser/purchases.js';
import { keyFromSecret } from '../src/keys/near-ckd.js';
import type { PurchaseRecord } from '../src/pay/purchase.js';
import { hex, usdc } from '../src/settle-near/codec.js';
import { buildPurchaseMessage, purchaseId } from '../src/settle-near/purchase.js';
import { NEAR_USDC } from '../src/settle-near/terms.js';
import type { IdentityWallet } from '../src/wallet/wallet.js';
import { purchase as fixture, must } from './fixtures.js';

export const now = 1800000000;
const secret = new Uint8Array(32);
secret[31] = 1;
export function record(): PurchaseRecord {
  const purchase = {
    ...fixture,
    route: 'near-usdc' as const,
    network: 'near:mainnet',
    asset: NEAR_USDC,
    expires_at: String(now + 3600),
  };
  const id = purchaseId(purchase);
  return {
    schemaVersion: 2,
    recoveryProved: false,
    payment: {
      route: '1click',
      amountUsdc: usdc(BigInt(purchase.price)),
      amountBaseUnits: purchase.price,
      asset: { symbol: 'USDC', id: purchase.asset },
      network: purchase.network,
    },
    id,
    revision: 0,
    purchase,
    message: buildPurchaseMessage(purchase),
    buyerSecret: hex(secret),
    recovery: purchase.recovery,
    checkedHeaderHash: `0x${'55'.repeat(32)}`,
    quote: {
      request: {} as import('../src/oneclick/oneclick.js').QuoteRequest,
      response: {},
      deposit: {
        address: 'synthetic-deposit',
        memo: 'synthetic-memo',
        amount: '250000',
        asset: 'nep141:synthetic',
        chain: 'evm',
        qrData: '{}',
        depositBefore: new Date((now + 3000) * 1000).toISOString(),
        purchaseExpiresAt: new Date((now + 3600) * 1000).toISOString(),
      },
    },
    terms: {
      network: purchase.network,
      contractId: purchase.contract,
      fileId: purchase.file_id,
      buyer: purchase.refund.id,
      seller: purchase.recovery,
      to: purchase.refund.id,
      usdc: purchase.asset,
      price: purchase.price,
      buyerKey: hex(keyFromSecret(secret).publicKeyBytes),
      nonce: purchase.nonce,
      headerHash: `0x${'55'.repeat(32)}`,
      cipherHash: `0x${'66'.repeat(32)}`,
      moderator: null,
    },
    attempts: [],
  };
}
export const wallet = { identity: fixture.recovery, authorize: vi.fn() } as IdentityWallet;
export function setup(clock: () => number = () => now) {
  const factory = new IDBFactory();
  const options = { factory, name: 'browser-purchases' };
  const storage = () => browserPurchaseStorage(options);
  const r = record();
  const sdk: PurchaseSdk = {
    buy: vi.fn(async (o) => {
      await o.onSaved?.(r);
      const proved = { ...r, revision: 1, recoveryProved: true };
      await o.onSaved?.(proved);
      await o.beforePayment?.(proved);
      return {
        route: r.payment.route,
        record: proved,
        instructions: must(r.quote).deposit,
      };
    }),
    accept: vi.fn(async () => false),
    proveRecovery: vi.fn(async (r) => ({ ...r, revision: r.revision + 1, recoveryProved: true })),
    recover: vi.fn(async () => []),
    open: vi.fn(async () => ({
      meta: { name: 'f', mime: '', size: 1, previewLen: 0 },
      data: new Uint8Array([1]),
    })),
  };
  const make = async (id: string) =>
    new BrowserPurchaseController({ storage: await storage(), sdk, id, now: clock });
  const create = async () =>
    BrowserPurchaseController.create(
      { storage: await storage(), sdk, now: clock },
      {
        id: 'synthetic-checkout',
        fileId: fixture.file_id,
        header: new Uint8Array([1, 2, 3]),
        resourceUrl: 'https://files.example/synthetic',
        route: '1click',
        maxPrice: 200000n,
      },
    );
  return { storage, sdk, make, create, r };
}
