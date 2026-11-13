import {
  type BrowserPurchaseIndex,
  type BrowserPurchaseRecord,
  type BrowserReceipt,
  type BrowserRecoveryArchiveIndex,
  purchaseStates,
  type StoredBrowserPurchase,
} from '../browser/record.js';
/** Portable purchase backups and encrypted CAS storage. The 32-byte secret is user-held randomness. */
import { concat, copy } from '../envelope/pay2.js';
import { AnnonError } from '../errors.js';
import { keyFromSecret } from '../keys/near-ckd.js';
import { bytes, exactKeys, hex, uint, usdc, utf8 } from '../settle-near/codec.js';
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
  storageBudget?: string;
  storageFunding?: 'pending' | 'funded' | 'refused';
  kind: 'sell';
  terms: import('../settle-near/terms.js').Terms;
  /** Immutable Base split provenance. Recipients and bps come from terms.near;
   * totalAllocation is 10000 and distributionIncentive is 0. Fixed before registration. */
  baseSplit: { address: string; kind: 'push' | 'pull'; salt: string } | null;
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
type PrivateRecord =
  | PurchaseRecord
  | RecoveryRecord
  | SellRecord
  | SellerKeyRecord
  | BrowserReceipt
  | BrowserRecoveryArchiveIndex
  | BrowserPurchaseIndex
  | StoredBrowserPurchase;
function validateRecord(r: PrivateRecord) {
  if ('kind' in r && r.kind === 'browser-recovery-archives') {
    bytes(r.purchaseId, 32);
    if (
      r.id !== `recovery-archives:${r.purchaseId}` ||
      !Number.isSafeInteger(r.revision) ||
      r.revision < 0 ||
      !Array.isArray(r.names) ||
      new Set(r.names).size !== r.names.length ||
      r.names.some(
        (name) =>
          typeof name !== 'string' ||
          !name.startsWith(`recovery:${r.purchaseId}:revision:`) ||
          !/^[0-9]+$/.test(name.slice(name.lastIndexOf(':') + 1)),
      )
    )
      throw new TypeError('invalid recovery archive index');
    return;
  }
  if ('kind' in r && r.kind === 'browser-purchase') {
    validateBrowserPurchase(r);
    return;
  }
  if ('kind' in r && r.kind === 'browser-purchase-index') {
    if (
      r.id !== 'browser-index' ||
      !Number.isSafeInteger(r.revision) ||
      r.revision < 0 ||
      !Array.isArray(r.entries) ||
      new Set(r.entries.map((e) => e.id)).size !== r.entries.length
    )
      throw new TypeError('invalid browser purchase index');
    for (const entry of r.entries) {
      if (
        !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.id) ||
        !Number.isSafeInteger(entry.revision) ||
        entry.revision < 0 ||
        !purchaseStates.includes(entry.state) ||
        !['near', 'base', '1click'].includes(entry.route) ||
        !Number.isSafeInteger(entry.createdAt) ||
        !Number.isSafeInteger(entry.updatedAt) ||
        entry.createdAt < 0 ||
        entry.updatedAt < entry.createdAt
      )
        throw new TypeError('invalid browser index entry');
      bytes(entry.fileId, 32);
      if (entry.purchaseId !== undefined) bytes(entry.purchaseId, 32);
      const url = new URL(entry.resourceUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
        throw new TypeError('invalid resource URL');
      if (
        Object.keys(entry).some(
          (key) =>
            ![
              'id',
              'revision',
              'fileId',
              'route',
              'state',
              'resourceUrl',
              'purchaseId',
              'createdAt',
              'updatedAt',
            ].includes(key),
        )
      )
        throw new TypeError('index must contain metadata only');
    }
    if (utf8.encode(JSON.stringify(r)).length > MAX_BYTES)
      throw new TypeError('browser index too large');
    return;
  }
  if ('kind' in r && r.kind === 'browser-receipt') {
    exactKeys(r, ['kind', 'entry']);
    validateBrowserPurchase(r.entry);
    return;
  }
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
      !Object.hasOwn(r, 'baseSplit') ||
      !(
        r.baseSplit === null ||
        (r.baseSplit &&
          /^0x[0-9a-f]{40}$/.test(r.baseSplit.address) &&
          ['push', 'pull'].includes(r.baseSplit.kind) &&
          /^0x[0-9a-f]{64}$/.test(r.baseSplit.salt))
      )
    )
      throw new TypeError('invalid Base split provenance');
    if (
      r.id !== `sell:${r.terms.file_id}` ||
      !Number.isSafeInteger(r.revision) ||
      r.revision < 0 ||
      !Number.isSafeInteger(r.deadline) ||
      r.deadline < 0
    )
      throw new TypeError('invalid sell record');
    if (
      r.storageBudget !== undefined &&
      (!/^[1-9][0-9]*$/.test(r.storageBudget) || BigInt(r.storageBudget) >= 2n ** 128n)
    )
      throw new TypeError('invalid sell storage budget');
    if (
      r.storageFunding !== undefined &&
      (!r.storageBudget || !['pending', 'funded', 'refused'].includes(r.storageFunding))
    )
      throw new TypeError('invalid sell funding state');
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

function validateBrowserPurchase(entry: BrowserPurchaseRecord) {
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(entry.id) ||
    !Number.isSafeInteger(entry.revision) ||
    entry.revision < 0 ||
    !purchaseStates.includes(entry.state) ||
    !['near', 'base', '1click'].includes(entry.route) ||
    typeof entry.header !== 'string' ||
    !/^0x(?:[0-9a-f]{2}){1,65536}$/.test(entry.header) ||
    (entry.needsProof !== undefined && typeof entry.needsProof !== 'boolean') ||
    !['not_submitted', 'uncertain', 'submitted'].includes(entry.submission)
  )
    throw new TypeError('invalid browser purchase');
  if (entry.paymentStarted !== undefined && typeof entry.paymentStarted !== 'boolean')
    throw new TypeError('invalid payment boundary');
  if (
    entry.lease &&
    (!/^[a-zA-Z0-9_-]{1,128}$/.test(entry.lease.owner) ||
      !Number.isSafeInteger(entry.lease.expiresAt) ||
      entry.lease.expiresAt < 0)
  )
    throw new TypeError('invalid purchase lease');
  if (entry.recoveryArchives !== undefined) {
    if (
      !Array.isArray(entry.recoveryArchives) ||
      new Set(entry.recoveryArchives.map((r) => r.revision)).size !== entry.recoveryArchives.length
    )
      throw new TypeError('invalid recovery archives');
    for (const archive of entry.recoveryArchives) {
      if (archive.kind !== 'recovery') throw new TypeError('invalid recovery archive');
      validate(archive);
      if (
        !entry.purchase ||
        archive.purchase_id !== entry.purchase.id ||
        archive.file_id !== entry.fileId
      )
        throw new TypeError('recovery archive mismatch');
    }
  }
  bytes(entry.fileId, 32);
  if (uint(entry.maxPrice, 128) === 0n) throw new TypeError('invalid browser price');
  const url = new URL(entry.resourceUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new TypeError('invalid resource URL');
  if (entry.purchase) {
    validatePurchaseRecord(entry.purchase);
    if (
      entry.purchase.purchase.file_id !== entry.fileId ||
      entry.purchase.purchase.route !== (entry.route === 'base' ? 'base-usdc' : 'near-usdc') ||
      entry.purchase.payment.route !== entry.route
    )
      throw new TypeError('browser purchase mismatch');
  }
  if (entry.recovery) {
    validate(entry.recovery);
    if (
      !entry.purchase ||
      entry.recovery.purchase_id !== entry.purchase.id ||
      entry.recovery.file_id !== entry.fileId
    )
      throw new TypeError('browser recovery mismatch');
  }
  if (
    entry.checkpoint &&
    (!entry.purchase ||
      !Number.isSafeInteger(entry.checkpoint.attempts) ||
      entry.checkpoint.attempts < 0 ||
      !Number.isSafeInteger(entry.checkpoint.errors) ||
      entry.checkpoint.errors < 0)
  )
    throw new TypeError('invalid browser checkpoint');
}
function validate(r: PrivateRecord): void {
  try {
    validateRecord(r);
  } catch (cause) {
    throw new AnnonError('invalid_record', 'Invalid encrypted record.', { cause });
  }
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
  try {
    checkPurchaseRecord(r);
  } catch (cause) {
    throw new AnnonError('invalid_record', 'Invalid purchase record.', { cause });
  }
}
function checkPurchaseRecord(r: PurchaseRecord): void {
  if (typeof r.recoveryProved !== 'boolean')
    throw new TypeError('invalid recovery proof checkpoint');
  if (
    r?.schemaVersion !== 2 ||
    !Object.hasOwn(r, 'quote') ||
    !(
      r.quote === null ||
      (r.quote &&
        typeof r.quote === 'object' &&
        r.quote.request &&
        r.quote.response &&
        r.quote.deposit)
    ) ||
    !r.payment ||
    !['near', 'base', '1click'].includes(r.payment.route) ||
    (r.payment.route === 'base') !== (r.purchase.route === 'base-usdc') ||
    r.payment.amountBaseUnits !== r.purchase.price ||
    r.payment.amountUsdc !== usdc(BigInt(r.purchase.price)) ||
    r.payment.network !== r.purchase.network ||
    r.payment.asset?.symbol !== 'USDC' ||
    r.payment.asset.id !== r.purchase.asset ||
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
function encryptedStore<T extends PrivateRecord & Versioned>(
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
      if (!('id' in r) || r.id !== encrypted.id || r.revision !== encrypted.revision)
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
export const encryptedSellerKeyStore = (
  raw: Store<EncryptedRecord>,
  secret: Uint8Array,
): Store<SellerKeyRecord> => encryptedStore<SellerKeyRecord>(raw, secret);

/** Browser workflow records use the same authenticated encryption and CAS binding as purchases. */
export const exportBrowserReceipt = (record: BrowserReceipt, secret: Uint8Array) =>
  encrypt(record, secret);
export async function importBrowserReceipt(
  file: string,
  secret: Uint8Array,
): Promise<BrowserReceipt> {
  const record = await decrypt(file, secret);
  if (!('kind' in record) || record.kind !== 'browser-receipt')
    throw new AnnonError('invalid_record');
  return record;
}

export const encryptedBrowserIndexStore = (
  raw: Store<EncryptedRecord>,
  secret: Uint8Array,
): Store<BrowserPurchaseIndex> => encryptedStore<BrowserPurchaseIndex>(raw, secret);
export const encryptedBrowserPurchaseStore = (
  raw: Store<EncryptedRecord>,
  secret: Uint8Array,
): Store<StoredBrowserPurchase> => encryptedStore<StoredBrowserPurchase>(raw, secret);
/** Prepare ciphertext outside an IndexedDB transaction; bind it to the same CAS context. */
export async function sealBrowserRecord(
  name: string,
  record: BrowserPurchaseIndex | StoredBrowserPurchase | BrowserRecoveryArchiveIndex,
  secret: Uint8Array,
): Promise<EncryptedRecord> {
  return {
    id: record.id,
    revision: record.revision,
    backup: await encrypt(record, secret, JSON.stringify([name, record.id, record.revision])),
  };
}

export const encryptedRecoveryArchiveIndexStore = (
  raw: Store<EncryptedRecord>,
  secret: Uint8Array,
): Store<BrowserRecoveryArchiveIndex> => encryptedStore<BrowserRecoveryArchiveIndex>(raw, secret);
