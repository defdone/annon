import { AnnonError } from '../errors.js';
import { type Identity, parseIdentity } from '../settle-near/identity.js';
import { buyerKey } from '../settle-near/purchase.js';
import { type Terms, termsHash } from '../settle-near/terms.js';
/**
 * Reading the Annon contract over NEAR JSON-RPC: views, and the outcome of a transaction sent to
 * it. Two rules, from how NEAR executes a call:
 * - Whether a payment or a listing was recorded is read from contract state (`get_purchase`,
 *   `get_file`), never from logs: a receipt that fails keeps its logs while its changes roll back,
 *   and a callback can fail after an earlier receipt committed.
 * - Events count only from successful receipts executed by the trusted contract: any contract can
 *   log `EVENT_JSON` with standard `annon`.
 * The RPC is trusted to report the chain; answers that don't fit the request are refused.
 */
export type NearErrorCode =
  /** The RPC couldn't be reached or answered something malformed; safe to retry. */
  | 'transport'
  | 'near_rpc_rate_limited'
  /** The contract refused (a panic); retrying the same call gives the same answer. */
  | 'refused';

export class NearError extends AnnonError {
  readonly code: NearErrorCode;
  constructor(code: NearErrorCode, message: string = code) {
    super(code, message);
    this.code = code;
    this.name = 'NearError';
  }
}

/** A typed RPC rate limit; callers retry through isTransient. */
export class NearRpcRateLimited extends NearError {
  constructor(message = 'NEAR RPC rate limited (429)') {
    super('near_rpc_rate_limited', message);
    this.name = 'NearRpcRateLimited';
  }
}

const fail = (code: NearErrorCode, message?: string): never => {
  throw new NearError(code, message);
};
const malformed = (what: string): never => fail('transport', `malformed RPC answer: ${what}`);

const toBase64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const fromBase64 = (s: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

/** A stalled RPC is given up on after this long, as unreachable. */
export const RPC_TIMEOUT_MS = 20_000;
let nextId = 0;

export interface RpcReply {
  result?: unknown;
  error?: {
    name?: string;
    cause?: { name?: string; info?: unknown };
    data?: unknown;
    message?: string;
  };
}

/**
 * One JSON-RPC call, one fetch: the reply to this request (its id checked), result or error
 * uninterpreted. Throws `transport` when there is no such reply.
 */
export async function rpcReply(url: string, method: string, params: unknown): Promise<RpcReply> {
  const id = `annon-${++nextId}`;
  let body: RpcReply & { id?: unknown; jsonrpc?: unknown };
  let response: Response;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error('timed out')), RPC_TIMEOUT_MS);
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: abort.signal,
    });
    const httpFailure = (): never => {
      if (response.status === 429)
        throw new NearRpcRateLimited('NEAR RPC HTTP 429: rate limited (429)');
      return fail('transport', `NEAR RPC HTTP ${response.status}`);
    };
    try {
      body = await response.json();
    } catch (error) {
      if (!response.ok) return httpFailure();
      throw error;
    }
    // NEAR also returns structured JSON-RPC errors on HTTP 400/408/500. Preserve them for
    // callers that distinguish pending work from rejection; use HTTP only without an RPC body.
    // A 429 is rate limiting whatever its body says, including replies without an id.
    if (response.status === 429) return httpFailure();
    if (
      !response.ok &&
      (!body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        (body.jsonrpc !== '2.0' && body.id !== id) ||
        (!('result' in body) && !('error' in body)))
    )
      return httpFailure();
  } catch (e) {
    if (e instanceof NearError) throw e;
    return fail('transport', `NEAR RPC unreachable: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  // Rate-limit answers carry no request id; name them instead of calling them someone else's reply.
  if ((body as { error?: { code?: unknown } })?.error?.code === -429)
    throw new NearRpcRateLimited();
  if (body?.id !== id) return malformed('a reply to another request');
  return body;
}

async function rpc(url: string, method: string, params: unknown): Promise<Record<string, unknown>> {
  const body = (await rpcReply(url, method, params)) as {
    result?: Record<string, unknown>;
    error?: RpcReply['error'];
  };
  if (body.error) {
    const msg = JSON.stringify(body.error.cause?.info ?? body.error.data ?? body.error.message);
    // A view that panics comes back as an RPC error on some providers.
    if (
      ['CONTRACT_EXECUTION_ERROR', 'UNKNOWN_ACCESS_KEY', 'UNKNOWN_ACCOUNT'].includes(
        body.error.cause?.name ?? '',
      )
    )
      fail('refused', msg);
    fail('transport', `NEAR RPC error: ${msg}`);
  }
  if (typeof body?.result !== 'object' || body.result === null) return malformed('no result');
  return body.result;
}

/** A view call; the contract's panic becomes `refused`. The caller validates the shape. */
export async function view(
  url: string,
  contractId: string,
  method: string,
  args: object,
  blockId?: string | number,
): Promise<unknown> {
  const r = await rpc(url, 'query', {
    request_type: 'call_function',
    ...(blockId === undefined ? { finality: 'final' } : { block_id: blockId }),
    account_id: contractId,
    method_name: method,
    args_base64: toBase64(JSON.stringify(args)),
  });
  if (typeof r.error === 'string') fail('refused', r.error);
  const bytes = r.result;
  if (!Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    return malformed('view bytes');
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes)));
  } catch {
    return malformed('view bytes are not JSON');
  }
}

const isHex = (v: unknown, bytes: number) =>
  typeof v === 'string' && new RegExp(`^0x[0-9a-f]{${2 * bytes}}$`).test(v);
/** NEAR's account id rule. */
const isAccount = (v: unknown) =>
  typeof v === 'string' &&
  /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(v);
const TAKEDOWN = ['illegal_content', 'court_order', 'rights_holder_notice'] as const;

/** Validated final contract state; price/payTo describe the optional Base route. */
export interface FileInfo {
  purchaseStorageBalance: bigint;
  terms: Terms;
  termsHash: string;
  seller: Identity;
  price: bigint;
  payTo: string;
  cipherHash: string;
  moderator: string | null;
  headerHash: string | null;
  salesStoppedAt: number | null;
  takenDown: string | null;
}
export async function getFile(
  url: string,
  contractId: string,
  fileId: string,
  blockId?: string | number,
): Promise<FileInfo | null> {
  const f = (await view(url, contractId, 'get_file', { file_id: fileId }, blockId)) as {
    purchase_storage_balance?: string;
    terms: Terms;
    terms_hash: string;
    header_hash: string | null;
    sales_stopped_at: number | null;
    taken_down: string | null;
  } | null;
  if (f === null) return null;
  try {
    const commitment = termsHash(f.terms, {
      nearUsdc: f.terms.near.token,
      ...(f.terms.base ? { baseUsdc: f.terms.base.usdc } : {}),
    });
    if (f.terms_hash !== commitment) throw new Error();
    if (
      (f.purchase_storage_balance !== undefined &&
        (typeof f.purchase_storage_balance !== 'string' ||
          !/^(0|[1-9][0-9]*)$/.test(f.purchase_storage_balance) ||
          BigInt(f.purchase_storage_balance) >= 2n ** 128n)) ||
      f.terms.contract !== contractId ||
      f.terms.file_id !== fileId ||
      !(f.header_hash === null || isHex(f.header_hash, 32)) ||
      !(
        f.sales_stopped_at === null ||
        (Number.isSafeInteger(f.sales_stopped_at) && f.sales_stopped_at > 0)
      ) ||
      !(
        f.taken_down === null ||
        (typeof f.taken_down === 'string' &&
          TAKEDOWN.includes(f.taken_down as (typeof TAKEDOWN)[number]))
      )
    )
      throw new Error();
  } catch {
    return malformed('get_file');
  }
  const t = f.terms;
  return {
    purchaseStorageBalance: BigInt(f.purchase_storage_balance ?? '0'),
    terms: t,
    termsHash: f.terms_hash,
    seller: parseIdentity(t.seller),
    price: BigInt(t.base?.price ?? t.near.price),
    payTo: t.base?.pay_to ?? '',
    cipherHash: t.cipher_hash,
    moderator: t.moderator,
    headerHash: f.header_hash,
    salesStoppedAt: f.sales_stopped_at,
    takenDown: f.taken_down,
  };
}
export interface PurchaseInfo {
  purchase_id: string;
  file_id: string;
  terms_hash: string;
  recovery: Identity;
  buyer_key: string;
  route: 'near-usdc' | 'base-usdc';
  delivery: number | null;
  accepted_at: number;
  grants: number;
}
export interface GrantInfo {
  purchase_id: string;
  grant: number;
  buyer_key: string;
}
export async function getPurchase(
  url: string,
  contract: string,
  id: string,
): Promise<PurchaseInfo | null> {
  const p = (await view(url, contract, 'get_purchase', { purchase_id: id })) as PurchaseInfo | null;
  if (p === null) return null;
  try {
    if (
      p.purchase_id !== id ||
      !isHex(p.file_id, 32) ||
      !isHex(p.terms_hash, 32) ||
      !Number.isSafeInteger(p.grants) ||
      p.grants < 1 ||
      p.grants > 0xffffffff ||
      !Number.isSafeInteger(p.accepted_at) ||
      p.accepted_at < 0 ||
      !['near-usdc', 'base-usdc'].includes(p.route) ||
      (p.route === 'base-usdc'
        ? p.delivery !== null
        : !Number.isSafeInteger(p.delivery) || (p.delivery as number) < 0)
    )
      throw new Error();
    buyerKey(p.buyer_key);
    parseIdentity(p.recovery);
  } catch {
    return malformed('get_purchase');
  }
  return p;
}
export async function getGrant(
  url: string,
  contract: string,
  id: string,
  grant = 0,
): Promise<GrantInfo | null> {
  if (!Number.isInteger(grant) || grant < 0 || grant > 0xffffffff)
    throw new TypeError('invalid grant');
  const g = (await view(url, contract, 'get_grant', {
    purchase_id: id,
    grant,
  })) as GrantInfo | null;
  if (g === null) return null;
  try {
    if (g.purchase_id !== id || g.grant !== grant) throw new Error();
    buyerKey(g.buyer_key);
  } catch {
    return malformed('get_grant');
  }
  return g;
}
export async function purchasesOf(
  url: string,
  contract: string,
  recovery: Identity,
  from = 0,
  limit = 50,
): Promise<string[]> {
  if (
    !Number.isSafeInteger(from) ||
    from < 0 ||
    from > 0xffffffff ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new TypeError('invalid page');
  const ids = await view(url, contract, 'purchases_of', {
    recovery: parseIdentity(recovery),
    from,
    limit,
  });
  if (!Array.isArray(ids) || ids.length > limit || !ids.every((id) => isHex(id, 32)))
    return malformed('purchases_of');
  return ids;
}

/** The contract's `get_config`: the token it accepts on Base and the MPC it asks. */
export interface Config {
  mpc: string;
  ckdDomain: number;
  foreignTxDomain: number;
  usdc: string;
  network: string;
  nearUsdc: string;
  intents: string;
}

export async function getConfig(url: string, contractId: string): Promise<Config> {
  const c = (await view(url, contractId, 'get_config', {})) as Record<string, unknown> | null;
  if (
    !isAccount(c?.mpc) ||
    !Number.isSafeInteger(c?.ckd_domain) ||
    !Number.isSafeInteger(c?.foreign_tx_domain) ||
    !isHex(c?.usdc, 20) ||
    !['near:mainnet', 'near:testnet', 'near:sandbox'].includes(c?.network as string) ||
    !isAccount(c?.near_usdc) ||
    !isAccount(c?.intents) ||
    (c?.ckd_domain as number) < 0 ||
    (c?.foreign_tx_domain as number) < 0
  ) {
    return malformed('get_config');
  }
  return {
    mpc: c?.mpc as string,
    ckdDomain: c?.ckd_domain as number,
    foreignTxDomain: c?.foreign_tx_domain as number,
    usdc: c?.usdc as string,
    network: c?.network as string,
    nearUsdc: c?.near_usdc as string,
    intents: c?.intents as string,
  };
}

/** An NEP-297 event the trusted contract logged in a receipt that succeeded. */
export interface AnnonEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Calls whose result is the CKD answer. */
const RELEASES = new Set(['register', 'unlock', 'reopen', 'reopen_seller', 'claim_key']);

export type Outcome =
  /** Not finished yet: ask again. */
  | { state: 'pending'; method: string; events: AnnonEvent[] }
  /** CKD answered: `answer` holds `big_y`/`big_c` for `keys/near-ckd`. */
  | { state: 'released'; method: string; answer: unknown; events: AnnonEvent[] }
  /**
   * `register`, `unlock` or `reopen` ended without a key. Whether the listing or the payment was
   * recorded is a question for the contract (`get_file`, `get_purchase`): if it was, `reopen`
   * gets the key; if not, the call can be sent again.
   */
  | { state: 'not_released'; method: string; reason: string; events: AnnonEvent[] }
  /** Any other call: it succeeded, with its return value. */
  | { state: 'done'; method: string; value: unknown; events: AnnonEvent[] }
  /** Any other call: the contract refused it. */
  | { state: 'refused'; method: string; reason: string; events: AnnonEvent[] };

type Status = string | { SuccessValue?: string; SuccessReceiptId?: string; Failure?: unknown };
const succeeded = (s: Status | undefined) =>
  typeof s === 'object' && s !== null && ('SuccessValue' in s || 'SuccessReceiptId' in s);

/** What a caller asked a relayer to send: the outcome must be of exactly this call. */
export interface ExpectedCall {
  txHash: string;
  signer: string;
  method?: string;
  /** The call's JSON arguments, compared as values (key order aside). */
  args?: unknown;
}

const canonical = (v: unknown): string =>
  v === null || typeof v !== 'object'
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(canonical).join(',')}]`
      : `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
          .join(',')}}`;

/**
 * Reads an `EXPERIMENTAL_tx_status` / `tx` result. With `expect`, the answer must be about that
 * transaction and, when given, that method with those arguments: a relayer can't hand back an
 * older or another call. Reads exactly one function call; register may include a positive
 * caller-funded file_budget when the expected arguments omit it.
 */
export function readOutcome(result: unknown, contractId: string, expect?: ExpectedCall): Outcome {
  const r = result as {
    transaction?: {
      hash?: unknown;
      signer_id?: unknown;
      receiver_id?: unknown;
      actions?: { FunctionCall?: { method_name?: unknown; args?: unknown } }[];
    };
    status?: Status;
    receipts_outcome?: { outcome?: { executor_id?: unknown; logs?: unknown; status?: Status } }[];
  };
  const t = r?.transaction;
  if (expect && (t?.hash !== expect.txHash || t?.signer_id !== expect.signer)) {
    return malformed('an outcome for another transaction');
  }
  if (t?.receiver_id !== contractId) {
    fail('transport', 'the transaction was not sent to the Annon contract');
  }
  const actions = Array.isArray(t?.actions) ? t.actions : [];
  const method = actions[0]?.FunctionCall?.method_name;
  if (actions.length !== 1 || typeof method !== 'string')
    return malformed('not a single function call');
  if (expect?.method !== undefined && method !== expect.method) {
    return malformed('an outcome of another method');
  }
  if (expect?.args !== undefined) {
    let sent: unknown;
    try {
      sent = JSON.parse(fromBase64(String(actions[0]?.FunctionCall?.args)));
    } catch {
      return malformed('call arguments are not JSON');
    }
    // Compared as JSON would send them: an `undefined` field is no field.
    const asked = JSON.parse(JSON.stringify(expect.args) ?? 'null');
    if (
      method === 'register' &&
      sent &&
      typeof sent === 'object' &&
      'args' in sent &&
      !Object.hasOwn(asked.args ?? {}, 'file_budget')
    ) {
      const a = (sent as { args: Record<string, unknown> }).args;
      if (Object.hasOwn(a, 'file_budget')) {
        if (
          typeof a.file_budget !== 'string' ||
          !/^[1-9][0-9]*$/.test(a.file_budget) ||
          BigInt(a.file_budget) >= 2n ** 128n
        )
          return malformed('invalid registration budget');
        delete a.file_budget;
      }
    }
    if (canonical(sent) !== canonical(asked)) return malformed('an outcome of another call');
  }

  const events: AnnonEvent[] = [];
  for (const o of Array.isArray(r.receipts_outcome) ? r.receipts_outcome : []) {
    if (o?.outcome?.executor_id !== contractId || !succeeded(o.outcome.status)) continue;
    for (const log of Array.isArray(o.outcome.logs) ? o.outcome.logs : []) {
      if (typeof log !== 'string' || !log.startsWith('EVENT_JSON:')) continue;
      try {
        const e = JSON.parse(log.slice('EVENT_JSON:'.length));
        if (e.standard === 'annon' && e.version === '2.0.0' && typeof e.event === 'string') {
          events.push({ event: e.event, data: e.data?.[0] ?? {} });
        }
      } catch {}
    }
  }

  const status = r.status;
  if (status === 'NotStarted' || status === 'Started') return { state: 'pending', method, events };
  if (typeof status !== 'object' || status === null) return malformed('status');
  const releases = RELEASES.has(method);
  if ('Failure' in status) {
    const reason = panicMessage(status.Failure);
    return releases
      ? { state: 'not_released', method, reason, events }
      : { state: 'refused', method, reason, events };
  }
  if (typeof status.SuccessValue !== 'string') return malformed('status');
  let value: unknown = null;
  if (status.SuccessValue !== '') {
    try {
      value = JSON.parse(fromBase64(status.SuccessValue));
    } catch {
      return malformed('return value is not JSON');
    }
  }
  if (!releases) return { state: 'done', method, value, events };
  const v = value as { big_y?: unknown; big_c?: unknown; error?: unknown } | null;
  if (v && typeof v.big_y === 'string' && typeof v.big_c === 'string') {
    return { state: 'released', method, answer: value, events };
  }
  const reason = v && typeof v.error === 'string' ? v.error : 'no key in the result';
  return { state: 'not_released', method, reason, events };
}

function panicMessage(failure: unknown): string {
  const kind = (
    failure as { ActionError?: { kind?: { FunctionCallError?: { ExecutionError?: unknown } } } }
  )?.ActionError?.kind?.FunctionCallError?.ExecutionError;
  if (typeof kind === 'string') return kind.replace(/^Smart contract panicked: /, '');
  return JSON.stringify(failure);
}

/** Fetches a transaction's outcome; `wait` as NEAR's `wait_until`. */
export async function txOutcome(
  url: string,
  txHash: string,
  signer: string,
  contractId: string,
  wait: 'EXECUTED_OPTIMISTIC' | 'FINAL' = 'FINAL',
  call?: { method: string; args: unknown },
): Promise<Outcome> {
  const r = await rpc(url, 'EXPERIMENTAL_tx_status', {
    tx_hash: txHash,
    sender_account_id: signer,
    wait_until: wait,
  });
  return readOutcome(r, contractId, { txHash, signer, ...call });
}

/** The current access key at finality, never an optimistic or wallet-supplied permission. */
export async function isFullAccessKey(
  url: string,
  accountId: string,
  publicKey: string,
): Promise<boolean> {
  const key = await rpc(url, 'query', {
    request_type: 'view_access_key',
    finality: 'final',
    account_id: accountId,
    public_key: publicKey,
  });
  return key.permission === 'FullAccess';
}

export interface FileStorageBalance {
  available: bigint;
  admissionRequirement: bigint;
}
export async function fileStorageBalance(
  url: string,
  contractId: string,
  fileId: string,
): Promise<FileStorageBalance> {
  const value = (await view(url, contractId, 'file_storage_balance', { file_id: fileId })) as {
    available?: unknown;
    admission_requirement?: unknown;
  } | null;
  const amount = (v: unknown) =>
    typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) && BigInt(v) < 2n ** 128n;
  if (
    !value ||
    !amount(value.available) ||
    !amount(value.admission_requirement) ||
    BigInt(value.admission_requirement as string) === 0n
  )
    return malformed('file_storage_balance');
  return {
    available: BigInt(value.available as string),
    admissionRequirement: BigInt(value.admission_requirement as string),
  };
}

/** Contract storage refusal diagnostics, shared by transaction transports. */
export function isStorageRequired(reason: unknown): boolean {
  return typeof reason === 'string' && /prepaid|storage balance|storage[_ ]deposit/i.test(reason);
}
