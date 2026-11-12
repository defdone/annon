/**
 * The public Annon relayer: an HTTP front for `relay` (packages/annon/src/relay). Relay admission
 * is in memory; the optional dedicated keeper persists jobs and budgets. Requests are checked
 * and sent, and one log line records each response on stdout.
 *
 *   POST /v1/relay          a RelayRequest as JSON → 200 { txHash, signer }, or 202 { txHash, signer,
 *                           uncertain: true, reason } when NEAR's answer was lost or unclear (read the
 *                           outcome by hash),
 *                           or 4xx/5xx { error, message }
 *   GET  /v1/capabilities   what this relayer sponsors
 *
 * The caller reads the transaction's outcome through its own NEAR RPC: a relayer can't fake one.
 */
import { mkdir } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { getConfig, rpcReply, view } from '../../packages/annon/src/near/rpc.ts';
import type { BudgetRecord } from '../../packages/annon/src/node/budget.ts';
import { fileStore } from '../../packages/annon/src/pay/store-node.ts';
import { keeperBalance } from '../../packages/annon/src/relay/keeper-balance.ts';
import type {
  KeeperRecord,
  KeepOptions,
  RefundSource,
} from '../../packages/annon/src/relay/keeper-runner.ts';
import {
  type CheckOptions,
  keep,
  RelayError,
  type RelayErrorCode,
  relay,
  relayStatus,
  type Sender,
} from '../../packages/annon/src/relay/relay.ts';
import { identityJson, parseIdentity } from '../../packages/annon/src/settle-near/identity.ts';

export interface Config extends Omit<CheckOptions, 'now'> {
  sender: Sender;
  keeper?: {
    sender: Sender;
    stateDir: string;
    hourlyBudget: bigint;
    dailyBudget: bigint;
    gasPrice: bigint;
    reserveLowWater: bigint;
    minPayout?: bigint;
    balanceLowWater?: bigint;
    alertWebhook?: string;
    refunds?: RefundSource;
  };
  /** Kill switch: answer 503 and send nothing. */
  disabled: boolean;
  /** New admissions per client per hour, and default daily capacity of each method pool. */
  sponsoredFilesPerIpDay?: number;
  perIpHour: number;
  perDay: number;
  unlockReserved?: number;
  perMethodDay?: Partial<Record<string, number>>;
  hitsCap?: number;
  requestMultiplier?: number;
  retrySeconds?: number;
  balanceLowWater?: bigint;
  storageLowWater?: bigint;
  alertWebhook?: string;
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
  in_flight: 202,
  unavailable: 503,
  transport: 502,
};

const MAX_BODY = 64 * 1024;

// Note: counters in memory, reset on restart; one machine. Shared store if it ever scales out.
export const hits = new Map<string, { n: number; until: number }>();
/** Expired counters are swept; oldest client counters are evicted at capacity. */
const SWEEP_AT = 10_000;
const CAP = 100_000;
/** Charges one use; the counter charged, or null at the limit. */
function allow(key: string, limit: number, windowMs: number, now: number, cap = CAP) {
  if (hits.size >= Math.min(SWEEP_AT, cap) && !hits.has(key)) {
    for (const [k, v] of hits) if (v.until <= now) hits.delete(k);
    while (hits.size >= cap) {
      let oldest: string | undefined;
      for (const key of hits.keys())
        if (key !== 'day' && !key.startsWith('day:')) {
          oldest = key;
          break;
        }
      if (oldest === undefined) break;
      hits.delete(oldest);
    }
  }
  const old = hits.get(key);
  const h = old && old.until > now ? old : { n: 0, until: now + windowMs };
  if (h.n >= limit) return null;
  h.n++;
  hits.set(key, h);
  return h;
}

/** Canonical IPv6 /64, including compressed notation; mapped IPv4 shares its IPv4 bucket. */
export function ipBucket(ip: string): string {
  const address = ip.split('%')[0] ?? ip;
  if (isIP(address) !== 6) return ip;
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left = '', right] = canonical.split('::');
  const a = left ? left.split(':') : [];
  const b = right ? right.split(':') : [];
  const words = right === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  if (words.slice(0, 5).every((w) => Number.parseInt(w, 16) === 0) && words[5] === 'ffff') {
    const n = Number.parseInt(words[6] ?? '0', 16) * 65536 + Number.parseInt(words[7] ?? '0', 16);
    return [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join('.');
  }
  return `${words
    .slice(0, 4)
    .map((w) => Number.parseInt(w, 16).toString(16))
    .join(':')}::/64`;
}

type RelayLookup = (
  ...args: Parameters<typeof relayStatus>
) => ReturnType<typeof relayStatus> | Awaited<ReturnType<typeof relayStatus>>;

/** One request: status and JSON body. Separate from the socket so it can be tested directly. */
export async function handle(
  c: Config,
  method: string,
  path: string,
  ip: string,
  body: string,
  send: typeof relay = relay,
  lookup: RelayLookup = relayStatus,
): Promise<{ status: number; body: unknown; headers?: Record<string, string> }> {
  const result = await admission(c, method, path, ipBucket(ip), body, send, lookup);
  return [429, 503, 425].includes(result.status)
    ? { ...result, headers: { 'Retry-After': String(result.retrySeconds ?? c.retrySeconds ?? 5) } }
    : result;
}
async function admission(
  c: Config,
  method: string,
  path: string,
  ip: string,
  body: string,
  send: typeof relay,
  lookup: RelayLookup,
): Promise<{ status: number; body: unknown; retrySeconds?: number }> {
  if (method === 'GET' && path === '/v1/capabilities') {
    return {
      status: 200,
      body: {
        network: 'near:mainnet',
        contract: c.contractId,
        relayer: c.sender.accountId,
        methods: [
          'register',
          'unlock',
          'claim_key',
          'reopen',
          'reopen_seller',
          'stop_sales',
          'fund_file_storage',
        ],
        baseSponsorship: c.policy.baseSponsorship !== false,
        fee: c.policy.fee ?? { fixed: '0', bps: 0, treasuryNear: null, treasuryEvm: null },
        sponsorship: {
          filesPerDay: c.policy.sponsoredFilesPerDay ?? 100,
          filesPerIpDay: c.sponsoredFilesPerIpDay ?? 5,
          fileBudget: String(c.policy.fileBudget ?? 5n * 10n ** 22n),
          listedFileBudget: String(
            c.policy.listedFileBudget ?? c.policy.fileBudget ?? 5n * 10n ** 22n,
          ),
          topupPerFile: String(c.policy.topupPerFile ?? 15n * 10n ** 22n),
          topupPerFileDay: String(c.policy.topupPerFileDay ?? 5n * 10n ** 22n),
          topupPerDay: String(c.policy.topupPerDay ?? 5n * 10n ** 23n),
        },
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
  // Coarse per-IP cap before any parsing, so polling can't be used to load the relayer.
  // Ten times the admission budget leaves room for a client polling every 5 s.
  if (
    !allow(`req:${ip}`, c.perIpHour * (c.requestMultiplier ?? 10), 3_600_000, Date.now(), c.hitsCap)
  )
    return {
      status: 429,
      retrySeconds: 3600,
      body: { error: 'rate_limited', message: 'too many requests from this address' },
    };
  let req: unknown;
  let validJson = true;
  try {
    req = JSON.parse(body);
  } catch {
    validJson = false;
  }
  // An admitted operation may be polled even when new admissions have spent the budgets.
  // Invalid requests still go through the IP limiter and the normal relay validation.
  if (validJson) {
    try {
      const admitted = await lookup(req, c);
      if (admitted === 'pending')
        return { status: 202, body: { pending: true, retryAfterMs: 5000 } };
      if (admitted)
        return {
          status: admitted.uncertain ? 202 : 200,
          body: { ...admitted, signer: c.sender.accountId },
        };
    } catch (e) {
      if (!(e instanceof RelayError)) throw e;
    }
  }
  const now = Date.now();
  const ipAdmission = allow(`ip:${ip}`, c.perIpHour, 3_600_000, now, c.hitsCap);
  if (!ipAdmission) {
    return {
      status: 429,
      retrySeconds: 3600,
      body: { error: 'rate_limited', message: 'too many requests from this address' },
    };
  }
  if (!validJson)
    return { status: 400, body: { error: 'bad_request', message: 'the body is not JSON' } };
  // The day's budget is reserved before sending, so concurrent requests can't overrun it, and
  // given back when `relay` throws: it throws only before anything is sent.
  const relayMethod = (req as { method?: unknown } | null)?.method;
  const pool =
    typeof relayMethod === 'string' &&
    [
      'register',
      'unlock',
      'claim_key',
      'reopen',
      'reopen_seller',
      'stop_sales',
      'fund_file_storage',
    ].includes(relayMethod)
      ? relayMethod
      : 'invalid';
  const charges: [string, { n: number; until: number }][] = [];
  const refund = () => {
    for (const [key, counter] of charges) {
      if (hits.get(key) === counter && counter.n > 0) {
        counter.n--;
        if (counter.n === 0 && key.startsWith('day:files-ip:')) hits.delete(key);
      }
    }
  };
  if (pool === 'register') {
    for (const [key, limit] of [
      ['day:files', c.policy.sponsoredFilesPerDay ?? 100],
      [`day:files-ip:${ip}`, c.sponsoredFilesPerIpDay ?? 5],
    ] as const) {
      const counter = allow(key, limit, 86_400_000, now, c.hitsCap);
      if (!counter) {
        refund();
        return { status: 429, body: { error: 'limited', message: 'sponsored file limit reached' } };
      }
      charges.push([key, counter]);
    }
  }
  const global = allow('day', c.perDay, 86_400_000, now, c.hitsCap);
  if (global) charges.push(['day', global]);
  const windowMs = global ? global.until - now : 86_400_000;
  const reserve = c.unlockReserved ?? Math.ceil(c.perDay / 2);
  const other =
    global && pool !== 'unlock'
      ? allow('day:other', Math.max(0, c.perDay - reserve), windowMs, now, c.hitsCap)
      : global;
  if (other && pool !== 'unlock') charges.push(['day:other', other]);
  const dayKey = `day:${pool}`;
  const day = other
    ? allow(dayKey, c.perMethodDay?.[pool] ?? c.perDay, windowMs, now, c.hitsCap)
    : null;
  if (!day) {
    refund();
    const retrySeconds = Math.max(
      1,
      Math.ceil(((hits.get('day')?.until ?? now + 86400000) - now) / 1000),
    );
    return {
      status: 503,
      retrySeconds,
      body: { error: 'budget', message: "today's relaying budget is spent" },
    };
  }
  charges.push([dayKey, day]);
  try {
    const { txHash, uncertain, reason } = await send(req, c);
    // 202: NEAR's answer was lost or unclear; the caller reads the outcome by hash.
    return uncertain
      ? { status: 202, body: { txHash, signer: c.sender.accountId, uncertain: true, reason } }
      : { status: 200, body: { txHash, signer: c.sender.accountId } };
  } catch (e) {
    // Back to the window it was charged to; a newer day keeps its own count.
    refund();
    if (e instanceof RelayError) {
      if (
        e.code === 'payment_not_safe' &&
        hits.get(`ip:${ip}`) === ipAdmission &&
        ipAdmission.n > 0
      )
        ipAdmission.n--;
      if (e.code === 'in_flight')
        return { status: 202, body: { pending: true, retryAfterMs: 5000 } };
      return {
        status: STATUS[e.code],
        body: { error: e.code, message: e.message },
        ...(e.retryAt !== undefined
          ? { retrySeconds: Math.max(1, Math.ceil((e.retryAt - Date.now()) / 1000)) }
          : {}),
      };
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
  'access-control-expose-headers': 'Retry-After',
};

/** The HTTP server; nothing a client sends can make the request handler throw. */
export function serve(c: Config, port: number, keeperSeconds = 0) {
  if (c.alertWebhook !== undefined) webhookUrl(c.alertWebhook);
  if (c.keeper?.alertWebhook !== undefined) webhookUrl(c.keeper.alertWebhook);
  if (
    c.keeper &&
    (c.keeper.sender.accountId === c.sender.accountId || c.keeper.sender.key === c.sender.key)
  )
    throw new Error('keeper requires a separate account and key');
  if (keeperSeconds > 0 && !c.keeper) throw new Error('separate keeper configuration required');
  const stopKeeper = keeperSeconds > 0 ? keeper(c, keeperSeconds) : () => {};
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void respond(c, req, res).catch(() => {
      // An aborted upload or a socket gone: nothing to answer.
      if (!res.headersSent && res.writable) res.writeHead(400, CORS).end();
    });
  });
  const stopAlerts = monitorRelayer(c);
  server.once('close', () => {
    stopKeeper();
    stopAlerts();
  });
  return server.listen(port, () =>
    console.log(`annon relayer on :${port} for ${c.contractId} as ${c.sender.accountId}`),
  );
}

/** Keeper passes every `seconds`, one at a time, each over every delivery. */
export function keeper(c: Config, seconds: number) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cachedConfig: Awaited<ReturnType<typeof getConfig>> | undefined;
  const pass = async () => {
    if (stopped) return;
    if (!c.disabled) {
      try {
        const k = c.keeper;
        if (!k) throw new Error('separate keeper configuration required');
        const jobs = join(k.stateDir, 'jobs'),
          budgets = join(k.stateDir, 'budgets');
        await mkdir(jobs, { recursive: true, mode: 0o700 });
        await mkdir(budgets, { recursive: true, mode: 0o700 });
        const deliveries: Promise<void>[] = [];
        cachedConfig ??= await getConfig(c.nearRpc, c.contractId);
        const options: KeepOptions = {
          network: cachedConfig.network,
          nearRpc: c.nearRpc,
          contractId: c.contractId,
          sender: k.sender,
          store: fileStore<KeeperRecord>(jobs),
          budgetStore: fileStore<BudgetRecord>(budgets),
          hourlyBudget: k.hourlyBudget,
          dailyBudget: k.dailyBudget,
          gasPrice: k.gasPrice,
          reserveLowWater: k.reserveLowWater,
          ...(k.minPayout === undefined ? {} : { minPayout: k.minPayout }),
          ...(k.balanceLowWater === undefined ? {} : { balanceLowWater: k.balanceLowWater }),
          ...(k.refunds ? { refunds: k.refunds } : {}),
          alert: (alert) => {
            console.log(JSON.stringify({ keeper: 'alert', ...alert }));
            if (k.alertWebhook) deliveries.push(deliverKeeperAlert(k.alertWebhook, alert));
          },
        };
        const result = await keep(options);
        await Promise.all(deliveries);
        for (const incident of result.incidents)
          console.log(JSON.stringify({ keeper: 'incident', ...incident }));
        // The message only: keeper errors carry RPC and validation text, never key material.
        for (const { deliveryId, error } of result.errors)
          console.log(
            JSON.stringify({
              keeper: 'error',
              deliveryId,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        for (const s of result.sent)
          console.log(
            JSON.stringify({
              at: new Date().toISOString(),
              keeper: s.method,
              ...s.args,
              ...s.result,
            }),
          );
      } catch (e) {
        console.log(
          JSON.stringify({
            at: new Date().toISOString(),
            keeper: 'error',
            message: (e as Error).message,
          }),
        );
      }
    }
    if (!stopped) timer = setTimeout(pass, seconds * 1000).unref();
  };
  void pass();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
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
        method: logField(r.method, 32),
        file: logField(file, 66),
        status: out.status,
        ...(out.body as object),
      }),
    );
  }
  res
    .writeHead(out.status, {
      ...CORS,
      ...('headers' in out ? out.headers : {}),
      'content-type': 'application/json',
    })
    .end(JSON.stringify(out.body));
}

export const logField = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' ? value.slice(0, max) : undefined;

type RelayerAlert = {
  type: 'low_balance' | 'storage_low';
  balance?: string;
  needed?: string;
  reserve?: string;
};
const relayerLow = new WeakMap<Config, Set<string>>();
/** One finalized balance sample; repeated low conditions alert only on transition. */
export async function relayerAlerts(c: Config): Promise<RelayerAlert[]> {
  const block = await rpcReply(c.nearRpc, 'block', { finality: 'final' });
  const hash = (block.result as { header?: { hash?: string } })?.header?.hash;
  if (block.error || !hash) throw new Error('final relayer balance block unavailable');
  const price = await rpcReply(c.nearRpc, 'gas_price', { block_id: hash });
  const gasPrice = (price.result as { gas_price?: string })?.gas_price;
  if (price.error || typeof gasPrice !== 'string' || !/^[0-9]+$/.test(gasPrice))
    throw new Error('relayer gas price unavailable');
  const [funds, storage] = await Promise.all([
    keeperBalance({
      nearRpc: c.nearRpc,
      accountId: c.sender.accountId,
      contractId: c.contractId,
      block: hash,
      gasPrice: BigInt(gasPrice),
      method: 'unlock',
      args: {},
      gas: 300000000000000n,
    }),
    view(c.nearRpc, c.contractId, 'storage_balance_of', { account_id: c.sender.accountId }, hash),
  ]);
  if (typeof storage !== 'string' || !/^[0-9]+$/.test(storage))
    throw new Error('relayer storage balance unavailable');
  const needed = funds.cost > (c.balanceLowWater ?? 0n) ? funds.cost : (c.balanceLowWater ?? 0n);
  const low: RelayerAlert[] = [];
  if (funds.balance < needed)
    low.push({ type: 'low_balance', balance: String(funds.balance), needed: String(needed) });
  if (BigInt(storage) < (c.storageLowWater ?? 100000000000000000000000n))
    low.push({ type: 'storage_low', reserve: storage });
  const old = relayerLow.get(c) ?? new Set<string>();
  relayerLow.set(c, new Set(low.map((a) => a.type)));
  return low.filter((a) => !old.has(a.type));
}
function monitorRelayer(c: Config): () => void {
  if (c.balanceLowWater === undefined && c.storageLowWater === undefined && !c.alertWebhook)
    return () => {};
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  const pass = async () => {
    try {
      for (const alert of await relayerAlerts(c)) {
        console.log(JSON.stringify({ relayer: 'alert', ...alert }));
        if (c.alertWebhook) await deliverKeeperAlert(c.alertWebhook, alert, fetch, 'relayer');
      }
    } catch {
      /* Monitoring failure cannot interrupt admission or expose endpoint credentials. */
    }
    if (!stopped) timer = setTimeout(pass, 60000).unref();
  };
  timer = setTimeout(pass, 60000).unref();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

function webhookUrl(value: string): string {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.hash) throw new Error();
    // Discord's Slack-compatible endpoint accepts the same {text} body as Slack.
    if (
      ['discord.com', 'discordapp.com'].includes(u.hostname) &&
      /^\/api(?:\/v[0-9]+)?\/webhooks\//.test(u.pathname) &&
      !u.pathname.endsWith('/slack')
    )
      u.pathname = `${u.pathname.replace(/\/$/, '')}/slack`;
    return u.href;
  } catch {
    throw new Error('KEEPER_ALERT_WEBHOOK must be an HTTPS URL without user info or fragment');
  }
}

/** Failures are deliberately contained; only public keeper alert fields are delivered. */
export async function deliverKeeperAlert(
  url: string,
  value: Parameters<NonNullable<KeepOptions['alert']>>[0] | RelayerAlert,
  fetcher: typeof fetch = fetch,
  source = 'keeper',
): Promise<void> {
  try {
    const alert: Record<string, string | number> = { type: value.type };
    for (const field of ['balance', 'needed', 'reserve'] as const) {
      const n = value[field];
      if (typeof n === 'string' && /^[0-9]+$/.test(n)) alert[field] = n;
    }
    if (
      'deliveryId' in value &&
      Number.isSafeInteger(value.deliveryId) &&
      (value.deliveryId ?? -1) >= 0
    )
      alert.deliveryId = value.deliveryId as number;
    const response = await fetcher(webhookUrl(url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: `${source}: alert ${JSON.stringify(alert)}`, alert }),
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    });
    await response.body?.cancel();
  } catch {
    /* Alerts must never interrupt keeper work or log webhook credentials/errors. */
  }
}

/** The settings from the environment (apps/relayer/README.md); throws on a missing or bad one. */
export function fromEnv(e: Record<string, string | undefined>): {
  config: Config;
  port: number;
  keeperSeconds: number;
} {
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
  const keeperSeconds = count('KEEPER_SECONDS', '0');
  const yocto = (name: string, fallback?: string) => {
    const value = env(name, fallback);
    if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} must be yoctoNEAR`);
    return BigInt(value);
  };
  const nearAmount = (name: string, fallback: string) => {
    const value = env(name, fallback);
    if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,24})?$/.test(value)) throw new Error(`${name} must be NEAR`);
    const [whole = '0', fraction = ''] = value.split('.');
    const amount = BigInt(whole) * 10n ** 24n + BigInt(fraction.padEnd(24, '0'));
    if (amount >= 2n ** 128n) throw new Error(`${name} too large`);
    return amount;
  };
  const treasury = (name: string) => {
    const value = e[name]?.trim();
    if (!value) return null;
    const at = value.indexOf(':');
    const identity = parseIdentity(
      at < 0
        ? { kind: name === 'TREASURY_EVM' ? 'evm' : 'near', id: value }
        : { kind: value.slice(0, at), id: value.slice(at + 1) },
    );
    if (name === 'TREASURY_EVM' && identity.kind !== 'evm')
      throw new Error('TREASURY_EVM must be EVM');
    return identity;
  };
  if (count('FEE_BPS', '100') >= 10000) throw new Error('FEE_BPS must be below 10000');
  const treasuryNear = treasury('TREASURY_NEAR');
  const treasuryEvm = treasury('TREASURY_EVM');
  const baseSetting = env('BASE_SPONSORSHIP', '1');
  if (!['0', '1'].includes(baseSetting)) throw new Error('BASE_SPONSORSHIP must be 0 or 1');
  const baseSponsorship = baseSetting === '1';
  if (
    (yocto('FEE_FIXED', '30000') > 0n || count('FEE_BPS', '100') > 0) &&
    !treasuryNear &&
    !treasuryEvm
  )
    throw new Error('fees require a treasury');
  if (baseSponsorship && !treasuryEvm) throw new Error('Base sponsorship requires TREASURY_EVM');
  const keeperConfig =
    keeperSeconds > 0
      ? {
          sender: { accountId: env('KEEPER_ACCOUNT'), key: env('KEEPER_KEY') },
          stateDir: env('KEEPER_STATE_DIR'),
          hourlyBudget: yocto('KEEPER_HOURLY_BUDGET'),
          dailyBudget: yocto('KEEPER_DAILY_BUDGET'),
          gasPrice: yocto('KEEPER_GAS_PRICE', '100000000'),
          minPayout: yocto('KEEPER_MIN_PAYOUT', '10000'),
          reserveLowWater: yocto('KEEPER_RESERVE_LOW_WATER', '40960000000000000000000'),
          balanceLowWater: yocto('KEEPER_BALANCE_LOW_WATER', '0'),
          ...(e.KEEPER_ALERT_WEBHOOK?.trim()
            ? { alertWebhook: webhookUrl(e.KEEPER_ALERT_WEBHOOK.trim()) }
            : {}),
        }
      : undefined;
  if (
    keeperConfig &&
    (keeperConfig.sender.accountId === env('RELAYER_ACCOUNT') ||
      keeperConfig.sender.key === env('RELAYER_KEY'))
  )
    throw new Error('keeper requires a separate account and key');
  const contractId = env('CONTRACT_ID');

  const perDay = count('PER_DAY', '500');
  const unlockReserved = count('UNLOCK_RESERVED', String(Math.ceil(perDay / 2)));
  if (unlockReserved > perDay) throw new Error('UNLOCK_RESERVED cannot exceed PER_DAY');
  return {
    config: {
      nearRpc: env('NEAR_RPC', 'https://rpc.mainnet.fastnear.com'),
      baseRpc: env('BASE_RPC', 'https://mainnet.base.org'),
      contractId,
      usdc: env('USDC', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
      sender: { accountId: env('RELAYER_ACCOUNT'), key: env('RELAYER_KEY') },
      policy: {
        minPrice: BigInt(count('MIN_PRICE', '100000')),
        baseSponsorship,
        fileBudget: nearAmount('FILE_BUDGET', '0.05'),
        listedFileBudget: nearAmount('LISTED_FILE_BUDGET', env('FILE_BUDGET', '0.05')),
        sponsoredFilesPerDay: count('SPONSORED_FILES_PER_DAY', '100'),
        topupPerFile: nearAmount('TOPUP_PER_FILE', '0.15'),
        topupPerFileDay: nearAmount('TOPUP_PER_FILE_DAY', '0.05'),
        topupPerDay: nearAmount('TOPUP_PER_DAY', '0.5'),
        fee: {
          fixed: yocto('FEE_FIXED', '30000').toString(),
          bps: count('FEE_BPS', '100'),
          treasuryNear,
          treasuryEvm,
        },
        maxDeadlineSeconds: count('MAX_DEADLINE_SECONDS', '600'),
        claimsPerPurchase: count('CLAIMS_PER_PURCHASE_DAY', '3'),
        registrationsPerSeller: count('REGISTRATIONS_PER_SELLER_DAY', '20'),
        reopensPerWalletFile: count('REOPENS_PER_PURCHASE_DAY', '10'),
        holdMs: count('HOLD_SECONDS', '900') * 1000,
        maxWaiting: count('MAX_WAITING', '32'),
        maxChecking: count('MAX_CHECKING', '32'),
        ...(sellers?.length ? { sellerAllowed: (s: string) => sellers.includes(s) } : {}),
      },
      ...(keeperConfig ? { keeper: keeperConfig } : {}),
      disabled: env('DISABLED', '0') === '1',
      sponsoredFilesPerIpDay: count('SPONSORED_FILES_PER_IP_DAY', '5'),
      perIpHour: count('PER_IP_HOUR', '60'),
      perDay,
      unlockReserved,
      perMethodDay: Object.fromEntries(
        [
          'register',
          'unlock',
          'claim_key',
          'reopen',
          'reopen_seller',
          'stop_sales',
          'fund_file_storage',
        ].map((m) => [m, count(`PER_DAY_${m.toUpperCase()}`, env('PER_DAY', '500'))]),
      ),
      hitsCap: Math.max(1, count('HITS_CAP', '100000')),
      requestMultiplier: count('REQUEST_MULTIPLIER', '10'),
      retrySeconds: count('RETRY_SECONDS', '5'),
      balanceLowWater: yocto('RELAYER_BALANCE_LOW_WATER', '100000000000000000000000'),
      storageLowWater: yocto('RELAYER_STORAGE_LOW_WATER', '100000000000000000000000'),
      ...(e.RELAYER_ALERT_WEBHOOK?.trim()
        ? { alertWebhook: webhookUrl(e.RELAYER_ALERT_WEBHOOK.trim()) }
        : {}),
      ...(e.IP_HEADER?.trim() ? { ipHeader: e.IP_HEADER.trim().toLowerCase() } : {}),
    },
    port: count('PORT', '8080'),
    keeperSeconds,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { config, port, keeperSeconds } = fromEnv(process.env);
  serve(config, port, keeperSeconds);
}
