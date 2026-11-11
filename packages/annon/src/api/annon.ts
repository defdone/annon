/** Sell, buy, open, recover and stop, using the single purchase/grant settlement model. */
import {
  type FileMeta,
  inspectHeader,
  type Listing,
  open as openPay2,
  sealWithKey,
  sha256,
} from '../envelope/pay2.js';
import { fileAppId, keyFromSecret, oneTimeKey, openAnswer } from '../keys/near-ckd.js';
import {
  type FileInfo,
  getConfig,
  getFile,
  getGrant,
  getPurchase,
  purchasesOf,
  readOutcome,
  view,
} from '../near/rpc.js';
import { registerText, reopenSellerText, reopenText, stopSalesText } from '../near/texts.js';
import {
  type Deposit,
  OneClick,
  type OneClickQuote,
  OneClickQuoteExpired,
  type Origin,
} from '../oneclick/oneclick.js';
import {
  type EncryptedRecord,
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
} from '../pay/backup.js';
import { balanceOf, hasCode, head, PayError } from '../pay/base.js';
import { authorize, preflight } from '../pay/pay.js';
import { type PurchaseRecord, purchaseKey, randomHex } from '../pay/purchase.js';
import { nextStep } from '../pay/recover.js';
import { createSplit, type SplitCall } from '../pay/split.js';
import type { Store, Versioned } from '../pay/store.js';
import type { PaymentRequired } from '../pay/x402.js';
import { account, bytes, compare, hex, network } from '../settle-near/codec.js';
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

export interface AnnonOptions {
  nearRpc: string;
  baseRpc: string;
  contractId: string;
  network: string;
  rawStore: Store<EncryptedRecord>;
  backupSecret: Uint8Array;
  /** Write the encrypted file durably (Node file, download, or an app's backup destination). */
  writeBackup(name: string, encryptedFile: string): Promise<void>;
  /** A transaction transport. Wait for final execution and return its decoded result/outcome. NEAR wallets can call directly when omitted. */
  send?: (method: string, args: object, wallet?: NearWallet) => Promise<unknown>;
  mpcKey?: string;
  now?: () => number;
}
export interface SellOptions {
  data: Uint8Array;
  name: string;
  mime: string;
  seller: IdentityWallet;
  near: { price: string; recipients: { identity: Identity; bps: number }[]; remainder: Identity };
  base?: {
    price: string;
    kind?: 'push' | 'pull';
    sendTransaction: (call: SplitCall) => Promise<void>;
  };
  moderator?: string;
  fileId?: string;
  previewLen?: number;
  /** Store/host the encrypted file and its public header. Called after header authorization. */
  publish: (file: { file: Uint8Array; header: Uint8Array; terms: Terms }) => Promise<void>;
}
export interface BuyOptions {
  fileId: string;
  header: Uint8Array;
  recovery: IdentityWallet;
  refund: Identity;
  payer?: IdentityWallet;
  maxPrice: bigint;
  moderators?: readonly string[];
  paymentRequired?: PaymentRequired;
  url?: string;
  oneClick?: Pick<OneClick, 'quote'>;
  origin?: Origin;
  /** Review the live 1Click quote after its encrypted backup is saved, before recovery proof and deposit instructions. */
  onQuote?: (quote: OneClickQuote) => void | Promise<void>;
  /** Submit the saved Base payload to the host/facilitator. Return only after its request completes. */
  submitBase?: (header: string) => Promise<void>;
}
export interface Bought {
  route: Purchase['route'];
  record: PurchaseRecord;
  instructions?: Deposit;
  uncertain?: { purchaseId: string; txHash: string };
  payment?: string;
}
const asNear = (w: IdentityWallet): NearWallet => {
  if (w.identity.kind !== 'near' || !('call' in w) || typeof w.call !== 'function')
    throw new TypeError('a NEAR transaction wallet is required');
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
export class SellError extends Error {
  readonly code?: string;
  constructor(
    readonly fileId: string,
    options?: ErrorOptions,
  ) {
    super(
      options?.cause instanceof Error
        ? options.cause.message
        : 'Sell incomplete; resume with fileId.',
      options,
    );
    if (options?.cause instanceof PayError) this.code = options.cause.code;
  }
}
export class Annon {
  readonly store: Store<PurchaseRecord>;
  private readonly sellerKeys: Store<SellerKeyRecord>;
  private readonly sells: Store<SellRecord>;
  private readonly recoveries: Store<RecoveryRecord>;
  private readonly unlocked = new Map<string, unknown>();
  constructor(private readonly o: AnnonOptions) {
    account(o.contractId);
    network(o.network);
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
      throw new Error('wallet did not authorize the exact text');
    return auth;
  }
  private async call(method: string, args: object, wallet?: IdentityWallet): Promise<unknown> {
    const near = wallet?.identity.kind === 'near' ? asNear(wallet) : undefined;
    let result: unknown;
    try {
      result = this.o.send
        ? await this.o.send(method, args, near)
        : near
          ? await near.call({ receiverId: this.o.contractId, method, args })
          : (() => {
              throw new Error('configure a transaction transport for relayed calls');
            })();
    } catch (error) {
      if (
        /prepaid|storage balance|storage[_ ]deposit/i.test(
          error instanceof Error ? error.message : '',
        )
      )
        throw new PayError('storage_required');
      throw error;
    }
    if (result && typeof result === 'object' && 'transaction' in result) {
      const transaction = (result as { transaction: { hash: string; signer_id: string } })
        .transaction;
      const outcome = readOutcome(result, this.o.contractId, {
        txHash: transaction.hash,
        signer: transaction.signer_id,
        method,
        args,
      });
      if (outcome.state === 'released') return outcome.answer;
      if (outcome.state === 'done') return outcome.value;
      if (
        /prepaid|storage balance|storage[_ ]deposit/i.test(
          'reason' in outcome ? outcome.reason : '',
        )
      )
        throw new PayError('storage_required');
      throw new Error(`contract ${method}: ${outcome.state}`);
    }
    return result;
  }
  private async answer(value: unknown, secret: Uint8Array, fileId: string): Promise<Uint8Array> {
    const answer = value && typeof value === 'object' && 'answer' in value ? value.answer : value;
    const config = await getConfig(this.o.nearRpc, this.o.contractId);
    const mpcKey = await view(this.o.nearRpc, config.mpc, 'public_key', {
      domain_id: config.ckdDomain,
    });
    if (typeof mpcKey !== 'string' || !mpcKey.startsWith('bls12381g2:'))
      throw new Error('MPC domain has no CKD key');
    if (this.o.mpcKey && this.o.mpcKey !== mpcKey)
      throw new Error('configured MPC key differs from the contract MPC domain');
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
  async sell(o: SellOptions) {
    const config = await getConfig(this.o.nearRpc, this.o.contractId);
    if (config.network !== this.o.network) throw new PayError('network_mismatch');
    const assets = { nearUsdc: config.nearUsdc, baseUsdc: config.usdc };
    const seller = parseIdentity(o.seller.identity);
    const fileId = o.fileId ?? `0x${randomHex(32)}`;
    const fileKey = crypto.getRandomValues(new Uint8Array(32));
    const s = await sealWithKey(fileKey, o.data, {
      fileId: bytes(fileId, 32),
      name: o.name,
      mime: o.mime,
      authKind: identityKind(seller) as 0 | 1 | 2,
      ...(o.previewLen === undefined ? {} : { previewLen: o.previewLen }),
    });
    const recipients = o.near.recipients
      .map((r) => ({ ...r, identity: parseIdentity(r.identity) }))
      .sort((a, b) => compare(encodeIdentity(a.identity), encodeIdentity(b.identity)));
    const remainder = recipients.findIndex(
      (r) => identityJson(r.identity) === identityJson(o.near.remainder),
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
    let baseSplit: SellRecord['baseSplit'];
    if (o.base) {
      if (recipients.some((r) => r.identity.kind !== 'evm'))
        throw new TypeError('Base split requires only EVM recipients');
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
      id: `sell:${fileId}`,
      revision: 0,
      terms,
      ...(baseSplit ? { baseSplit } : {}),
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
  async resumeSell(o: {
    fileId: string;
    data: Uint8Array;
    seller: IdentityWallet;
    publish: SellOptions['publish'];
  }) {
    const job = await this.sells.load(`annon/sell/${o.fileId}`);
    if (!job) throw new Error('no saved sell job');
    if (job.published) {
      await this.o.writeBackup(job.id, await exportSell(job, this.o.backupSecret));
      throw new Error('sell already published; secrets cleared');
    }
    if (!job.fileKey || !job.sellerSecret) throw new Error('sell job has no file key');
    if (
      job.terms.contract !== this.o.contractId ||
      identityJson(job.terms.seller) !== identityJson(o.seller.identity)
    )
      throw new Error('sell job identity mismatch');
    await this.o.writeBackup(job.id, await exportSell(job, this.o.backupSecret));
    const s = await sealWithKey(bytes(job.fileKey, 32), o.data, {
      fileId: bytes(o.fileId, 32),
      name: job.name,
      mime: job.mime,
      authKind: identityKind(job.terms.seller) as 0 | 1 | 2,
      previewLen: job.previewLen,
    });
    if (hex(s.cipherHash) !== job.terms.cipher_hash)
      throw new Error('original data cipher hash mismatch');
    const registered = await getFile(this.o.nearRpc, this.o.contractId, o.fileId);
    if (registered && registered.termsHash !== termsHash(job.terms, assetsFor(job.terms)))
      throw new Error('registered sell job mismatch');
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
      throw new Error('not the registered seller');
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
  private async finishSell(
    job: SellRecord,
    s: Awaited<ReturnType<typeof sealWithKey>>,
    seller: IdentityWallet,
    publish: SellOptions['publish'],
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
          await this.call('register', { args, ...(auth ? { auth } : {}) }, seller),
          key.secret,
          fileId,
        );
      }
      const current = await this.sells.load(`annon/sell/${fileId}`);
      if (!current) throw new Error('sell job missing');
      const next = { ...current, revision: current.revision + 1, ckdSecret: hex(ckd) };
      if (!(await this.sells.compareAndSet(`annon/sell/${fileId}`, current, next)))
        throw new PayError('store_conflict');
    }
    const file = await s.finish({
      contractId: this.o.contractId,
      ckdSecret: ckd,
      seller: job.terms.seller,
      ...(seller.identity.kind === 'near'
        ? {}
        : {
            sign: async (text: string) => {
              const a = await this.auth(seller, text);
              if (!a) throw new Error('missing header authorization');
              const signature = bytes(a.sig, seller.identity.kind === 'evm' ? 65 : 64);
              return seller.identity.kind === 'solana'
                ? { signature, signedMessage: new TextEncoder().encode(text) }
                : signature;
            },
          }),
    });
    const headerLen = new DataView(file.buffer, file.byteOffset).getUint32(8);
    const header = file.subarray(0, headerLen);
    if (seller.identity.kind === 'near')
      await this.call(
        'publish_header',
        { file_id: fileId, header_hash: hex(await sha256(header.subarray(0, headerLen - 65))) },
        seller,
      );
    await publish({ file, header, terms: job.terms });
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
      preview: s.preview,
    };
  }
  async buy(o: BuyOptions): Promise<Bought> {
    if (typeof o.maxPrice !== 'bigint' || o.maxPrice <= 0n || o.maxPrice >= 2n ** 128n)
      throw new TypeError('maxPrice must be a positive human-approved cap');
    const f = await this.file(o.fileId, true);
    if (f.moderator !== null && !(o.moderators ?? []).includes(f.moderator))
      throw new PayError('unknown_moderator');
    const checked = await inspectHeader(o.header, listing(o.fileId, f), this.o.contractId);
    if (!checked.usable) throw new PayError('file_invalid');
    let route: Purchase['route'] = 'near-usdc';
    if (o.payer?.identity.kind === 'evm' && f.terms.base && 'signTypedData' in o.payer) {
      const h = await head(this.o.baseRpc);
      if (
        !(await hasCode(this.o.baseRpc, o.payer.identity.id, h.number)) &&
        (await balanceOf(this.o.baseRpc, f.terms.base.usdc, o.payer.identity.id, h.number)) >=
          BigInt(f.terms.base.price)
      )
        route = 'base-usdc';
    }
    const price = route === 'base-usdc' && f.terms.base ? f.terms.base.price : f.terms.near.price;
    if (BigInt(price) > o.maxPrice) throw new PayError('price_above_max');
    if (route === 'near-usdc' && o.payer?.identity.kind !== 'near' && !o.origin)
      throw new TypeError('a 1Click origin is required for cross-chain payment');
    const recovery = parseIdentity(o.recovery.identity);
    const key = oneTimeKey();
    const p: Purchase = {
      version: 2,
      refund: parseIdentity(o.refund),
      network: route === 'base-usdc' ? 'eip155:8453' : this.o.network,
      contract: this.o.contractId,
      route,
      asset: route === 'base-usdc' && f.terms.base ? f.terms.base.usdc : f.terms.near.token,
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
          throw new Error('NEAR recovery requires an account ownership proof before payment');
        await w.proveControl(proofText, { contractId: this.o.contractId, nearRpc: this.o.nearRpc });
      } else await this.auth(o.recovery, proofText);
    };
    const deferProof = route === 'near-usdc' && o.payer?.identity.kind !== 'near' && o.onQuote;
    if (!deferProof) await proveRecovery();
    if (route === 'base-usdc') {
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
      const result = await authorize(q, {
        purchase: p,
        buyerSecret: key.secret,
        wallet: { address: payer.identity.id, signTypedData: (t) => payer.signTypedData(t) },
        store: this.store,
      });
      if (o.submitBase) await o.submitBase(result.header);
      return { route, record: result.purchase, payment: result.header };
    }
    const headerHash = hex(checked.headerHash);
    let record: PurchaseRecord = {
      schemaVersion: 2,
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
    if (!(await this.store.compareAndSet(purchaseKey(id), null, record)))
      throw new PayError('store_conflict');
    if (o.payer?.identity.kind === 'near') {
      try {
        await asNear(o.payer).transferPurchase(message, assets);
      } catch (error) {
        if (!(error instanceof TransactionUncertain)) throw error;
        const next: PurchaseRecord = {
          ...record,
          revision: record.revision + 1,
          nearSubmission: { state: 'uncertain', txHash: error.txHash },
        };
        if (!(await this.store.compareAndSet(purchaseKey(id), record, next)))
          throw new TransactionUncertain(error.txHash, id);
        return { route, record: next, uncertain: { purchaseId: id, txHash: error.txHash } };
      }
      return { route, record };
    }
    if (!o.origin) throw new TypeError('a 1Click origin is required for cross-chain payment');
    const quote = await (o.oneClick ?? new OneClick()).quote(message, o.origin);
    const next = { ...record, revision: record.revision + 1, quote };
    if (!(await this.store.compareAndSet(purchaseKey(id), record, next)))
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
    return { route, record, instructions: quote.deposit };
  }
  /** Resume a paid Base purchase before any host download, which requires a final grant. */
  async accept(record: PurchaseRecord | undefined, id = record?.id): Promise<boolean> {
    if (!id) throw new TypeError('missing purchase id');
    if (await getPurchase(this.o.nearRpc, this.o.contractId, id)) return true;
    if (record?.purchase.route !== 'base-usdc') return false;
    if (!this.o.baseRpc) throw new Error('configure baseRpc to resume a Base purchase');
    const next = await nextStep(record, {
      nearRpc: this.o.nearRpc,
      baseRpc: this.o.baseRpc,
      store: this.store,
    });
    if (next.step === 'unlock') {
      const answer = await this.call('unlock', { args: next.args });
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
    if (!o.record && !o.recovery)
      throw new TypeError('a saved purchase or recovery grant is required');
    const r = o.recovery;
    if (r && r.grant === null) throw new Error('recovery grant is not final');
    const id = r?.purchase_id ?? o.record?.id;
    if (!id) throw new TypeError('missing purchase id');
    if (!(await this.accept(o.record, id)))
      throw new PayError('settlement_processing', 'purchase not accepted; check status and resume');
    const fileId = r?.file_id ?? o.record?.purchase.file_id;
    if (!fileId) throw new TypeError('missing file id');
    const grant = r?.grant ?? 0;
    const secretHex = r?.buyerSecret ?? o.record?.buyerSecret;
    if (!secretHex) throw new TypeError('missing buyer secret');
    const secret = bytes(secretHex, 32);
    const final = await getPurchase(this.o.nearRpc, this.o.contractId, id);
    const g = await getGrant(this.o.nearRpc, this.o.contractId, id, grant);
    if (
      !final ||
      final.file_id !== fileId ||
      !g ||
      hex(keyFromSecret(secret).publicKeyBytes) !== g.buyer_key
    )
      throw new Error('saved key does not match the final grant');
    const f = await this.file(fileId);
    const inspected = await inspectHeader(
      o.file.subarray(0, new DataView(o.file.buffer, o.file.byteOffset).getUint32(8)),
      listing(fileId, f),
      this.o.contractId,
    );
    if (o.record && hex(inspected.headerHash) !== o.record.checkedHeaderHash)
      throw new Error('header differs from the checked purchase header');
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
    return openPay2(o.file, {
      contractId: this.o.contractId,
      listing: listing(fileId, f),
      ckdSecret: async () => ckd,
    });
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
          throw new Error('purchase recovery identity mismatch');
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
        if (grant === null) throw new Error('reopen grant is not final; resume the saved recovery');
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
      throw new Error('not the registered seller');
    const args = { file_id: o.fileId, key: null, deadline: this.now() + 540 };
    const auth = await this.auth(o.seller, stopSalesText(this.o.contractId, args, f.seller));
    await this.call('stop_sales', { args, ...(auth ? { auth } : {}) }, o.seller);
  }
}
