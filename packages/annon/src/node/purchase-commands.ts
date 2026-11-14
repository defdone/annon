/** Buyer commands on an existing purchase: `status`, `recover` and `open`. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { download } from '../download/download.js';
import { inspectHeader } from '../envelope/pay2.js';
import type { AnnonErrorCode } from '../errors.js';
import { getPurchase } from '../near/rpc.js';
import {
  type EncryptedRecord,
  encryptedPurchaseStore,
  encryptedRecoveryStore,
  importPurchase,
  importRecovery,
  type RecoveryRecord,
} from '../pay/backup.js';
import { type PurchaseRecord, purchaseKey } from '../pay/purchase.js';
import { fileStore } from '../pay/store-node.js';
import { bytes, hex } from '../settle-near/codec.js';
import { backupPath, fail, isId } from './adapter-checks.js';
import type { CommandSession, RequestContext } from './command-context.js';
import { AdapterError, publicError, usage } from './errors.js';
import { fileSource, newOutput, withOutput, withSpool } from './io.js';
import { resourceHeader } from './offers.js';
import { resourceAllowed } from './resources.js';
import { retryGate } from './retry-gate.js';
import { readBackupSecret } from './wallets.js';

/**
 * `status`, first step: a purchase already accepted on chain, or the pending answer when no
 * backup secret is configured. Returns nothing when the saved record has to be checked.
 */
async function statusOnChain(ctx: RequestContext): Promise<Record<string, unknown> | undefined> {
  const { c, d, env, o, paymentDetails, pendingSetup } = ctx;
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

/** `status` from the saved purchase record: accepted, or still pending with a retry delay. */
async function status(ctx: CommandSession): Promise<Record<string, unknown>> {
  const { c, d, env, o, paymentDetails, pendingSetup, sdk, wallet } = ctx;
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

/** `recover`: purchases found for the recovery wallet, with per-purchase public errors. */
async function recover(ctx: CommandSession): Promise<Record<string, unknown>> {
  const { c, o, sdk, wallet } = ctx;
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

/**
 * `open`: loads the purchase or recovery record, waits for acceptance, then claims the key and
 * decrypts a local file or a download into the output. Unknown commands end here with usage.
 */
async function open(ctx: CommandSession): Promise<Record<string, unknown>> {
  const {
    c,
    d,
    env,
    fetcher,
    o,
    paymentDetails,
    rawStore,
    readListing,
    resources,
    sdk,
    secret,
    wallet,
  } = ctx;
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
      return fail('resource_not_allowed', 'The resource URL is outside the configured policy.', 2);
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
    if (!purchaseId || !buyerSecret || recovery?.grant === null) throw new Error('grant not final');
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
}

export { open, recover, status, statusOnChain };
