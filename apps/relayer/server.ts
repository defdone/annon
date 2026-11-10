/**
 * The public Annon relayer: an HTTP front for `relay` (packages/annon/src/relay). It keeps no
 * database; each request is checked and sent, and one log line records it on stdout.
 *
 *   POST /v1/relay          a RelayRequest as JSON → 200 { txHash, signer }, or 202 { txHash, signer,
 *                           uncertain: true, reason } when NEAR's answer was lost or unclear (read the
 *                           outcome by hash),
 *                           or 4xx/5xx { error, message }
 *   GET  /v1/capabilities   what this relayer sponsors
 *
 * The caller reads the transaction's outcome through its own NEAR RPC: a relayer can't fake one.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  type CheckOptions,
  RelayError,
  type RelayErrorCode,
  relay,
  type Sender,
} from '../../packages/annon/src/relay/relay.ts';
import { identityJson, parseIdentity } from '../../packages/annon/src/settle-near/identity.ts';

export interface Config extends Omit<CheckOptions, 'now'> {
  sender: Sender;
  /** Kill switch: answer 503 and send nothing. */
  disabled: boolean;
  /** Requests per IP per hour, and transactions per day for everyone. */
  perIpHour: number;
  perDay: number;
  /** The header a trusted proxy puts the client's IP in; without one, the connection's address. */
  ipHeader?: string;
}

const STATUS: Record<RelayErrorCode, number> = {
  bad_request: 400,
  bad_signature: 400,
  bad_deadline: 400,
  not_sponsored: 403,
  unknown_file: 404,
  payment_not_found: 404,
  not_buyer: 403,
  already_registered: 409,
  sales_stopped: 409,
  payment_used: 409,
  taken_down: 410,
  // Too Early: the same request succeeds once Base reaches safe.
  payment_not_safe: 425,
  bad_header: 400,
  limited: 429,
  duplicate: 409,
  unavailable: 503,
  transport: 502,
};

const MAX_BODY = 64 * 1024;

// ponytail: counters in memory, reset on restart; one machine. Shared store if it ever scales out.
export const hits = new Map<string, { n: number; until: number }>();
/** Above this many counters, expired ones are swept; past the cap, new addresses wait. */
const SWEEP_AT = 10_000;
const CAP = 100_000;
/** Charges one use; the counter charged, or null at the limit. */
function allow(key: string, limit: number, windowMs: number, now: number) {
  if (hits.size >= SWEEP_AT && !hits.has(key)) {
    for (const [k, v] of hits) if (v.until <= now) hits.delete(k);
    if (hits.size >= CAP) return null;
  }
  const old = hits.get(key);
  const h = old && old.until > now ? old : { n: 0, until: now + windowMs };
  if (h.n >= limit) return null;
  h.n++;
  hits.set(key, h);
  return h;
}

/** One request: status and JSON body. Separate from the socket so it can be tested directly. */
export async function handle(
  c: Config,
  method: string,
  path: string,
  ip: string,
  body: string,
  send: typeof relay = relay,
): Promise<{ status: number; body: unknown }> {
  if (method === 'GET' && path === '/v1/capabilities') {
    return {
      status: 200,
      body: {
        network: 'near:mainnet',
        contract: c.contractId,
        relayer: c.sender.accountId,
        methods: ['register', 'unlock', 'claim_key', 'reopen', 'reopen_seller', 'stop_sales'],
        minPrice: c.policy.minPrice.toString(),
        maxDeadlineSeconds: c.policy.maxDeadlineSeconds,
        disabled: c.disabled,
      },
    };
  }
  if (method === 'GET' && path === '/healthz') return { status: 200, body: { ok: true } };
  if (method !== 'POST' || path !== '/v1/relay')
    return { status: 404, body: { error: 'not_found' } };
  if (c.disabled)
    return { status: 503, body: { error: 'disabled', message: 'relaying is paused' } };
  const now = Date.now();
  if (!allow(`ip:${ip}`, c.perIpHour, 3_600_000, now)) {
    return {
      status: 429,
      body: { error: 'rate_limited', message: 'too many requests from this address' },
    };
  }
  let req: unknown;
  try {
    req = JSON.parse(body);
  } catch {
    return { status: 400, body: { error: 'bad_request', message: 'the body is not JSON' } };
  }
  // The day's budget is reserved before sending, so concurrent requests can't overrun it, and
  // given back when `relay` throws: it throws only before anything is sent.
  const day = allow('day', c.perDay, 86_400_000, now);
  if (!day) {
    return { status: 503, body: { error: 'budget', message: "today's relaying budget is spent" } };
  }
  try {
    const { txHash, uncertain, reason } = await send(req, c);
    // 202: NEAR's answer was lost or unclear; the caller reads the outcome by hash.
    return uncertain
      ? { status: 202, body: { txHash, signer: c.sender.accountId, uncertain: true, reason } }
      : { status: 200, body: { txHash, signer: c.sender.accountId } };
  } catch (e) {
    // Back to the window it was charged to; a newer day keeps its own count.
    if (hits.get('day') === day && day.n > 0) day.n--;
    if (e instanceof RelayError) {
      return { status: STATUS[e.code], body: { error: e.code, message: e.message } };
    }
    return { status: 500, body: { error: 'internal', message: 'unexpected error' } };
  }
}

/** The body, null when it is over the limit; rejects when the client goes away mid-upload. */
async function read(req: IncomingMessage): Promise<string | null> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return null;
    parts.push(chunk as Buffer);
  }
  return Buffer.concat(parts).toString('utf8');
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST',
  'access-control-allow-headers': 'content-type',
};

/** The HTTP server; nothing a client sends can make the request handler throw. */
export function serve(c: Config, port: number) {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void respond(c, req, res).catch(() => {
      // An aborted upload or a socket gone: nothing to answer.
      if (!res.headersSent && res.writable) res.writeHead(400, CORS).end();
    });
  }).listen(port, () =>
    console.log(`annon relayer on :${port} for ${c.contractId} as ${c.sender.accountId}`),
  );
}

async function respond(c: Config, req: IncomingMessage, res: ServerResponse) {
  if (req.method === 'OPTIONS') return void res.writeHead(204, CORS).end();
  // A client can send any header: only the one a trusted proxy sets (and overwrites) counts.
  const forwarded = c.ipHeader ? req.headers[c.ipHeader] : undefined;
  const ip = String(forwarded ?? req.socket.remoteAddress ?? '');
  const body = req.method === 'POST' ? await read(req) : '';
  const path = (req.url ?? '/').split('?')[0] as string;
  const out =
    body === null
      ? { status: 413, body: { error: 'too_large' } }
      : await handle(c, req.method ?? 'GET', path, ip, body);
  if (path === '/v1/relay') {
    let what: unknown = null;
    try {
      what = JSON.parse(body ?? 'null');
    } catch {}
    const r = (what && typeof what === 'object' ? what : {}) as {
      method?: unknown;
      args?: { file_id?: unknown };
    };
    const file = r.args && typeof r.args === 'object' ? r.args.file_id : undefined;
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        ip,
        method: r.method,
        file,
        status: out.status,
        ...(out.body as object),
      }),
    );
  }
  res
    .writeHead(out.status, { ...CORS, 'content-type': 'application/json' })
    .end(JSON.stringify(out.body));
}

/** The settings from the environment (apps/relayer/README.md); throws on a missing or bad one. */
export function fromEnv(e: Record<string, string | undefined>): { config: Config; port: number } {
  const env = (name: string, fallback?: string) => {
    const v = e[name]?.trim() || fallback;
    if (v === undefined) throw new Error(`${name} is not set`);
    return v;
  };
  // A typo stops the start instead of turning a limit off.
  const count = (name: string, fallback: string) => {
    const n = Number(env(name, fallback));
    if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} must be a whole number`);
    return n;
  };
  const sellers = e.SELLERS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const separator = s.indexOf(':');
      return identityJson(
        parseIdentity({ kind: s.slice(0, separator), id: s.slice(separator + 1) }),
      );
    });
  return {
    config: {
      nearRpc: env('NEAR_RPC', 'https://rpc.mainnet.fastnear.com'),
      baseRpc: env('BASE_RPC', 'https://mainnet.base.org'),
      contractId: env('CONTRACT_ID'),
      usdc: env('USDC', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
      sender: { accountId: env('RELAYER_ACCOUNT'), key: env('RELAYER_KEY') },
      policy: {
        minPrice: BigInt(count('MIN_PRICE', '10000')),
        maxDeadlineSeconds: count('MAX_DEADLINE_SECONDS', '600'),
        ...(sellers?.length ? { sellerAllowed: (s: string) => sellers.includes(s) } : {}),
      },
      disabled: env('DISABLED', '0') === '1',
      perIpHour: count('PER_IP_HOUR', '60'),
      perDay: count('PER_DAY', '500'),
      ...(e.IP_HEADER?.trim() ? { ipHeader: e.IP_HEADER.trim().toLowerCase() } : {}),
    },
    port: count('PORT', '8080'),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { config, port } = fromEnv(process.env);
  serve(config, port);
}
