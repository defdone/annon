/** Durable hosted selling. A pending operation is evidence, not permission to send again. */
import {
  metadataHash,
  normalizeMetadata,
  UploadClient,
  type UploadIntent,
  type UploadPublished,
  type UploadResult,
  uploadOrigin,
  uploadText,
  verifyUploadAuthorization,
} from '../download/upload.js';
import { sha256 } from '../envelope/pay2.js';
import { type PreparedSeal, prepareSeal, type SellData } from '../envelope/replay.js';
import { AnnonError } from '../errors.js';
import { keyFromSecret, oneTimeKey } from '../keys/near-ckd.js';
import { MAX_PLAINTEXT_BYTES } from '../limits.js';
import { readOutcome, txOutcome, view } from '../near/rpc.js';
import { encryptedSellStore, exportSell, type SellRecord } from '../pay/backup.js';
import { createSplit } from '../pay/split.js';
import type { Store } from '../pay/store.js';
import {
  applySponsoredFee,
  checkProtocolFee,
  type ProtocolFee,
  protocolFeeAboveMax,
} from '../relay/fees.js';
import { bytes, compare, hex } from '../settle-near/codec.js';
import {
  encodeIdentity,
  identityJson,
  identityKind,
  parseIdentity,
  verifyAuthorization,
} from '../settle-near/identity.js';
import { registerTextV2, type Terms, termsHash } from '../settle-near/terms.js';
import { TransactionUncertain } from '../wallet/uncertain.js';
import type { IdentityWallet, NearWallet } from '../wallet/wallet.js';
import type { AnnonOptions } from './annon-types.js';
import { assets, salt, shareSteps, validateHostedRecord } from './hosted-record.js';
import type {
  HostedCheckpoint,
  HostedSellRecord,
  ShareContext,
  ShareOptions,
  ShareQuote,
  ShareStep,
} from './sharing-types.js';

export { shareSteps, validateHostedRecord } from './hosted-record.js';
export type {
  HostedCheckpoint,
  HostedSellRecord,
  ShareContext,
  Shared,
  ShareHosting,
  ShareOptions,
  ShareQuote,
  ShareStep,
} from './sharing-types.js';

function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new AnnonError('invalid_record');
  return value;
}
export function shareSize(data: SellData): number {
  const size = data instanceof Uint8Array ? data.length : data.size;
  if (!Number.isSafeInteger(size) || size < 0) throw new AnnonError('invalid_arguments');
  if (size > MAX_PLAINTEXT_BYTES) throw new AnnonError('too_large');
  return size;
}
const nearValiditySeconds = 172800;
function result<T>(r: UploadResult<T>): T {
  if (!r.ok) throw r.error;
  return r.value;
}
function nearWallet(seller: IdentityWallet): NearWallet {
  if (seller.identity.kind !== 'near' || !('call' in seller))
    throw new AnnonError('near_wallet_required');
  return seller as NearWallet;
}
export class HostedSelling {
  private readonly store: Store<SellRecord>;
  private readonly quotes = new Map<string, { job: SellRecord; input: ShareOptions }>();
  constructor(
    private readonly o: AnnonOptions,
    private readonly context: ShareContext,
  ) {
    this.store = encryptedSellStore(o.rawStore, o.backupSecret);
  }
  private async direct(
    seller: IdentityWallet,
    method: string,
    args: object,
    deposit: bigint,
  ): Promise<unknown> {
    const value = await nearWallet(seller).call({
      receiverId: this.o.contractId,
      method,
      args,
      deposit,
    });
    if (!value || typeof value !== 'object' || !('transaction' in value)) return value;
    const tx = value.transaction as { hash: string; signer_id: string };
    try {
      const outcome = readOutcome(value, this.o.contractId, {
        txHash: tx.hash,
        signer: seller.identity.id,
        method,
        args,
      });
      if (outcome.state === 'released') return outcome.answer;
      if (outcome.state === 'done') return outcome.value;
    } catch {
      throw new TransactionUncertain(tx.hash);
    }
    throw new TransactionUncertain(tx.hash);
  }
  private async fundingBalance(job: SellRecord, step: ShareStep): Promise<bigint | null> {
    const value =
      step === 'deposit'
        ? await view(this.o.nearRpc, this.o.contractId, 'storage_balance_of', {
            account_id: job.terms.seller.id,
          })
        : (await this.context.file(job.terms.file_id))?.purchaseStorageBalance?.toString();
    if (value === null && step === 'deposit') return null;
    if (
      typeof value !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(value) ||
      BigInt(value) >= 2n ** 128n
    )
      throw new AnnonError('invalid_response');
    return BigInt(value);
  }
  private now() {
    return (this.o.now ?? (() => Math.floor(Date.now() / 1000)))();
  }
  private key(id: string) {
    bytes(id, 32);
    return `annon/sell/${id}`;
  }
  async load(id: string): Promise<HostedSellRecord> {
    try {
      const job = await this.store.load(this.key(id));
      if (
        !job?.hosting ||
        job.terms.network !== this.o.network ||
        job.terms.contract !== this.o.contractId
      )
        throw new Error();
      validateHostedRecord(job);
      if ((await metadataHash(job.hosting.metadata)) !== job.hosting.intent.metadataHash)
        throw new Error();
      return job as HostedSellRecord;
    } catch (cause) {
      throw new AnnonError('invalid_record', undefined, { cause });
    }
  }
  private async save(old: SellRecord | null, job: SellRecord): Promise<HostedSellRecord> {
    validateHostedRecord(job);
    if (!(await this.store.compareAndSet(this.key(job.terms.file_id), old, job)))
      throw new AnnonError('store_conflict');
    await this.o.writeBackup(job.id, await exportSell(job, this.o.backupSecret));
    return job as HostedSellRecord;
  }
  async quote(input: ShareOptions): Promise<ShareQuote> {
    if (!input.hosting?.origin) throw new AnnonError('transport_required');
    const origin = uploadOrigin(input.hosting.origin);
    const size = shareSize(input.data);
    const seller = parseIdentity(input.seller.identity);
    if (seller.kind === 'near' && (!input.listingStorage || !input.storageBudget))
      throw new AnnonError('storage_required');
    for (const v of [input.listingStorage, input.storageBudget])
      if (v !== undefined && (v <= 0n || v >= 2n ** 128n))
        throw new AnnonError('invalid_arguments');
    if (
      seller.kind !== 'near' &&
      (input.listingStorage !== undefined || input.storageBudget !== undefined)
    )
      throw new AnnonError('near_wallet_required');
    const metadata = normalizeMetadata({
      filename: input.name,
      title: input.title ?? input.name,
      description: input.description ?? '',
    });
    const c = await this.context.config();
    if (c.network !== this.o.network) throw new AnnonError('network_mismatch');
    const recipients = input.near?.recipients ?? [{ identity: seller, bps: 10000 }];
    const remainderId = input.near?.remainder ?? seller;
    let near: Terms['near'] = {
      token: c.nearUsdc,
      price: input.price,
      recipients: structuredClone(recipients),
      remainder: recipients.findIndex(
        (r) => identityJson(r.identity) === identityJson(remainderId),
      ),
    };
    let fee: ProtocolFee | null = null;
    if (seller.kind !== 'near' && this.o.sponsorship) {
      fee = (await this.o.sponsorship()).fee;
      if (protocolFeeAboveMax(input.price, fee, this.o.maxProtocolFee) && !input.onSplit)
        throw new AnnonError('protocol_fee_above_max');
      near = applySponsoredFee(near, fee, seller.kind === 'evm' ? input.price : undefined);
    }
    const remainder = near.recipients[near.remainder]?.identity;
    near.recipients.sort((a, b) => compare(encodeIdentity(a.identity), encodeIdentity(b.identity)));
    near.remainder = near.recipients.findIndex(
      (r) => identityJson(r.identity) === identityJson(present(remainder)),
    );
    const fileId = `0x${hex(crypto.getRandomValues(new Uint8Array(32))).slice(2)}`;
    const fileKey = crypto.getRandomValues(new Uint8Array(32));
    const prepared = await prepareSeal(fileKey, input.data, {
      fileId: bytes(fileId, 32),
      name: metadata.filename,
      mime: input.mime,
      authKind: identityKind(seller) as 0 | 1 | 2,
    });
    const terms: Terms = {
      network: c.network,
      contract: this.o.contractId,
      file_id: fileId,
      seller,
      pay2_version: 2,
      cipher_hash: hex(prepared.cipherHash),
      moderator: null,
      near,
      base: null,
    };
    let baseSplit: SellRecord['baseSplit'] = null;
    if (seller.kind === 'evm') {
      if (near.recipients.some((r) => r.identity.kind !== 'evm'))
        throw new AnnonError('bad_requirements');
      const split = createSplit(
        'push',
        {
          recipients: near.recipients.map((r) => r.identity.id),
          allocations: near.recipients.map((r) => BigInt(r.bps)),
          totalAllocation: 10000n,
          distributionIncentive: 0,
        },
        salt,
      );
      baseSplit = { address: split.address, kind: 'push', salt };
      terms.base = { usdc: c.usdc, price: input.price, pay_to: split.address };
    }
    const hash = termsHash(terms, { nearUsdc: c.nearUsdc, baseUsdc: c.usdc });
    if (fee) checkProtocolFee(terms, fee);
    const headerSize = prepared.headerSize(this.o.contractId);
    const intent: UploadIntent = {
      network: c.network,
      contract: this.o.contractId,
      seller,
      fileId,
      cipherHash: terms.cipher_hash,
      termsHash: hash,
      byteSize: headerSize + size + prepared.manifest.metaLen + 16 * prepared.manifest.n,
      plaintextSize: size,
      headerSize,
      hostOrigin: origin,
      metadataHash: await metadataHash(metadata),
      nonce: hex(crypto.getRandomValues(new Uint8Array(32))),
      expiresAt: this.now() + 600,
    };
    const job: HostedSellRecord = {
      kind: 'sell',
      id: `sell:${fileId}`,
      revision: 0,
      terms,
      baseSplit,
      fileKey: hex(fileKey),
      sellerSecret: hex(oneTimeKey().secret),
      deadline: this.now() + 540,
      name: metadata.filename,
      mime: input.mime,
      previewLen: 0,
      ckdSecret: null,
      ...(input.storageBudget ? { storageBudget: String(input.storageBudget) } : {}),
      hosting: {
        origin,
        metadata,
        fee,
        intent,
        manifest: prepared.manifest,
        authorization: null,
        uploadId: null,
        reservation: null,
        split: null,
        steps: shareSteps(seller),
        completed: [],
        pending: null,
        lease: null,
        backupConfirmed: false,
        listingStorage: input.listingStorage ? String(input.listingStorage) : null,
        header: null,
        result: null,
      },
    };
    const quoteId = crypto.randomUUID();
    this.quotes.set(quoteId, { job: structuredClone(job), input });
    return structuredClone({
      quoteId,
      fileId,
      terms,
      fee,
      steps: job.hosting.steps,
      metadata,
      listingStorage: job.hosting.listingStorage,
      storageBudget: job.storageBudget ?? null,
    });
  }
  async begin(quoteId: string): Promise<SellRecord> {
    const quote = this.quotes.get(quoteId);
    if (!quote) throw new AnnonError('invalid_arguments');
    const job = await this.save(null, structuredClone(quote.job));
    this.quotes.delete(quoteId);
    return job;
  }
  async confirmBackup(id: string): Promise<SellRecord> {
    const job = await this.load(id),
      h = job.hosting;
    if (h.backupConfirmed) return job;
    if (h.pending || h.lease)
      throw Object.assign(new AnnonError('lease_busy'), { retryAfterSeconds: 5 });
    return this.save(job, {
      ...job,
      revision: job.revision + 1,
      hosting: { ...h, backupConfirmed: true },
    });
  }
  async discard(id: string): Promise<void> {
    const job = await this.load(id);
    if (job.hosting.lease && job.hosting.lease.until > this.now())
      throw Object.assign(new AnnonError('lease_busy'), { retryAfterSeconds: 5 });
    if (!(await this.store.compareAndSet(this.key(id), job, null)))
      throw new AnnonError('store_conflict');
  }
  async backup(id: string) {
    return exportSell(await this.load(id), this.o.backupSecret);
  }
  private async prepared(
    job: SellRecord,
    input: Pick<ShareOptions, 'data'>,
  ): Promise<PreparedSeal<SellData>> {
    const size = shareSize(input.data);
    if (!job.fileKey) throw new AnnonError('invalid_record');
    if (size !== job.hosting?.intent.plaintextSize) throw new AnnonError('source_changed');
    const s = await prepareSeal(bytes(job.fileKey, 32), input.data, {
      fileId: bytes(job.terms.file_id, 32),
      name: job.name,
      mime: job.mime,
      authKind: identityKind(job.terms.seller) as 0 | 1 | 2,
    });
    if (hex(s.cipherHash) !== job.terms.cipher_hash) throw new AnnonError('source_changed');
    return s;
  }
  async verifySource(id: string, data: SellData): Promise<void> {
    await this.prepared(await this.load(id), { data });
  }
  async next(
    id: string,
    input: Pick<ShareOptions, 'data' | 'seller' | 'hosting'> & {
      expectedRevision?: number;
      txHash?: string;
    },
  ): Promise<HostedSellRecord> {
    await this.advance(id, input);
    return this.load(id);
  }
  private async advance(
    id: string,
    input: Pick<ShareOptions, 'data' | 'seller' | 'hosting'> & {
      expectedRevision?: number;
      txHash?: string;
    },
  ): Promise<SellRecord> {
    let job = await this.load(id);
    if (input.expectedRevision !== undefined && input.expectedRevision !== job.revision)
      throw new AnnonError('store_conflict');
    if (identityJson(parseIdentity(input.seller.identity)) !== identityJson(job.terms.seller))
      throw new AnnonError('wrong_identity');
    if (uploadOrigin(input.hosting.origin) !== job.hosting.origin)
      throw new AnnonError('config_conflict');
    if (job.published) return job;
    if (!job.hosting.backupConfirmed) throw new AnnonError('backup_secret_required');
    if (job.hosting.lease && job.hosting.lease.until > this.now())
      throw Object.assign(new AnnonError('lease_busy'), { retryAfterSeconds: 5 });
    const owner = crypto.randomUUID();
    job = await this.save(job, {
      ...job,
      revision: job.revision + 1,
      hosting: { ...job.hosting, lease: { owner, until: this.now() + 120 } },
    });
    const fence = async () => {
      const current = await this.load(id);
      if (
        renewalFailed ||
        current.revision !== job.revision ||
        current.hosting.lease?.owner !== owner ||
        current.hosting.lease.until <= this.now()
      )
        throw Object.assign(new AnnonError('lease_busy'), { retryAfterSeconds: 5 });
      if (identityJson(parseIdentity(input.seller.identity)) !== identityJson(job.terms.seller))
        throw new AnnonError('wrong_identity');
    };
    let awaitingSignature = false;
    let awaitingTransaction = false;
    let freshAttempt = false;
    let journal: SellRecord | null = null;
    let journalKey = '';
    let updates = Promise.resolve();
    let renewalFailed = false;
    const writeUpdate = async (change: Partial<SellRecord>, h: Partial<HostedCheckpoint> = {}) => {
      await fence();
      job = await this.save(job, {
        ...job,
        ...change,
        revision: job.revision + 1,
        hosting: {
          ...job.hosting,
          ...h,
          lease: h.lease === null ? null : { owner, until: this.now() + 120 },
        },
      });
      if (journal && h.lease !== null) {
        await fence();
        const next = {
          ...job,
          revision: journal.revision + 1,
          hosting: { ...job.hosting, lease: null },
        };
        if (!(await this.store.compareAndSet(journalKey, journal, next)))
          throw new AnnonError('store_conflict');
        journal = next;
      }
    };
    const update = (
      change: Partial<SellRecord>,
      h: Partial<HostedCheckpoint> = {},
    ): Promise<void> => {
      const next = updates.then(() => writeUpdate(change, h));
      updates = next.catch(() => {});
      return next;
    };
    const heartbeat = setInterval(() => {
      void update({}, { lease: { owner, until: this.now() + 120 } }).catch(() => {
        renewalFailed = true;
      });
    }, 30000);
    const effect = async <T>(run: () => Promise<T>): Promise<T> => {
      await updates;
      await fence();
      const value = await run();
      await updates;
      await fence();
      return value;
    };
    const client = new UploadClient(
      job.hosting.origin,
      this.o.fetch ? { fetch: this.o.fetch } : {},
    );
    const authorize = async () => {
      const intent = { ...job.hosting.intent, expiresAt: this.now() + 600 };
      awaitingSignature = true;
      const auth = await effect(async () => {
        if (job.terms.seller.kind === 'near') {
          if (!input.hosting.signUpload) throw new AnnonError('missing_method');
          return input.hosting.signUpload(structuredClone(intent));
        }
        const value = await input.seller.authorize(uploadText(intent));
        if (!value || !verifyAuthorization(job.terms.seller, uploadText(intent), value))
          throw new AnnonError('invalid_signature');
        return value;
      });
      awaitingSignature = false;
      await effect(() =>
        verifyUploadAuthorization(
          { intent, auth },
          {
            network: this.o.network,
            contract: this.o.contractId,
            hostOrigin: job.hosting.origin,
            now: this.now(),
            nearRpc: this.o.nearRpc,
          },
        ),
      );
      await update({}, { intent, authorization: { intent, auth } });
    };
    const body = async (prepared: PreparedSeal<SellData>, uploadId: string) => {
      if (!input.hosting.spool)
        throw new AnnonError('transport_required', 'A ciphertext spool is required.');
      await prepared.stage(input.hosting.spool, async (source) => {
        const wire = input.hosting.body ? await input.hosting.body(source) : source.read();
        const reserved = result(
          await effect(() => client.body(uploadId, present(job.hosting.authorization), wire)),
        );
        await update({}, { reservation: reserved.reservation });
      });
    };
    const create = async () => {
      const h = job.hosting;
      const created = result(
        await effect(() =>
          client.create({
            ...present(h.authorization),
            terms: job.terms,
            manifest: h.manifest,
            metadata: h.metadata,
          }),
        ),
      );
      if (h.uploadId && h.uploadId !== created.uploadId) throw new AnnonError('upload_conflict');
      await update(
        {},
        {
          uploadId: created.uploadId,
          ...(created.state === 'reserved' ? { reservation: created.reservation } : {}),
        },
      );
      return created;
    };
    const refresh = async () => {
      if (job.hosting.authorization && job.hosting.intent.expiresAt <= this.now()) {
        await authorize();
        return create();
      }
      return null;
    };
    const complete = async () =>
      update(
        {},
        { completed: [...job.hosting.completed, present(job.hosting.pending).step], pending: null },
      );
    const resetPending = async () => {
      await fence();
      if (journal && !(await this.store.compareAndSet(journalKey, journal, null)))
        throw new AnnonError('store_conflict');
      journal = null;
      await update({}, { pending: null });
    };
    const direct = async (method: string, args: object, deposit: bigint) => {
      awaitingTransaction = true;
      const value = await this.direct(input.seller, method, args, deposit);
      awaitingTransaction = false;
      return value;
    };
    const uncertain = (retryAfterSeconds = 30) =>
      Object.assign(new AnnonError('transaction_uncertain'), { retryAfterSeconds });
    const checkedOutcome = async (
      operation: { method: string; args: object; deposit: string },
      txHash: string,
    ) => {
      const pending = present(job.hosting.pending);
      const candidate = !pending.txHash;
      // Funding already persists its attempt time through the wallet validity bound.
      const notBefore =
        pending.validUntil === undefined
          ? pending.startedAt
          : pending.validUntil - nearValiditySeconds;
      if (candidate && notBefore === undefined) throw uncertain();
      return effect(async () => {
        try {
          return await txOutcome(
            this.o.nearRpc,
            txHash,
            job.terms.seller.id,
            this.o.contractId,
            'FINAL',
            {
              ...operation,
              ...(candidate ? { notBefore: present(notBefore) } : {}),
            },
          );
        } catch (error) {
          // Invalid candidate evidence says nothing about the outstanding wallet call.
          if (candidate) throw uncertain();
          throw error;
        }
      });
    };
    try {
      let h = job.hosting;
      const step = h.steps[h.completed.length];
      if (!step) throw new AnnonError('invalid_record');
      journalKey = `annon/share-operation/${id}/${step}`;
      journal = await this.store.load(journalKey);
      await fence();
      if (journal && !h.pending) {
        if (termsHash(journal.terms, assets(journal.terms)) !== h.intent.termsHash)
          throw new AnnonError('invalid_record');
        // Restore the durable operation instead of trusting a rolled-back progress list.
        await update(
          { ...journal, revision: job.revision },
          { ...present(journal.hosting), lease: h.lease },
        );
        if (job.hosting.completed.includes(step) || job.published) return job;
        h = job.hosting;
      }
      if (
        input.txHash !== undefined &&
        (typeof input.txHash !== 'string' ||
          !input.txHash ||
          job.terms.seller.kind !== 'near' ||
          !h.pending?.operation ||
          !['deposit', 'fund', 'publish'].includes(step))
      )
        throw new AnnonError('invalid_arguments');
      // Unsaved signatures cannot have reached the host or the chain.
      if (
        h.pending &&
        ((step === 'stage' && !h.authorization) ||
          (step === 'publish' && !h.header) ||
          (step === 'register' && job.terms.seller.kind !== 'near' && !h.pending.auth))
      ) {
        await resetPending();
        h = job.hosting;
      }
      // Reconcile saved evidence. A relayer replay uses exactly the original envelope.
      if (h.pending) {
        if (step === 'register') {
          const f = await effect(() => this.context.file(id));
          if (f) {
            if (f.termsHash !== h.intent.termsHash) throw new AnnonError('file_mismatch');
            await complete();
          } else {
            const pending = h.pending;
            const args = pending.operation?.args as { args?: { deadline?: number } } | undefined;
            const deadline = args?.args?.deadline;
            if (typeof deadline === 'number' && this.now() > deadline + 60) {
              await resetPending();
            } else if (pending.operation?.method === 'register' && pending.auth) {
              const value = await effect(() =>
                this.context.call(
                  'register',
                  {
                    ...present(pending.operation).args,
                    auth: pending.auth,
                    hostingReservation: h.reservation,
                    ...(job.baseSplit ? { baseSplit: { kind: 'push', salt } } : {}),
                  },
                  input.seller,
                ),
              );
              const ckd = await effect(() =>
                this.context.answer(
                  value,
                  keyFromSecret(bytes(present(job.sellerSecret), 32)).secret,
                  id,
                ),
              );
              await update({ ckdSecret: hex(ckd) });
              await complete();
            } else throw new AnnonError('transaction_uncertain');
          }
        } else if (['deposit', 'fund'].includes(step)) {
          const pending = h.pending;
          if (!pending.operation) {
            await resetPending();
          } else if (pending.txHash || input.txHash) {
            const outcome = await checkedOutcome(
              pending.operation,
              present(pending.txHash ?? input.txHash),
            );
            if (outcome.state === 'refused') await resetPending();
            else {
              if (outcome.state !== 'done') throw uncertain();
              await complete();
            }
          } else {
            const balance = await effect(() => this.fundingBalance(job, step));
            if (
              step === 'deposit' && pending.storageAccountExisted === false
                ? (balance ?? 0n) > 0n
                : (balance ?? 0n) >=
                  BigInt(present(pending.snapshot)) + BigInt(pending.operation.deposit)
            )
              await complete();
            else if (this.now() > present(pending.validUntil)) await resetPending();
            else throw uncertain(Math.max(1, present(pending.validUntil) - this.now()));
          }
        } else if (h.authorization && ['stage', 'split', 'publish'].includes(step)) {
          await refresh();
          if (!job.hosting.uploadId) await create();
          h = job.hosting;
          const status = result(
            await effect(() => client.status(present(h.uploadId), present(h.authorization))),
          );
          if (step === 'stage' && status.state !== 'published') {
            if (status.state === 'receiving')
              await body(await this.prepared(job, input), present(h.uploadId));
            else await update({}, { reservation: status.reservation });
            await complete();
          } else if (step === 'split') {
            const split =
              status.baseSplit?.state === 'ready'
                ? status.baseSplit
                : result(
                    await effect(() =>
                      client.baseSplit(present(h.uploadId), present(h.authorization), {
                        kind: 'push',
                        salt,
                      }),
                    ),
                  ).baseSplit;
            this.checkSplit(job, split);
            await update({}, { split });
            if (split?.state !== 'ready') throw new AnnonError('settlement_pending');
            await complete();
          } else if (step === 'publish' && status.state === 'published')
            await this.finishPublication(status.result, job, update);
          else if (step === 'publish' && h.header) {
            if (job.terms.seller.kind === 'near') {
              const f = await effect(() => this.context.file(id));
              const header = bytes(h.header, (h.header.length - 2) / 2);
              if (f?.headerHash !== hex(await sha256(header.subarray(0, header.length - 65)))) {
                const pending = present(h.pending);
                const txHash = pending.txHash ?? input.txHash;
                if (txHash) {
                  const operation = present(pending.operation);
                  const outcome = await checkedOutcome(operation, txHash);
                  if (outcome.state === 'refused') {
                    await resetPending();
                    return job;
                  }
                  if (outcome.state !== 'done') throw uncertain();
                } else {
                  await resetPending();
                  return job;
                }
              }
            }
            const published = result(
              await effect(() =>
                client.header(
                  present(h.uploadId),
                  present(h.authorization),
                  new Uint8Array(bytes(present(h.header), (present(h.header).length - 2) / 2)),
                ),
              ),
            );
            await this.finishPublication(published, job, update);
          } else throw new AnnonError('transaction_uncertain');
        } else throw new AnnonError('transaction_uncertain');
        return job;
      }
      freshAttempt = true;
      const prepared = await this.prepared(job, input);
      await fence();
      await update({}, { pending: { step, token: crypto.randomUUID(), startedAt: this.now() } });
      if (!journal) {
        const claim = { ...job, revision: 0, hosting: { ...job.hosting, lease: null } };
        await fence();
        if (!(await this.store.compareAndSet(journalKey, null, claim)))
          throw new AnnonError('store_conflict');
        journal = claim;
      }
      if (step !== 'stage') await refresh();
      h = job.hosting;
      if (step === 'stage') {
        await authorize();
        const created = await create();
        if (created.state === 'published') {
          await this.finishPublication(created.result, job, update);
          return job;
        }
        if (created.state === 'receiving') await body(prepared, created.uploadId);
      } else if (step === 'split') {
        if (job.terms.seller.kind !== 'evm' || !job.terms.base)
          throw new AnnonError('route_unavailable');
        await this.live(job, client, effect);
        const split = result(
          await effect(() =>
            client.baseSplit(present(h.uploadId), present(h.authorization), { kind: 'push', salt }),
          ),
        ).baseSplit;
        this.checkSplit(job, split);
        await update({}, { split });
        if (split?.state !== 'ready') throw new AnnonError('settlement_pending');
      } else if (step === 'deposit' || step === 'fund') {
        await this.live(job, client, effect);
        const seller = nearWallet(input.seller);
        const operation = {
          method: step === 'deposit' ? 'storage_deposit' : 'fund_file_storage',
          args: step === 'deposit' ? { account_id: seller.identity.id } : { file_id: id },
          deposit: step === 'deposit' ? present(h.listingStorage) : present(job.storageBudget),
        };
        const snapshot = await effect(() => this.fundingBalance(job, step));
        await update(
          {},
          {
            pending: {
              ...present(job.hosting.pending),
              operation,
              snapshot: (snapshot ?? 0n).toString(),
              ...(step === 'deposit' ? { storageAccountExisted: snapshot !== null } : {}),
              validUntil: this.now() + nearValiditySeconds,
            },
          },
        );
        await effect(() => direct(operation.method, operation.args, BigInt(operation.deposit)));
      } else if (step === 'register') {
        const existing = await effect(() => this.context.file(id));
        if (existing) {
          if (existing.termsHash !== h.intent.termsHash) throw new AnnonError('file_mismatch');
        } else {
          await this.live(job, client, effect);
          const key = keyFromSecret(bytes(present(job.sellerSecret), 32));
          const args = {
            terms: job.terms,
            seller_key: hex(key.publicKeyBytes),
            deadline: this.now() + 540,
          };
          await update(
            {},
            {
              pending: {
                ...present(job.hosting.pending),
                operation: { method: 'register', args: { args }, deposit: '0' },
              },
            },
          );
          const value = await effect(async () => {
            if (job.terms.seller.kind === 'near') return direct('register', { args }, 0n);
            awaitingSignature = true;
            const auth = await input.seller.authorize(
              registerTextV2(job.terms, args.seller_key, args.deadline, assets(job.terms)),
            );
            awaitingSignature = false;
            if (
              !auth ||
              !verifyAuthorization(
                job.terms.seller,
                registerTextV2(job.terms, args.seller_key, args.deadline, assets(job.terms)),
                auth,
              )
            )
              throw new AnnonError('invalid_signature');
            await update({}, { pending: { ...present(job.hosting.pending), auth } });
            await fence();
            return this.context.call(
              'register',
              {
                args,
                auth,
                hostingReservation: job.hosting.reservation,
                ...(job.baseSplit ? { baseSplit: { kind: 'push', salt } } : {}),
              },
              input.seller,
            );
          });
          const ckd = await effect(() => this.context.answer(value, key.secret, id));
          await update({ ckdSecret: hex(ckd) });
        }
      } else if (step === 'publish') {
        if (!job.ckdSecret) {
          const ckd = await effect(() => this.context.reopen(id, input.seller));
          await update({ ckdSecret: hex(ckd) });
        }
        const finished = await effect(() =>
          prepared.finish({
            contractId: this.o.contractId,
            seller: job.terms.seller,
            ckdSecret: bytes(present(job.ckdSecret), 48),
            ...(job.terms.seller.kind === 'near'
              ? {}
              : {
                  sign: async (text: string) => {
                    awaitingSignature = true;
                    const auth = await effect(() => input.seller.authorize(text));
                    awaitingSignature = false;
                    if (!auth || !verifyAuthorization(job.terms.seller, text, auth))
                      throw new AnnonError('invalid_signature');
                    const signature = bytes(auth.sig, job.terms.seller.kind === 'evm' ? 65 : 64);
                    return job.terms.seller.kind === 'solana'
                      ? { signature, signedMessage: new TextEncoder().encode(text) }
                      : signature;
                  },
                }),
          }),
        );
        try {
          // Exhaust the checked replay even though only the header is sent in this step.
          if (finished.file instanceof ReadableStream) {
            const reader = finished.file.getReader();
            try {
              while (!(await reader.read()).done) {}
            } finally {
              reader.releaseLock();
            }
          }
          if (!finished.consumed()) throw new AnnonError('upload_incomplete');
          await update({}, { header: hex(finished.header) });
          if (job.terms.seller.kind === 'near') {
            const operation = {
              method: 'publish_header',
              args: {
                file_id: id,
                header_hash: hex(
                  await sha256(finished.header.subarray(0, finished.header.length - 65)),
                ),
              },
              deposit: '0',
            };
            await update({}, { pending: { ...present(job.hosting.pending), operation } });
            await effect(() => direct(operation.method, operation.args, 0n));
          }
          const published = result(
            await effect(() =>
              client.header(
                present(h.uploadId),
                present(h.authorization),
                new Uint8Array(finished.header),
              ),
            ),
          );
          await this.finishPublication(published, job, update);
          return job;
        } catch (e) {
          await finished.cancel(e).catch(() => {});
          throw e;
        }
      }
      await complete();
      return job;
    } catch (error) {
      const refusedRegistration =
        freshAttempt &&
        job.hosting.pending?.step === 'register' &&
        error instanceof AnnonError &&
        [
          'budget',
          'limited',
          'rate_limited',
          'not_sponsored',
          'bad_request',
          'bad_signature',
          'bad_deadline',
          'upload_expired',
        ].includes(error.code) &&
        !('txHash' in error);
      if (
        refusedRegistration ||
        (freshAttempt &&
          (awaitingSignature || awaitingTransaction) &&
          error instanceof AnnonError &&
          error.code === 'rejected' &&
          !('txHash' in error))
      ) {
        await resetPending();
      }
      if (error instanceof AnnonError && 'txHash' in error && typeof error.txHash === 'string') {
        try {
          await update({}, { pending: { ...present(job.hosting.pending), txHash: error.txHash } });
        } catch {
          /* A new owner retains the original operation. */
        }
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      await updates;
      // A former owner never adopts the revision or lease of its successor.
      try {
        await fence();
        await update({}, { lease: null });
      } catch {
        /* The durable pending operation remains available to its new owner. */
      }
    }
  }
  private checkSplit(
    job: SellRecord,
    value: { address: string; kind: string; salt: string } | null,
  ) {
    if (
      !value ||
      job.terms.seller.kind !== 'evm' ||
      value.address.toLowerCase() !== job.terms.base?.pay_to ||
      value.kind !== 'push' ||
      value.salt !== salt
    )
      throw new AnnonError('bad_response');
  }
  private async live(
    job: SellRecord,
    client: UploadClient,
    effect: <T>(run: () => Promise<T>) => Promise<T>,
  ) {
    const h = job.hosting;
    if (!h) throw new AnnonError('invalid_record');
    if (!h.uploadId || !h.authorization) throw new AnnonError('upload_incomplete');
    const status = result(
      await effect(() => client.status(present(h.uploadId), present(h.authorization))),
    );
    if (
      status.state !== 'reserved' ||
      status.reservation.expiresAt <= this.now() ||
      status.reservation.termsHash !== h.intent.termsHash
    )
      throw new AnnonError('upload_expired');
  }
  private async finishPublication(
    published: UploadPublished,
    job: SellRecord,
    update: (c: Partial<SellRecord>, h: Partial<HostedCheckpoint>) => Promise<void>,
  ) {
    const expiry = published.expiresAt;
    if (expiry !== null) {
      if (!Number.isSafeInteger(expiry) || expiry <= 0) throw new AnnonError('bad_response');
      const now = this.now();
      if (expiry <= now) throw new AnnonError('file_expired');
    }
    await update(
      { published: true, fileKey: null, sellerSecret: null, ckdSecret: null },
      {
        result: { ...published, expiresAt: published.expiresAt },
        completed: [...(job.hosting?.steps ?? [])],
        pending: null,
      },
    );
  }
}
