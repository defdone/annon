import { describe, expect, it } from 'vitest';
import { purchase } from '../../test/fixtures.js';
import { keyFromSecret } from '../keys/near-ckd.js';
import { hex } from '../settle-near/codec.js';
import { baseNonceV2, buildPurchaseMessage, purchaseId } from '../settle-near/purchase.js';
import {
  type EncryptedRecord,
  encryptedPurchaseStore,
  exportPurchase,
  importPurchase,
  newBackupSecret,
} from './backup.js';
import type { PurchaseRecord } from './purchase.js';
import { memoryStore } from './store.js';

const secret = new Uint8Array(32);
secret[31] = 1;
const record: PurchaseRecord = {
  schemaVersion: 2,
  id: purchaseId(purchase),
  revision: 0,
  purchase,
  message: buildPurchaseMessage(purchase),
  buyerSecret: hex(secret),
  quote: { amountIn: '202064' },
  recovery: purchase.recovery,
  checkedHeaderHash: `0x${'55'.repeat(32)}`,
  terms: {
    network: 'eip155:8453',
    contractId: purchase.contract,
    fileId: purchase.file_id,
    buyer: purchase.refund.id,
    seller: purchase.recovery,
    to: purchase.refund.id,
    usdc: purchase.asset,
    price: purchase.price,
    buyerKey: hex(keyFromSecret(secret).publicKeyBytes),
    nonce: baseNonceV2(purchaseId(purchase)),
    headerHash: `0x${'55'.repeat(32)}`,
    cipherHash: `0x${'66'.repeat(32)}`,
    moderator: null,
  },
  attempts: [],
};
describe('user-held encrypted purchase backup', () => {
  it('round trips all recovery material; ciphertext contains no secrets and uses random salt/IV', async () => {
    const key = newBackupSecret();
    expect(key).toHaveLength(32);
    const a = await exportPurchase(record, key);
    const b = await exportPurchase(record, key);
    expect(a).not.toBe(b);
    expect(a).not.toContain(record.buyerSecret);
    expect(a).not.toContain(record.message);
    expect(await importPurchase(a, key)).toEqual(record);
  });
  it('refuses wrong secrets, edits, unsupported versions, wallet signatures and malformed records', async () => {
    const key = newBackupSecret();
    const file = await exportPurchase(record, key);
    await expect(importPurchase(file, newBackupSecret())).rejects.toThrow();
    const edited = JSON.parse(file);
    // Always change a bit; replacing a random byte with 00 leaves it unchanged 1/256 times.
    const firstByte = (Number.parseInt(edited.ciphertext.slice(2, 4), 16) ^ 1)
      .toString(16)
      .padStart(2, '0');
    edited.ciphertext = `0x${firstByte}${edited.ciphertext.slice(4)}`;
    await expect(importPurchase(JSON.stringify(edited), key)).rejects.toThrow();
    await expect(exportPurchase(record, new Uint8Array(65))).rejects.toThrow();
    await expect(
      exportPurchase({ ...record, buyerSecret: `0x${'00'.repeat(32)}` }, key),
    ).rejects.toThrow();
    await expect(
      importPurchase(JSON.stringify({ ...JSON.parse(file), v: 9 }), key),
    ).rejects.toThrow();
  });
  it('encrypts the durable store, preserving CAS under concurrent writers', async () => {
    const raw = memoryStore<EncryptedRecord>();
    const key = newBackupSecret();
    const store = encryptedPurchaseStore(raw, key);
    expect(await store.compareAndSet(record.id, null, record)).toBe(true);
    expect(JSON.stringify(await raw.load(record.id))).not.toContain(record.buyerSecret);
    expect(await store.load(record.id)).toEqual(record);
    const writes = await Promise.all([
      store.compareAndSet(record.id, record, { ...record, revision: 1 }),
      store.compareAndSet(record.id, record, { ...record, revision: 1, quote: { other: true } }),
    ]);
    expect(writes.filter(Boolean)).toHaveLength(1);
    await expect(encryptedPurchaseStore(raw, newBackupSecret()).load(record.id)).rejects.toThrow();
  });
});

it('rejects a non-boolean recovery proof checkpoint in a portable purchase', async () => {
  await expect(
    exportPurchase({ ...record, recoveryProved: 'true' } as never, newBackupSecret()),
  ).rejects.toThrow(/proof/);
});
