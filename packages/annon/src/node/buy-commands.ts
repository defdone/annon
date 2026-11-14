/** Buyer commands before a purchase exists: `verify` a file and `buy` it. */
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspect, inspectHeader, MAX_HEADER, parseHeader } from '../envelope/pay2.js';
import { AnnonError } from '../errors.js';
import { fileStorageBalance, getConfig, getPurchase } from '../near/rpc.js';
import { OneClick } from '../oneclick/oneclick.js';
import type { EncryptedRecord } from '../pay/backup.js';
import { purchaseKey } from '../pay/purchase.js';
import { fileStore } from '../pay/store-node.js';
import { checkBaseSponsorship } from '../relay/capabilities.js';
import { hex } from '../settle-near/codec.js';
import { backupPath, fail, isId } from './adapter-checks.js';
import { amount } from './amounts.js';
import { type BudgetRecord, reserveSpend } from './budget.js';
import type { CommandSession, RequestContext } from './command-context.js';
import { AdapterError, usage } from './errors.js';
import { offer, resourceHeader, response } from './offers.js';
import { originFor } from './origin.js';
import {
  humanPaymentTerms,
  quotedSource,
  type SourcePayment,
  savedPayment,
  validatePaymentToken,
} from './payment-terms.js';
import { claimPurchase, type PurchaseGuard } from './purchase-guard.js';
import { resourceAllowed } from './resources.js';

type PreparedBuy = Awaited<ReturnType<typeof prepareBuy>>;

/** `verify`: a local file's header and body, or a remote file's header, against its listing. */
async function verifyFile(ctx: RequestContext): Promise<Record<string, unknown>> {
  const { c, fetcher, o, readListing } = ctx;
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

/**
 * `buy`, checks that run before the backup secret is read: agent policy, the price cap, the
 * offer and its header against the registered listing.
 */
async function prepareBuy(ctx: RequestContext) {
  const { c, d, fetcher, o, readListing } = ctx;
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
}

/**
 * `buy`: confirms the exact terms, holds the per-file purchase guard and the agent budget, then
 * lets the SDK pay.
 */
async function buy(
  ctx: CommandSession,
  preparedBuy: PreparedBuy | undefined,
): Promise<Record<string, unknown>> {
  const { c, d, env, fetcher, o, resources, sdk, storeDir, wallet } = ctx;
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
    return fail('network_mismatch', 'The contract network differs from the configured network.', 2);
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
    const envelope = JSON.parse(await readFile(join(storeDir, name), 'utf8')) as EncryptedRecord;
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

export { buy, prepareBuy, verifyFile };
