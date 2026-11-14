/** What one CLI command run shares across the command modules: input, config, wallet and stores. */
import type { Annon, AnnonOptions } from '../api/annon.js';
import { getFile, type getPurchase } from '../near/rpc.js';
import type { EncryptedRecord } from '../pay/backup.js';
import type { PaymentSummary, PurchaseRecord } from '../pay/purchase.js';
import type { Store } from '../pay/store.js';
import { fail } from './adapter-checks.js';
import type { startBrowserSession } from './browser-login.js';
import type { Input } from './cli.js';
import type { Config, TrustPrompt } from './config.js';
import type { Keychain } from './keychain.js';
import { savedPayment } from './payment-terms.js';
import { retryGate } from './retry-gate.js';
import { type Environment, type LocalWallet, loadWallet } from './wallets.js';

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

type AdapterSdk = ReturnType<NonNullable<Dependencies['sdk']>>;

/** One command run: its input, the resolved config and the injected dependencies. */
interface RequestContext {
  env: Environment;
  d: Dependencies;
  fetcher: typeof fetch;
  wait: (ms: number) => Promise<void>;
  o: Input;
  c: Config;
  /** Set by `fund` and `wallet()`; the relay transport signs with it when it is a NEAR wallet. */
  selected: LocalWallet | undefined;
  readListing: (fileId: string) => ReturnType<typeof readListing>;
  paymentDetails: (
    load: () => Promise<PurchaseRecord | null | undefined>,
  ) => ReturnType<typeof paymentDetails>;
  pendingSetup: (purchaseId: string) => ReturnType<typeof pendingSetup>;
  wallet: () => Promise<LocalWallet>;
}

/** A command run once the backup secret, the local stores and the SDK are ready. */
interface CommandSession extends RequestContext {
  secret: Uint8Array;
  storeDir: string;
  rawStore: Store<EncryptedRecord>;
  resources: Store<Resource>;
  sdk: AdapterSdk;
}

/** The helpers close over the returned object, so they all see the same selected wallet. */
function requestContext(
  env: Environment,
  d: Dependencies,
  fetcher: typeof fetch,
  wait: (ms: number) => Promise<void>,
  o: Input,
  c: Config,
): RequestContext {
  const ctx: RequestContext = {
    env,
    d,
    fetcher,
    wait,
    o,
    c,
    selected: undefined,
    readListing: (fileId) => readListing(ctx, fileId),
    paymentDetails: (load) => paymentDetails(ctx, load),
    pendingSetup: (purchaseId) => pendingSetup(ctx, purchaseId),
    wallet: () => selectWallet(ctx),
  };
  return ctx;
}

/** The registered file and the listing its header must match, for the configured deployment. */
async function readListing(ctx: RequestContext, fileId: string) {
  const { c, d } = ctx;
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
}

/** Payment summary of a saved purchase, or nothing when the record is missing or unreadable. */
async function paymentDetails(
  ctx: RequestContext,
  load: () => Promise<PurchaseRecord | null | undefined>,
): Promise<{ route?: PaymentSummary['route']; payment?: PaymentSummary }> {
  const { c } = ctx;
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
}

/** A purchase whose acceptance cannot be checked without saved state and the backup secret. */
async function pendingSetup(ctx: RequestContext, purchaseId: string) {
  const { c, d } = ctx;
  if (d.agent) await retryGate({ ...c, purchaseId }).defer('settlement_pending', 30);
  return {
    purchaseId,
    state: 'pending',
    next: 'Check the payment; configure readable saved state and the matching backup secret to resume Base unlock. 1Click SUCCESS alone is not acceptance.',
  };
}

/** Loads the command's wallet once; later calls reuse it. */
async function selectWallet(ctx: RequestContext) {
  const { c, d, env, o } = ctx;
  ctx.selected ??= await (d.wallet ?? loadWallet)({ ...o, network: c.network }, env, c.nearRpc);
  return ctx.selected;
}

export { type AdapterSdk, type CommandSession, type RequestContext, type Resource, requestContext };
