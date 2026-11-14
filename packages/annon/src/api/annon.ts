import { AnnonError, toPublicError } from '../errors.js';
import type { BuyRoute } from '../routes.js';
import { HostedSelling, type ShareHosting, type ShareOptions, shareSize } from './sharing.js';
/** Sell, buy, open, recover and stop, using the single purchase/grant settlement model. */

import { DownloadError } from '../download/download.js';
import {
  concat,
  type FileMeta,
  inspectHeader,
  type Listing,
  open as openPay2,
  sha256,
} from '../envelope/pay2.js';
import {
  type PreparedSeal,
  prepareOpen,
  prepareSeal,
  type ReplayableSource,
  type SellData,
  type Spool,
  withReplay,
} from '../envelope/replay.js';
import { SourceChangedError } from '../envelope/stream.js';
import { fileAppId, keyFromSecret, oneTimeKey, openAnswer } from '../keys/near-ckd.js';
import { MAX_PAY2_BYTES, MAX_PLAINTEXT_BYTES } from '../limits.js';
import {
  type FileInfo,
  fileStorageBalance,
  getConfig,
  getFile,
  getGrant,
  getPurchase,
  isStorageRequired,
  purchasesOf,
  readOutcome,
  view,
} from '../near/rpc.js';
import {
  fileFundingText,
  registerText,
  reopenSellerText,
  reopenText,
  stopSalesText,
} from '../near/texts.js';
import { OneClick, OneClickQuoteExpired, validateOrigin } from '../oneclick/oneclick.js';
import {
  encryptedPurchaseStore,
  encryptedRecoveryStore,
  encryptedSellerKeyStore,
  encryptedSellStore,
  exportPurchase,
  exportRecovery,
  exportSell,
  exportSellerKey,
  type RecoveryRecord,
  type SellerKeyRecord,
  type SellRecord,
  validatePurchaseRecord,
} from '../pay/backup.js';
import { balanceOf, hasCode, head, PayError } from '../pay/base.js';
import { authorize, preflight } from '../pay/pay.js';
import { type PurchaseRecord, purchaseKey, randomHex } from '../pay/purchase.js';
import { nextStep } from '../pay/recover.js';
import { createSplit } from '../pay/split.js';
import type { Store, Versioned } from '../pay/store.js';
import {
  checkBaseSplit,
  checkBaseSponsorship,
  validBaseSponsorship,
} from '../relay/capabilities.js';
import {
  applySponsoredFee,
  checkProtocolFee,
  type ProtocolFee,
  protocolFeeAboveMax,
} from '../relay/fees.js';
import { account, bytes, compare, hex, network, usdc } from '../settle-near/codec.js';
import {
  type Authorization,
  encodeIdentity,
  type Identity,
  identityJson,
  identityKind,
  identityText,
  parseIdentity,
  verifyAuthorization,
} from '../settle-near/identity.js';
import {
  buildPurchaseMessage,
  type Purchase,
  parsePurchaseMessage,
  purchaseId,
} from '../settle-near/purchase.js';
import { type Terms, termsHash } from '../settle-near/terms.js';
import { TransactionUncertain } from '../wallet/uncertain.js';
import type { EvmWallet, IdentityWallet, NearWallet } from '../wallet/wallet.js';
import { FileFundingRefused, fundFileStorage } from '../wallet/wallet.js';

import type { AnnonOptions, Bought, BuyOptions, SellOptions } from './annon-types.js';

export type { BuyRoute } from '../routes.js';
export type { AnnonOptions, Bought, BuyOptions, SellOptions } from './annon-types.js';

const asNear = (w: IdentityWallet): NearWallet => {
  if (w.identity.kind !== 'near' || !('call' in w) || typeof w.call !== 'function')
    throw new AnnonError('near_wallet_required', 'a NEAR transaction wallet is required');
  return w as NearWallet;
};
const assetsFor = (terms: Terms) => ({
  nearUsdc: terms.near.token,
  ...(terms.base ? { baseUsdc: terms.base.usdc } : {}),
});
const listing = (fileId: string, f: FileInfo): Listing => ({
  fileId,
  cipherHash: f.cipherHash,
  seller: f.seller,
  ...(f.headerHash ? { publishedHeaderHash: f.headerHash } : {}),
});
export class SellError extends AnnonError {
  readonly txHash?: string;
  readonly retryAfterSeconds?: number;
  constructor(
    readonly fileId: string,
    options?: ErrorOptions,
  ) {
    const cause = options?.cause;
    const code =
      cause instanceof AnnonError || cause instanceof SourceChangedError
        ? cause.code
        : 'sell_incomplete';
    super(
      code,
      cause instanceof Error ? cause.message : 'Sell incomplete; resume with fileId.',
      options,
    );
    this.name = 'SellError';
    const safe = toPublicError(cause);
    if (safe.retryAfterSeconds !== undefined) this.retryAfterSeconds = safe.retryAfterSeconds;
    if (cause instanceof AnnonError && 'txHash' in cause && typeof cause.txHash === 'string')
      this.txHash = cause.txHash;
  }
}
export class Annon {
  readonly store: Store<PurchaseRecord>;
  readonly hosted: HostedSelling;
  private readonly sellerKeys: Store<SellerKeyRecord>;
  private readonly sells: Store<SellRecord>;
  private readonly recoveries: Store<RecoveryRecord>;
  private readonly selfUnlockWallets = new Map<string, NearWallet>();
  private readonly unlocked = new Map<string, unknown>();
  constructor(private readonly o: AnnonOptions) {
    account(o.contractId);
    network(o.network);
    this.hosted = new HostedSelling(o, {
      config: () => getConfig(o.nearRpc, o.contractId),
      file: (id) => getFile(o.nearRpc, o.contractId, id),
      call: (method, args, seller) => this.call(method, args, seller),
      answer: (value, secret, id) => this.answer(value, secret, id),
      reopen: (id, seller) => this.reopenSeller({ fileId: id, seller }),
    });
    this.store = this.withBackup(encryptedPurchaseStore(o.rawStore, o.backupSecret), (r) =>
      exportPurchase(r, o.backupSecret),
    );
    this.sellerKeys = this.withBackup(encryptedSellerKeyStore(o.rawStore, o.backupSecret), (r) =>
      exportSellerKey(r, o.backupSecret),
    );
    this.sells = this.withBackup(encryptedSellStore(o.rawStore, o.backupSecret), (r) =>
      exportSell(r, o.backupSecret),
    );
    this.recoveries = this.withBackup(encryptedRecoveryStore(o.rawStore, o.backupSecret), (r) =>
      exportRecovery(r, o.backupSecret),
    );
  }
  private withBackup<T extends Versioned>(
    store: Store<T>,
    encode: (r: T) => Promise<string>,
  ): Store<T> {
    return {
      load: (key) => store.load(key),
      compareAndSet: async (key, expected, next) => {
        const ok = await store.compareAndSet(key, expected, next);
        if (ok && next) await this.o.writeBackup(next.id, await encode(next));
        return ok;
      },
    };
  }
  private now() {
    return (this.o.now ?? (() => Math.floor(Date.now() / 1000)))();
  }
  private async auth(wallet: IdentityWallet, text: string): Promise<Authorization | undefined> {
    const id = parseIdentity(wallet.identity);
    const auth = await wallet.authorize(text);
    if (!verifyAuthorization(id, text, auth, id.kind === 'near' ? id.id : undefined))
      throw new AnnonError('invalid_signature', 'wallet did not authorize the exact text');
    return auth;
  }
  private async call(method: string, args: object, wallet?: IdentityWallet): Promise<unknown> {
    const near = wallet?.identity.kind === 'near' ? asNear(wallet) : undefined;
    const result = this.o.send
      ? await this.o.send(method, args, near)
      : near
        ? await near.call({ receiverId: this.o.contractId, method, args })
        : (() => {
            throw new AnnonError(
              'transport_required',
              'configure a transaction transport for relayed calls',
            );
          })();
    if (result && typeof result === 'object' && 'transaction' in result) {
      const transaction = (result as { transaction: { hash: string; signer_id: string } })
        .transaction;
      const outcome = readOutcome(result, this.o.contractId, {
        txHash: transaction.hash,
        signer: transaction.signer_id,
        method,
        args:
          method === 'fund_file_storage'
            ? {
                file_id: (args as { args: { file_id: string } }).args.file_id,
                amount: (args as { args: { amount: string } }).args.amount,
              }
            : method === 'register'
              ? // Relayer-only fields never reach the contract call.
                Object.fromEntries(
                  Object.entries(args).filter(
                    ([key]) => key !== 'baseSplit' && key !== 'hostingReservation',
                  ),
                )
              : args,
      });
      if (outcome.state === 'released') return outcome.answer;
      if (outcome.state === 'done') return outcome.value;
      if (isStorageRequired('reason' in outcome ? outcome.reason : ''))
        throw new PayError('storage_required');
      throw new AnnonError(outcome.state === 'pending' ? 'settlement_pending' : 'refused');
    }
    return result;
  }
  /** Allocate file storage directly with NEAR, or request a seller-signed sponsored top-up. */
  async fund(
    fileId: string,
    amount: bigint,
    seller: IdentityWallet,
    options: { nonce?: string; deadline?: number } = {},
  ): Promise<unknown> {
    bytes(fileId, 32);
    if (amount <= 0n || amount >= 2n ** 128n) throw new PayError('bad_requirements');
    const file = await getFile(this.o.nearRpc, this.o.contractId, fileId);
    if (!file) throw new PayError('unknown_file');
    if (file.terms.network !== this.o.network || file.terms.contract !== this.o.contractId)
      throw new PayError('network_mismatch');
    if (identityJson(parseIdentity(seller.identity)) !== identityJson(file.seller))
      throw new PayError('wrong_identity');
    if (file.takenDown !== null) throw new PayError('taken_down');
    if (file.salesStoppedAt !== null) throw new PayError('sales_stopped');
    if (seller.identity.kind === 'near')
      return fundFileStorage(asNear(seller), this.o.contractId, fileId, amount);
    const deadline = options.deadline ?? this.now() + 600;
    if (!Number.isSafeInteger(deadline) || deadline <= this.now() || deadline > this.now() + 600)
      throw new PayError('bad_requirements');
    const args = {
      file_id: fileId,
      amount: String(amount),
      nonce: options.nonce ?? `0x${randomHex(32)}`,
      deadline,
    };
    const text = fileFundingText({
      ...args,
      network: this.o.network,
      contract: this.o.contractId,
      seller: file.seller,
    });
    const auth = await this.auth(seller, text);
    return this.call('fund_file_storage', { args, auth }, seller);
  }
  private async answer(value: unknown, secret: Uint8Array, fileId: string): Promise<Uint8Array> {
    const answer = value && typeof value === 'object' && 'answer' in value ? value.answer : value;
    const config = await getConfig(this.o.nearRpc, this.o.contractId);
    const mpcKey = await view(this.o.nearRpc, config.mpc, 'public_key', {
      domain_id: config.ckdDomain,
    });
    if (typeof mpcKey !== 'string' || !mpcKey.startsWith('bls12381g2:'))
      throw new AnnonError('ckd_invalid', 'MPC domain has no CKD key');
    if (this.o.mpcKey && this.o.mpcKey !== mpcKey)
      throw new AnnonError(
        'ckd_invalid',
        'configured MPC key differs from the contract MPC domain',
      );
    return openAnswer(answer, {
      secret,
      appId: fileAppId(this.o.contractId, bytes(fileId, 32)),
      mpcKey,
    });
  }
  private async file(fileId: string, forSale = false): Promise<FileInfo> {
    const f = await getFile(this.o.nearRpc, this.o.contractId, fileId);
    if (!f) throw new PayError('unknown_file');
    if (f.takenDown) throw new PayError('taken_down');
    if (forSale && f.salesStoppedAt !== null) throw new PayError('sales_stopped');
    const config = await getConfig(this.o.nearRpc, this.o.contractId);
    if (
      f.terms.network !== this.o.network ||
      config.network !== this.o.network ||
      f.terms.near.token !== config.nearUsdc ||
      (f.terms.base && f.terms.base.usdc !== config.usdc)
    )
      throw new PayError('network_mismatch');
    return f;
  }
  /** Hosted sale with a pending backup saved before the first approval. */
  private async startShare(options: ShareOptions): Promise<SellRecord> {
    const quote = await this.hosted.quote(options);
    await options.onSplit?.(
      structuredClone(quote.terms.near),
      quote.fee ?? undefined,
      quote.fee ? protocolFeeAboveMax(options.price, quote.fee, this.o.maxProtocolFee) : false,
    );
    try {
      const job = await this.hosted.begin(quote.quoteId);
      if (!options.confirmBackup) throw new AnnonError('backup_secret_required');
      await options.confirmBackup({
        fileId: quote.fileId,
        text: await this.hosted.backup(quote.fileId),
      });
      await this.hosted.confirmBackup(job.terms.file_id);
      return job;
    } catch (cause) {
      if (cause instanceof SellError) throw cause;
      throw new SellError(quote.fileId, { cause });
    }
  }

  async share(options: ShareOptions) {
    const job = await this.startShare(options);
    return this.resumeShare({ ...options, fileId: job.terms.file_id });
  }
  async resumeShare(
    options: Pick<ShareOptions, 'data' | 'seller' | 'hosting'> & { fileId: string },
  ) {
    try {
      shareSize(options.data);
      for (;;) {
        const job = await this.hosted.load(options.fileId);
        if (job.hosting?.result) return job.hosting.result;
        await this.hosted.next(options.fileId, options);
      }
    } catch (cause) {
      throw new SellError(options.fileId, { cause });
    }
  }
  private async hostedFile<T extends SellData>(
    original: SellRecord,
    data: T,
    publish: SellOptions<T>['publish'],
  ) {
    const job = await this.hosted.load(original.terms.file_id);
    if (!job.hosting.result || !job.hosting.header || !original.fileKey)
      throw new AnnonError('invalid_record');
    const header = bytes(job.hosting.header, (job.hosting.header.length - 2) / 2);
    const prepared = await prepareSeal(bytes(original.fileKey, 32), data, {
      fileId: bytes(job.terms.file_id, 32),
      name: job.name,
      mime: job.mime,
      authKind: identityKind(job.terms.seller) as 0 | 1 | 2,
    });
    if (hex(prepared.cipherHash) !== job.terms.cipher_hash) throw new SourceChangedError();
    let consumed = false;
    let file: import('../envelope/replay.js').SellFile<T>;
    if (data instanceof Uint8Array) {
      file = concat(
        header,
        new Uint8Array(await new Response(prepared.body()).arrayBuffer()),
      ) as import('../envelope/replay.js').SellFile<T>;
      consumed = true;
    } else {
      const reader = prepared.body().getReader();
      let first = true;
      file = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            if (first) {
              first = false;
              controller.enqueue(header);
              return;
            }
            try {
              const part = await reader.read();
              if (part.done) {
                consumed = true;
                controller.close();
                reader.releaseLock();
              } else controller.enqueue(part.value);
            } catch (error) {
              controller.error(error);
              reader.releaseLock();
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              reader.releaseLock();
            }
          },
        },
        { highWaterMark: 0 },
      ) as import('../envelope/replay.js').SellFile<T>;
    }
    try {
      await publish({ file, header, terms: job.terms });
      if (!consumed) throw new AnnonError('upload_incomplete');
    } catch (error) {
      if (file instanceof ReadableStream) await file.cancel(error).catch(() => {});
      throw error;
    }
    return {
      terms: job.terms,
      ...(job.baseSplit ? { baseSplit: job.baseSplit } : {}),
      file,
      header,
    };
  }
  async sell<T extends SellData>(o: SellOptions<T>) {
    if (o.base && parseIdentity(o.seller.identity).kind !== 'evm')
      throw new AnnonError('route_unavailable');
    if (o.hosting) {
      if (
        o.fileId ||
        o.moderator ||
        (o.previewLen ?? 0) !== 0 ||
        (o.base && o.base.price !== o.near.price)
      )
        throw new AnnonError('invalid_arguments');
      const options: ShareOptions = {
        data: o.data,
        name: o.name,
        mime: o.mime,
        seller: o.seller,
        price: o.near.price,
        near: { recipients: o.near.recipients, remainder: o.near.remainder },
        hosting: o.hosting,
        ...(o.storageBudget !== undefined ? { storageBudget: o.storageBudget } : {}),
        ...(o.hosting.listingStorage !== undefined
          ? { listingStorage: o.hosting.listingStorage }
          : {}),
        ...(o.hosting.confirmBackup ? { confirmBackup: o.hosting.confirmBackup } : {}),
        ...(o.onSplit ? { onSplit: o.onSplit } : {}),
      };
      const job = await this.startShare(options);
      await this.resumeShare({ ...options, fileId: job.terms.file_id });
      return this.hostedFile(job, o.data, o.publish);
    }

    if ((o.data instanceof Uint8Array ? o.data.length : o.data.size) > MAX_PLAINTEXT_BYTES)
      throw new DownloadError('too_large');
    if (o.storageBudget !== undefined && (o.storageBudget <= 0n || o.storageBudget >= 2n ** 128n))
      throw new AnnonError('invalid_arguments', 'invalid storage budget');
    if (o.storageBudget !== undefined && o.seller.identity.kind !== 'near')
      throw new AnnonError('near_wallet_required', 'storage budget requires a NEAR wallet');
    const config = await getConfig(this.o.nearRpc, this.o.contractId);
    if (config.network !== this.o.network) throw new PayError('network_mismatch');
    const assets = { nearUsdc: config.nearUsdc, baseUsdc: config.usdc };
    const seller = parseIdentity(o.seller.identity);
    const fileId = o.fileId ?? `0x${randomHex(32)}`;
    const fileKey = crypto.getRandomValues(new Uint8Array(32));
    const s = await prepareSeal(fileKey, o.data, {
      fileId: bytes(fileId, 32),
      name: o.name,
      mime: o.mime,
      authKind: identityKind(seller) as 0 | 1 | 2,
      ...(o.previewLen === undefined ? {} : { previewLen: o.previewLen }),
    });
    let near = {
      token: config.nearUsdc,
      ...o.near,
      remainder: o.near.recipients.findIndex(
        (r) => identityJson(r.identity) === identityJson(o.near.remainder),
      ),
    };
    let fee: ProtocolFee | undefined;
    if (this.o.sponsorship && seller.kind !== 'near') {
      const advertised = (await this.o.sponsorship()).fee;
      fee = advertised;
      if (
        !o.onSplit &&
        [near.price, ...(o.base ? [o.base.price] : [])].some((price) =>
          protocolFeeAboveMax(price, advertised, this.o.maxProtocolFee),
        )
      )
        throw new PayError('protocol_fee_above_max');
      near = applySponsoredFee(near, fee, o.base?.price);
      // The shared treasury share must meet both route requirements.
      checkProtocolFee({ near, base: o.base ? { price: o.base.price } : null } as Terms, fee);
    }
    const aboveMaximum =
      fee !== undefined &&
      [near.price, ...(o.base ? [o.base.price] : [])].some((price) =>
        protocolFeeAboveMax(price, fee, this.o.maxProtocolFee),
      );
    if (aboveMaximum && !o.onSplit) throw new PayError('protocol_fee_above_max');
    await o.onSplit?.(near, fee, aboveMaximum);
    const remainderIdentity = near.recipients[near.remainder]?.identity;
    const recipients = near.recipients
      .map((r) => ({ ...r, identity: parseIdentity(r.identity) }))
      .sort((a, b) => compare(encodeIdentity(a.identity), encodeIdentity(b.identity)));
    const remainder = recipients.findIndex(
      (r) => identityJson(r.identity) === identityJson(remainderIdentity as Identity),
    );
    const terms: Terms = {
      network: this.o.network,
      contract: this.o.contractId,
      file_id: fileId,
      seller,
      pay2_version: 2,
      cipher_hash: hex(s.cipherHash),
      moderator: o.moderator ?? null,
      near: { token: config.nearUsdc, price: o.near.price, recipients, remainder },
      base: null,
    };
    termsHash(terms, assets); // Validate all local terms before even creating a Base split.
    let baseSplit: SellRecord['baseSplit'] = null;
    if (o.base) {
      if (recipients.some((r) => r.identity.kind !== 'evm'))
        throw new AnnonError('bad_requirements', 'Base split requires only EVM recipients');
      const kind = o.base.kind ?? 'push';
      const salt = `0x${randomHex(32)}`;
      const split = createSplit(
        kind,
        {
          recipients: recipients.map((r) => r.identity.id),
          allocations: recipients.map((r) => BigInt(r.bps)),
          totalAllocation: 10000n,
          distributionIncentive: 0,
        },
        salt,
      );
      baseSplit = { address: split.address, kind, salt };
      terms.base = { usdc: config.usdc, price: o.base.price, pay_to: split.address };
      termsHash(terms, assets);
      await o.base.sendTransaction(split);
    }
    const key = oneTimeKey();
    const job: SellRecord = {
      kind: 'sell',
      ...(o.storageBudget !== undefined ? { storageBudget: o.storageBudget.toString() } : {}),
      id: `sell:${fileId}`,
      revision: 0,
      terms,
      baseSplit,
      fileKey: hex(fileKey),
      sellerSecret: hex(key.secret),
      deadline: this.now() + 540,
      name: o.name,
      mime: o.mime,
      previewLen: o.previewLen ?? 0,
      ckdSecret: null,
    };
    try {
      if (!(await this.sells.compareAndSet(`annon/sell/${fileId}`, null, job)))
        throw new PayError('store_conflict');
      return await this.finishSell(job, s, o.seller, o.publish, false);
    } catch (cause) {
      throw new SellError(fileId, { cause });
    }
  }
  /** Resume with the original plaintext; the saved file key reproduces the registered cipher hash. */
  async resumeSell<T extends SellData>(o: {
    fileId: string;
    data: T;
    seller: IdentityWallet;
    publish: SellOptions<T>['publish'];
    hosting?: ShareHosting;
  }) {
    if ((o.data instanceof Uint8Array ? o.data.length : o.data.size) > MAX_PLAINTEXT_BYTES)
      throw new DownloadError('too_large');
    const job = await this.sells.load(`annon/sell/${o.fileId}`);
    if (!job) throw new AnnonError('invalid_record', 'no saved sell job');
    if (job.hosting && !job.published) {
      if (!o.hosting) throw new AnnonError('transport_required');
      await this.resumeShare({
        fileId: o.fileId,
        data: o.data,
        seller: o.seller,
        hosting: o.hosting,
      });
      return this.hostedFile(job, o.data, o.publish);
    }
    if (job.published) {
      await this.o.writeBackup(job.id, await exportSell(job, this.o.backupSecret));
      throw new AnnonError('invalid_record', 'sell already published; secrets cleared');
    }
    if (!job.fileKey || !job.sellerSecret)
      throw new AnnonError('invalid_record', 'sell job has no file key');
    if (
      job.terms.contract !== this.o.contractId ||
      identityJson(job.terms.seller) !== identityJson(o.seller.identity)
    )
      throw new AnnonError('wrong_identity', 'sell job identity mismatch');
    await this.o.writeBackup(job.id, await exportSell(job, this.o.backupSecret));
    const s = await prepareSeal(bytes(job.fileKey, 32), o.data, {
      fileId: bytes(o.fileId, 32),
      name: job.name,
      mime: job.mime,
      authKind: identityKind(job.terms.seller) as 0 | 1 | 2,
      previewLen: job.previewLen,
    });
    if (hex(s.cipherHash) !== job.terms.cipher_hash)
      throw new AnnonError('cipher_hash_mismatch', 'original data cipher hash mismatch');
    const registered = await getFile(this.o.nearRpc, this.o.contractId, o.fileId);
    if (registered && registered.termsHash !== termsHash(job.terms, assetsFor(job.terms)))
      throw new AnnonError('file_mismatch', 'registered sell job mismatch');
    try {
      return await this.finishSell(job, s, o.seller, o.publish, registered !== null);
    } catch (cause) {
      throw new SellError(o.fileId, { cause });
    }
  }
  /** A new seller one-time key is backed up before the single-use reopen_seller call. */
  async reopenSeller(o: { fileId: string; seller: IdentityWallet }): Promise<Uint8Array> {
    const f = await this.file(o.fileId);
    if (identityJson(f.seller) !== identityJson(o.seller.identity))
      throw new AnnonError('wrong_identity', 'not the registered seller');
    const keyName = `annon/seller-key/${o.fileId}`;
    const previous = await this.sellerKeys.load(keyName);
    const key = oneTimeKey();
    const next: SellerKeyRecord = {
      kind: 'seller-key',
      id: `seller-key:${o.fileId}`,
      file_id: o.fileId,
      seller: f.seller,
      revision: (previous?.revision ?? -1) + 1,
      buyerSecret: hex(key.secret),
      deadline: this.now() + 540,
    };
    if (!(await this.sellerKeys.compareAndSet(keyName, previous, next)))
      throw new PayError('store_conflict');
    const args = { file_id: o.fileId, key: hex(key.publicKeyBytes), deadline: next.deadline };
    const auth = await this.auth(o.seller, reopenSellerText(this.o.contractId, args, f.seller));
    const answer = await this.answer(
      await this.call('reopen_seller', { args, ...(auth ? { auth } : {}) }, o.seller),
      key.secret,
      o.fileId,
    );
    if (
      !(await this.sellerKeys.compareAndSet(keyName, next, {
        ...next,
        revision: next.revision + 1,
        buyerSecret: null,
      }))
    )
      throw new PayError('store_conflict');
    key.secret.fill(0);
    return answer;
  }
  private async finishSell<T extends SellData>(
    job: SellRecord,
    s: PreparedSeal<T>,
    seller: IdentityWallet,
    publish: SellOptions<T>['publish'],
    registered: boolean,
  ) {
    const fileId = job.terms.file_id;
    let ckd: Uint8Array;
    if (job.ckdSecret) ckd = bytes(job.ckdSecret, 48);
    else {
      if (registered) ckd = await this.reopenSeller({ fileId, seller });
      else {
        const key = keyFromSecret(bytes(job.sellerSecret as string, 32));
        const args = {
          terms: job.terms,
          seller_key: hex(key.publicKeyBytes),
          deadline: this.now() + 540,
        };
        const auth = await this.auth(
          seller,
          registerText(this.o.contractId, args, assetsFor(job.terms)),
        );
        ckd = await this.answer(
          await this.call(
            'register',
            {
              args,
              ...(auth ? { auth } : {}),
              ...(auth && job.baseSplit
                ? { baseSplit: { kind: job.baseSplit.kind, salt: job.baseSplit.salt } }
                : {}),
            },
            seller,
          ),
          key.secret,
          fileId,
        );
      }
      const current = await this.sells.load(`annon/sell/${fileId}`);
      if (!current) throw new AnnonError('invalid_record', 'sell job missing');
      const next = { ...current, revision: current.revision + 1, ckdSecret: hex(ckd) };
      if (!(await this.sells.compareAndSet(`annon/sell/${fileId}`, current, next)))
        throw new PayError('store_conflict');
    }
    const { file, header, consumed, cancel } = await s.finish({
      contractId: this.o.contractId,
      ckdSecret: ckd,
      seller: job.terms.seller,
      ...(seller.identity.kind === 'near'
        ? {}
        : {
            sign: async (text: string) => {
              const a = await this.auth(seller, text);
              if (!a) throw new AnnonError('invalid_signature', 'missing header authorization');
              const signature = bytes(a.sig, seller.identity.kind === 'evm' ? 65 : 64);
              return seller.identity.kind === 'solana'
                ? { signature, signedMessage: new TextEncoder().encode(text) }
                : signature;
            },
          }),
    });
    const headerLen = header.length;
    try {
      if (seller.identity.kind === 'near')
        await this.call(
          'publish_header',
          { file_id: fileId, header_hash: hex(await sha256(header.subarray(0, headerLen - 65))) },
          seller,
        );
      if (job.storageBudget) {
        const name = `annon/sell/${fileId}`;
        let current = await this.sells.load(name);
        if (!current) throw new AnnonError('invalid_record', 'sell job missing');
        const target = BigInt(job.storageBudget);
        if (current.storageFunding === 'pending') {
          // The call may have landed and its allocation may already have been spent.
          // A low current balance cannot justify automatically allocating the amount again.
          const budget = await fileStorageBalance(this.o.nearRpc, this.o.contractId, fileId);
          if (budget.available < target)
            throw new PayError(
              'storage_required',
              'Previous file funding is uncertain; inspect it and explicitly fund before resuming.',
            );
        } else if (current.storageFunding !== 'funded') {
          const pending = {
            ...current,
            revision: current.revision + 1,
            storageFunding: 'pending' as const,
          };
          if (!(await this.sells.compareAndSet(name, current, pending)))
            throw new PayError('store_conflict');
          current = pending;
          try {
            await fundFileStorage(asNear(seller), this.o.contractId, fileId, target);
          } catch (error) {
            if (
              error instanceof FileFundingRefused &&
              !(await this.sells.compareAndSet(name, current, {
                ...current,
                revision: current.revision + 1,
                storageFunding: 'refused' as const,
              }))
            )
              throw new PayError('store_conflict');
            throw error;
          }
        }
        if (
          current.storageFunding !== 'funded' &&
          !(await this.sells.compareAndSet(name, current, {
            ...current,
            revision: current.revision + 1,
            storageFunding: 'funded',
          }))
        )
          throw new PayError('store_conflict');
      }
      await publish({ file, header, terms: job.terms });
      if (!consumed())
        throw new AnnonError(
          'upload_incomplete',
          'publish did not consume the complete file stream',
        );
    } catch (error) {
      await cancel(error).catch(() => {});
      throw error;
    }
    const sellerKeyName = `annon/seller-key/${fileId}`;
    const sellerKey = await this.sellerKeys.load(sellerKeyName);
    if (
      sellerKey?.buyerSecret &&
      !(await this.sellerKeys.compareAndSet(sellerKeyName, sellerKey, {
        ...sellerKey,
        revision: sellerKey.revision + 1,
        buyerSecret: null,
      }))
    )
      throw new PayError('store_conflict');
    const current = await this.sells.load(`annon/sell/${fileId}`);
    if (
      !current ||
      !(await this.sells.compareAndSet(`annon/sell/${fileId}`, current, {
        ...current,
        revision: current.revision + 1,
        published: true,
        fileKey: null,
        sellerSecret: null,
        ckdSecret: null,
      }))
    )
      throw new PayError('store_conflict');
    ckd.fill(0);
    return {
      terms: job.terms,
      ...(job.baseSplit ? { baseSplit: job.baseSplit } : {}),
      file,
      header,
    };
  }
  async buy(o: BuyOptions): Promise<Bought> {
    if (typeof o.maxPrice !== 'bigint' || o.maxPrice <= 0n || o.maxPrice >= 2n ** 128n)
      throw new AnnonError('max_price_required', 'maxPrice must be a positive human-approved cap');
    const f = await this.file(o.fileId, true);
    if (f.moderator !== null && !(o.moderators ?? []).includes(f.moderator))
      throw new PayError('unknown_moderator');
    const checked = await inspectHeader(o.header, listing(o.fileId, f), this.o.contractId);
    if (!checked.usable) throw new PayError('file_invalid');
    if (o.route !== undefined && !['near', 'base', '1click'].includes(o.route))
      throw new AnnonError('invalid_arguments', 'invalid purchase route');
    if (o.route === 'base' && !f.terms.base) throw new AnnonError('route_unavailable');
    if (o.route === 'near' && o.payer?.identity.kind !== 'near')
      throw new AnnonError('near_wallet_required', 'direct NEAR requires a NEAR payment wallet');
    if (o.route === '1click' && !o.origin)
      throw new AnnonError('origin_required', 'a 1Click origin is required');
    if (o.route === 'base' && (o.payer?.identity.kind !== 'evm' || !('signTypedData' in o.payer)))
      throw new AnnonError(
        'base_wallet_required',
        'Base requires Base terms and an EVM payment wallet',
      );
    const oneclick =
      o.route === '1click' || (o.route === undefined && o.payer?.identity.kind !== 'near');
    const store: Store<PurchaseRecord> = {
      load: (name) => this.store.load(name),
      compareAndSet: async (name, expected, next) => {
        if (next) await o.beforeSave?.(next);
        const ok = await this.store.compareAndSet(name, expected, next);
        if (ok && next) await o.onSaved?.(next);
        return ok;
      },
    };
    let wireRoute: Purchase['route'] = o.route === 'base' ? 'base-usdc' : 'near-usdc';
    if (
      o.route === undefined &&
      o.payer?.identity.kind === 'evm' &&
      f.terms.base &&
      'signTypedData' in o.payer
    ) {
      const h = await head(this.o.baseRpc);
      if (
        !(await hasCode(this.o.baseRpc, o.payer.identity.id, h.number)) &&
        (await balanceOf(this.o.baseRpc, f.terms.base.usdc, o.payer.identity.id, h.number)) >=
          BigInt(f.terms.base.price)
      )
        wireRoute = 'base-usdc';
    }
    const route: BuyRoute = wireRoute === 'base-usdc' ? 'base' : oneclick ? '1click' : 'near';
    if (wireRoute === 'near-usdc' && oneclick && o.origin) validateOrigin(o.origin);
    const price =
      wireRoute === 'base-usdc' && f.terms.base ? f.terms.base.price : f.terms.near.price;
    if (BigInt(price) > o.maxPrice) throw new PayError('price_above_max');
    let ensureBase = async () => {};
    if (wireRoute === 'base-usdc') {
      if (o.baseUnlock !== undefined && !['relayer', 'self'].includes(o.baseUnlock))
        throw new AnnonError('invalid_arguments', 'invalid Base unlock transport');
      if (o.baseUnlock === 'self') {
        asNear(o.recovery);
        ensureBase = async () => checkBaseSplit(f, this.o.baseRpc);
      } else {
        if (!this.o.relayer) throw new AnnonError('transport_required');
        const config = await getConfig(this.o.nearRpc, this.o.contractId);
        const options = {
          deployment: {
            network: this.o.network,
            contractId: this.o.contractId,
            nearUsdc: config.nearUsdc,
            baseUsdc: config.usdc,
          },
          file: f,
          baseRpc: this.o.baseRpc,
          relayer: this.o.relayer,
          ...(this.o.fetch ? { fetch: this.o.fetch } : {}),
          now: () => this.now(),
        };
        let checked = o.baseSponsorship;
        ensureBase = async () => {
          if (!validBaseSponsorship(checked, options))
            checked = await checkBaseSponsorship(options);
        };
      }
    }
    await ensureBase();
    if (wireRoute === 'near-usdc') {
      const budget = await fileStorageBalance(this.o.nearRpc, this.o.contractId, o.fileId);
      if (budget.available < budget.admissionRequirement) throw new PayError('file_storage_low');
    }
    if (wireRoute === 'near-usdc' && o.payer?.identity.kind !== 'near' && !o.origin)
      throw new AnnonError(
        'origin_required',
        'a 1Click origin is required for cross-chain payment',
      );
    const recovery = parseIdentity(o.recovery.identity);
    const key = oneTimeKey();
    const p: Purchase = {
      version: 2,
      refund: parseIdentity(o.refund),
      network: wireRoute === 'base-usdc' ? 'eip155:8453' : this.o.network,
      contract: this.o.contractId,
      route: wireRoute,
      asset: wireRoute === 'base-usdc' && f.terms.base ? f.terms.base.usdc : f.terms.near.token,
      file_id: o.fileId,
      terms_hash: f.termsHash,
      price,
      nonce: `0x${randomHex(32)}`,
      buyer_key: hex(key.publicKeyBytes),
      recovery,
      expires_at: String(this.now() + 3600),
    };
    const assets = {
      nearUsdc: f.terms.near.token,
      ...(f.terms.base ? { baseUsdc: f.terms.base.usdc } : {}),
    };
    const id = purchaseId(p, assets);
    const message = buildPurchaseMessage(p, assets);
    parsePurchaseMessage(message, assets);
    const proofText = `Annon: verify purchase recovery\ncontract: ${this.o.contractId}\npurchase: ${id}\nrecovery: ${identityText(recovery)}`;
    const proveRecovery = async () => {
      if (recovery.kind === 'near') {
        const w = asNear(o.recovery);
        if (!w.proveControl)
          throw new AnnonError(
            'missing_method',
            'NEAR recovery requires an account ownership proof before payment',
          );
        await w.proveControl(proofText, { contractId: this.o.contractId, nearRpc: this.o.nearRpc });
      } else await this.auth(o.recovery, proofText);
    };
    const deferProof = wireRoute === 'near-usdc' && oneclick && o.onQuote;
    if (!deferProof) await proveRecovery();
    if (wireRoute === 'base-usdc') {
      if (!o.paymentRequired || !o.url || !o.payer || !('signTypedData' in o.payer))
        throw new TypeError(
          'Base requires paymentRequired, resource URL and an EVM payment wallet',
        );
      const payer = o.payer as EvmWallet;
      const q = await preflight({
        nearRpc: this.o.nearRpc,
        baseRpc: this.o.baseRpc,
        contractId: this.o.contractId,
        fileId: o.fileId,
        buyer: payer.identity.id,
        paymentRequired: o.paymentRequired,
        url: o.url,
        pay2: o.header,
        maxPrice: o.maxPrice,
        ...(o.moderators ? { moderators: o.moderators } : {}),
      });
      await ensureBase();
      const result = await authorize(q, {
        purchase: p,
        buyerSecret: key.secret,
        wallet: { address: payer.identity.id, signTypedData: (t) => payer.signTypedData(t) },
        store,
      });
      const proved = {
        ...result.purchase,
        revision: result.purchase.revision + 1,
        recoveryProved: true,
      };
      if (!(await store.compareAndSet(purchaseKey(id), result.purchase, proved)))
        throw new PayError('store_conflict');
      await o.beforePayment?.(proved);
      if (o.baseUnlock === 'self') this.selfUnlockWallets.set(id, asNear(o.recovery));
      if (o.submitBase) await o.submitBase(result.header);
      return { route, record: proved, payment: result.header };
    }
    const headerHash = hex(checked.headerHash);
    let record: PurchaseRecord = {
      schemaVersion: 2,
      payment: {
        route,
        amountUsdc: usdc(BigInt(price)),
        amountBaseUnits: price,
        asset: { symbol: 'USDC', id: p.asset },
        network: p.network,
      },
      recoveryProved: !deferProof,
      id,
      revision: 0,
      purchase: p,
      message,
      buyerSecret: hex(key.secret),
      quote: null,
      recovery,
      checkedHeaderHash: headerHash,
      terms: {
        network: p.network,
        contractId: p.contract,
        fileId: p.file_id,
        buyer: o.payer?.identity.id ?? recovery.id,
        seller: f.seller,
        to: p.contract,
        usdc: p.asset,
        price: p.price,
        buyerKey: p.buyer_key,
        nonce: p.nonce,
        headerHash,
        cipherHash: f.cipherHash,
        moderator: f.moderator,
      },
      attempts: [],
    };
    if (!(await store.compareAndSet(purchaseKey(id), null, record)))
      throw new PayError('store_conflict');
    if (!oneclick && o.payer?.identity.kind === 'near') {
      await o.beforePayment?.(record);
      try {
        await asNear(o.payer).transferPurchase(message, assets);
      } catch (error) {
        if (!(error instanceof TransactionUncertain)) throw error;
        const next: PurchaseRecord = {
          ...record,
          revision: record.revision + 1,
          nearSubmission: { state: 'uncertain', txHash: error.txHash },
        };
        if (!(await store.compareAndSet(purchaseKey(id), record, next)))
          throw new TransactionUncertain(error.txHash, id);
        return { route, record: next, uncertain: { purchaseId: id, txHash: error.txHash } };
      }
      return { route, record };
    }
    if (!o.origin)
      throw new AnnonError(
        'origin_required',
        'a 1Click origin is required for cross-chain payment',
      );
    const quote = await (o.oneClick ?? new OneClick()).quote(message, o.origin);
    const next = { ...record, revision: record.revision + 1, quote };
    if (!(await store.compareAndSet(purchaseKey(id), record, next)))
      throw new PayError('store_conflict');
    record = next;
    if (o.onQuote) {
      await o.onQuote(quote);
      const checkDeadline = () => {
        const cutoff = Date.parse(quote.deposit.depositBefore);
        if (!Number.isFinite(cutoff) || cutoff - this.now() * 1000 < 600000)
          throw new OneClickQuoteExpired();
      };
      checkDeadline();
      await proveRecovery();
      checkDeadline();
    }
    if (!record.recoveryProved) {
      const proved = { ...record, revision: record.revision + 1, recoveryProved: true };
      if (!(await store.compareAndSet(purchaseKey(id), record, proved)))
        throw new PayError('store_conflict');
      record = proved;
    }
    await o.beforePayment?.(record);
    return { route, record, instructions: quote.deposit };
  }
  /** Reprove the same saved purchase after reload, without preparing or submitting a payment. */
  async proveRecovery(record: PurchaseRecord, wallet: IdentityWallet): Promise<PurchaseRecord> {
    const current = await this.store.load(purchaseKey(record.id));
    if (!current || current.revision !== record.revision) throw new PayError('store_conflict');
    if (
      current.purchase.contract !== this.o.contractId ||
      current.purchase.network !==
        (current.purchase.route === 'base-usdc' ? 'eip155:8453' : this.o.network)
    )
      throw new AnnonError('network_mismatch', 'saved purchase is outside this SDK scope');
    if (identityJson(parseIdentity(wallet.identity)) !== identityJson(current.recovery))
      throw new AnnonError('wrong_identity', 'purchase recovery identity mismatch');
    const text = `Annon: verify purchase recovery\ncontract: ${this.o.contractId}\npurchase: ${current.id}\nrecovery: ${identityText(current.recovery)}`;
    if (current.recovery.kind === 'near') {
      const w = asNear(wallet);
      if (!w.proveControl)
        throw new AnnonError(
          'missing_method',
          'NEAR recovery requires an account ownership proof before payment',
        );
      await w.proveControl(text, { contractId: this.o.contractId, nearRpc: this.o.nearRpc });
    } else await this.auth(wallet, text);
    const next = { ...current, revision: current.revision + 1, recoveryProved: true };
    if (!(await this.store.compareAndSet(purchaseKey(current.id), current, next)))
      throw new PayError('store_conflict');
    return next;
  }
  /** Resume a paid Base purchase before any host download, which requires a final grant. */
  async accept(
    record: PurchaseRecord | undefined,
    id = record?.id,
    options: { unlockWallet?: NearWallet } = {},
  ): Promise<boolean> {
    if (record) validatePurchaseRecord(record);
    if (!id) throw new AnnonError('purchase_required', 'missing purchase id');
    if (await getPurchase(this.o.nearRpc, this.o.contractId, id)) return true;
    if (record?.purchase.route !== 'base-usdc') return false;
    if (!this.o.baseRpc)
      throw new AnnonError('base_rpc_required', 'configure baseRpc to resume a Base purchase');
    const next = await nextStep(record, {
      nearRpc: this.o.nearRpc,
      baseRpc: this.o.baseRpc,
      store: this.store,
    });
    if (next.step === 'unlock') {
      const answer = await this.call(
        'unlock',
        { args: next.args },
        options.unlockWallet ?? this.selfUnlockWallets.get(id),
      );
      this.unlocked.set(id, answer);
      // Bound answers retained by status-only callers; evicted entries use claim_key.
      if (this.unlocked.size > 64) {
        const oldest = this.unlocked.keys().next().value;
        if (oldest !== undefined) this.unlocked.delete(oldest);
      }
    }
    return (await getPurchase(this.o.nearRpc, this.o.contractId, id)) !== null;
  }
  async open(o: {
    file: Uint8Array;
    record?: PurchaseRecord;
    recovery?: RecoveryRecord;
  }): Promise<{ meta: FileMeta; data: Uint8Array }> {
    return this.openSource(o) as Promise<{ meta: FileMeta; data: Uint8Array }>;
  }
  /** Replay PAY2 to a provisional sink; resolve after every check. Single-use streams require a ciphertext spool. */
  async openTo(o: {
    file: ReplayableSource | ReadableStream<Uint8Array>;
    sink: WritableStream<Uint8Array>;
    spool?: Spool;
    record?: PurchaseRecord;
    recovery?: RecoveryRecord;
  }): Promise<{ meta: FileMeta }> {
    return withReplay(o.file, (file) => this.openSource({ ...o, file }), o.spool);
  }
  private async openSource(o: {
    file: Uint8Array | ReplayableSource;
    sink?: WritableStream<Uint8Array>;
    record?: PurchaseRecord;
    recovery?: RecoveryRecord;
  }): Promise<{ meta: FileMeta; data?: Uint8Array }> {
    if ((o.file instanceof Uint8Array ? o.file.length : o.file.size) > MAX_PAY2_BYTES)
      throw new DownloadError('too_large');
    if (!o.record && !o.recovery)
      throw new AnnonError('purchase_required', 'a saved purchase or recovery grant is required');
    const r = o.recovery;
    if (r && r.grant === null)
      throw new AnnonError('recovery_not_final', 'recovery grant is not final');
    const id = r?.purchase_id ?? o.record?.id;
    if (!id) throw new AnnonError('purchase_required', 'missing purchase id');
    if (!(await this.accept(o.record, id)))
      throw new PayError('settlement_pending', 'purchase not accepted; check status and resume');
    const fileId = r?.file_id ?? o.record?.purchase.file_id;
    if (!fileId) throw new AnnonError('file_required', 'missing file id');
    const grant = r?.grant ?? 0;
    const secretHex = r?.buyerSecret ?? o.record?.buyerSecret;
    if (!secretHex) throw new AnnonError('invalid_record', 'missing buyer secret');
    const secret = bytes(secretHex, 32);
    const final = await getPurchase(this.o.nearRpc, this.o.contractId, id);
    const g = await getGrant(this.o.nearRpc, this.o.contractId, id, grant);
    if (
      !final ||
      final.file_id !== fileId ||
      !g ||
      hex(keyFromSecret(secret).publicKeyBytes) !== g.buyer_key
    )
      throw new AnnonError('invalid_record', 'saved key does not match the final grant');
    const f = await this.file(fileId);
    const prepared =
      o.file instanceof Uint8Array
        ? undefined
        : await prepareOpen(o.file, {
            listing: listing(fileId, f),
            contractId: this.o.contractId,
          });
    const inspected = await inspectHeader(
      prepared
        ? prepared.header
        : (o.file as Uint8Array).subarray(
            0,
            new DataView(
              (o.file as Uint8Array).buffer,
              (o.file as Uint8Array).byteOffset,
            ).getUint32(8),
          ),
      listing(fileId, f),
      this.o.contractId,
    );
    if (o.record && hex(inspected.headerHash) !== o.record.checkedHeaderHash)
      throw new AnnonError('file_mismatch', 'header differs from the checked purchase header');
    const cached = grant === 0 ? this.unlocked.get(id) : undefined;
    if (grant === 0) this.unlocked.delete(id);
    let ckd: Uint8Array | undefined;
    if (cached) {
      try {
        ckd = await this.answer(cached, secret, fileId);
      } catch {
        /* A missing or invalid unlock answer falls back to the usual verified claim. */
      }
    }
    if (!ckd)
      ckd = await this.answer(
        await this.call('claim_key', { purchase_id: id, grant }),
        secret,
        fileId,
      );
    if (prepared) {
      if (!o.sink) throw new AnnonError('invalid_arguments', 'a plaintext sink is required');
      const meta = await prepared.writeTo(o.sink, async () => ckd);
      if (meta.size > MAX_PLAINTEXT_BYTES) throw new DownloadError('too_large');
      return { meta };
    }
    const opened = await openPay2(o.file as Uint8Array, {
      contractId: this.o.contractId,
      listing: listing(fileId, f),
      ckdSecret: async () => ckd,
    });
    if (opened.meta.size > MAX_PLAINTEXT_BYTES) throw new DownloadError('too_large');
    return opened;
  }
  async recover(o: {
    wallet: IdentityWallet;
    purchaseId?: string;
    limit?: number;
    /** Batch errors are isolated; an explicit purchase still rejects on failure. */
    onError?: (purchaseId: string, error: unknown) => void;
  }): Promise<RecoveryRecord[]> {
    const recovery = parseIdentity(o.wallet.identity);
    const ids: string[] = [];
    if (o.purchaseId) ids.push(o.purchaseId);
    else {
      const limit = o.limit ?? 50;
      for (let from = 0; ; from += limit) {
        const page = await purchasesOf(this.o.nearRpc, this.o.contractId, recovery, from, limit);
        ids.push(...page);
        if (page.length < limit) break;
      }
    }
    const recovered: RecoveryRecord[] = [];
    for (const id of ids) {
      try {
        const p = await getPurchase(this.o.nearRpc, this.o.contractId, id);
        if (!p || identityJson(p.recovery) !== identityJson(recovery))
          throw new AnnonError('wrong_identity', 'purchase recovery identity mismatch');
        await this.file(p.file_id);
        const keyName = `annon/recovery/${id}`;
        let r = await this.recoveries.load(keyName);
        if (r?.grant !== null && r?.grant !== undefined) {
          recovered.push(r);
          continue;
        }
        if (!r) {
          const key = oneTimeKey();
          r = {
            kind: 'recovery',
            id: `recovery:${id}`,
            revision: 0,
            purchase_id: id,
            file_id: p.file_id,
            recovery,
            buyerSecret: hex(key.secret),
            fresh_key: hex(key.publicKeyBytes),
            nonce: `0x${randomHex(32)}`,
            deadline: this.now() + 540,
            grant: null,
          };
          if (!(await this.recoveries.compareAndSet(keyName, null, r)))
            throw new PayError('store_conflict');
        }
        let current = r;
        const findGrant = async (count: number): Promise<number | null> => {
          for (let i = 1; i < count; i++) {
            const g = await getGrant(this.o.nearRpc, this.o.contractId, id, i);
            if (g?.buyer_key === current.fresh_key) return i;
          }
          return null;
        };
        // A previously accepted grant needs no new transaction, even if its request deadline passed.
        let grant = await findGrant(p.grants);
        let result: unknown;
        if (grant === null) {
          if (r.deadline <= this.now()) {
            // Preserve the old key before replacing it; its request may have landed near expiry.
            await this.o.writeBackup(
              `${r.id}:revision:${r.revision}`,
              await exportRecovery(r, this.o.backupSecret),
            );
            const key = oneTimeKey();
            const next = {
              ...r,
              revision: r.revision + 1,
              buyerSecret: hex(key.secret),
              fresh_key: hex(key.publicKeyBytes),
              nonce: `0x${randomHex(32)}`,
              deadline: this.now() + 540,
            };
            if (!(await this.recoveries.compareAndSet(keyName, r, next)))
              throw new PayError('store_conflict');
            r = next;
            current = next;
          }
          await this.o.writeBackup(r.id, await exportRecovery(r, this.o.backupSecret));
          const args = {
            purchase_id: id,
            fresh_key: r.fresh_key,
            nonce: r.nonce,
            deadline: r.deadline,
          };
          const auth = await this.auth(
            o.wallet,
            reopenText({ ...args, contract: this.o.contractId, file_id: p.file_id, recovery }),
          );
          result = await this.call('reopen', { args, ...(auth ? { auth } : {}) }, o.wallet);
          const final = await getPurchase(this.o.nearRpc, this.o.contractId, id);
          grant = await findGrant(final?.grants ?? p.grants);
        }
        if (grant === null)
          throw new AnnonError(
            'recovery_not_final',
            'reopen grant is not final; resume the saved recovery',
          );
        // Validate any returned CKD answer; claim_key is repeatable if it was absent/failed.
        if (result && typeof result === 'object' && ('big_y' in result || 'answer' in result))
          await this.answer(result, bytes(r.buyerSecret, 32), p.file_id);
        const next = { ...r, revision: r.revision + 1, grant };
        if (!(await this.recoveries.compareAndSet(keyName, r, next)))
          throw new PayError('store_conflict');
        recovered.push(next);
      } catch (error) {
        if (o.purchaseId) throw error;
        o.onError?.(id, error);
      }
    }
    return recovered;
  }
  async stop(o: { fileId: string; seller: IdentityWallet }): Promise<void> {
    const f = await this.file(o.fileId);
    if (identityJson(f.seller) !== identityJson(o.seller.identity))
      throw new AnnonError('wrong_identity', 'not the registered seller');
    const args = { file_id: o.fileId, key: null, deadline: this.now() + 540 };
    const auth = await this.auth(o.seller, stopSalesText(this.o.contractId, args, f.seller));
    await this.call('stop_sales', { args, ...(auth ? { auth } : {}) }, o.seller);
  }
}
