/** Durable SDK orchestration. Storage belongs to the embedding origin; no UI or wallet connector. */
import { Annon, type AnnonOptions, type BuyOptions, type BuyRoute } from '../api/annon.js';
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
  exportBrowserIndex,
  exportPurchase,
  exportRecovery,
  importBrowserIndex,
  importPurchase,
  importRecovery,
  newBackupSecret,
  type RecoveryRecord,
  sealBrowserRecord,
} from '../pay/backup.js';
import type {
  BrowserPurchaseIndex,
  BrowserPurchaseRecord,
  BrowserPurchaseState,
} from '../pay/browser-record.js';
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

export type { BrowserPurchaseRecord, BrowserPurchaseState } from '../pay/browser-record.js';
export type PurchaseSdk = Pick<Annon, 'buy' | 'accept' | 'open' | 'recover' | 'proveRecovery'>;
const INDEX = 'annon/browser/index';
const conflict = () => new Error('browser purchase store conflict; reload the saved purchase');
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
      return exportBrowserIndex(
        {
          kind: 'browser-index',
          id: 'browser-index',
          revision: 0,
          entries: [portable],
          backups: {},
        },
        secret,
      );
    },
    async importReceipt(file, secret) {
      const receipt = await importBrowserIndex(file, secret);
      if (receipt.entries.length !== 1 || Object.keys(receipt.backups).length)
        throw new TypeError('invalid portable receipt');
      const entry = receipt.entries[0];
      if (!entry) throw new TypeError('empty portable receipt');
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
}
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
      ...(record.checkpoint?.lastStatus ? { swapStatus: record.checkpoint.lastStatus.status } : {}),
    };
  }
  private now() {
    return (this.options.now ?? (() => Math.floor(Date.now() / 1000)))();
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
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* A UI observer cannot interrupt durable payment checkpoints. */
      }
    }
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
    let saved = await this.read();
    if (saved.state !== 'terms_review')
      throw new Error('purchase already started; resume the saved purchase');
    if (saved.route === 'base-usdc' && typeof options.submitBase !== 'function')
      throw new TypeError('Base requires submitBase');
    const lease = () => ({ owner: this.owner, expiresAt: this.now() + 120 });
    saved = await this.change(saved, {
      state: 'preparing',
      submission: 'not_submitted',
      lease: lease(),
    });
    let queue: Promise<unknown> = Promise.resolve();
    let heartbeatError: unknown;
    const persist = (patch: Partial<BrowserPurchaseRecord>, release = false): Promise<void> => {
      const run = queue.then(async () => {
        if (heartbeatError) throw heartbeatError;
        if (saved.lease?.owner !== this.owner || saved.lease.expiresAt <= this.now())
          throw new Error('purchase lease expired; resume the saved checkout');
        saved = await this.change(saved, { ...patch, lease: release ? undefined : lease() });
      });
      queue = run.catch(() => {});
      return run;
    };
    const heartbeat = setInterval(() => {
      void persist({}).catch((error) => {
        heartbeatError = error;
      });
    }, 30000);
    try {
      const result = await this.options.sdk.buy({
        ...options,
        fileId: saved.fileId,
        header: bytes(saved.header, (saved.header.length - 2) / 2),
        url: saved.resourceUrl,
        route: saved.route,
        maxPrice: BigInt(saved.maxPrice),
        beforeSave: async (purchase) => {
          await persist({
            purchase,
            ...(saved.route === 'base-usdc' &&
            purchase.attempts.some((attempt) => !!attempt.payload)
              ? { submission: 'uncertain' as const }
              : {}),
          });
        },
        onSaved: async (purchase) => {
          if (JSON.stringify(saved.purchase) !== JSON.stringify(purchase))
            await persist({
              purchase,
              ...(saved.route === 'base-usdc' &&
              purchase.attempts.some((attempt) => !!attempt.payload)
                ? { submission: 'uncertain' as const }
                : {}),
            });
        },
        beforePayment: async (purchase) => {
          if (!purchase.recoveryProved || saved.purchase?.id !== purchase.id)
            throw new Error('durable recovery proof required');
          if (saved.lease?.owner !== this.owner || saved.lease.expiresAt <= this.now())
            throw new Error('purchase lease expired');
          if (saved.route !== 'oneclick')
            await persist({
              state: 'payment_uncertain',
              purchase,
              submission: 'uncertain',
              paymentStarted: true,
            });
        },
      });
      await persist(
        {
          purchase: result.record,
          state: saved.route === 'oneclick' ? 'awaiting_deposit' : 'payment_uncertain',
          submission:
            saved.route === 'oneclick'
              ? 'not_submitted'
              : result.uncertain
                ? 'uncertain'
                : saved.submission === 'not_submitted'
                  ? 'not_submitted'
                  : 'submitted',
        },
        true,
      );
    } catch (error) {
      // Only an unstaged failure can return to review. A staged purchase must resume its original commitment.
      await this.change(saved, {
        state: saved.purchase ? 'payment_uncertain' : 'terms_review',
        lease: undefined,
      }).catch(() => {});
      throw error;
    } finally {
      clearInterval(heartbeat);
      await queue;
    }
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
    if (
      ['terms_review', 'refunded', 'failed', 'file_ready', 'accepted', 'abandoned'].includes(
        saved.state,
      )
    )
      return;
    if (saved.lease && saved.lease.expiresAt > this.now()) return;
    if (saved.state === 'recovering') {
      if (options.recovery) await this.recover(options.recovery);
      return;
    }
    if (!saved.purchase) {
      await this.change(saved, { state: 'terms_review', lease: undefined });
      return;
    }
    const purchase = saved.purchase;
    const signed = purchase.attempts.some((attempt) => !!attempt.payload);
    if (
      saved.route !== 'oneclick' &&
      saved.submission === 'not_submitted' &&
      !signed &&
      !saved.paymentStarted &&
      !saved.purchase.nearSubmission
    ) {
      await this.change(saved, { state: 'abandoned', lease: undefined });
      return;
    }
    if (saved.lease || (signed && saved.submission === 'not_submitted'))
      saved = await this.change(saved, {
        lease: undefined,
        ...(signed ? { submission: 'uncertain' as const } : {}),
      });
    const restored = await this.storage.restorePurchase(purchase);
    if (JSON.stringify(restored) !== JSON.stringify(saved.purchase))
      saved = await this.change(saved, { purchase: restored });
    if (await this.options.sdk.accept(restored)) {
      await this.change(saved, { state: 'accepted' });
      return;
    }
    const status = saved.checkpoint?.lastStatus?.status;
    const progress =
      status === 'SUCCESS' || saved.state === 'accepting'
        ? 'accepting'
        : status === 'PROCESSING' || status === 'KNOWN_DEPOSIT_TX' || saved.state === 'processing'
          ? 'processing'
          : null;
    if (saved.route === 'oneclick' && progress) {
      await this.change(saved, { state: progress });
      return;
    }
    if (saved.state === 'expired') return;
    if (saved.route !== 'oneclick') {
      await this.change(saved, {
        state:
          this.now() >= Number(restored.purchase.expires_at)
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
      await this.change(saved, { state: 'expired' });
      return;
    }
    if (saved.needsProof || !saved.purchase?.recoveryProved) {
      if (!options.recovery) return;
      const purchase = await this.options.sdk.proveRecovery(restored, options.recovery);
      saved = await this.change(saved, { purchase, needsProof: false });
      if (Date.parse(deposit.depositBefore) - this.now() * 1000 < 600000) {
        await this.change(saved, { state: 'expired' });
        return;
      }
    }
    await this.change(saved, {
      state:
        status === 'SUCCESS'
          ? 'accepting'
          : status === 'INCOMPLETE_DEPOSIT'
            ? 'incomplete_deposit'
            : status === 'PROCESSING'
              ? 'processing'
              : 'awaiting_deposit',
    });
  }
  /** Polling remains available after the deposit cutoff to track late deposits and refunds. */
  async poll(
    options: Omit<PollOptions, 'checkpoint' | 'memo' | 'onProgress'> & {
      oneClick?: Pick<OneClick, 'poll'>;
    } = {},
  ): Promise<void> {
    let saved = await this.read();
    const deposit = this.deposit(saved);
    if (
      saved.route !== 'oneclick' ||
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
        saved = await this.change(saved, { checkpoint, state });
      },
    });
    if (
      saved.state === 'accepting' &&
      saved.purchase &&
      (await this.options.sdk.accept(saved.purchase))
    )
      await this.change(saved, { state: 'accepted' });
  }
  async recover(wallet: IdentityWallet): Promise<void> {
    let saved = await this.read();
    if (!saved.purchase) throw new Error('saved purchase required');
    const purchase = await this.storage.restorePurchase(saved.purchase);
    saved = await this.change(saved, { state: 'recovering', purchase });
    const recovered = await this.options.sdk.recover({ wallet, purchaseId: purchase.id });
    const recovery = recovered[0];
    if (!recovery || recovery.grant === null)
      throw new Error('recovery not final; resume recovery');
    await this.change(saved, { recovery, state: 'accepted' });
  }
  /** Delegates a caller-supplied PAY2 file. Downloading and browser saving are separate integrations. */
  async open(file: Uint8Array): ReturnType<Annon['open']> {
    let saved = await this.read();
    if (!['accepted', 'file_ready'].includes(saved.state) || !saved.purchase)
      throw new Error('purchase is not accepted');
    const restored = await this.storage.restorePurchase(saved.purchase);
    if (JSON.stringify(restored) !== JSON.stringify(saved.purchase))
      saved = await this.change(saved, { purchase: restored });
    const result = await this.options.sdk.open({
      file,
      record: restored,
      ...(saved.recovery ? { recovery: saved.recovery } : {}),
    });
    await this.change(saved, { state: 'file_ready' });
    return result;
  }
  exportReceipt(secret: Uint8Array): Promise<string> {
    return this.storage.exportReceipt(this.options.id, secret);
  }
}
