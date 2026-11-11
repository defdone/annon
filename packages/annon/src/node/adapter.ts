/** Node I/O around the SDK. Settlement, commitments, encryption and proofs stay in the SDK. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Annon, type AnnonOptions } from '../api/annon.js';
import { download, secureUrl } from '../download/download.js';
import { sameResource } from '../download/proof.js';
import { inspect, inspectHeader, MAX_HEADER, parseHeader } from '../envelope/pay2.js';
import { getConfig, getFile, getPurchase, txOutcome } from '../near/rpc.js';
import { OneClick, type Origin } from '../oneclick/oneclick.js';
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
import { discover, type PaymentRequired, readPaymentRequired } from '../pay/x402.js';
import { bytes, hex } from '../settle-near/codec.js';
import { identityJson, parseIdentity } from '../settle-near/identity.js';
import type { NearWallet } from '../wallet/wallet.js';
import { agentPolicy, configPath, initAgent, savePublicConfig } from './agent.js';
import { type BrowserSession, startBrowserSession } from './browser-login.js';
import { type BudgetRecord, reserveSpend } from './budget.js';
import type { Input } from './cli.js';
import { type Config, loadConfig, type TrustPrompt, trustContract } from './config.js';
import { AdapterError, publicError, usage } from './errors.js';
import { newOutput, writeBackup } from './io.js';
import { type Keychain, osKeychain } from './keychain.js';
import { confinePaths } from './paths.js';
import {
  humanPaymentTerms,
  quotedSource,
  type SourceAsset,
  type SourcePayment,
  savedPayment,
  validatePaymentToken,
} from './payment-terms.js';
import { assertSignerInput, configuredWallet } from './signer-wallet.js';
import { type SigningResult, signingRequest, verifySigningResult } from './signing.js';
import {
  type Environment,
  identity,
  type LocalWallet,
  loadWallet,
  readBackupSecret,
} from './wallets.js';

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
    'sell' | 'buy' | 'open' | 'recover' | 'stop' | 'store' | 'accept' | 'resumeSell'
  >;
  wallet?: typeof loadWallet;
  file?: typeof getFile;
  purchase?: typeof getPurchase;
  fetch?: typeof fetch;
  prompt?: TrustPrompt;
  notify?: (message: string) => void;
  wait?: (ms: number) => Promise<void>;
}
const fail = (code: string, message: string, exit = 1): never => {
  throw new AdapterError(code, message, exit);
};
export function amount(text: string): string {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(text)) throw usage();
  const [whole, fraction = ''] = text.split('.');
  const n = BigInt(whole ?? '') * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (n <= 0n || n >= 2n ** 128n) throw usage();
  return String(n);
}
const isId = (id: string) => /^0x[0-9a-f]{64}$/.test(id);
interface Resource {
  id: string;
  revision: number;
  contractId: string;
  header: string;
  url?: string;
}
const backupPath = (c: Config, id: string) => {
  if (!/^(recovery:|sell:|seller-key:)?0x[0-9a-f]{64}(:revision:[0-9]+)?$/.test(id)) throw usage();
  return join(c.stateDir, 'backups', `${id.replaceAll(':', '-')}.json`);
};
const requestOptions = { redirect: 'error', credentials: 'omit', cache: 'no-store' } as const;
async function response(url: string, fetcher: typeof fetch, headers?: Record<string, string>) {
  const u = secureUrl(url);
  if (u.username || u.password) throw usage();
  return fetcher(u, {
    ...requestOptions,
    signal: AbortSignal.timeout(20000),
    ...(headers ? { headers } : {}),
  });
}
async function headerAt(
  url: string,
  fetcher: typeof fetch,
  initial?: Response,
): Promise<Uint8Array> {
  const r = initial ?? (await response(url, fetcher, { Range: `bytes=0-${MAX_HEADER - 1}` }));
  if (![200, 206].includes(r.status) || !r.body) throw new Error('header unavailable');
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < MAX_HEADER) {
      const next = await reader.read();
      if (next.done) break;
      const part = next.value.subarray(0, MAX_HEADER - size);
      parts.push(part);
      size += part.length;
    }
  } finally {
    await reader.cancel();
  }
  const b = Buffer.concat(parts);
  if (b.length < 12) throw new Error('short header');
  const length = b.readUInt32BE(8);
  if (length > MAX_HEADER || length > b.length) throw new Error('bad header length');
  return new Uint8Array(b.subarray(0, length));
}
async function offer(
  target: string,
  c: Config,
  fetcher: typeof fetch,
  provided?: PaymentRequired,
  expectedUrl?: string,
) {
  let pr: PaymentRequired;
  if (provided) pr = provided;
  else if (/^https?:/.test(target)) {
    const r = await response(target, fetcher);
    await r.body?.cancel();
    const required = r.headers.get('PAYMENT-REQUIRED');
    if (!required)
      return fail('offer_required', 'The URL must advertise an Annon PAYMENT-REQUIRED offer.');
    pr = readPaymentRequired(required);
  } else {
    // A named file contains the decoded x402 JSON; SDK parsing remains authoritative.
    const text = await readFile(target, 'utf8');
    pr = readPaymentRequired(Buffer.from(text).toString('base64'));
  }
  const found = discover(pr, [c.contractId]);
  const url = (pr.resource as { url?: unknown } | undefined)?.url;
  if (
    typeof url !== 'string' ||
    !sameResource(url, /^https?:/.test(target) ? target : (expectedUrl ?? ''))
  )
    throw new Error('resource mismatch');
  secureUrl(url);
  const header = pr.extensions?.annon?.info.header;
  if (typeof header !== 'string') throw new Error('header missing');
  if (secureUrl(header).origin !== new URL(url).origin) throw new Error('header origin mismatch');
  return { pr, url, header: await headerAt(header, fetcher), fileId: found.fileId };
}
async function resourceHeader(url: string, c: Config, fetcher: typeof fetch) {
  const r = await response(url, fetcher, { Range: `bytes=0-${MAX_HEADER - 1}` });
  const required = r.headers.get('PAYMENT-REQUIRED');
  if (r.status === 402 && required) {
    await r.body?.cancel();
    const found = await offer(url, c, fetcher, readPaymentRequired(required));
    if (hex(parseHeader(new Uint8Array(found.header)).fileId) !== found.fileId)
      throw new Error('offer header mismatch');
    return found.header;
  }
  return headerAt(url, fetcher, r);
}
const tokenIdentifier = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= 128 &&
  !/[^A-Za-z0-9._:-]/.test(value);
const chainAliases = new Map([
  ['solana', 'sol'],
  ['ethereum', 'eth'],
  ['arbitrum', 'arb'],
  ['polygon', 'pol'],
  ['optimism', 'op'],
  ['avalanche', 'avax'],
  ['berachain', 'bera'],
]);
async function originFor(
  o: Input,
  env: Environment,
  wallet: LocalWallet,
  fetcher: typeof fetch,
  c: Config,
): Promise<Origin & { sourceAsset: SourceAsset }> {
  if (o.origin) {
    if (!c.origins || !Object.hasOwn(c.origins, o.origin))
      return fail('origin_not_allowed', 'Choose a human-configured origin name.', 2);
    o = { ...o, ...c.origins[o.origin] };
  }
  const inputChain = o.fromChain ?? env.ANNON_FROM_CHAIN;
  const chain = inputChain ? (chainAliases.get(inputChain) ?? inputChain) : undefined;
  if (!chain)
    return fail(
      'origin_required',
      'Choose --from-chain and optionally --from-asset for 1Click.',
      2,
    );
  let asset = o.fromAsset ?? env.ANNON_FROM_ASSET;
  let token: { symbol: string; decimals?: number; contractAddress?: string } | undefined;
  if (!asset) {
    const r = await response('https://1click.chaindefuser.com/v0/tokens', fetcher);
    if (!r.ok) throw new Error('tokens unavailable');
    const tokens = (await r.json()) as {
      blockchain: string;
      symbol: string;
      assetId: string;
      decimals?: number;
      contractAddress?: string;
    }[];
    const matches = tokens.filter((t) => t.blockchain === chain && t.symbol === 'USDC');
    if (matches.length !== 1)
      return fail(
        'origin_asset_required',
        'Specify --from-asset with the exact 1Click nep141 asset ID for this chain.',
        2,
      );
    token = matches[0];
    asset = matches[0]?.assetId;
  }
  if (!tokenIdentifier(asset))
    return fail('origin_asset_required', 'Specify --from-asset with a valid 1Click asset ID.', 2);
  const kind: Origin['chain'] =
    chain === 'sol'
      ? 'solana'
      : chain === 'near'
        ? 'near'
        : [
              'eth',
              'base',
              'arb',
              'pol',
              'op',
              'avax',
              'bsc',
              'gnosis',
              'bera',
              'scroll',
              'monad',
              'xlayer',
              'abs',
              'plasma',
            ].includes(chain)
          ? 'evm'
          : 'other';
  let refundTo = o.refundTo ?? env.ANNON_REFUND_TO;
  if (!refundTo && kind === wallet.identity.kind) {
    refundTo = wallet.identity.id;
    if (kind === 'solana') {
      const { base58 } = await import('@scure/base');
      refundTo = base58.encode(bytes(`0x${wallet.identity.id}`, 32));
    }
  }
  if (!asset || !refundTo)
    return fail('origin_required', 'Provide --from-asset and --refund-to for the source chain.', 2);
  const decimals = token?.decimals;
  const contractAddress = token?.contractAddress;
  return {
    asset,
    chain: kind,
    refundTo,
    sourceAsset: {
      chain,
      asset,
      ...(token ? { symbol: token.symbol } : {}),
      ...(typeof decimals === 'number' &&
      Number.isInteger(decimals) &&
      decimals >= 0 &&
      decimals <= 255
        ? { decimals }
        : {}),
      ...(tokenIdentifier(contractAddress) ? { contractAddress } : {}),
    },
  };
}

/**
 * Wait after a relayer admission refusal: seconds or an HTTP date, 5 s when absent or unreadable. Null when the
 * relayer asks for more than a minute (an hourly IP budget): that wait is the caller's decision.
 */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  const delay = !header
    ? NaN
    : /^\d+$/.test(header)
      ? Number(header) * 1000
      : Date.parse(header) - now;
  if (!Number.isFinite(delay)) return 5000;
  return delay > 60_000 ? null : Math.max(0, delay);
}

function createCoreAdapter(env: Environment = process.env, d: Dependencies = {}) {
  const fetcher = d.fetch ?? globalThis.fetch;
  const wait = d.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
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
    ): Promise<{ payment?: PaymentSummary }> => {
      try {
        const record = await load();
        if (
          !record ||
          record.purchase.contract !== c.contractId ||
          record.terms.contractId !== c.contractId
        )
          return {};
        return { payment: savedPayment(record) };
      } catch {
        // Optional reporting must not block an accepted purchase or a successful open.
        return {};
      }
    };
    const pendingSetup = (purchaseId: string) => ({
      purchaseId,
      state: 'pending',
      next: 'Check the payment; configure readable saved state and the matching backup secret to resume Base unlock. 1Click SUCCESS alone is not acceptance.',
    });
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
        return fail('unusable_file', 'The file has no key stanza for the trusted contract.');
      return {
        fileId,
        verified: true,
        checked: remote ? 'header' : 'header-and-body',
        contractId: c.contractId,
      };
    }
    if (o.command === 'status') {
      if (!o.target || !isId(o.target)) throw usage();
      const p = await (d.purchase ?? getPurchase)(c.nearRpc, c.contractId, o.target);
      if (p)
        return {
          purchaseId: o.target,
          state: 'accepted',
          fileId: p.file_id,
          route: p.route,
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
    let selected: LocalWallet | undefined;
    const wallet = async () => {
      selected ??= await (d.wallet ?? loadWallet)({ ...o, network: c.network }, env, c.nearRpc);
      return selected;
    };
    const send: NonNullable<AnnonOptions['send']> = async (method, args, owner) => {
      if (method === 'unlock' && !c.baseRpc)
        return fail('base_rpc_required', 'Configure baseRpc before resuming a Base purchase.', 2);
      const signer =
        owner ?? (selected?.identity.kind === 'near' ? (selected as NearWallet) : undefined);
      let submitted: { txHash: string; signer: string } | undefined;
      const call = async () => {
        if (signer) return signer.call({ receiverId: c.contractId, method, args });
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
          if ([429, 503].includes(r.status)) {
            const delay = retryAfterMs(r.headers.get('Retry-After'));
            await r.body?.cancel();
            const code = r.status === 429 ? 'relayer_rate_limited' : 'relayer_unavailable';
            const error = new AdapterError(
              code,
              'Relayer admission is delayed; retry the saved operation later.',
              4,
            );
            if (delay === null) throw error;
            throw Object.assign(error, { retryAfterMs: delay });
          }
          if (![200, 202].includes(r.status)) {
            const body = (await r.json().catch(() => null)) as { error?: unknown } | null;
            if (r.status === 409 && body?.error === 'duplicate')
              throw new Error('relayer in flight; retry');
            if (r.status === 425 || body?.error === 'payment_not_safe') {
              const safe = publicError({ code: 'payment_not_safe' });
              const hint = r.headers.get('Retry-After');
              throw Object.assign(new AdapterError(safe.code, safe.message, safe.exitCode), {
                safetyDelayMs: hint
                  ? Math.max(
                      0,
                      /^\d+$/.test(hint) ? Number(hint) * 1000 : Date.parse(hint) - Date.now(),
                    )
                  : 0,
              });
            }
            throw new Error('relayer refused');
          }
          const body = (await r.json()) as { txHash?: string; signer?: string; pending?: boolean };
          if (r.status === 202 && body.pending === true)
            throw new Error('relayer in flight; retry');
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
          args,
        });
        if (result.state === 'released') return result.answer;
        if (result.state === 'done') return result.value;
        if ('reason' in result && /prepaid|storage balance|storage[_ ]deposit/i.test(result.reason))
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
          if (error instanceof AdapterError && 'retryAfterMs' in error) {
            if (admissions++ >= 3) throw error;
            await wait((error as AdapterError & { retryAfterMs: number }).retryAfterMs);
            continue;
          }
          if (
            method === 'unlock' &&
            error instanceof AdapterError &&
            error.code === 'payment_not_safe'
          ) {
            if (o.command === 'status') throw new AdapterError(error.code, error.message, 4);
            if (o.command !== 'open' || d.agent || o.json) throw error;
            const planned = [10000, 20000, 30000, 40000, 60000][safetyWaits++];
            const minimum = (error as AdapterError & { safetyDelayMs?: number }).safetyDelayMs ?? 0;
            if (planned === undefined || minimum > 60000) throw error;
            const delay = Math.max(planned, Number.isFinite(minimum) ? minimum : 0);
            d.notify?.(`Base settlement pending; retrying unlock in ${delay / 1000} seconds.`);
            await wait(delay);
            continue;
          }
          const inFlight = /in flight/i.test(error instanceof Error ? error.message : '');
          const timeout = /timeout|timed out/i.test(error instanceof Error ? error.message : '');
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
      backupSecret: secret,
      send,
      writeBackup: (id, encrypted) => writeBackup(backupPath(c, id), encrypted),
    });
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
      const accepted = await sdk.accept(record ?? undefined, o.target);
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
    if (o.command === 'sell') {
      if (!o.target) throw usage();
      const seller = await wallet();
      const output = o.output ?? `${o.target}.pay2`;
      await newOutput(output);
      const publish = async (file: { file: Uint8Array }) => {
        await writeFile(output, file.file, { mode: 0o600, flag: 'wx' });
      };
      if (o.resume) {
        if (!isId(o.resume) || o.price || o.split || o.base || o.moderator) throw usage();
        const result = await sdk.resumeSell({
          fileId: o.resume,
          data: new Uint8Array(await readFile(o.target)),
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
      const result = await sdk.sell({
        data: new Uint8Array(await readFile(o.target)),
        name: basename(o.target),
        mime: 'application/octet-stream',
        seller,
        near: { price: amount(o.price), recipients, remainder },
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
      };
    }
    if (o.command === 'buy') {
      if (!o.target) throw usage();
      if (d.agent && !/^https?:/.test(o.target))
        return fail(
          'resource_not_allowed',
          'Agent purchases require an allowlisted URL, never an offer file.',
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
      if (d.agent && (!resource || !c.allowedResources?.some((url) => sameResource(url, resource))))
        return fail(
          'resource_not_allowed',
          'Agent purchases require a human-allowed resource URL.',
          2,
        );
      if (d.agent && (o.refundTo || o.fromChain || o.fromAsset))
        return fail('origin_not_allowed', 'Use a human-configured origin name.', 2);
      const buyer = await wallet();
      const found = await offer(o.target, c, fetcher, undefined, o.url);
      const { f, listing } = await readListing(found.fileId);
      await inspectHeader(found.header, listing, c.contractId);
      const route =
        o.route ??
        (o.fromChain || o.origin ? '1click' : buyer.identity.kind === 'near' ? 'near' : 'base');
      if (route === 'near' && buyer.identity.kind !== 'near')
        return fail(
          'near_wallet_required',
          'The direct NEAR route requires a NEAR wallet; use 1click for another chain.',
          2,
        );
      if (
        route === 'base' &&
        (buyer.identity.kind !== 'evm' || !('signTypedData' in buyer) || !f.terms.base)
      )
        return fail(
          'base_unavailable',
          'The Base route requires an EVM wallet and a Base offer.',
          2,
        );
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
      if (route === 'base' && c.relayer) {
        const reply = await response(new URL('/v1/capabilities', c.relayer).href, fetcher);
        const cap = (await reply.json()) as {
          contract?: unknown;
          minPrice?: unknown;
          disabled?: unknown;
          methods?: unknown;
        };
        if (
          !reply.ok ||
          cap.contract !== c.contractId ||
          typeof cap.minPrice !== 'string' ||
          !/^[0-9]+$/.test(cap.minPrice) ||
          !Array.isArray(cap.methods) ||
          !cap.methods.includes('unlock')
        )
          return fail(
            'relayer_unavailable',
            'Relayer sponsorship policy is unavailable; check configuration before paying.',
          );
        if (cap.disabled === true || BigInt(price) < BigInt(cap.minPrice))
          return fail(
            'not_sponsored',
            'The relayer does not sponsor this Base price; do not pay through this route.',
          );
      }
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
      const paymentConfig = await getConfig(c.nearRpc, c.contractId);
      if (paymentConfig.network !== c.network)
        return fail(
          'network_mismatch',
          'The contract network differs from the configured network.',
          2,
        );
      validatePaymentToken(paymentTerms, paymentConfig);
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
      if (!origin || (o.json && !d.browserApprovals)) await confirmPayment();
      let refundBudget: (() => Promise<void>) | undefined;
      if (d.agent) {
        if (c.dailyBudget === undefined)
          return fail('budget_required', 'Configure a daily agent budget before buying.', 2);
        const budgetDir = join(c.stateDir, 'budgets');
        await mkdir(budgetDir, { recursive: true, mode: 0o700 });
        refundBudget = await reserveSpend(
          fileStore<BudgetRecord>(budgetDir),
          'agent:USDC',
          BigInt(price),
          {
            daily: c.dailyBudget === '0' ? 0n : BigInt(amount(c.dailyBudget)),
          },
        );
      }
      let completed = false;
      try {
        let source: SourcePayment | undefined;
        const bought = await sdk.buy({
          fileId: found.fileId,
          header: found.header,
          recovery: buyer,
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
        completed = true;
        let payment: ReturnType<typeof savedPayment> | undefined;
        try {
          payment = savedPayment(bought.record, source);
          const next = { ...bought.record, revision: bought.record.revision + 1, payment };
          await sdk.store.compareAndSet(purchaseKey(next.id), bought.record, next);
        } catch {
          // The purchase already completed. Its public summary is optional metadata.
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
      }
    }
    if (o.command === 'recover') {
      if (!o.recovery || (o.purchase && !isId(o.purchase))) throw usage();
      const errors: { purchaseId: string; code: string; message: string }[] = [];
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
    if (!(await sdk.accept(record, recovery?.purchase_id ?? record?.id)))
      throw new AdapterError(
        'settlement_processing',
        publicError({ code: 'settlement_processing' }).message,
      );
    const resource = await resources.load(fileId);
    let file: Uint8Array;
    const local = o.file ?? (o.purchase ? o.target : undefined);
    if (local) file = new Uint8Array(await readFile(local));
    else {
      const url = o.url ?? resource?.url;
      if (!url)
        return fail('file_required', 'Provide --file or --url to open this saved purchase.', 2);
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
      const stream = download({
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
      file = new Uint8Array(await new Response(stream).arrayBuffer());
    }
    // claim_key is permissionless; a configured NEAR wallet can pay gas instead of a relayer.
    if (o.wallet || env.ANNON_WALLET) await wallet();
    const opened = await sdk.open({
      file,
      ...(recovery?.grant != null ? { recovery } : record ? { record } : {}),
    });
    await writeFile(o.output, opened.data, { mode: 0o600, flag: 'wx' });
    return {
      fileId,
      purchaseId: recovery?.purchase_id ?? record?.id,
      output: o.output,
      bytes: opened.data.length,
      ...(await paymentDetails(
        async () => record ?? (recovery ? sdk.store.load(purchaseKey(recovery.purchase_id)) : null),
      )),
    };
  };
}

/** CLI session lifetime includes every wallet action and is always closed on exit. */
export function createAdapter(env: Environment = process.env, d: Dependencies = {}) {
  return async (o: Input): Promise<Record<string, unknown>> => {
    if (o.command !== 'init' && (o.signer || o.credentialEnv || o.credentialKeychain))
      throw new AdapterError(
        'signer_init_only',
        'Signer and credential references can only be set by init.',
        2,
      );
    const agent = await agentPolicy(o, env, d.agent);
    if (o.command === 'init') return initAgent(o, env, d.keychain ?? osKeychain);
    const c = await loadConfig(o, env, o.command === 'login', d.agent);
    if (agent || c.agent) o = await confinePaths(o, c.workDir as string);
    if (c.signer) assertSignerInput(o);
    if ((agent || c.agent) && o.command === 'login')
      throw new AdapterError('agent_policy', 'Agent mode refuses interactive login.', 2);
    let session: BrowserSession | undefined;
    let terms: unknown = null;
    const browser = async () => {
      if (!session) {
        session = await (d.browser ?? startBrowserSession)({ noOpen: o.noOpen === true });
        const port = new URL(session.url).port;
        d.notify?.(
          `Annon pairing code ${session.pairingCode}${o.noOpen ? `\n${session.url}` : ''}\nFor SSH: forward this port with ssh -L ${port}:127.0.0.1:${port} host. Use --no-open for a manual pairing URL.`,
        );
      }
      return session;
    };
    try {
      if (o.command === 'login') {
        const s = await browser();
        const kind = o.wallet ?? 'evm';
        if (kind === 'solana') throw new Error('browser Solana login is not supported');
        const challenge = `Annon login: ${crypto.randomUUID()} on ${c.network}`;
        const q = signingRequest(
          kind === 'evm' ? 'evm.personalSign' : 'near.nep413',
          kind === 'evm' ? 'eip155:8453' : c.network,
          '',
          kind === 'evm'
            ? { message: challenge }
            : {
                message: challenge,
                recipient: c.contractId || 'annon-cli',
                nonce: [...crypto.getRandomValues(new Uint8Array(32))],
                callbackUrl: new URL('/callback', s.url).href,
              },
        );
        let identity: ReturnType<typeof parseIdentity> | undefined;
        await s.request<SigningResult>(q, async (r) => {
          const selected = parseIdentity({ kind, id: kind === 'evm' ? r.account : r.accountId });
          await verifySigningResult({ ...q, account: selected.id }, r, c.nearRpc);
          identity = selected;
        });
        if (!identity) throw new Error('login failed');
        await savePublicConfig(configPath(o, env), {
          signer: { mode: 'browser', identity },
          agent: false,
          network: c.network,
          nearRpc: c.nearRpc,
          ...(c.contractId ? { contractId: c.contractId } : {}),
          ...(c.baseRpc ? { baseRpc: c.baseRpc } : {}),
        });
        return { identity, network: c.network, mode: 'browser' };
      }
      const signer = c.signer;
      return await createCoreAdapter(env, {
        ...d,
        agent: agent || c.agent === true,
        browserApprovals: signer?.mode === 'browser',
        paymentTerms: (value) => {
          terms = value;
          d.paymentTerms?.(value);
        },
        ...(signer && !d.wallet
          ? {
              wallet: (input, environment) =>
                configuredWallet(
                  signer,
                  c,
                  input as Input,
                  environment,
                  d.keychain ?? osKeychain,
                  browser,
                  () => terms,
                ),
            }
          : {}),
      })(o);
    } finally {
      await session?.close();
    }
  };
}
