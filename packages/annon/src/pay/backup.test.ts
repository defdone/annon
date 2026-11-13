import { describe, expect, it } from 'vitest';
import { purchase } from '../../test/fixtures.js';
import { keyFromSecret } from '../keys/near-ckd.js';
import { hex } from '../settle-near/codec.js';
import { baseNonceV2, buildPurchaseMessage, purchaseId } from '../settle-near/purchase.js';
import {
  type EncryptedRecord,
  encryptedPurchaseStore,
  exportPurchase,
  exportSellerKey,
  importPurchase,
  importSellerKey,
  newBackupSecret,
  type SellerKeyRecord,
} from './backup.js';
import type { PurchaseRecord } from './purchase.js';
import { memoryStore } from './store.js';

const secret = new Uint8Array(32);
secret[31] = 1;
const record: PurchaseRecord = {
  schemaVersion: 2,
  recoveryProved: false,
  payment: {
    route: 'base',
    amountUsdc: '0.2',
    amountBaseUnits: purchase.price,
    asset: { symbol: 'USDC', id: purchase.asset },
    network: purchase.network,
  },
  id: purchaseId(purchase),
  revision: 0,
  purchase,
  message: buildPurchaseMessage(purchase),
  buyerSecret: hex(secret),
  quote: null,
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
      store.compareAndSet(record.id, record, { ...record, revision: 1, recoveryProved: true }),
    ]);
    expect(writes.filter(Boolean)).toHaveLength(1);
    await expect(encryptedPurchaseStore(raw, newBackupSecret()).load(record.id)).rejects.toThrow();
  });
});

it('rejects a non-boolean recovery proof checkpoint in a portable purchase', async () => {
  await expect(
    exportPurchase({ ...record, recoveryProved: 'true' } as never, newBackupSecret()),
  ).rejects.toMatchObject({ code: 'invalid_record' });
});

it.each(['payment', 'quote', 'recoveryProved'] as const)(
  'rejects a never-released purchase missing %s',
  async (field) => {
    const old = { ...record };
    delete (old as Partial<PurchaseRecord>)[field];
    await expect(exportPurchase(old, newBackupSecret())).rejects.toMatchObject({
      code: 'invalid_record',
    });
  },
);
it('rejects a summary that disagrees with the protocol purchase', async () => {
  await expect(
    exportPurchase({ ...record, payment: { ...record.payment, route: 'near' } }, newBackupSecret()),
  ).rejects.toMatchObject({ code: 'invalid_record' });
});

it.each(['amount', 'decimal', 'network', 'asset', 'symbol', 'route', 'quote'] as const)(
  'rejects inconsistent payment facts: %s',
  async (field) => {
    const edited = structuredClone(record);
    if (field === 'amount') edited.payment.amountBaseUnits = '1';
    if (field === 'decimal') edited.payment.amountUsdc = '0.1';
    if (field === 'network') edited.payment.network = 'near:mainnet';
    if (field === 'asset') edited.payment.asset.id = 'other-token';
    if (field === 'symbol') edited.payment.asset.symbol = 'OTHER' as never;
    if (field === 'route') edited.payment.route = 'base-usdc' as never;
    if (field === 'quote') edited.quote = {} as never;
    await expect(exportPurchase(edited, newBackupSecret())).rejects.toMatchObject({
      code: 'invalid_record',
    });
  },
);

it('requires the quote checkpoint to survive JSON serialization', async () => {
  const edited = { ...record };
  delete (edited as Partial<PurchaseRecord>).quote;
  Object.setPrototypeOf(edited, { quote: null });
  await expect(exportPurchase(edited, newBackupSecret())).rejects.toMatchObject({
    code: 'invalid_record',
  });
});

const sellerKey: SellerKeyRecord = {
  kind: 'seller-key',
  id: `seller-key:${purchase.file_id}`,
  file_id: purchase.file_id,
  revision: 0,
  seller: purchase.recovery,
  buyerSecret: hex(secret),
  deadline: 10,
};
it('imports only authenticated validated seller-key backups', async () => {
  const key = newBackupSecret();
  const backup = await exportSellerKey(sellerKey, key);
  expect(await importSellerKey(backup, key)).toEqual(sellerKey);
  await expect(importSellerKey(backup, newBackupSecret())).rejects.toThrow();
  const edited = JSON.parse(backup);
  edited.ciphertext = `0x${(parseInt(edited.ciphertext.slice(2, 4), 16) ^ 1).toString(16).padStart(2, '0')}${edited.ciphertext.slice(4)}`;
  await expect(importSellerKey(JSON.stringify(edited), key)).rejects.toThrow();
  await expect(importSellerKey(await exportPurchase(record, key), key)).rejects.toMatchObject({
    code: 'invalid_record',
  });
});
it.each([
  'id',
  'revision',
  'fractional-revision',
  'deadline',
  'fractional-deadline',
  'file_id',
  'seller',
  'buyerSecret',
  'zero-secret',
  'extra',
] as const)('rejects an authenticated malformed seller key: %s', async (field) => {
  const key = newBackupSecret();
  const original = JSON.parse(await exportSellerKey(sellerKey, key));
  const value: Record<string, unknown> = { ...sellerKey };
  if (field === 'extra') value.extra = true;
  else if (field === 'fractional-revision') value.revision = 0.5;
  else if (field === 'fractional-deadline') value.deadline = 0.5;
  else if (field === 'zero-secret') value.buyerSecret = `0x${'00'.repeat(32)}`;
  else value[field] = field === 'revision' || field === 'deadline' ? -1 : 'invalid';
  if (field === 'file_id') value.id = `seller-key:${value.file_id}`;
  const tag = new TextEncoder().encode('annon/purchase-backup/v1');
  const material = await crypto.subtle.importKey('raw', key, 'HKDF', false, ['deriveKey']);
  const aes = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: Uint8Array.from(Buffer.from(original.salt.slice(2), 'hex')),
      info: tag,
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: Uint8Array.from(Buffer.from(original.iv.slice(2), 'hex')),
      additionalData: tag,
    },
    aes,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  original.ciphertext = hex(new Uint8Array(ciphertext));
  await expect(importSellerKey(JSON.stringify(original), key)).rejects.toMatchObject({
    code: 'invalid_record',
  });
});

it('imports a completed seller key with its cleared secret', async () => {
  const key = newBackupSecret();
  const completed = { ...sellerKey, buyerSecret: null };
  expect(await importSellerKey(await exportSellerKey(completed, key), key)).toEqual(completed);
});
