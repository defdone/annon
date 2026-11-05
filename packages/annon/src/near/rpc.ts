/**
 * Reading the Annon contract over NEAR JSON-RPC: views, and the outcome of a transaction sent to
 * it. Two rules, from how NEAR executes a call:
 * - Whether a payment or a listing was recorded is read from contract state (`is_payment_used`,
 *   `get_file`), never from logs: a receipt that fails keeps its logs while its changes roll back,
 *   and a callback can fail after an earlier receipt committed.
 * - Events count only from successful receipts executed by the trusted contract: any contract can
 *   log `EVENT_JSON` with standard `annon`.
 * The RPC is trusted to report the chain; answers that don't fit the request are refused.
 */
import type { Source } from './texts.js';

export type NearErrorCode =
  /** The RPC couldn't be reached or answered something malformed; safe to retry. */
  | 'transport'
  /** The contract refused (a panic); retrying the same call gives the same answer. */
  | 'refused';

export class NearError extends Error {
  readonly code: NearErrorCode;
  constructor(code: NearErrorCode, message: string = code) {
    super(message);
    this.code = code;
    this.name = 'NearError';
  }
}

const fail = (code: NearErrorCode, message?: string): never => {
  throw new NearError(code, message);
};
const malformed = (what: string): never => fail('transport', `malformed RPC answer: ${what}`);

const toBase64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const fromBase64 = (s: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

let nextId = 0;

async function rpc(url: string, method: string, params: unknown): Promise<Record<string, unknown>> {
  const id = `annon-${++nextId}`;
  let body: {
    id?: unknown;
    result?: Record<string, unknown>;
    error?: { cause?: { name?: string; info?: unknown }; data?: unknown; message?: string };
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    body = await res.json();
  } catch (e) {
    return fail('transport', `NEAR RPC unreachable: ${(e as Error).message}`);
  }
  if (body?.id !== id) return malformed('a reply to another request');
  if (body.error) {
    const msg = JSON.stringify(body.error.cause?.info ?? body.error.data ?? body.error.message);
    // A view that panics comes back as an RPC error on some providers.
    if (body.error.cause?.name === 'CONTRACT_EXECUTION_ERROR') fail('refused', msg);
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
): Promise<unknown> {
  const r = await rpc(url, 'query', {
    request_type: 'call_function',
    finality: 'final',
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
const U128_MAX = 2n ** 128n - 1n;
const TAKEDOWN = ['illegal_content', 'court_order', 'rights_holder_notice'] as const;

/** The contract's `get_file`, with the price as a bigint. `null` for an unknown file. */
export interface FileInfo {
  seller: string;
  price: bigint;
  source: Source;
  cipherHash: string;
  moderator: string | null;
  salesStoppedAt: number | null;
  takenDown: (typeof TAKEDOWN)[number] | null;
}

export async function getFile(
  url: string,
  contractId: string,
  fileId: string,
): Promise<FileInfo | null> {
  const f = (await view(url, contractId, 'get_file', { file_id: fileId })) as Record<
    string,
    unknown
  > | null;
  if (f === null) return null;
  const s = f?.source as { kind?: unknown; pay_to?: unknown } | undefined;
  // The contract stores `pay_to` as registered: any case, `0x` or not.
  const payTo =
    s?.kind === 'x402' && typeof s.pay_to === 'string' && /^(0x)?[0-9a-fA-F]{40}$/.test(s.pay_to)
      ? `0x${s.pay_to.replace(/^0x/, '').toLowerCase()}`
      : undefined;
  const price = typeof f?.price === 'string' && /^\d{1,39}$/.test(f.price) ? BigInt(f.price) : 0n;
  if (
    !isHex(f?.seller, 20) ||
    price < 1n ||
    price > U128_MAX ||
    !(s?.kind === 'partner' || payTo) ||
    !isHex(f.cipher_hash, 32) ||
    !(f.moderator === null || isAccount(f.moderator)) ||
    !(
      f.sales_stopped_at === null ||
      (Number.isSafeInteger(f.sales_stopped_at) && (f.sales_stopped_at as number) > 0)
    ) ||
    !(f.taken_down === null || TAKEDOWN.includes(f.taken_down as (typeof TAKEDOWN)[number]))
  ) {
    return malformed('get_file');
  }
  return {
    seller: f.seller as string,
    price,
    source: payTo ? { kind: 'x402', pay_to: payTo } : { kind: 'partner' },
    cipherHash: f.cipher_hash as string,
    moderator: f.moderator as string | null,
    salesStoppedAt: f.sales_stopped_at as number | null,
    takenDown: f.taken_down as FileInfo['takenDown'],
  };
}

async function flag(url: string, contractId: string, method: string, args: object) {
  const v = await view(url, contractId, method, args);
  return typeof v === 'boolean' ? v : malformed(method);
}

export const isBuyer = (url: string, contractId: string, fileId: string, wallet: string) =>
  flag(url, contractId, 'is_buyer', { file_id: fileId, wallet });

/** Whether an `unlock` for this Base payment was recorded: the truth after any failed release. */
export const isPaymentUsed = (url: string, contractId: string, baseTx: string, logIndex: number) =>
  flag(url, contractId, 'is_payment_used', { base_tx: baseTx, log_index: logIndex });

/** An NEP-297 event the trusted contract logged in a receipt that succeeded. */
export interface AnnonEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Calls whose result is the CKD answer. */
const RELEASES = new Set(['register', 'unlock', 'reopen']);

export type Outcome =
  /** Not finished yet: ask again. */
  | { state: 'pending'; method: string; events: AnnonEvent[] }
  /** CKD answered: `answer` holds `big_y`/`big_c` for `keys/near-ckd`. */
  | { state: 'released'; method: string; answer: unknown; events: AnnonEvent[] }
  /**
   * `register`, `unlock` or `reopen` ended without a key. Whether the listing or the payment was
   * recorded is a question for the contract (`get_file`, `is_payment_used`): if it was, `reopen`
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

/**
 * Reads an `EXPERIMENTAL_tx_status` / `tx` result. With `expect`, the answer must be about that
 * transaction. Only single-call transactions to `contractId` are read: the SDK sends no batches.
 */
export function readOutcome(
  result: unknown,
  contractId: string,
  expect?: { txHash: string; signer: string },
): Outcome {
  const r = result as {
    transaction?: {
      hash?: unknown;
      signer_id?: unknown;
      receiver_id?: unknown;
      actions?: { FunctionCall?: { method_name?: unknown } }[];
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
  if (actions.length !== 1 || typeof method !== 'string') {
    return malformed('not a single function call');
  }

  const events: AnnonEvent[] = [];
  for (const o of Array.isArray(r.receipts_outcome) ? r.receipts_outcome : []) {
    if (o?.outcome?.executor_id !== contractId || !succeeded(o.outcome.status)) continue;
    for (const log of Array.isArray(o.outcome.logs) ? o.outcome.logs : []) {
      if (typeof log !== 'string' || !log.startsWith('EVENT_JSON:')) continue;
      try {
        const e = JSON.parse(log.slice('EVENT_JSON:'.length));
        if (e.standard === 'annon' && e.version === '1.0.0' && typeof e.event === 'string') {
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
): Promise<Outcome> {
  const r = await rpc(url, 'EXPERIMENTAL_tx_status', {
    tx_hash: txHash,
    sender_account_id: signer,
    wait_until: wait,
  });
  return readOutcome(r, contractId, { txHash, signer });
}
