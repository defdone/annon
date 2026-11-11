/** Portable purchase backups and encrypted CAS storage. The 32-byte secret is user-held randomness. */
import { concat, copy } from '../envelope/pay2.js';
import { keyFromSecret } from '../keys/near-ckd.js';
import { bytes, exactKeys, hex, utf8 } from '../settle-near/codec.js';
import { identityJson } from '../settle-near/identity.js';
import { baseNonceV2, buildPurchaseMessage, purchaseId } from '../settle-near/purchase.js';
import type { PurchaseRecord } from './purchase.js';
import { checkNext, type Store, type Versioned } from './store.js';

const subtle = globalThis.crypto.subtle;
const MAX_BYTES = 2 * 1024 * 1024;
const TAG = 'annon/purchase-backup/v1';
export interface RecoveryRecord extends Versioned {
  kind: 'recovery';
  purchase_id: string;
  file_id: string;
  recovery: import('../settle-near/identity.js').Identity;
  buyerSecret: string;
  fresh_key: string;
  nonce: string;
  deadline: number;
  grant: number | null;
}
export interface SellRecord extends Versioned {
  kind: 'sell';
  terms: import('../settle-near/terms.js').Terms;
  published?: boolean;
  fileKey: string | null;
  sellerSecret: string | null;
  deadline: number;
  name: string;
  mime: string;
  previewLen: number;
  ckdSecret: string | null;
}
export interface SellerKeyRecord extends Versioned {
  kind: 'seller-key';
  file_id: string;
  seller: import('../settle-near/identity.js').Identity;
  buyerSecret: string | null;
  deadline: number;
}
type PrivateRecord = PurchaseRecord | RecoveryRecord | SellRecord | SellerKeyRecord;
function validate(r: PrivateRecord) {
  if ('kind' in r && r.kind === 'seller-key') {
    if (
      r.id !== `seller-key:${r.file_id}` ||
      !Number.isSafeInteger(r.revision) ||
      r.revision < 0 ||
      !Number.isSafeInteger(r.deadline) ||
      r.deadline < 0
    )
      throw new TypeError('invalid seller key record');
    bytes(r.file_id, 32);
    if (r.buyerSecret !== null) bytes(r.buyerSecret, 32);
    identityJson(r.seller);
    return;
  }
  if ('kind' in r && r.kind === 'sell') {
    if (
      r.id !== `sell:${r.terms.file_id}` ||
      !Number.isSafeInteger(r.revision) ||
      r.revision < 0 ||
      !Number.isSafeInteger(r.deadline) ||
      r.deadline < 0
    )
      throw new TypeError('invalid sell record');
    if (r.published === true) {
      if (r.fileKey !== null || r.sellerSecret !== null || r.ckdSecret !== null)
        throw new TypeError('published sell retains secrets');
    } else {
      bytes(r.fileKey as string, 32);
      bytes(r.sellerSecret as string, 32);
    }
    if (r.ckdSecret !== null) bytes(r.ckdSecret, 48);
    return;
  }
  if ('kind' in r && r.kind === 'recovery') {
    bytes(r.purchase_id, 32);
    bytes(r.file_id, 32);
    bytes(r.nonce, 32);
    if (
      r.id !== `recovery:${r.purchase_id}` ||
      hex(keyFromSecret(bytes(r.buyerSecret, 32)).publicKeyBytes) !== r.fresh_key ||
      !Number.isSafeInteger(r.deadline) ||
      r.deadline < 0 ||
      !Number.isSafeInteger(r.revision) ||
      r.revision < 0 ||
      !(r.grant === null || (Number.isInteger(r.grant) && r.grant >= 0 && r.grant <= 0xffffffff))
    )
      throw new TypeError('invalid recovery record');
    identityJson(r.recovery);
  } else validatePurchaseRecord(r as PurchaseRecord);
}
interface Backup {
  format: 'annon-purchase-backup';
  v: 1;
  kdf: 'HKDF-SHA256';
  salt: string;
  iv: string;
  ciphertext: string;
}
export interface EncryptedRecord extends Versioned {
  backup: string;
}
export const newBackupSecret = () => crypto.getRandomValues(new Uint8Array(32));
function secretKey(secret: Uint8Array) {
  if (!(secret instanceof Uint8Array) || secret.length !== 32)
    throw new TypeError('backup secret must be 32 random bytes held by the user');
  return subtle.importKey('raw', copy(secret), 'HKDF', false, ['deriveKey']);
}
async function derive(secret: Uint8Array, salt: Uint8Array) {
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: copy(salt), info: utf8.encode(TAG) },
    await secretKey(secret),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
export function validatePurchaseRecord(r: PurchaseRecord): void {
  if (
    r?.schemaVersion !== 2 ||
    !Number.isSafeInteger(r.revision) ||
    r.revision < 0 ||
    r.id !==
      purchaseId(
        r.purchase,
        r.purchase.route === 'base-usdc'
          ? { baseUsdc: r.purchase.asset }
          : { nearUsdc: r.purchase.asset },
      ) ||
    r.message !==
      buildPurchaseMessage(
        r.purchase,
        r.purchase.route === 'base-usdc'
          ? { baseUsdc: r.purchase.asset }
          : { nearUsdc: r.purchase.asset },
      ) ||
    hex(keyFromSecret(bytes(r.buyerSecret, 32)).publicKeyBytes) !== r.purchase.buyer_key ||
    identityJson(r.recovery) !== identityJson(r.purchase.recovery) ||
    (r.paymentState !== undefined && !['expired', 'canceled'].includes(r.paymentState)) ||
    !Array.isArray(r.attempts) ||
    !r.terms ||
    r.terms.network !== r.purchase.network ||
    r.terms.usdc !== r.purchase.asset ||
    r.terms.price !== r.purchase.price ||
    r.terms.nonce !== (r.purchase.route === 'base-usdc' ? baseNonceV2(r.id) : r.purchase.nonce) ||
    r.terms.contractId !== r.purchase.contract ||
    r.terms.fileId !== r.purchase.file_id ||
    r.terms.buyerKey !== r.purchase.buyer_key ||
    r.terms.headerHash !== r.checkedHeaderHash
  )
    throw new TypeError('invalid purchase record');
  bytes(r.checkedHeaderHash, 32);
  if (utf8.encode(JSON.stringify(r)).length > MAX_BYTES)
    throw new TypeError('purchase record too large');
}
async function encrypt(r: PrivateRecord, secret: Uint8Array, context = ''): Promise<string> {
  validate(r);
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: concat(utf8.encode(TAG), utf8.encode(context)),
      tagLength: 128,
    },
    await derive(secret, salt),
    utf8.encode(JSON.stringify(r)),
  );
  const out: Backup = {
    format: 'annon-purchase-backup',
    v: 1,
    kdf: 'HKDF-SHA256',
    salt: hex(salt),
    iv: hex(iv),
    ciphertext: hex(new Uint8Array(ciphertext)),
  };
  return JSON.stringify(out);
}
async function decrypt(file: string, secret: Uint8Array, context = ''): Promise<PrivateRecord> {
  if (typeof file !== 'string' || file.length > MAX_BYTES * 2 + 1024)
    throw new TypeError('backup too large');
  const b: unknown = JSON.parse(file);
  exactKeys(b, ['format', 'v', 'kdf', 'salt', 'iv', 'ciphertext']);
  if (
    b.format !== 'annon-purchase-backup' ||
    b.v !== 1 ||
    b.kdf !== 'HKDF-SHA256' ||
    typeof b.ciphertext !== 'string' ||
    !/^0x(?:[0-9a-f]{2}){16,}$/.test(b.ciphertext)
  )
    throw new TypeError('unsupported backup format');
  const raw = bytes(b.ciphertext, (b.ciphertext.length - 2) / 2);
  const plain = await subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: bytes(b.iv as string, 12),
      additionalData: concat(utf8.encode(TAG), utf8.encode(context)),
      tagLength: 128,
    },
    await derive(secret, bytes(b.salt as string, 32)),
    raw,
  );
  const r = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)) as PurchaseRecord;
  validate(r);
  return r;
}
export const exportPurchase = (record: PurchaseRecord, secret: Uint8Array) =>
  encrypt(record, secret);
export const importPurchase = async (file: string, secret: Uint8Array): Promise<PurchaseRecord> => {
  const r = await decrypt(file, secret);
  if ('kind' in r) throw new TypeError('not a purchase');
  return r;
};
export const exportRecovery = (record: RecoveryRecord, secret: Uint8Array) =>
  encrypt(record, secret);
export const importRecovery = async (file: string, secret: Uint8Array): Promise<RecoveryRecord> => {
  const r = await decrypt(file, secret);
  if (!('kind' in r) || r.kind !== 'recovery') throw new TypeError('not a recovery');
  return r;
};
/** Wrap memory, IndexedDB, fileStore or an existing durable store; keep only ciphertext at rest. */
function encryptedStore<T extends PrivateRecord>(
  raw: Store<EncryptedRecord>,
  secret: Uint8Array,
): Store<T> {
  if (secret.length !== 32) throw new TypeError('backup secret must be 32 bytes');
  const key = copy(secret);
  const context = (name: string, v: Versioned) => JSON.stringify([name, v.id, v.revision]);
  return {
    async load(name) {
      const encrypted = await raw.load(name);
      if (!encrypted) return null;
      const r = await decrypt(encrypted.backup, key, context(name, encrypted));
      if (r.id !== encrypted.id || r.revision !== encrypted.revision)
        throw new Error('encrypted record metadata mismatch');
      return r as T;
    },
    async compareAndSet(name, expected, next) {
      checkNext(expected, next);
      const value = next
        ? {
            id: next.id,
            revision: next.revision,
            backup: await encrypt(next, key, context(name, next)),
          }
        : null;
      return raw.compareAndSet(name, expected, value);
    },
  };
}

export const encryptedPurchaseStore = (
  raw: Store<EncryptedRecord>,
  secret: Uint8Array,
): Store<PurchaseRecord> => encryptedStore<PurchaseRecord>(raw, secret);
export const encryptedRecoveryStore = (
  raw: Store<EncryptedRecord>,
  secret: Uint8Array,
): Store<RecoveryRecord> => encryptedStore<RecoveryRecord>(raw, secret);

export const exportSell = (record: SellRecord, secret: Uint8Array) => encrypt(record, secret);
export const importSell = async (file: string, secret: Uint8Array): Promise<SellRecord> => {
  const r = await decrypt(file, secret);
  if (!('kind' in r) || r.kind !== 'sell') throw new TypeError('not a sell record');
  return r;
};
export const encryptedSellStore = (
  raw: Store<EncryptedRecord>,
  secret: Uint8Array,
): Store<SellRecord> => encryptedStore<SellRecord>(raw, secret);

export const exportSellerKey = (record: SellerKeyRecord, secret: Uint8Array) =>
  encrypt(record, secret);
export const importSellerKey = async (
  file: string,
  secret: Uint8Array,
): Promise<SellerKeyRecord> => {
  const r = await decrypt(file, secret);
  if (!('kind' in r) || r.kind !== 'seller-key') throw new TypeError('not a seller-key record');
  return r;
};
export const encryptedSellerKeyStore = (
  raw: Store<EncryptedRecord>,
  secret: Uint8Array,
): Store<SellerKeyRecord> => encryptedStore<SellerKeyRecord>(raw, secret);
