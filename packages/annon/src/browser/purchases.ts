/** Durable SDK orchestration. Storage belongs to the embedding origin; no UI or wallet connector. */
import { Annon, type AnnonOptions, type BuyOptions, type BuyRoute } from '../api/annon.js';
import { DownloadError } from '../download/download.js';
import { sha256 } from '../envelope/pay2.js';
import { AnnonError } from '../errors.js';
import {
  type Deposit,
  OneClick,
  type OneClickQuote,
  type PollOptions,
} from '../oneclick/oneclick.js';
import {
  type EncryptedRecord,
  encryptedBrowserIndexStore,
  encryptedBrowserPurchaseStore,
  encryptedPurchaseStore,
  encryptedRecoveryArchiveIndexStore,
  encryptedRecoveryStore,
  exportBrowserReceipt,
  exportPurchase,
  exportRecovery,
  importBrowserReceipt,
  importPurchase,
  importRecovery,
  newBackupSecret,
  type RecoveryRecord,
  sealBrowserRecord,
} from '../pay/backup.js';
import { type PurchaseRecord, purchaseKey } from '../pay/purchase.js';
import {
  checkNext,
  indexedDbStore,
  type Store,
  type StoreWrite,
  type Versioned,
} from '../pay/store.js';
import { bytes, hex } from '../settle-near/codec.js';
import type { IdentityWallet } from '../wallet/wallet.js';
import {
  BROWSER_DOWNLOAD_LIMIT,
  type BrowserDownloadOptions,
  browserDownload,
  downloadProgress,
} from './download.js';
import type {
  BrowserPurchaseIndex,
  BrowserPurchaseRecord,
  BrowserPurchaseState,
} from './record.js';

export type { BrowserPurchaseRecord, BrowserPurchaseState } from './record.js';
export type PurchaseSdk = Pick<Annon, 'buy' | 'accept' | 'open' | 'recover' | 'proveRecovery'>;
const INDEX = 'annon/browser/index';
const conflict = () =>
  new AnnonError('store_conflict', 'browser purchase store conflict; reload the saved purchase');
export interface BrowserPurchaseStorage {
  rawStore: Store<EncryptedRecord>;
  backupSecret: Uint8Array;
  writeBackup(name: string, encryptedFile: string): Promise<void>;
  load(id: string): Promise<BrowserPurchaseRecord | null>;
  save(expected: BrowserPurchaseRecord | null, next: BrowserPurchaseRecord): Promise<void>;
  restorePurchase(record: PurchaseRecord): Promise<PurchaseRecord>;
  list(): Promise<Pick<BrowserPurchaseRecord, 'id' | 'fileId' | 'route' | 'state'>[]>;
  exportReceipt(id: string, secret: Uint8Array): Promise<string>;
  importReceipt(file: string, secret: Uint8Array): Promise<string>;
  recoveryArchives(purchaseId: string): Promise<RecoveryRecord[]>;
}
const entryKey = (id: string) => `annon/browser/entry/${id}`;
const backupKey = (name: string) => `annon/browser/backup/${name}`;
const MAX_CAS_ATTEMPTS = 32;
/** Local secret is random, persisted once with CAS. Clearing site storage removes local recovery. */
export async function browserPurchaseStorage(
  options: { name?: string; factory?: IDBFactory } = {},
): Promise<BrowserPurchaseStorage> {
  const local = indexedDbStore<Versioned & { secret: string }>(options);
  const secretName = 'annon/browser/secret';
  let saved = await local.load(secretName);
  if (!saved) {
    const next = { id: 'browser-secret', revision: 0, secret: hex(newBackupSecret()) };
    if (await local.compareAndSet(secretName, null, next)) saved = next;
    else saved = await local.load(secretName);
  }
  if (saved?.id !== 'browser-secret') throw new Error('local backup secret missing');
  const backupSecret = bytes(saved.secret, 32);
  const rawStore = indexedDbStore<EncryptedRecord>(options);
  const indexStore = encryptedBrowserIndexStore(rawStore, backupSecret);
  const entries = encryptedBrowserPurchaseStore(rawStore, backupSecret);
  const read = () => indexStore.load(INDEX);
  const empty = (): BrowserPurchaseIndex => ({
    kind: 'browser-purchase-index',
    id: 'browser-index',
    revision: 0,
    entries: [],
  });
  async function update(
    fn: (index: BrowserPurchaseIndex) => Promise<StoreWrite<EncryptedRecord>[]>,
  ): Promise<void> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const before = await read();
      const next = before ? structuredClone({ ...before, revision: before.revision + 1 }) : empty();
      // Re-run the per-entry comparison on every fresh index. Only index contention is retried.
      const writes = await fn(next);
      const sealed = await sealBrowserRecord(INDEX, next, backupSecret);
      if (
        await rawStore.compareAndSetMany([
          { key: INDEX, expected: before, next: sealed },
          ...writes,
        ])
      )
        return;
    }
    throw conflict();
  }
  const load = async (id: string): Promise<BrowserPurchaseRecord | null> => {
    const stored = await entries.load(entryKey(id));
    if (!stored) return null;
    const { kind: _kind, ...record } = stored;
    return record;
  };
  const save = async (
    expected: BrowserPurchaseRecord | null,
    next: BrowserPurchaseRecord,
    uniquePurchase = false,
  ): Promise<void> => {
    checkNext(expected, next);
    await update(async (index) => {
      if (
        uniquePurchase &&
        next.purchase &&
        index.entries.some((e) => e.purchaseId === next.purchase?.id)
      )
        throw conflict();
      const current = index.entries.find((e) => e.id === next.id);
      if (expected ? !current || current.revision !== expected.revision : current) throw conflict();
      const now = Date.now();
      const metadata = {
        id: next.id,
        revision: next.revision,
        fileId: next.fileId,
        route: next.route,
        state: next.state,
        resourceUrl: next.resourceUrl,
        createdAt: current?.createdAt ?? now,
        updatedAt: Math.max(current?.updatedAt ?? now, now),
        ...(next.purchase ? { purchaseId: next.purchase.id } : {}),
      };
      if (current) index.entries[index.entries.indexOf(current)] = metadata;
      else index.entries.push(metadata);
      return [
        {
          key: entryKey(next.id),
          expected,
          next: await sealBrowserRecord(
            entryKey(next.id),
            { ...next, kind: 'browser-purchase' },
            backupSecret,
          ),
        },
      ];
    });
  };
  const archiveIndex = encryptedRecoveryArchiveIndexStore(rawStore, backupSecret);
  const archiveIndexKey = (purchaseId: string) => `annon/browser/archives/${purchaseId}`;
  const recoveryArchives = async (purchaseId: string): Promise<RecoveryRecord[]> => {
    const index = await archiveIndex.load(archiveIndexKey(purchaseId));
    return Promise.all(
      (index?.names ?? []).map(async (name) => {
        const archived = await rawStore.load(backupKey(name));
        if (!archived) throw new Error('recovery archive missing');
        const record = await importRecovery(archived.backup, backupSecret);
        if (
          record.purchase_id !== purchaseId ||
          name !== `${record.id}:revision:${record.revision}`
        )
          throw new Error('recovery archive mismatch');
        return record;
      }),
    );
  };
  const writeBackup = async (name: string, encryptedFile: string): Promise<void> => {
    const key = backupKey(name);
    const canonical = name.replace(/:revision:[0-9]+$/, '');
    const recovery = canonical.startsWith('recovery:')
      ? await importRecovery(encryptedFile, backupSecret)
      : undefined;
    const sourceRevision =
      recovery?.revision ??
      (/^0x[0-9a-f]{64}$/.test(canonical)
        ? (await importPurchase(encryptedFile, backupSecret)).revision
        : undefined);
    const archived = name !== canonical;
    if (archived && (!recovery || name !== `${recovery.id}:revision:${recovery.revision}`))
      throw new TypeError('invalid recovery archive name');
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const before = (await rawStore.load(key)) as
        | (EncryptedRecord & { sourceRevision?: number })
        | null;
      if (
        sourceRevision !== undefined &&
        before?.sourceRevision !== undefined &&
        before.sourceRevision >= sourceRevision
      )
        return;
      const next = {
        ...(sourceRevision === undefined ? {} : { sourceRevision }),
        id: name,
        revision: before ? before.revision + 1 : 0,
        backup: encryptedFile,
      };
      if (archived && recovery) {
        const indexKey = archiveIndexKey(recovery.purchase_id);
        const current = await archiveIndex.load(indexKey);
        const names = current?.names ?? [];
        const index = {
          kind: 'browser-recovery-archives' as const,
          id: `recovery-archives:${recovery.purchase_id}`,
          revision: current ? current.revision + 1 : 0,
          purchaseId: recovery.purchase_id,
          names: names.includes(name) ? names : [...names, name],
        };
        if (
          await rawStore.compareAndSetMany([
            { key, expected: before, next },
            {
              key: indexKey,
              expected: current,
              next: await sealBrowserRecord(indexKey, index, backupSecret),
            },
          ])
        )
          return;
      } else if (await rawStore.compareAndSet(key, before, next)) return;
    }
    throw conflict();
  };
  return {
    rawStore,
    backupSecret,
    load,
    save,
    writeBackup,
    recoveryArchives,
    async restorePurchase(record) {
      const purchases = encryptedPurchaseStore(rawStore, backupSecret);
      const name = purchaseKey(record.id);
      const current = await purchases.load(name);
      if (
        current &&
        (current.message !== record.message || current.buyerSecret !== record.buyerSecret)
      )
        throw conflict();
      if (current && current.revision >= record.revision) return current;
      const restored = { ...record, revision: current ? current.revision + 1 : 0 };
      if (!(await purchases.compareAndSet(name, current, restored))) throw conflict();
      await writeBackup(restored.id, await exportPurchase(restored, backupSecret));
      return restored;
    },
    async list() {
      return ((await read())?.entries ?? []).map(({ id, fileId, route, state }) => ({
        id,
        fileId,
        route,
        state,
      }));
    },
    async exportReceipt(id, secret) {
      const entry = await load(id);
      if (!entry) throw new Error('purchase missing');
      const portable = structuredClone(entry);
      if (entry.purchase) portable.recoveryArchives = await recoveryArchives(entry.purchase.id);
      if (entry.purchase) {
        const current = await encryptedPurchaseStore(rawStore, backupSecret).load(
          purchaseKey(entry.purchase.id),
        );
        if (current && current.revision >= entry.purchase.revision) portable.purchase = current;
        const backed = await rawStore.load(backupKey(entry.purchase.id));
        if (backed) {
          const purchase = await importPurchase(backed.backup, backupSecret);
          if (purchase.revision > (portable.purchase?.revision ?? -1)) portable.purchase = purchase;
        }
        const recovery = await encryptedRecoveryStore(rawStore, backupSecret).load(
          `annon/recovery/${entry.purchase.id}`,
        );
        const pending = await rawStore.load(backupKey(`recovery:${entry.purchase.id}`));
        if (recovery) portable.recovery = recovery;
        else if (pending) portable.recovery = await importRecovery(pending.backup, backupSecret);
      }
      return exportBrowserReceipt({ kind: 'browser-receipt', entry: portable }, secret);
    },
    async importReceipt(file, secret) {
      const { entry } = await importBrowserReceipt(file, secret);
      if (await load(entry.id)) throw conflict();
      if (entry.purchase) {
        const index = await read();
        if (index?.entries.some((e) => e.purchaseId === entry.purchase?.id)) throw conflict();
        const purchases = encryptedPurchaseStore(rawStore, backupSecret);
        const next = { ...entry.purchase, revision: 0 };
        const current = await purchases.load(purchaseKey(next.id));
        if (
          current &&
          (current.message !== next.message || current.buyerSecret !== next.buyerSecret)
        )
          throw conflict();
        if (!current && !(await purchases.compareAndSet(purchaseKey(next.id), null, next)))
          throw conflict();
        entry.purchase = current ?? next;
      }
      if (entry.recovery) {
        const recoveries = encryptedRecoveryStore(rawStore, backupSecret);
        const name = `annon/recovery/${entry.recovery.purchase_id}`;
        const current = await recoveries.load(name);
        if (current && current.buyerSecret !== entry.recovery.buyerSecret) throw conflict();
        const next = { ...entry.recovery, revision: 0 };
        if (!current && !(await recoveries.compareAndSet(name, null, next))) throw conflict();
        entry.recovery = current ?? next;
      }
      for (const archive of entry.recoveryArchives ?? [])
        await writeBackup(
          `${archive.id}:revision:${archive.revision}`,
          await exportRecovery(archive, backupSecret),
        );
      await save(
        null,
        {
          ...entry,
          revision: 0,
          needsProof: true,
          lease: undefined,
          state: [
            'terms_review',
            'refunded',
            'failed',
            'expired',
            'recovering',
            'accepted',
            'file_ready',
            'abandoned',
          ].includes(entry.state)
            ? entry.state
            : 'payment_uncertain',
        },
        true,
      );
      return entry.id;
    },
  };
}
export interface PurchaseProgress {
  id: string;
  state: BrowserPurchaseState;
  revision: number;
  /** A safe status code; raw upstream details stay in the encrypted record. */
  swapStatus?: string;
  /** Unix seconds when another tab or a crashed owner releases this checkout. */
  leaseWaitUntil?: number;
}
export type BrowserOpenOptions = Pick<
  BrowserDownloadOptions,
  'fetch' | 'signal' | 'size' | 'onProgress' | 'retries' | 'settleTries' | 'wait'
>;
export interface ControllerOptions {
  storage: BrowserPurchaseStorage;
  sdk: PurchaseSdk;
  id: string;
  now?: () => number;
}
export interface PurchaseTermsReview {
  /** Caller-chosen stable checkout id deduplicates double clicks and tabs. */
  id: string;
  fileId: string;
  header: Uint8Array;
  resourceUrl: string;
  route: BuyRoute;
  maxPrice: bigint;
}
/** Build the real SDK using the same encrypted storage and durable internal backups. */
export function browserAnnon(
  storage: BrowserPurchaseStorage,
  options: Omit<AnnonOptions, 'rawStore' | 'backupSecret' | 'writeBackup'>,
): Annon {
  return new Annon({
    ...options,
    rawStore: storage.rawStore,
    backupSecret: storage.backupSecret,
    writeBackup: storage.writeBackup,
  });
}
const LEASE_SECONDS = 120;
const HEARTBEAT_MS = 30000;

export class PurchaseLeaseBusy extends AnnonError {
  readonly code = 'lease_busy';
  constructor(readonly waitUntil: number) {
    super('lease_busy', 'Another tab holds this purchase; wait for its lease to expire.');
    this.name = 'PurchaseLeaseBusy';
  }
}
interface LeaseSession {
  record: BrowserPurchaseRecord;
  change(patch: Partial<BrowserPurchaseRecord>): Promise<BrowserPurchaseRecord>;
}
export class BrowserPurchaseController {
  readonly storage: BrowserPurchaseStorage;
  private readonly owner = crypto.randomUUID();
  private readonly listeners = new Set<(event: PurchaseProgress) => void>();
  constructor(private readonly options: ControllerOptions) {
    this.storage = options.storage;
  }
  static async create(options: Omit<ControllerOptions, 'id'>, terms: PurchaseTermsReview) {
    const record: BrowserPurchaseRecord = {
      id: terms.id,
      revision: 0,
      fileId: terms.fileId,
      header: hex(terms.header),
      resourceUrl: terms.resourceUrl,
      route: terms.route,
      maxPrice: String(terms.maxPrice),
      state: 'terms_review',
      submission: 'not_submitted',
    };
    await options.storage.save(null, record);
    return new BrowserPurchaseController({ ...options, id: terms.id });
  }
  subscribe(listener: (event: PurchaseProgress) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private async read(): Promise<BrowserPurchaseRecord> {
    const record = await this.storage.load(this.options.id);
    if (!record) throw new Error('purchase missing');
    return record;
  }
  /** Safe to render. Full records are available only through the persistence adapter. */
  async snapshot(): Promise<
    PurchaseProgress & { fileId: string; route: BuyRoute; resourceUrl: string }
  > {
    const record = await this.read();
    return {
      id: record.id,
      state: record.state,
      revision: record.revision,
      fileId: record.fileId,
      route: record.route,
      resourceUrl: record.resourceUrl,
      ...this.waiting(record),
      ...(record.checkpoint?.lastStatus ? { swapStatus: record.checkpoint.lastStatus.status } : {}),
    };
  }
  private now() {
    return (this.options.now ?? (() => Math.floor(Date.now() / 1000)))();
  }
  private waiting(record: BrowserPurchaseRecord): { leaseWaitUntil?: number } {
    return record.lease && record.lease.expiresAt > this.now()
      ? { leaseWaitUntil: record.lease.expiresAt }
      : {};
  }
  private emit(event: PurchaseProgress) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* Observers cannot interrupt the workflow. */
      }
    }
  }
  private busy(record: BrowserPurchaseRecord): PurchaseLeaseBusy | undefined {
    if (!record.lease || record.lease.expiresAt <= this.now()) return;
    this.emit({
      id: record.id,
      state: record.state,
      revision: record.revision,
      ...this.waiting(record),
    });
    return new PurchaseLeaseBusy(record.lease.expiresAt);
  }
  /** Every asynchronous operation owns a renewable lease, with revision CAS on every write. */
  private async withLease<T>(
    run: (session: LeaseSession) => Promise<T>,
    options: { initial?: Partial<BrowserPurchaseRecord>; finalCheckpoint?: boolean } = {},
  ): Promise<T> {
    const before = await this.read();
    const busy = this.busy(before);
    if (busy) throw busy;
    if (options.initial?.state === 'preparing' && before.state !== 'terms_review')
      throw new Error('purchase already started; resume the saved purchase');
    const lease = () => ({ owner: this.owner, expiresAt: this.now() + LEASE_SECONDS });
    const session: LeaseSession = {
      record: await this.change(before, { ...options.initial, lease: lease() }),
      change: (patch) =>
        enqueue(async () => {
          if (heartbeatError) throw heartbeatError;
          if (
            session.record.lease?.owner !== this.owner ||
            session.record.lease.expiresAt <= this.now()
          )
            throw new Error('purchase lease expired; resume the saved purchase');
          session.record = await this.change(session.record, { ...patch, lease: lease() });
          return session.record;
        }),
    };
    let queue: Promise<unknown> = Promise.resolve();
    let heartbeatError: unknown;
    function enqueue<R>(fn: () => Promise<R>): Promise<R> {
      const next = queue.then(fn);
      queue = next.catch(() => {});
      return next;
    }
    const heartbeat = setInterval(() => {
      void session.change({}).catch((error) => {
        heartbeatError = error;
      });
    }, HEARTBEAT_MS);
    try {
      const result = await run(session);
      if (options.finalCheckpoint !== false) await session.change({});
      return result;
    } finally {
      clearInterval(heartbeat);
      await queue;
      // A stale owner must never release a newer owner's lease.
      await this.change(session.record, { lease: undefined }).catch(() => {});
    }
  }
  private async change(before: BrowserPurchaseRecord, patch: Partial<BrowserPurchaseRecord>) {
    const next = { ...before, ...patch, id: before.id, revision: before.revision + 1 };
    await this.storage.save(before, next);
    const event: PurchaseProgress = {
      id: next.id,
      state: next.state,
      revision: next.revision,
      ...(next.checkpoint?.lastStatus ? { swapStatus: next.checkpoint.lastStatus.status } : {}),
    };
    this.emit(event);
    return next;
  }
  async start(
    options: Omit<
      BuyOptions,
      | 'fileId'
      | 'header'
      | 'url'
      | 'route'
      | 'maxPrice'
      | 'onSaved'
      | 'beforeSave'
      | 'beforePayment'
      | 'onQuote'
    >,
  ): Promise<void> {
    const before = await this.read();
    if (before.state !== 'terms_review')
      throw new Error('purchase already started; resume the saved purchase');
    if (before.route === 'base' && typeof options.submitBase !== 'function')
      throw new TypeError('Base requires submitBase');
    await this.withLease(
      async (session) => {
        const persist = async (patch: Partial<BrowserPurchaseRecord>) => {
          await session.change(patch);
        };
        try {
          const result = await this.options.sdk.buy({
            ...options,
            fileId: session.record.fileId,
            header: bytes(session.record.header, (session.record.header.length - 2) / 2),
            url: session.record.resourceUrl,
            route: session.record.route,
            maxPrice: BigInt(session.record.maxPrice),
            beforeSave: async (purchase) => {
              await persist({
                purchase,
                ...(session.record.route === 'base' &&
                purchase.attempts.some((attempt) => !!attempt.payload)
                  ? { submission: 'uncertain' as const }
                  : {}),
              });
            },
            onSaved: async (purchase) => {
              if (session.record.purchase?.revision !== purchase.revision)
                await persist({
                  purchase,
                  ...(session.record.route === 'base' &&
                  purchase.attempts.some((attempt) => !!attempt.payload)
                    ? { submission: 'uncertain' as const }
                    : {}),
                });
            },
            beforePayment: async (purchase) => {
              if (!purchase.recoveryProved || session.record.purchase?.id !== purchase.id)
                throw new Error('durable recovery proof required');
              if (
                session.record.lease?.owner !== this.owner ||
                session.record.lease.expiresAt <= this.now()
              )
                throw new Error('purchase lease expired');
              if (session.record.route !== '1click')
                await persist({
                  state: 'payment_uncertain',
                  purchase,
                  submission: 'uncertain',
                  paymentStarted: true,
                });
            },
          });
          await persist({
            purchase: result.record,
            state: session.record.route === '1click' ? 'awaiting_deposit' : 'payment_uncertain',
            submission:
              session.record.route === '1click'
                ? 'not_submitted'
                : result.uncertain
                  ? 'uncertain'
                  : session.record.submission === 'not_submitted'
                    ? 'not_submitted'
                    : 'submitted',
          });
        } catch (error) {
          // Only an unstaged failure can return to review. A staged purchase must resume its original commitment.
          await session
            .change({
              state: session.record.purchase ? 'payment_uncertain' : 'terms_review',
            })
            .catch(() => {});
          throw error;
        }
      },
      { initial: { state: 'preparing', submission: 'not_submitted' }, finalCheckpoint: false },
    );
  }
  private deposit(record: BrowserPurchaseRecord): Deposit | undefined {
    return (record.purchase?.quote as OneClickQuote | null)?.deposit;
  }
  async instructions(): Promise<Deposit | null> {
    const record = await this.read();
    const deposit = this.deposit(record);
    if (
      !['awaiting_deposit', 'incomplete_deposit'].includes(record.state) ||
      record.needsProof ||
      !record.purchase?.recoveryProved ||
      !deposit ||
      !Number.isFinite(Date.parse(deposit.depositBefore)) ||
      Date.parse(deposit.depositBefore) - this.now() * 1000 < 600000
    )
      return null;
    return structuredClone(deposit);
  }
  async resume(options: { recovery?: IdentityWallet } = {}): Promise<void> {
    let saved = await this.read();
    if (this.busy(saved)) return;
    if (
      ['terms_review', 'refunded', 'failed', 'file_ready', 'accepted', 'abandoned'].includes(
        saved.state,
      )
    )
      return;
    if (saved.state === 'recovering') {
      if (options.recovery) await this.recover(options.recovery);
      return;
    }
    const interrupted = saved.lease !== undefined;
    return this.withLease(async (session) => {
      saved = session.record;
      if (!saved.purchase) {
        await session.change({ state: 'terms_review' });
        return;
      }
      const purchase = saved.purchase;
      const signed = purchase.attempts.some((attempt) => !!attempt.payload);
      if (
        saved.route !== '1click' &&
        saved.submission === 'not_submitted' &&
        !signed &&
        !saved.paymentStarted &&
        !saved.purchase.nearSubmission
      ) {
        await session.change({ state: 'abandoned' });
        return;
      }
      if ((interrupted || signed) && saved.submission === 'not_submitted')
        saved = await session.change({
          ...(signed ? { submission: 'uncertain' as const } : {}),
        });
      let restored = await this.storage.restorePurchase(purchase);
      if (JSON.stringify(restored) !== JSON.stringify(saved.purchase))
        saved = await session.change({ purchase: restored });
      const pendingBase = () =>
        saved.route === 'base' &&
        restored.paymentState !== 'expired' &&
        (signed || saved.submission !== 'not_submitted' || saved.state === 'accepting');
      if (pendingBase() && saved.state !== 'accepting')
        saved = await session.change({ state: 'accepting' });
      if (await this.options.sdk.accept(restored)) {
        await session.change({ state: 'accepted' });
        return;
      }
      restored = await this.storage.restorePurchase(restored);
      if (JSON.stringify(restored) !== JSON.stringify(saved.purchase))
        saved = await session.change({ purchase: restored });
      const status = saved.checkpoint?.lastStatus?.status;
      const progress =
        status === 'SUCCESS' || saved.state === 'accepting'
          ? 'accepting'
          : status === 'PROCESSING' || status === 'KNOWN_DEPOSIT_TX' || saved.state === 'processing'
            ? 'processing'
            : null;
      if (saved.route === '1click' && progress) {
        await session.change({ state: progress });
        return;
      }
      if (saved.state === 'expired' && saved.route !== 'base') return;
      if (saved.route !== '1click') {
        await session.change({
          state: pendingBase()
            ? 'accepting'
            : this.now() >= Number(restored.purchase.expires_at)
              ? 'expired'
              : saved.submission === 'submitted'
                ? 'accepting'
                : 'payment_uncertain',
        });
        return;
      }
      const deposit = this.deposit(saved);
      if (
        !deposit ||
        !Number.isFinite(Date.parse(deposit.depositBefore)) ||
        Date.parse(deposit.depositBefore) - this.now() * 1000 < 600000
      ) {
        await session.change({ state: 'expired' });
        return;
      }
      if (saved.needsProof || !saved.purchase?.recoveryProved) {
        if (!options.recovery) return;
        const purchase = await this.options.sdk.proveRecovery(restored, options.recovery);
        saved = await session.change({ purchase, needsProof: false });
        if (Date.parse(deposit.depositBefore) - this.now() * 1000 < 600000) {
          await session.change({ state: 'expired' });
          return;
        }
      }
      await session.change({
        state:
          status === 'SUCCESS'
            ? 'accepting'
            : status === 'INCOMPLETE_DEPOSIT'
              ? 'incomplete_deposit'
              : status === 'PROCESSING'
                ? 'processing'
                : 'awaiting_deposit',
      });
    });
  }
  /** Polling remains available after the deposit cutoff to track late deposits and refunds. */
  async poll(
    options: Omit<PollOptions, 'checkpoint' | 'memo' | 'onProgress'> & {
      oneClick?: Pick<OneClick, 'poll'>;
    } = {},
  ): Promise<void> {
    return this.withLease(async (session) => {
      let saved = session.record;
      const deposit = this.deposit(saved);
      if (
        saved.route !== '1click' ||
        !deposit ||
        [
          'terms_review',
          'accepted',
          'recovering',
          'file_ready',
          'refunded',
          'failed',
          'abandoned',
        ].includes(saved.state)
      )
        throw new Error('no pollable 1Click deposit in this state');
      const { oneClick = new OneClick(), ...pollOptions } = options;
      await oneClick.poll(deposit.address, {
        ...pollOptions,
        ...(deposit.memo === undefined ? {} : { memo: deposit.memo }),
        ...(saved.checkpoint ? { checkpoint: saved.checkpoint } : {}),
        onProgress: async (checkpoint) => {
          const status = checkpoint.lastStatus?.status;
          const states: Record<string, BrowserPurchaseState> = {
            PENDING_DEPOSIT: 'awaiting_deposit',
            KNOWN_DEPOSIT_TX: 'processing',
            PROCESSING: 'processing',
            INCOMPLETE_DEPOSIT: 'incomplete_deposit',
            SUCCESS: 'accepting',
            REFUNDED: 'refunded',
            FAILED: 'failed',
          };
          let state = status ? (states[status] ?? saved.state) : saved.state;
          if (
            ['awaiting_deposit', 'incomplete_deposit'].includes(state) &&
            (saved.state === 'expired' || Date.parse(deposit.depositBefore) <= this.now() * 1000)
          )
            state = 'expired';
          saved = await session.change({ checkpoint, state });
        },
      });
      if (
        saved.state === 'accepting' &&
        saved.purchase &&
        (await this.options.sdk.accept(saved.purchase))
      )
        await session.change({ state: 'accepted' });
    });
  }
  async recover(wallet: IdentityWallet): Promise<void> {
    return this.withLease(async (session) => {
      let saved = session.record;
      if (!saved.purchase) throw new Error('saved purchase required');
      const purchase = await this.storage.restorePurchase(saved.purchase);
      saved = await session.change({ state: 'recovering', purchase });
      const recovered = await this.options.sdk.recover({ wallet, purchaseId: purchase.id });
      const recovery = recovered[0];
      if (!recovery || recovery.grant === null)
        throw new Error('recovery not final; resume recovery');
      await session.change({ recovery, state: 'accepted' });
    });
  }
  /** Open supplied ciphertext, or download with the saved grant. Returns plaintext only in memory. */
  async open(input: Uint8Array | BrowserOpenOptions = {}): ReturnType<Annon['open']> {
    return this.withLease(async (session) => {
      let saved = session.record;
      if (!['accepted', 'file_ready'].includes(saved.state) || !saved.purchase)
        throw new Error('purchase is not accepted');
      const restored = await this.storage.restorePurchase(saved.purchase);
      if (JSON.stringify(restored) !== JSON.stringify(saved.purchase))
        saved = await session.change({ purchase: restored });
      const options = input instanceof Uint8Array ? {} : input;
      if (input instanceof Uint8Array && input.length > BROWSER_DOWNLOAD_LIMIT)
        throw new DownloadError('too_large', 'File exceeds the 50 MB size limit.');
      const header = bytes(saved.header, (saved.header.length - 2) / 2);
      if (saved.recovery?.grant === null) throw new Error('recovery grant is not final');
      const file =
        input instanceof Uint8Array
          ? input
          : await browserDownload({
              ...options,
              url: saved.resourceUrl,
              contractId: restored.terms.contractId,
              fileId: saved.fileId,
              header,
              checkedHeaderHash: restored.checkedHeaderHash,
              listing: {
                fileId: saved.fileId,
                cipherHash: restored.terms.cipherHash,
                seller: restored.terms.seller,
                // The complete header digest was pinned before payment. Annon.open also checks final terms.
                publishedHeaderHash: hex(await sha256(header.subarray(0, -65))),
              },
              proof: {
                secret: bytes(saved.recovery?.buyerSecret ?? restored.buyerSecret, 32),
                purchase_id: restored.id,
                grant: saved.recovery?.grant ?? 0,
              },
            });
      if (options.signal?.aborted) throw new DownloadError('cancelled');
      downloadProgress(options.onProgress, { phase: 'decrypting', received: file.length });
      const result = await this.options.sdk.open({
        file,
        record: restored,
        ...(saved.recovery ? { recovery: saved.recovery } : {}),
      });
      if (options.signal?.aborted) throw new DownloadError('cancelled');
      await session.change({ state: 'file_ready' });
      downloadProgress(options.onProgress, { phase: 'ready', received: file.length });
      return result;
    });
  }
  exportReceipt(secret: Uint8Array): Promise<string> {
    return this.storage.exportReceipt(this.options.id, secret);
  }
}
