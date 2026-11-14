/** Runs one CLI command against the SDK once config, trust and signer are resolved. */
// The imports keep node/adapter.ts's original order, bare ones included, so modules initialize as before.
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Annon, type AnnonOptions } from '../api/annon.js';
import { download, secureUrl } from '../download/download.js';
import '../download/proof.js';
import { inspect, inspectHeader, MAX_HEADER, parseHeader } from '../envelope/pay2.js';
import { AnnonError, type AnnonErrorCode, isAnnonErrorCode, isTransient } from '../errors.js';
import {
  fileStorageBalance,
  getConfig,
  getFile,
  getPurchase,
  isStorageRequired,
  txOutcome,
} from '../near/rpc.js';
import { parseRetryAfterMs, sleep } from '../net/retry.js';
import { OneClick } from '../oneclick/oneclick.js';
import {
  type EncryptedRecord,
  encryptedPurchaseStore,
  encryptedRecoveryStore,
  importPurchase,
  importRecovery,
  type RecoveryRecord,
} from '../pay/backup.js';
import { type PaymentSummary, type PurchaseRecord, purchaseKey } from '../pay/purchase.js';
import { fileStore } from '../pay/store-node.js';
import '../pay/x402.js';
import { checkBaseSponsorship } from '../relay/capabilities.js';
import { type ProtocolFee, protocolFeeAboveMax } from '../relay/fees.js';
import { bytes, hex } from '../settle-near/codec.js';
import { identityJson } from '../settle-near/identity.js';
import { TransactionUncertain } from '../wallet/uncertain.js';
import type { NearWallet } from '../wallet/wallet.js';
import { fundFileStorage } from '../wallet/wallet.js';
import './agent.js';
import './browser-login.js';
import type { startBrowserSession } from './browser-login.js';
import { type BudgetRecord, reserveSpend } from './budget.js';
import type { Input } from './cli.js';
import { loadConfig, type TrustPrompt, trustContract } from './config.js';
import { AdapterError, publicError, usage } from './errors.js';
import { fileSource, newOutput, withOutput, withSpool, writeBackup, writeStream } from './io.js';
import './keychain.js';
import type { Keychain } from './keychain.js';
import './paths.js';
import {
  humanPaymentTerms,
  quotedSource,
  type SourcePayment,
  savedPayment,
  validatePaymentToken,
} from './payment-terms.js';
import { claimPurchase, type PurchaseGuard } from './purchase-guard.js';
import { resourceAllowed } from './resources.js';
import { retryGate } from './retry-gate.js';
import { shareHost } from './sharing.js';
import { selectedShopRules } from './shops.js';
import './signer-wallet.js';
import './signing.js';
import {
  type Environment,
  identity,
  type LocalWallet,
  loadWallet,
  readBackupSecret,
} from './wallets.js';

// Modules split out of the adapter load after its original imports, so initialization order is unchanged.

import { backupPath, fail, isId } from './adapter-checks.js';
import { amount, nearAmount } from './amounts.js';
import { offer, requestOptions, resourceHeader, response } from './offers.js';
import { originFor } from './origin.js';

export interface Dependencies {
  /** Server-owned policy; never taken from tool arguments. */
  agent?: boolean;
  keychain?: Keychain;
  browser?: typeof startBrowserSession;
  paymentTerms?: (terms: unknown) => void;
  browserApprovals?: boolean;
  sdk?: (
    options: AnnonOptions,
  ) => Pick<
    Annon,
    | 'fund'
    | 'sell'
    | 'buy'
    | 'open'
    | 'openTo'
    | 'recover'
    | 'stop'
    | 'store'
    | 'accept'
    | 'resumeSell'
  > &
    Partial<Pick<Annon, 'share' | 'resumeShare'>>;
  wallet?: typeof loadWallet;
  file?: typeof getFile;
  purchase?: typeof getPurchase;
  fetch?: typeof fetch;
  prompt?: TrustPrompt;
  notify?: (message: string) => void;
  wait?: (ms: number) => Promise<void>;
}
interface Resource {
  id: string;
  revision: number;
  contractId: string;
  header: string;
  url?: string;
}
function createCoreAdapter(env: Environment = process.env, d: Dependencies = {}) {
  const fetcher = d.fetch ?? globalThis.fetch;
  const wait = d.wait ?? sleep;
  return async (o: Input): Promise<Record<string, unknown>> => {
    const c = await loadConfig(o, env, false, d.agent);
    await trustContract(
      c,
      o.trustContract === true || c.trustContract === true,
      o.json || d.agent ? undefined : d.prompt,
    );
    const readListing = async (fileId: string) => {
      const f = await (d.file ?? getFile)(c.nearRpc, c.contractId, fileId);
      if (!f) return fail('unknown_file', 'No registered file exists at this contract.');
      if (f.takenDown) return fail('taken_down', 'The file has been taken down.');
      if (f.terms.network !== c.network || f.terms.contract !== c.contractId)
        throw new Error('deployment mismatch');
      return {
        f,
        listing: {
          fileId,
          cipherHash: f.cipherHash,
          seller: f.seller,
          ...(f.headerHash ? { publishedHeaderHash: f.headerHash } : {}),
        },
      };
    };
    const paymentDetails = async (
      load: () => Promise<PurchaseRecord | null | undefined>,
    ): Promise<{ route?: PaymentSummary['route']; payment?: PaymentSummary }> => {
      try {
        const record = await load();
        if (
          !record ||
          record.purchase.contract !== c.contractId ||
          record.terms.contractId !== c.contractId
        )
          return {};
        const payment = savedPayment(record);
        return { route: payment.route, payment };
      } catch {
        // Optional reporting must not block an accepted purchase or a successful open.
        return {};
      }
    };
    const pendingSetup = async (purchaseId: string) => {
      if (d.agent) await retryGate({ ...c, purchaseId }).defer('settlement_pending', 30);
      return {
        purchaseId,
        state: 'pending',
        next: 'Check the payment; configure readable saved state and the matching backup secret to resume Base unlock. 1Click SUCCESS alone is not acceptance.',
      };
    };
    if (o.command === 'budget') {
      if (!o.target || !isId(o.target)) throw usage();
      const budget = await fileStorageBalance(c.nearRpc, c.contractId, o.target);
      return {
        fileId: o.target,
        available: budget.available.toString(),
        admissionRequirement: budget.admissionRequirement.toString(),
      };
    }
    if (o.command === 'verify') {
      if (!o.target) throw usage();
      const remote = /^https?:/.test(o.target);
      const data = remote
        ? await resourceHeader(o.target, c, fetcher)
        : new Uint8Array(await readFile(o.target));
      const parsed = parseHeader(new Uint8Array(data.subarray(0, MAX_HEADER)));
      const fileId = hex(parsed.fileId);
      const { listing } = await readListing(fileId);
      const result = await (remote
        ? inspectHeader(data, listing, c.contractId)
        : inspect(data, listing, c.contractId));
      if (!result.usable)
        return fail('no_usable_stanza', 'The file has no key stanza for the trusted contract.');
      return {
        fileId,
        verified: true,
        checked: remote ? 'header' : 'header-and-body',
        contractId: c.contractId,
      };
    }
    if (o.command === 'status') {
      if (!o.target || !isId(o.target)) throw usage();
      if (d.agent) await retryGate({ ...c, purchaseId: o.target }).check();
      const p = await (d.purchase ?? getPurchase)(c.nearRpc, c.contractId, o.target);
      if (p)
        return {
          purchaseId: o.target,
          state: 'accepted',
          fileId: p.file_id,
          grants: p.grants,
          next: 'open',
          ...(await paymentDetails(async () =>
            encryptedPurchaseStore(
              fileStore<EncryptedRecord>(join(c.stateDir, 'records')),
              await readBackupSecret(o, env),
            ).load(purchaseKey(o.target as string)),
          )),
        };
      if (!o.backupSecretFile && !env.ANNON_BACKUP_SECRET_FILE && !env.ANNON_BACKUP_SECRET)
        return pendingSetup(o.target);
    }
    const prepareBuy = async () => {
      if (!o.target) throw usage();
      if (d.agent && !/^https?:/.test(o.target))
        return fail(
          'resource_not_allowed',
          'Agent purchases require a secure resource URL; offer files are refused.',
          2,
        );
      const cap = o.maxPrice ?? c.maxPrice;
      if (!cap)
        return fail(
          'max_price_required',
          'Set --max-price, ANNON_MAX_PRICE or maxPrice in human configuration before buying.',
          2,
        );
      const maxPrice = BigInt(amount(cap));
      if (c.maxPrice && maxPrice > BigInt(amount(c.maxPrice)))
        return fail('price_above_max', 'The requested cap exceeds the configured maximum.', 2);
      const resource = /^https?:/.test(o.target) ? o.target : o.url;
      if (d.agent && (!resource || !resourceAllowed(c.allowedResources, resource)))
        return fail(
          'resource_not_allowed',
          'The resource URL is outside the configured agent policy.',
          2,
        );
      if (d.agent && (o.refundTo || o.fromChain || o.fromAsset))
        return fail('origin_not_allowed', 'Use a human-configured origin name.', 2);
      const found = await offer(o.target, c, fetcher, undefined, o.url);
      const { f, listing } = await readListing(found.fileId);
      await inspectHeader(found.header, listing, c.contractId);
      if (o.route === 'base' && !f.terms.base) throw new AnnonError('route_unavailable');
      return { found, f, maxPrice };
    };
    const preparedBuy = o.command === 'buy' ? await prepareBuy() : undefined;
    const hostedOrigin = o.command === 'share' ? await shareHost(c, o.shop, fetcher) : undefined;
    const shopRules = o.command === 'share' ? await selectedShopRules(c, o.shop, fetcher) : {};
    let selected: LocalWallet | undefined;
    if (o.command === 'fund') {
      if (d.agent) return fail('human_only', 'File funding requires a human CLI session.', 2);
      if (!o.target || !isId(o.target)) throw usage();
      const text = o.fundAmount;
      if (!text) return fail('invalid_arguments', 'Provide the NEAR amount to allocate.', 2);
      const owner = await (d.wallet ?? loadWallet)({ ...o, network: c.network }, env, c.nearRpc);
      selected = owner;
      if (owner.identity.kind === 'near') {
        if (!('call' in owner))
          return fail('near_wallet_required', 'File funding requires a NEAR wallet.', 2);
        await fundFileStorage(owner as NearWallet, c.contractId, o.target, nearAmount(text));
        return { fileId: o.target, fundedNear: text };
      }
    }
    let secret: Uint8Array;
    try {
      secret = await readBackupSecret(o, env);
    } catch (error) {
      if (o.command === 'status' && o.target) return pendingSetup(o.target);
      throw error;
    }
    const storeDir = join(c.stateDir, 'records');
    const resourceDir = join(c.stateDir, 'resources');
    if (o.command !== 'status')
      for (const dir of [storeDir, resourceDir, join(c.stateDir, 'backups')])
        await mkdir(dir, { recursive: true, mode: 0o700 });
    const rawStore = fileStore<EncryptedRecord>(storeDir);
    const resources = fileStore<Resource>(resourceDir);
    const wallet = async () => {
      selected ??= await (d.wallet ?? loadWallet)({ ...o, network: c.network }, env, c.nearRpc);
      return selected;
    };
    const send: NonNullable<AnnonOptions['send']> = async (method, args, owner) => {
      if (method === 'unlock' && !c.baseRpc)
        return fail('base_rpc_required', 'Configure baseRpc before resuming a Base purchase.', 2);
      // The relayer gets the full request; the contract call, and so the outcome check, never
      // carries the relayer-only fields.
      const {
        baseSplit: _baseSplit,
        hostingReservation: _hostingReservation,
        ...envelope
      } = args as Record<string, unknown>;
      const funding = envelope.args as { file_id: string; amount: string };
      const wireArgs =
        method === 'fund_file_storage'
          ? { file_id: funding.file_id, amount: funding.amount }
          : envelope;
      const signer =
        owner ?? (selected?.identity.kind === 'near' ? (selected as NearWallet) : undefined);
      let submitted: { txHash: string; signer: string } | undefined;
      const call = async () => {
        if (signer) return signer.call({ receiverId: c.contractId, method, args: wireArgs });
        if (!c.relayer)
          return fail(
            'transport_required',
            'Configure a relayer URL or select a NEAR wallet for transaction calls.',
            2,
          );
        if (!submitted) {
          const r = await fetcher(new URL('/v1/relay', secureUrl(c.relayer)), {
            ...requestOptions,
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(method === 'claim_key' ? { method, args } : { method, ...args }),
            signal: AbortSignal.timeout(60000),
          });
          if (![200, 202].includes(r.status)) {
            const body = (await r.json().catch(() => null)) as Record<string, unknown> | null;
            const fallback =
              r.status === 425
                ? 'settlement_pending'
                : r.status === 429
                  ? 'relayer_rate_limited'
                  : r.status === 503
                    ? 'relayer_unavailable'
                    : 'operation_failed';
            const code = isAnnonErrorCode(body?.error) ? body.error : fallback;
            const delay = parseRetryAfterMs(r.headers.get('Retry-After'));
            const safe = publicError({
              ...(body && isAnnonErrorCode(body.error) ? body : {}),
              code,
              ...(delay !== undefined ? { retryAfterSeconds: Math.ceil(delay / 1000) } : {}),
            });
            const error = Object.assign(
              new AdapterError(safe.code, safe.message, safe.exitCode),
              safe,
            );
            if (code === 'budget') throw error;
            if (code === 'settlement_pending')
              throw Object.assign(error, { safetyDelayMs: (safe.retryAfterSeconds ?? 30) * 1000 });
            const waitMs =
              delay ??
              (safe.retryAfterSeconds === undefined ? 5000 : safe.retryAfterSeconds * 1000);
            if ([429, 503].includes(r.status) && waitMs <= 60000)
              throw Object.assign(error, { retryAfterMs: waitMs });
            throw error;
          }
          const body = (await r.json()) as { txHash?: string; signer?: string; pending?: boolean };
          if (r.status === 202 && body.pending === true)
            throw new AdapterError('in_flight', 'Relayer operation is pending.', 4);
          if (
            typeof body.txHash !== 'string' ||
            !body.txHash ||
            typeof body.signer !== 'string' ||
            !body.signer
          )
            throw new Error('invalid relayer transaction response');
          submitted = { txHash: body.txHash, signer: body.signer };
        }
        const tx = submitted;
        const result = await txOutcome(c.nearRpc, tx.txHash, tx.signer, c.contractId, 'FINAL', {
          method,
          args: wireArgs,
        });
        if (result.state === 'released') return result.answer;
        if (result.state === 'done') return result.value;
        if ('reason' in result && isStorageRequired(result.reason))
          throw new AdapterError(
            'storage_required',
            'Prepay Annon storage with the SDK storageDeposit helper, then resume the saved operation.',
          );
        throw new Error(`transaction ${result.state}`);
      };
      // Timeouts repeat only idempotent releases; explicit admission refusals have their own cap.
      let timeouts = 0;
      let pending = 0;
      let admissions = 0;
      let safetyWaits = 0;
      for (;;) {
        try {
          return await call();
        } catch (error) {
          if (o.command === 'share' && submitted) {
            if (error instanceof AnnonError && !isTransient(error))
              throw Object.assign(error, { txHash: submitted.txHash });
            throw new TransactionUncertain(submitted.txHash);
          }
          if (error instanceof AdapterError && 'retryAfterMs' in error) {
            if (admissions++ >= 3) throw error;
            await wait((error as AdapterError & { retryAfterMs: number }).retryAfterMs);
            continue;
          }
          if (
            method === 'unlock' &&
            error instanceof AdapterError &&
            error.code === 'settlement_pending'
          ) {
            if (o.command === 'status') throw error;
            if (o.command !== 'open' || d.agent || o.json) throw error;
            const planned = [10000, 20000, 30000, 40000, 60000][safetyWaits++];
            const minimum = (error as AdapterError & { safetyDelayMs?: number }).safetyDelayMs ?? 0;
            if (planned === undefined || minimum > 60000) throw error;
            const delay = Math.max(planned, Number.isFinite(minimum) ? minimum : 0);
            d.notify?.(`Base settlement pending; retrying unlock in ${delay / 1000} seconds.`);
            await wait(delay);
            continue;
          }
          const inFlight =
            error instanceof AdapterError && ['in_flight', 'duplicate'].includes(error.code);
          const timeout =
            isTransient(error) || (error instanceof Error && error.name === 'TimeoutError');
          if (
            !['unlock', 'reopen', 'claim_key'].includes(method) ||
            (!inFlight && !timeout) ||
            (inFlight ? pending++ >= 36 : timeouts++ >= 2)
          )
            throw error;
          if (!o.json) d.notify?.('Key release pending; retrying the saved request.');
          await wait(inFlight ? 5000 : 1000 * 2 ** (timeouts - 1));
        }
      }
    };
    const sdk = (d.sdk ?? ((options) => new Annon(options)))({
      ...c,
      rawStore,
      fetch: fetcher,
      backupSecret: secret,
      send,
      ...(c.relayer
        ? {
            sponsorship: async () => {
              const reply = await response(new URL('/v1/capabilities', c.relayer).href, fetcher);
              if (!reply.ok) throw new Error('relayer capabilities unavailable');
              const cap = (await reply.json()) as {
                contract?: string;
                disabled?: boolean;
                fee?: ProtocolFee;
              };
              if (cap.contract !== c.contractId || cap.disabled || !cap.fee)
                throw new Error('invalid relayer sponsorship policy');
              if (
                (d.agent || o.json) &&
                o.price &&
                protocolFeeAboveMax(amount(o.price), cap.fee, c.maxProtocolFee)
              )
                return fail(
                  'protocol_fee_above_max',
                  'The advertised protocol fee exceeds maxProtocolFee. Review the fee in human configuration.',
                  2,
                );
              return { fee: cap.fee };
            },
          }
        : {}),
      writeBackup: (id, encrypted) => writeBackup(backupPath(c, id), encrypted),
    });
    if (o.command === 'fund') {
      if (!o.target || !o.fundAmount) throw usage();
      await sdk.fund(o.target, nearAmount(o.fundAmount), await wallet());
      return { fileId: o.target, fundedNear: o.fundAmount };
    }
    if (o.command === 'status') {
      if (!o.target) throw usage();
      let record: PurchaseRecord | null;
      try {
        record = await sdk.store.load(purchaseKey(o.target));
      } catch {
        return pendingSetup(o.target);
      }
      if (!record) return pendingSetup(o.target);
      if (o.wallet || env.ANNON_WALLET) await wallet();
      let accepted: boolean;
      try {
        accepted = await sdk.accept(record ?? undefined, o.target);
      } catch (error) {
        const safe = publicError(error);
        if (d.agent && safe.retryAfterSeconds !== undefined)
          await retryGate({ ...c, purchaseId: o.target }).defer(safe.code, safe.retryAfterSeconds);
        throw error;
      }
      if (d.agent && !accepted)
        await retryGate({ ...c, purchaseId: o.target }).defer('settlement_pending', 30);
      return {
        purchaseId: o.target,
        state: accepted ? 'accepted' : 'pending',
        ...(await paymentDetails(async () => record)),
        ...(accepted ? {} : { retryAfterSeconds: 30 }),
        next: accepted
          ? 'open'
          : 'Check the payment and retry status. 1Click SUCCESS alone is not acceptance.',
      };
    }
    if (o.command === 'share') {
      if (!o.target || !hostedOrigin || !sdk.share || !sdk.resumeShare) throw usage();
      const seller = await wallet();
      const hosting = {
        origin: hostedOrigin,
        ...(seller.signUpload ? { signUpload: seller.signUpload } : {}),
        spool: <T>(
          stream: ReadableStream<Uint8Array>,
          use: (source: import('../envelope/replay.js').ReplayableSource) => Promise<T>,
        ) => withSpool(join(c.stateDir, 'hosted'), stream, use),
      };
      const data = await fileSource(o.target);
      if (o.resume) {
        if (
          !isId(o.resume) ||
          [o.price, o.title, o.description, o.storageBudget, o.listingStorage].some(
            (v) => v !== undefined,
          )
        )
          throw usage();
        return {
          ...(await sdk.resumeShare({ fileId: o.resume, data, seller, hosting })),
          ...shopRules,
        };
      }
      if (!o.price) throw usage();
      const near = seller.identity.kind === 'near';
      if (
        near &&
        (d.agent || o.json) &&
        (!(d.agent ? c.listingStorage : (o.listingStorage ?? c.listingStorage)) ||
          !(d.agent ? c.storageBudget : (o.storageBudget ?? c.storageBudget)))
      )
        throw new AdapterError(
          'storage_required',
          'Configure listingStorage and storageBudget, or provide --listing-storage and --storage-budget in a human CLI session, before noninteractive NEAR sharing.',
          2,
        );
      const listingStorage = near
        ? nearAmount(
            d.agent
              ? (c.listingStorage ?? '0.01')
              : (o.listingStorage ?? c.listingStorage ?? '0.01'),
          )
        : undefined;
      const storageBudget = near
        ? nearAmount(
            d.agent ? (c.storageBudget ?? '0.05') : (o.storageBudget ?? c.storageBudget ?? '0.05'),
          )
        : undefined;
      if (!near && (o.listingStorage || o.storageBudget)) throw usage();
      return {
        ...shopRules,
        ...(await sdk.share({
          data,
          name: basename(o.target),
          mime: 'application/octet-stream',
          seller,
          price: amount(o.price),
          hosting,
          ...(o.title !== undefined ? { title: o.title } : {}),
          ...(o.description !== undefined ? { description: o.description } : {}),
          ...(listingStorage !== undefined ? { listingStorage } : {}),
          ...(storageBudget !== undefined ? { storageBudget } : {}),
          onSplit: async (split, fee, aboveMaximum) => {
            if (aboveMaximum && (d.agent || o.json))
              throw new AdapterError(
                'protocol_fee_above_max',
                'Review maxProtocolFee in human configuration.',
                2,
              );
            const terms = {
              seller: seller.identity,
              host: hostedOrigin,
              contract: c.contractId,
              price: split.price,
              split,
              fee: fee ?? null,
              listingStorage: listingStorage?.toString() ?? null,
              purchaseStorage: storageBudget?.toString() ?? null,
              registerDeposit: '0',
            };
            d.paymentTerms?.(terms);
            if (
              !d.agent &&
              !o.json &&
              !(await d.prompt?.(`${JSON.stringify(terms)}\nType yes to share: `))
            )
              throw new AdapterError('sale_not_approved', 'Sale terms were not approved.', 3);
          },
          // The configured secret is separate from the durable backup files.
          confirmBackup: async () => {},
        })),
      };
    }
    if (o.command === 'sell') {
      if (!o.target) throw usage();
      const seller = await wallet();
      const output = o.output ?? `${o.target}.pay2`;
      await newOutput(output);
      const publish = async (file: { file: ReadableStream<Uint8Array> }) => {
        await writeStream(output, file.file);
      };
      if (o.resume) {
        if (!isId(o.resume) || o.price || o.split || o.base || o.moderator || o.storageBudget)
          throw usage();
        const result = await sdk.resumeSell({
          fileId: o.resume,
          data: await fileSource(o.target),
          seller,
          publish,
        });
        return {
          fileId: result.terms.file_id,
          file: output,
          terms: result.terms,
          ...(result.baseSplit ? { baseSplit: result.baseSplit } : {}),
        };
      }
      if (!o.price || !o.split) throw usage();
      if (o.base && !c.baseRpc)
        return fail('base_rpc_required', 'Configure baseRpc before creating a Base listing.', 2);
      const recipients = o.split.split(',').map((entry) => {
        const at = entry.lastIndexOf(':');
        return { identity: identity(entry.slice(0, at)), bps: Number(entry.slice(at + 1)) };
      });
      if (
        !recipients.length ||
        recipients.length > 8 ||
        recipients.some((r) => !Number.isInteger(r.bps) || r.bps <= 0 || r.bps > 10000) ||
        recipients.reduce((n, r) => n + r.bps, 0) !== 10000 ||
        new Set(recipients.map((r) => identityJson(r.identity))).size !== recipients.length
      )
        throw usage();
      const remainder = recipients[0]?.identity;
      if (!remainder) throw usage();
      if (o.base && (!seller.sendBase || recipients.some((r) => r.identity.kind !== 'evm')))
        return fail(
          'base_wallet_required',
          'Base listings require an EVM wallet and EVM split recipients.',
          2,
        );
      const storageBudget = d.agent ? c.storageBudget : (o.storageBudget ?? c.storageBudget);
      const selfNear = seller.identity.kind === 'near';
      if (o.storageBudget && !selfNear)
        return fail(
          'invalid_arguments',
          '--storage-budget requires a self-registered NEAR sell.',
          2,
        );
      if (selfNear && !storageBudget)
        d.notify?.(
          'This self-registered file has no purchase storage budget. Fund it before NEAR or 1Click purchases.',
        );
      const result = await sdk.sell({
        data: await fileSource(o.target),
        name: basename(o.target),
        mime: 'application/octet-stream',
        seller,
        near: { price: amount(o.price), recipients, remainder },
        ...((!c.relayer || seller.identity.kind === 'near') &&
        (d.agent ? c.storageBudget : (o.storageBudget ?? c.storageBudget))
          ? {
              storageBudget: nearAmount(
                (d.agent ? c.storageBudget : (o.storageBudget ?? c.storageBudget)) as string,
              ),
            }
          : {}),
        onSplit: async (split, fee, aboveMaximum) => {
          if (aboveMaximum && (d.agent || o.json))
            return fail(
              'protocol_fee_above_max',
              'The advertised protocol fee exceeds maxProtocolFee. Review the fee in human configuration.',
              2,
            );
          if (!c.relayer || seller.identity.kind === 'near') return;
          const description = [
            'Sponsored sale split:',
            ...(fee
              ? [
                  `Protocol fee: ${fee.fixed} USDC base units + ${fee.bps} bps.`,
                  ...(aboveMaximum ? ['This exceeds maxProtocolFee.'] : []),
                ]
              : []),
            ...split.recipients.map(
              (r, i) =>
                `${identityJson(r.identity)}: ${(r.bps / 100).toFixed(2)}%${i === split.remainder ? ' (rounding remainder)' : ''}`,
            ),
          ].join('\n');
          if (!d.agent && !o.json) {
            d.notify?.(description);
            if (!(await d.prompt?.(`${description}\nType yes to register: `)))
              return fail('sale_not_approved', 'Sale split was not approved.', 3);
          }
        },
        ...(o.base
          ? {
              base: {
                price: amount(o.price),
                sendTransaction: async (call) => {
                  await seller.sendBase?.(call, c.baseRpc);
                },
              },
            }
          : {}),
        ...(o.moderator ? { moderator: o.moderator } : {}),
        publish,
      });
      return {
        fileId: result.terms.file_id,
        file: output,
        terms: result.terms,
        ...(result.baseSplit ? { baseSplit: result.baseSplit } : {}),
        ...(selfNear && !storageBudget
          ? {
              warnings: [
                'This file has no purchase storage budget. Fund it before NEAR or 1Click purchases.',
              ],
            }
          : {}),
      };
    }
    if (o.command === 'buy') {
      if (!preparedBuy) throw usage();
      const { found, f, maxPrice } = preparedBuy;
      const buyer = await wallet();
      const route =
        o.route ??
        (o.fromChain || o.origin ? '1click' : buyer.identity.kind === 'near' ? 'near' : 'base');
      if (d.agent && route === '1click' && !o.origin)
        return fail('origin_not_allowed', 'Use a human-configured origin name.', 2);
      if (route === 'near' && buyer.identity.kind !== 'near')
        return fail(
          'near_wallet_required',
          'The direct NEAR route requires a NEAR wallet; use 1click for another chain.',
          2,
        );
      if (route === 'base' && !f.terms.base)
        throw new AdapterError(
          o.route ? 'route_unavailable' : 'origin_required',
          'This file has no direct Base route. Use --route 1click --from-chain base to pay from Base.',
          2,
        );
      if (route === 'base' && (buyer.identity.kind !== 'evm' || !('signTypedData' in buyer)))
        return fail('base_wallet_required', 'The Base route requires an EVM payment wallet.', 2);
      if (route === 'base' && !c.baseRpc)
        return fail('base_rpc_required', 'Configure baseRpc before a Base purchase.', 2);
      const origin = route === '1click' ? await originFor(o, env, buyer, fetcher, c) : undefined;
      const before = await resources.load(found.fileId);
      if (
        !(await resources.compareAndSet(found.fileId, before, {
          id: found.fileId,
          revision: (before?.revision ?? -1) + 1,
          contractId: c.contractId,
          url: found.url,
          header: hex(found.header),
        }))
      )
        throw new Error('resource conflict');
      const price = route === 'base' ? f.terms.base?.price : f.terms.near.price;
      if (!price || BigInt(price) > maxPrice)
        return fail('price_above_max', 'The registered price exceeds maxPrice.');
      const paymentConfig = await getConfig(c.nearRpc, c.contractId);

      const paymentTerms = {
        file: found.fileId,
        resource: found.url,
        network: route === 'base' ? 'eip155:8453' : c.network,
        route,
        price,
        recipients: f.terms.near.recipients,
        remainder: f.terms.near.remainder,
        baseRecipient: f.terms.base?.pay_to,
        token: route === 'base' ? f.terms.base?.usdc : f.terms.near.token,
      };
      if (paymentConfig.network !== c.network)
        return fail(
          'network_mismatch',
          'The contract network differs from the configured network.',
          2,
        );
      validatePaymentToken(paymentTerms, paymentConfig);
      const baseSponsorship =
        route === 'base'
          ? await checkBaseSponsorship({
              deployment: {
                network: c.network,
                contractId: c.contractId,
                nearUsdc: paymentConfig.nearUsdc,
                baseUsdc: paymentConfig.usdc,
              },
              file: f,
              baseRpc: c.baseRpc,
              relayer: c.relayer ?? '',
              fetch: fetcher,
            })
          : undefined;
      if (route !== 'base') {
        const budget = await fileStorageBalance(c.nearRpc, c.contractId, f.terms.file_id);
        if (budget.available < budget.admissionRequirement)
          return fail(
            'file_storage_low',
            'This file needs more purchase storage funding before a NEAR or 1Click payment.',
            2,
          );
      }
      if (origin && !d.agent && !d.browserApprovals && !o.json && !d.prompt)
        return fail(
          'confirmation_required',
          'Review and confirm the exact payment terms before paying.',
          3,
        );
      const confirmPayment = async (source?: SourcePayment) => {
        const review = { ...paymentTerms, ...(source ? { source } : {}) };
        d.paymentTerms?.(review);
        if (!d.agent && !d.browserApprovals) {
          d.notify?.(o.json ? JSON.stringify(review) : humanPaymentTerms(review, paymentConfig));
          if (!(await (o.json ? undefined : d.prompt)?.('Type yes to pay: ')))
            return fail(
              'confirmation_required',
              'Review and confirm the exact payment terms before paying.',
              3,
            );
        }
      };
      if (d.agent && c.dailyBudget === undefined)
        return fail('budget_required', 'Configure a daily budget before buying.', 2);
      const guardDir = join(c.stateDir, 'purchase-guards');
      await mkdir(guardDir, { recursive: true, mode: 0o700 });
      const known: string[] = [];
      for (const name of await readdir(storeDir)) {
        if (!/^[0-9a-f]{64}\.json$/.test(name)) continue;
        const envelope = JSON.parse(
          await readFile(join(storeDir, name), 'utf8'),
        ) as EncryptedRecord;
        if (!isId(envelope.id)) continue;
        const saved = await sdk.store.load(purchaseKey(envelope.id));
        if (
          saved?.purchase.file_id === found.fileId &&
          saved.purchase.contract === c.contractId &&
          saved.terms.network === (saved.purchase.route === 'base-usdc' ? 'eip155:8453' : c.network)
        )
          known.push(saved.id);
      }
      const guard = await claimPurchase(
        fileStore<PurchaseGuard>(guardDir),
        JSON.stringify([c.network, c.contractId, found.fileId]),
        {
          known,
          ...(o.force === undefined ? {} : { force: o.force }),
          live: async (id, claimUntil) => {
            const saved = await sdk.store.load(purchaseKey(id));
            if (await (d.purchase ?? getPurchase)(c.nearRpc, c.contractId, id)) return true;
            if (!saved) return Date.now() / 1000 < claimUntil;
            return (
              Number(saved.purchase.expires_at) > Date.now() / 1000 ||
              (saved.purchase.route === 'base-usdc' && saved.attempts.length > 0)
            );
          },
        },
      );
      let renewalError: unknown;
      const heartbeat = setInterval(() => {
        void guard.renew().catch((error: unknown) => {
          renewalError = error;
        });
      }, 30000);
      let refundBudget: (() => Promise<void>) | undefined;
      const reserve = async (spend: bigint) => {
        if (!d.agent) return;
        if (c.dailyBudget === undefined)
          return fail('budget_required', 'Configure a daily budget before buying.', 2);
        const budgetDir = join(c.stateDir, 'budgets');
        await mkdir(budgetDir, { recursive: true, mode: 0o700 });
        refundBudget = await reserveSpend(fileStore<BudgetRecord>(budgetDir), 'agent:USDC', spend, {
          daily: c.dailyBudget === '0' ? 0n : BigInt(amount(c.dailyBudget)),
        });
      };
      let completed = false;
      try {
        if (!origin || (o.json && !d.browserApprovals)) await confirmPayment();
        if (!origin) await reserve(BigInt(price));
        let source: SourcePayment | undefined;
        const bought = await sdk.buy({
          fileId: found.fileId,
          header: found.header,
          beforeSave: async (record) => {
            if (renewalError) throw renewalError;
            await guard.saved(record.id);
          },
          recovery: buyer,
          ...(baseSponsorship ? { baseSponsorship } : {}),
          route,
          refund: buyer.identity,
          ...(route === '1click' ? {} : { payer: buyer }),
          maxPrice,
          moderators: o.moderator ? [o.moderator] : (c.moderators ?? []),
          paymentRequired: found.pr,
          url: found.url,
          ...(origin
            ? {
                origin,
                oneClick: new OneClick({ fetch: fetcher }),
                onQuote: async (quote) => {
                  source = quotedSource(quote, origin.sourceAsset);
                  let spend = BigInt(price);
                  if (d.agent) {
                    const sourceAmount = BigInt(source.amount);
                    if (
                      origin.maxSourceAmount !== undefined &&
                      sourceAmount > BigInt(origin.maxSourceAmount)
                    )
                      return fail(
                        'price_above_max',
                        'The quoted source amount exceeds the configured origin cap.',
                        2,
                      );
                    if (source.symbol === 'USDC' && source.decimals !== undefined) {
                      const scale = 10n ** BigInt(source.decimals);
                      spend = (sourceAmount * 1000000n + scale - 1n) / scale;
                      if (spend > maxPrice)
                        return fail(
                          'price_above_max',
                          'The quoted source USDC amount exceeds maxPrice.',
                          2,
                        );
                    } else if (!origin.maxSourceAmount)
                      return fail(
                        'origin_not_allowed',
                        'Configure maxSourceAmount in source base units for this origin before buying.',
                        2,
                      );
                  }
                  await reserve(spend);
                  await confirmPayment(source);
                },
              }
            : {}),
          submitBase: async (payment) => {
            const r = await response(found.url, fetcher, { 'PAYMENT-SIGNATURE': payment });
            await r.body?.cancel();
            if (![200, 206, 402, 503].includes(r.status))
              throw new AdapterError(
                'host_payment_failed',
                `Payment submission failed: host HTTP ${r.status}. Keep the saved purchase and check status before retrying.`,
              );
          },
        });
        await guard.saved(bought.record.id);
        completed = true;
        let payment: ReturnType<typeof savedPayment> | undefined;
        try {
          payment = savedPayment(bought.record, source);
          const next = { ...bought.record, revision: bought.record.revision + 1, payment };
          await sdk.store.compareAndSet(purchaseKey(next.id), bought.record, next);
        } catch {
          // Keep the completed purchase when saving source details fails.
        }
        // Raw purchase records and signed payment payloads never cross the adapter boundary.
        return {
          purchaseId: bought.record.id,
          fileId: found.fileId,
          route: bought.route,
          ...(payment ? { payment } : {}),
          state: bought.uncertain
            ? 'uncertain'
            : bought.instructions
              ? 'deposit_required'
              : 'submitted',
          ...(bought.uncertain ? { txHash: bought.uncertain.txHash } : {}),
          backup: backupPath(c, bought.record.id),
          ...(bought.instructions ? { instructions: bought.instructions } : {}),
          ...(source ? { source } : {}),
          next: 'Fund the deposit if instructed, then check status and open this purchase.',
        };
      } catch (error) {
        // Only failures before the SDK returns can release a 1Click reservation.
        if (origin && !completed) await refundBudget?.().catch(() => {});
        throw error;
      } finally {
        clearInterval(heartbeat);
        if (completed) await guard.release().catch(() => {});
        else await guard.release();
      }
    }
    if (o.command === 'recover') {
      if (!o.recovery || (o.purchase && !isId(o.purchase))) throw usage();
      const errors: { purchaseId: string; code: AnnonErrorCode; message: string }[] = [];
      const recovered = await sdk.recover({
        onError: (purchaseId, error) => {
          const { code, message } = publicError(error);
          errors.push({ purchaseId, code, message });
        },
        wallet: await wallet(),
        ...(o.purchase ? { purchaseId: o.purchase } : {}),
      });
      return {
        errors,
        recovered: recovered.map((r) => ({
          purchaseId: r.purchase_id,
          fileId: r.file_id,
          grant: r.grant,
          backup: backupPath(c, r.id),
        })),
      };
    }
    if (o.command === 'stop') {
      if (!o.target || !isId(o.target)) throw usage();
      await sdk.stop({ fileId: o.target, seller: await wallet() });
      return { fileId: o.target, stopped: true };
    }
    if (o.command !== 'open' || !o.target || !o.output) throw usage();
    if (d.agent && o.url && !resourceAllowed(c.allowedResources, o.url))
      return fail('resource_not_allowed', 'The resource URL is outside the configured policy.', 2);
    await newOutput(o.output);
    const ref = o.purchase ?? o.target;
    let record: PurchaseRecord | undefined;
    let recovery: RecoveryRecord | undefined;
    if (isId(ref)) {
      recovery =
        (await encryptedRecoveryStore(rawStore, secret).load(`annon/recovery/${ref}`)) ?? undefined;
      if (!recovery || recovery.grant === null)
        record = (await sdk.store.load(purchaseKey(ref))) ?? undefined;
    } else {
      const encrypted = await readFile(ref, 'utf8');
      try {
        record = await importPurchase(encrypted, secret);
      } catch {
        recovery = await importRecovery(encrypted, secret);
      }
    }
    if (!record && !recovery)
      return fail(
        'purchase_required',
        'Provide a saved purchase ID or encrypted purchase/recovery backup.',
        2,
      );
    if (
      record &&
      (record.purchase.contract !== c.contractId || record.terms.contractId !== c.contractId)
    )
      throw new Error('backup contract mismatch');
    const fileId = recovery?.file_id ?? record?.purchase.file_id;
    if (!fileId) throw usage();
    if (o.wallet || env.ANNON_WALLET) await wallet();
    const purchaseId = recovery?.purchase_id ?? record?.id;
    if (!purchaseId) throw usage();
    const resource = await resources.load(fileId);
    const local = o.file ?? (o.purchase ? o.target : undefined);
    const remoteUrl = o.url ?? resource?.url;
    if (d.agent && !local && remoteUrl && !resourceAllowed(c.allowedResources, remoteUrl))
      return fail('resource_not_allowed', 'The resource URL is outside the configured policy.', 2);
    const settlementGate = retryGate({ ...c, purchaseId });
    const downloadGate =
      !local && remoteUrl
        ? retryGate({ ...c, purchaseId, fileId, host: new URL(remoteUrl).origin })
        : undefined;
    if (d.agent) {
      await settlementGate.check();
      await downloadGate?.check();
    }
    let accepted: boolean;
    try {
      accepted = await sdk.accept(record, purchaseId);
    } catch (error) {
      const safe = publicError(error);
      if (d.agent && safe.retryAfterSeconds !== undefined)
        await settlementGate.defer(safe.code, safe.retryAfterSeconds);
      throw error;
    }
    if (!accepted) {
      if (d.agent) await settlementGate.defer('settlement_pending', 30);

      throw new AdapterError(
        'settlement_pending',
        publicError({ code: 'settlement_pending' }).message,
        4,
      );
    }
    let readFileSource: () => Awaited<ReturnType<typeof fileSource>> | ReadableStream<Uint8Array>;
    if (local) {
      const source = await fileSource(local);
      readFileSource = () => source;
    } else {
      const url = o.url ?? resource?.url;
      if (!url)
        return fail('file_required', 'Provide --file or --url to open this saved purchase.', 2);
      if (d.agent && !resourceAllowed(c.allowedResources, url))
        return fail(
          'resource_not_allowed',
          'The resource URL is outside the configured policy.',
          2,
        );
      const header =
        resource && resource.contractId === c.contractId
          ? bytes(resource.header, (resource.header.length - 2) / 2)
          : await resourceHeader(url, c, fetcher);
      if (
        record &&
        hex(await (await import('../envelope/pay2.js')).sha256(header)) !== record.checkedHeaderHash
      )
        throw new Error('header mismatch');
      const { listing } = await readListing(fileId);
      await inspectHeader(header, listing, c.contractId);
      const purchaseId = recovery?.purchase_id ?? record?.id;
      const buyerSecret = recovery?.buyerSecret ?? record?.buyerSecret;
      if (!purchaseId || !buyerSecret || recovery?.grant === null)
        throw new Error('grant not final');
      const payment =
        record?.purchase.route === 'base-usdc'
          ? [...record.attempts].reverse().find((attempt) => attempt.payload)?.payload
          : undefined;
      readFileSource = () =>
        download({
          url,
          contractId: c.contractId,
          fileId,
          header,
          proof: {
            secret: bytes(buyerSecret, 32),
            purchase_id: purchaseId,
            grant: recovery?.grant ?? 0,
          },
          fetch: fetcher,
          ...(payment ? { payment: { header: payment } } : {}),
        });
    }
    // claim_key is permissionless; a configured NEAR wallet can pay gas instead of a relayer.
    if (o.wallet || env.ANNON_WALLET) await wallet();
    const opened = await withOutput(o.output, (sink) =>
      sdk.openTo({
        file: readFileSource(),
        sink,
        spool: (stream, use) => withSpool(o.output as string, stream, use),
        ...(recovery?.grant != null ? { recovery } : record ? { record } : {}),
      }),
    ).catch(async (error: unknown) => {
      const safe = publicError(error);
      if (
        d.agent &&
        safe.retryAfterSeconds !== undefined &&
        ['download_limited', 'download_in_progress', 'rate_limited', 'unavailable'].includes(
          safe.code,
        )
      )
        await downloadGate?.defer(safe.code, safe.retryAfterSeconds);
      throw error;
    });
    return {
      fileId,
      purchaseId: recovery?.purchase_id ?? record?.id,
      output: o.output,
      bytes: opened.meta.size,
      ...(await paymentDetails(
        async () => record ?? (recovery ? sdk.store.load(purchaseKey(recovery.purchase_id)) : null),
      )),
    };
  };
}

export { createCoreAdapter };
