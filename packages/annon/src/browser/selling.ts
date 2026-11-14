/** One browser sale, backed by the same hosted workflow as the SDK and command line. */
import { Annon, type AnnonOptions } from '../api/annon.js';
import type { ShareOptions, ShareQuote, ShareStep } from '../api/sharing.js';
import type { UploadAuth, UploadIntent } from '../download/upload.js';
import { blobSource, type Spool } from '../envelope/replay.js';
import { AnnonError, present } from '../errors.js';
import { exportSell, importSell, newBackupSecret, type SellRecord } from '../pay/backup.js';
import { indexedDbStore, type Store, type Versioned } from '../pay/store.js';
import type { BuyRoute } from '../routes.js';
import { bytes, hex, usdc } from '../settle-near/codec.js';
import {
  type Identity,
  identityJson,
  identityText,
  parseIdentity,
} from '../settle-near/identity.js';
import type { IdentityWallet } from '../wallet/wallet.js';
import { browserPurchaseStorage } from './purchases.js';

export interface SellerConnection {
  readonly id: string;
  readonly kind: Identity['kind'];
  readonly label: string;
}
export interface SellDraft {
  file: Blob & { readonly name: string };
  title: string;
  description: string;
  priceUsdc: string;
  listingStorageNear?: string;
  storageBudgetNear?: string;
}
export type SellStep = 'backup' | ShareStep;
export interface SellTerms {
  seller: { kind: Identity['kind']; label: string };
  sellerIdentity: string;
  filename: string;
  title: string;
  priceUsdc: string;
  shares: { label: string; bps: number; amountUsdc: string }[];
  fee: { fixedUsdc: string; bps: number; amountUsdc: string } | null;
  funding: { listingStorageNear: string; purchaseStorageNear: string } | null;
  routes: BuyRoute[];
  baseSplit: boolean;
  steps: SellStep[];
  contract: string;
  host: string;
}
export interface SellQuote extends SellTerms {
  quoteId: string;
  description: string;
  byteSize: number;
  /** The selected shop's stated lifetime in days, null for no planned expiry, absent when unknown. */
  hostedDays?: number | null;
}
export interface SaleView extends SellTerms {
  id: string;
  revision: number;
  done: SellStep[];
  next: SellStep | null;
  pending: boolean;
  needs: ('wallet' | 'file' | 'secret')[];
  registered: boolean;
  /** expiresAt is Unix seconds, or null when the shop plans no hosting expiry. */
  result: { fileId: string; url: string; expiresAt: number | null } | null;
}
export interface SellProgress {
  phase: 'encrypting' | 'uploading';
  done: number;
  total: number;
}
export interface SaleHandle {
  readonly id: string;
  view(): Promise<SaleView>;
  subscribe(listener: (view: SaleView) => void): () => void;
  exportBackup(): Promise<{ filename: string; text: string; secret: string }>;
  confirmBackup(): Promise<void>;
  attachWallet(connection: SellerConnection): Promise<void>;
  attachFile(file: Blob & { readonly name: string }): Promise<void>;
  unlock(secret: string): Promise<void>;
  /**
   * A rejected txHash must not be passed again. Call next() later without txHash
   * to reconcile from final contract state.
   */
  next(options?: {
    signal?: AbortSignal;
    /** Untrusted NEAR wallet return candidate, checked against the pending call and attempt. */
    txHash?: string;
    onProgress?: (progress: SellProgress) => void;
  }): Promise<SaleView>;
  discard(): Promise<void>;
}
export interface SellerFacade {
  readonly kind: 'sdk';
  readonly live: boolean;
  active(): Promise<SaleHandle | null>;
  quote(connection: SellerConnection, draft: SellDraft): Promise<SellQuote>;
  begin(quoteId: string): Promise<SaleHandle>;
}
/** Metadata and an encrypted portable backup only. The separate export secret stays in memory. */
export interface BrowserSaleIndex extends Versioned {
  fileId: string;
  backup: string | null;
}
export interface BrowserSellerOptions extends AnnonOptions {
  host: string;
  /**
   * Display only: the selected shop's stated file lifetime in days from its validated rules,
   * null for no planned expiry. The per-file publication response states the actual expiry.
   */
  fileLifetimeDays?: number | null;
  indexStore: Store<BrowserSaleIndex>;
  /** Resolve a page-owned handle to its canonical wallet without signing. */
  wallet(connection: SellerConnection): {
    wallet: IdentityWallet;
    signUpload?: (intent: UploadIntent) => Promise<UploadAuth>;
  };
}
const indexKey = 'annon/browser/sale';
function decimal(value: string, places: number): bigint {
  if (
    typeof value !== 'string' ||
    !new RegExp(`^(0|[1-9][0-9]*)(\\.[0-9]{1,${places}})?$`).test(value)
  )
    throw new AnnonError('invalid_arguments');
  const [whole, fraction = ''] = value.split('.');
  const amount =
    BigInt(present(whole)) * 10n ** BigInt(places) + BigInt(fraction.padEnd(places, '0'));
  if (amount <= 0n || amount >= 2n ** 128n) throw new AnnonError('invalid_arguments');
  return amount;
}
function near(value: string): string {
  const v = BigInt(value);
  const fraction = (v % 10n ** 24n).toString().padStart(24, '0').replace(/0+$/, '');
  return `${v / 10n ** 24n}${fraction ? `.${fraction}` : ''}`;
}
/** Only ciphertext is collected, using the existing bounded streaming encoder. */
export const browserSellerSpool: Spool = async (stream, use) => {
  const blob = await new Response(stream).blob();
  return use(blobSource(blob));
};
function immutable(job: SellRecord): string {
  const h = present(job.hosting);
  const { expiresAt: _expiresAt, ...intent } = h.intent;
  return JSON.stringify([
    intent,
    job.terms,
    job.baseSplit,
    h.origin,
    h.metadata,
    h.manifest,
    h.listingStorage,
    job.storageBudget ?? null,
    h.fee,
    h.steps,
  ]);
}
function keyMaterial(job: SellRecord): string {
  return JSON.stringify([job.fileKey, job.sellerSecret]);
}
function display(job: SellRecord): SellTerms {
  const h = present(job.hosting),
    t = job.terms;
  const price = BigInt(t.near.price);
  const amounts = t.near.recipients.map((r) => (price * BigInt(r.bps)) / 10000n);
  amounts[t.near.remainder] =
    present(amounts[t.near.remainder]) + price - amounts.reduce((a, b) => a + b, 0n);
  const sellerIndex = t.near.recipients.findIndex(
    (r) => identityJson(r.identity) === identityJson(t.seller),
  );
  const sellerAmount = amounts[sellerIndex] ?? 0n;
  const indices = t.near.recipients
    .map((_, i) => i)
    .sort((a, b) => (a === sellerIndex ? -1 : b === sellerIndex ? 1 : a - b));
  return {
    seller: { kind: t.seller.kind, label: identityText(t.seller) },
    sellerIdentity: identityText(t.seller),
    filename: job.name,
    title: h.metadata.title,
    priceUsdc: usdc(price),
    shares: indices.map((i) => ({
      label: i === sellerIndex ? 'You' : 'Protocol fee',
      bps: present(t.near.recipients[i]).bps,
      amountUsdc: usdc(present(amounts[i])),
    })),
    fee: h.fee
      ? { fixedUsdc: usdc(h.fee.fixed), bps: h.fee.bps, amountUsdc: usdc(price - sellerAmount) }
      : null,
    funding:
      t.seller.kind === 'near'
        ? {
            listingStorageNear: near(present(h.listingStorage)),
            purchaseStorageNear: near(present(job.storageBudget)),
          }
        : null,
    routes: t.base ? ['near', 'base', '1click'] : ['near', '1click'],
    baseSplit: t.base !== null,
    steps: ['backup', ...h.steps],
    contract: t.contract,
    host: h.origin,
  };
}
export async function browserSellerStorage(options: { name?: string; factory?: IDBFactory } = {}) {
  const location = { ...options, name: options.name ?? 'annon-selling' };
  const { rawStore, backupSecret, writeBackup } = await browserPurchaseStorage(location);
  return {
    rawStore,
    backupSecret,
    writeBackup,
    indexStore: indexedDbStore<BrowserSaleIndex>(location),
  };
}
export function createBrowserSeller(options: BrowserSellerOptions): SellerFacade {
  const days = options.fileLifetimeDays;
  if (days !== undefined && days !== null && (!Number.isSafeInteger(days) || days < 0))
    throw new AnnonError('invalid_arguments');
  const sdk = new Annon(options);
  const sessions = new Map<
    string,
    {
      approved?: string;
      approvedKeys?: string;
      secret?: Uint8Array;
      file?: SellDraft['file'];
      connection?: SellerConnection;
    }
  >();
  const quotes = new Map<
    string,
    { quote: ShareQuote; draft: SellDraft; connection: SellerConnection; shown: SellTerms }
  >();
  const listeners = new Map<string, Set<(view: SaleView) => void>>();
  const session = (id: string) => {
    let value = sessions.get(id);
    if (!value) {
      value = {};
      sessions.set(id, value);
    }
    return value;
  };
  const index = async () => {
    try {
      const value = await options.indexStore.load(indexKey);
      if (
        value &&
        (value.id !== 'browser-sale' ||
          !Number.isSafeInteger(value.revision) ||
          value.revision < 0 ||
          !/^0x[0-9a-f]{64}$/.test(value.fileId) ||
          !(value.backup === null || typeof value.backup === 'string') ||
          Object.keys(value).some((k) => !['id', 'revision', 'fileId', 'backup'].includes(k)))
      )
        throw new Error();
      return value;
    } catch (cause) {
      throw new AnnonError('invalid_record', undefined, { cause });
    }
  };
  const read = async (id: string) => {
    const saved = await index();
    if (!saved || saved.fileId !== id) throw new AnnonError('invalid_record');
    const job = await sdk.hosted.load(id);
    if (session(id).approved && session(id).approved !== immutable(job))
      throw new AnnonError('invalid_record');
    if (!job.published && session(id).approvedKeys && session(id).approvedKeys !== keyMaterial(job))
      throw new AnnonError('invalid_record');
    const secret = session(id).secret;
    if (secret) {
      if (!saved.backup) throw new AnnonError('backup_secret_required');
      let backup: SellRecord;
      try {
        backup = await importSell(saved.backup, secret);
      } catch (cause) {
        throw new AnnonError('invalid_record', undefined, { cause });
      }
      if (
        immutable(job) !== immutable(backup) ||
        (!job.published && keyMaterial(job) !== keyMaterial(backup))
      )
        throw new AnnonError('invalid_record');
    }
    // No object loaded after authentication is substituted into this display or approval.
    if (
      (await sdk.hosted.load(id)).revision !== job.revision ||
      (await index())?.revision !== saved.revision
    )
      throw new AnnonError('store_conflict');
    return { saved, job };
  };
  const view = async (id: string): Promise<SaleView> => {
    const { job } = await read(id),
      h = present(job.hosting),
      s = session(id);
    const result = h.result;
    const shown: SaleView = {
      ...display(job),
      id,
      revision: job.revision,
      done: [...(h.backupConfirmed ? ['backup' as const] : []), ...h.completed],
      next: result ? null : h.backupConfirmed ? (h.steps[h.completed.length] ?? null) : 'backup',
      pending: h.pending !== null,
      needs: result
        ? []
        : [
            ...(!s.connection ? ['wallet' as const] : []),
            ...(!s.file ? ['file' as const] : []),
            ...(h.backupConfirmed && !s.secret ? ['secret' as const] : []),
          ],
      registered: h.completed.includes('register'),
      result: result
        ? { fileId: result.fileId, url: result.url, expiresAt: result.expiresAt }
        : null,
    };
    return structuredClone(shown);
  };
  const emit = async (id: string) => {
    const current = await view(id);
    for (const listener of listeners.get(id) ?? []) {
      try {
        listener(structuredClone(current));
      } catch {
        /* Observers do not control the sale. */
      }
    }
    return current;
  };
  const handle = (id: string): SaleHandle => ({
    id,
    view: () => view(id),
    subscribe(listener) {
      const set = listeners.get(id) ?? new Set();
      listeners.set(id, set);
      set.add(listener);
      return () => {
        set.delete(listener);
      };
    },
    async exportBackup() {
      const { job, saved } = await read(id);
      if (
        present(job.hosting).backupConfirmed ||
        present(job.hosting).pending ||
        present(job.hosting).lease
      )
        throw new AnnonError('invalid_arguments');
      const secret = newBackupSecret();
      const text = await exportSell(job, secret);
      if ((await sdk.hosted.load(id)).revision !== job.revision)
        throw new AnnonError('store_conflict');
      if (
        !(await options.indexStore.compareAndSet(indexKey, saved, {
          ...saved,
          revision: saved.revision + 1,
          backup: text,
        }))
      )
        throw new AnnonError('store_conflict');
      session(id).secret = secret;
      return { filename: `annon-seller-${id.slice(2)}.json`, text, secret: hex(secret).slice(2) };
    },
    async confirmBackup() {
      const { saved } = await read(id);
      if (!session(id).secret || !saved.backup) throw new AnnonError('backup_secret_required');
      await sdk.hosted.confirmBackup(id);
      await emit(id);
    },
    async attachWallet(connection) {
      const { job } = await read(id);
      const resolved = options.wallet(connection);
      if (
        connection.kind !== job.terms.seller.kind ||
        identityJson(parseIdentity(resolved.wallet.identity)) !== identityJson(job.terms.seller)
      )
        throw new AnnonError('wrong_identity');
      session(id).connection = connection;
      await emit(id);
    },
    async attachFile(file) {
      await read(id);
      await sdk.hosted.verifySource(id, blobSource(file));
      session(id).file = file;
      await emit(id);
    },
    async unlock(value) {
      try {
        if (!/^[0-9a-f]{64}$/.test(value)) throw new Error();
        const { job, saved } = await read(id);
        if (!saved.backup) throw new Error();
        const secret = bytes(`0x${value}`, 32),
          backup = await importSell(saved.backup, secret);
        if (
          immutable(job) !== immutable(backup) ||
          (!job.published && keyMaterial(job) !== keyMaterial(backup)) ||
          (await sdk.hosted.load(id)).revision !== job.revision
        )
          throw new Error();
        session(id).secret = secret;
      } catch (cause) {
        throw new AnnonError('invalid_record', undefined, { cause });
      }
      await emit(id);
    },
    async next(run = {}) {
      if (run.signal?.aborted) throw new AnnonError('cancelled');
      const { job, saved } = await read(id),
        s = session(id);
      if (!s.secret || !saved.backup || !present(job.hosting).backupConfirmed)
        throw new AnnonError('backup_secret_required');
      if (present(job.hosting).result) return view(id);
      if (!s.connection) throw new AnnonError('signer_required');
      if (!s.file) throw new AnnonError('file_required');
      const { wallet, signUpload } = options.wallet(s.connection);
      if (identityJson(parseIdentity(wallet.identity)) !== identityJson(job.terms.seller))
        throw new AnnonError('wrong_identity');
      const progress = (phase: SellProgress['phase'], done: number) => {
        try {
          run.onProgress?.({ phase, done, total: present(s.file).size });
        } catch {
          /* Observers do not control the sale. */
        }
      };
      progress('encrypting', 0);
      await sdk.hosted.next(id, {
        expectedRevision: job.revision,
        ...(run.txHash ? { txHash: run.txHash } : {}),
        data: blobSource(s.file),
        seller: wallet,
        hosting: {
          origin: options.host,
          ...(signUpload ? { signUpload } : {}),
          spool: browserSellerSpool,
          body: async (source) => {
            progress('encrypting', present(s.file).size);
            progress('uploading', 0);
            return new Response(source.read()).blob();
          },
        },
      });
      progress('uploading', s.file.size);
      const shown = await emit(id);
      if (shown.result) delete s.approvedKeys;
      return shown;
    },
    async discard() {
      const saved = await index();
      if (!saved || saved.fileId !== id) throw new AnnonError('invalid_record');
      if (await options.rawStore.load(`annon/sell/${id}`)) {
        try {
          await read(id);
          await sdk.hosted.discard(id);
        } catch (error) {
          if (!(error instanceof AnnonError) || error.code !== 'invalid_record') throw error;
          // Keep unreadable evidence and its journal; only forget the browser index.
        }
      }
      if (!(await options.indexStore.compareAndSet(indexKey, saved, null)))
        throw new AnnonError('store_conflict');
      session(id).secret?.fill(0);
      sessions.delete(id);
    },
  });
  return {
    kind: 'sdk',
    live: true,
    async active() {
      const saved = await index();
      return saved ? handle(saved.fileId) : null;
    },
    async quote(connection, draft) {
      const { wallet, signUpload } = options.wallet(connection);
      if (connection.kind !== wallet.identity.kind) throw new AnnonError('wrong_identity');
      const input: ShareOptions = {
        data: blobSource(draft.file),
        name: draft.file.name,
        mime: draft.file.type || 'application/octet-stream',
        seller: wallet,
        price: String(decimal(draft.priceUsdc, 6)),
        title: draft.title,
        description: draft.description,
        hosting: { origin: options.host, ...(signUpload ? { signUpload } : {}) },
        ...(wallet.identity.kind === 'near'
          ? {
              listingStorage: decimal(draft.listingStorageNear ?? '0.01', 24),
              storageBudget: decimal(draft.storageBudgetNear ?? '0.05', 24),
            }
          : {}),
      };
      const q = await sdk.hosted.quote(input);
      // This record is private to the engine; display projection uses the checked quote fields.
      const shown = display({
        terms: q.terms,
        name: q.metadata.filename,
        storageBudget: q.storageBudget ?? undefined,
        hosting: {
          origin: options.host,
          metadata: q.metadata,
          fee: q.fee,
          steps: q.steps,
          listingStorage: q.listingStorage,
        },
      } as SellRecord);
      quotes.set(q.quoteId, { quote: structuredClone(q), draft: { ...draft }, connection, shown });
      return structuredClone({
        ...shown,
        quoteId: q.quoteId,
        description: q.metadata.description,
        byteSize: draft.file.size,
        ...(options.fileLifetimeDays === undefined ? {} : { hostedDays: options.fileLifetimeDays }),
      });
    },
    async begin(quoteId) {
      const quoted = quotes.get(quoteId);
      if (!quoted) throw new AnnonError('invalid_arguments');
      let existing = await index();
      if (existing && !(await options.rawStore.load(`annon/sell/${existing.fileId}`))) {
        if (!(await options.indexStore.compareAndSet(indexKey, existing, null)))
          throw new AnnonError('store_conflict');
        existing = null;
      }
      if (existing && !(await sdk.hosted.load(existing.fileId)).published)
        throw new AnnonError('sell_incomplete');
      const next: BrowserSaleIndex = {
        id: 'browser-sale',
        revision: (existing?.revision ?? -1) + 1,
        fileId: quoted.quote.fileId,
        backup: null,
      };
      const begun = await sdk.hosted.begin(quoteId);
      if (!(await options.indexStore.compareAndSet(indexKey, existing, next))) {
        await sdk.hosted.discard(next.fileId);
        throw new AnnonError('sell_incomplete');
      }
      sessions.set(next.fileId, {
        approved: immutable(begun),
        approvedKeys: keyMaterial(begun),
        file: quoted.draft.file,
        connection: quoted.connection,
      });
      quotes.delete(quoteId);
      return handle(next.fileId);
    },
  };
}
