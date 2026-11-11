/** Node I/O around the SDK. Settlement, commitments, encryption and proofs stay in the SDK. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Annon, type AnnonOptions } from '../api/annon.js';
import { download, secureUrl } from '../download/download.js';
import { sameResource } from '../download/proof.js';
import { inspect, inspectHeader, MAX_HEADER, parseHeader } from '../envelope/pay2.js';
import { getFile, getPurchase, txOutcome } from '../near/rpc.js';
import { OneClick, type Origin } from '../oneclick/oneclick.js';
import {
  type EncryptedRecord,
  encryptedRecoveryStore,
  importPurchase,
  importRecovery,
  type RecoveryRecord,
} from '../pay/backup.js';
import { type PurchaseRecord, purchaseKey } from '../pay/purchase.js';
import { fileStore } from '../pay/store-node.js';
import { discover, type PaymentRequired, readPaymentRequired } from '../pay/x402.js';
import { bytes, hex } from '../settle-near/codec.js';
import { identityJson } from '../settle-near/identity.js';
import type { NearWallet } from '../wallet/wallet.js';
import type { Input } from './cli.js';
import { type Config, loadConfig, type TrustPrompt, trustContract } from './config.js';
import { AdapterError, usage } from './errors.js';
import { newOutput, writeBackup } from './io.js';
import {
  type Environment,
  identity,
  type LocalWallet,
  loadWallet,
  readBackupSecret,
} from './wallets.js';

export interface Dependencies {
  sdk?: (
    options: AnnonOptions,
  ) => Pick<Annon, 'sell' | 'buy' | 'open' | 'recover' | 'stop' | 'store'>;
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
  if (!/^(recovery:)?0x[0-9a-f]{64}$/.test(id)) throw usage();
  return join(c.stateDir, 'backups', `${id.replace(':', '-')}.json`);
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
async function offer(target: string, c: Config, fetcher: typeof fetch, provided?: PaymentRequired) {
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
  if (typeof url !== 'string' || (/^https?:/.test(target) && !sameResource(url, target)))
    throw new Error('resource mismatch');
  secureUrl(url);
  const header = pr.extensions?.annon?.info.header;
  if (typeof header !== 'string') throw new Error('header missing');
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
async function originFor(
  o: Input,
  env: Environment,
  wallet: LocalWallet,
  fetcher: typeof fetch,
): Promise<Origin> {
  const chain = o.fromChain ?? env.ANNON_FROM_CHAIN;
  if (!chain)
    return fail(
      'origin_required',
      'Choose --from-chain and optionally --from-asset for 1Click.',
      2,
    );
  let asset = o.fromAsset ?? env.ANNON_FROM_ASSET;
  if (!asset) {
    const r = await response('https://1click.chaindefuser.com/v0/tokens', fetcher);
    if (!r.ok) throw new Error('tokens unavailable');
    const tokens = (await r.json()) as { blockchain: string; symbol: string; assetId: string }[];
    const matches = tokens.filter((t) => t.blockchain === chain && t.symbol === 'USDC');
    if (matches.length !== 1)
      return fail(
        'origin_asset_required',
        'Specify --from-asset with the exact 1Click nep141 asset ID for this chain.',
        2,
      );
    asset = matches[0]?.assetId;
  }
  const kind: Origin['chain'] =
    chain === 'solana'
      ? 'solana'
      : chain === 'near'
        ? 'near'
        : [
              'eth',
              'ethereum',
              'base',
              'arbitrum',
              'polygon',
              'bsc',
              'optimism',
              'avalanche',
              'gnosis',
              'berachain',
              'aurora',
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
  return { asset, chain: kind, refundTo };
}

export function createAdapter(env: Environment = process.env, d: Dependencies = {}) {
  const fetcher = d.fetch ?? globalThis.fetch;
  const wait = d.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (o: Input): Promise<Record<string, unknown>> => {
    const c = await loadConfig(o, env);
    await trustContract(c, o.trustContract === true, o.json ? undefined : d.prompt);
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
    if (o.command === 'status') {
      if (!o.target || !isId(o.target)) throw usage();
      const p = await (d.purchase ?? getPurchase)(c.nearRpc, c.contractId, o.target);
      return {
        purchaseId: o.target,
        state: p ? 'accepted' : 'pending',
        ...(p ? { fileId: p.file_id, route: p.route, grants: p.grants } : {}),
        next: p
          ? 'open'
          : 'Check the deposit/payment; retry status. 1Click SUCCESS alone is not acceptance.',
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
        return fail('unusable_file', 'The file has no key stanza for the trusted contract.');
      return {
        fileId,
        verified: true,
        checked: remote ? 'header' : 'header-and-body',
        contractId: c.contractId,
      };
    }
    const secret = await readBackupSecret(o, env);
    const storeDir = join(c.stateDir, 'records');
    const resourceDir = join(c.stateDir, 'resources');
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
      const signer =
        owner ?? (selected?.identity.kind === 'near' ? (selected as NearWallet) : undefined);
      const call = async () => {
        if (signer) return signer.call({ receiverId: c.contractId, method, args });
        if (!c.relayer)
          return fail(
            'transport_required',
            'Configure a relayer URL or select a NEAR wallet for transaction calls.',
            2,
          );
        const r = await fetcher(new URL('/v1/relay', secureUrl(c.relayer)), {
          ...requestOptions,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method, ...args }),
          signal: AbortSignal.timeout(60000),
        });
        if (![200, 202].includes(r.status)) throw new Error('relayer refused');
        const tx = (await r.json()) as { txHash: string; signer: string };
        const result = await txOutcome(c.nearRpc, tx.txHash, tx.signer, c.contractId, 'FINAL', {
          method,
          args,
        });
        if (result.state === 'released') return result.answer;
        if (result.state === 'done') return result.value;
        throw new Error(`transaction ${result.state}`);
      };
      // Only repeat idempotent release requests. Registration and payment are never blindly retried.
      for (let attempt = 0; ; attempt++) {
        try {
          return await call();
        } catch (error) {
          if (
            !['unlock', 'reopen', 'claim_key'].includes(method) ||
            attempt >= 2 ||
            !/timeout|timed out/i.test(error instanceof Error ? error.message : '')
          )
            throw error;
          d.notify?.('Key release timed out; retrying the saved request.');
          await wait(1000 * 2 ** attempt);
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
    if (o.command === 'sell') {
      if (!o.target || !o.price || !o.split) throw usage();
      const seller = await wallet();
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
      const output = o.output ?? `${o.target}.pay2`;
      await newOutput(output);
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
        publish: async (file) => {
          await writeFile(output, file.file, { mode: 0o600, flag: 'wx' });
        },
      });
      return { fileId: result.terms.file_id, file: output, terms: result.terms };
    }
    if (o.command === 'buy') {
      if (!o.target) throw usage();
      const buyer = await wallet();
      const found = await offer(o.target, c, fetcher);
      const { f, listing } = await readListing(found.fileId);
      await inspectHeader(found.header, listing, c.contractId);
      const route =
        o.route ?? (o.fromChain ? '1click' : buyer.identity.kind === 'near' ? 'near' : 'base');
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
      const origin = route === '1click' ? await originFor(o, env, buyer, fetcher) : undefined;
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
      const bought = await sdk.buy({
        fileId: found.fileId,
        header: found.header,
        recovery: buyer,
        refund: buyer.identity,
        ...(route === '1click' ? {} : { payer: buyer }),
        maxPrice: BigInt(
          o.maxPrice
            ? amount(o.maxPrice)
            : route === 'base'
              ? (f.terms.base?.price ?? f.terms.near.price)
              : f.terms.near.price,
        ),
        moderators: o.moderator ? [o.moderator] : [],
        paymentRequired: found.pr,
        url: found.url,
        ...(origin ? { origin, oneClick: new OneClick({ fetch: fetcher }) } : {}),
        submitBase: async (payment) => {
          const r = await response(found.url, fetcher, { 'PAYMENT-SIGNATURE': payment });
          await r.body?.cancel();
          if (![200, 206, 402, 503].includes(r.status))
            throw new Error('payment submission failed');
        },
      });
      // Raw purchase records and signed payment payloads never cross the adapter boundary.
      return {
        purchaseId: bought.record.id,
        fileId: found.fileId,
        route: bought.route,
        state: bought.instructions ? 'deposit_required' : 'submitted',
        backup: backupPath(c, bought.record.id),
        ...(bought.instructions ? { instructions: bought.instructions } : {}),
        next: 'Fund the deposit if instructed, then check status and open this purchase.',
      };
    }
    if (o.command === 'recover') {
      if (!o.recovery || (o.purchase && !isId(o.purchase))) throw usage();
      const recovered = await sdk.recover({
        wallet: await wallet(),
        ...(o.purchase ? { purchaseId: o.purchase } : {}),
      });
      return {
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
    };
  };
}
