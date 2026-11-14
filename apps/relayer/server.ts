import { parseIdentity } from '@defdone/annon';
/**
 * The public Annon relayer: an HTTP front for `@defdone/annon/relay`. Relay admission
 * persists sponsorship, admissions and optional keeper work on mounted storage. Requests are checked
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
import { join } from 'node:path';
import { corsHeaders, preflight } from '@defdone/annon/download/http';
import { getConfig, getFile, rpcReply, view } from '@defdone/annon/near/rpc';
import type { BudgetRecord } from '@defdone/annon/node';
import { fileStore, ownDirectory } from '@defdone/annon/pay/store-node';
import type { KeeperRecord, KeepOptions, RefundSource } from '@defdone/annon/relay';
import {
  baseEligibility,
  type CheckOptions,
  clientKey,
  deferPaidUnlock,
  keep,
  keeperBalance,
  NEAR_USDC,
  RelayError,
  type RelayErrorCode,
  RelayLedger,
  type RelayState,
  reconcileRelayStorage,
  relay,
  relayLimits,
  relayStatus,
  retryPaidUnlocks,
  type Sender,
} from '@defdone/annon/relay';
import {
  type MonitorRecord,
  type MonitorSettings,
  type ServiceAlert,
  ServiceMonitor,
  volumeUsage,
} from './alerts.ts';
import { type CorsSettings, relayerCorsPolicy } from './http.ts';

export interface Config extends Omit<CheckOptions, 'now'> {
  sender: Sender;
  stateDir?: string;
  archivalRpc?: string;
  cors?: CorsSettings;
  monitorSettings?: MonitorSettings;
  monitor?: ServiceMonitor;
  keeperLastSuccess?: number;
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
  unlockListedReserved?: number;
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
  budget: 429,
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
  settlement_pending: 425,
  relayer_unavailable: 503,
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
const eligibilityChecking = new WeakMap<Config, number>();
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
  const h =
    old && old.until > now ? old : { n: 0, until: (Math.floor(now / windowMs) + 1) * windowMs };
  if (h.n >= limit) return null;
  h.n++;
  hits.set(key, h);
  return h;
}

export const ipBucket = (ip: string) => clientKey(ip, undefined);

type RelayLookup = (
  ...args: Parameters<typeof relayStatus>
) => ReturnType<typeof relayStatus> | Awaited<ReturnType<typeof relayStatus>>;

/** One request: status and JSON body. Separate from the socket so it can be tested directly. */
export async function handle(
  c: Config,
  method: string,
  path: string,
  ip: string | string[] | undefined,
  body: string,
  send: typeof relay = relay,
  lookup: RelayLookup = relayStatus,
  socket?: string,
): Promise<{ status: number; body: unknown; headers?: Record<string, string> }> {
  const result = await admission(c, method, path, clientKey(ip, socket), body, send, lookup);
  if (result.status === 429) c.monitor?.refused();
  if (result.status >= 500)
    void c.monitor?.failure(result.status === 503 ? 'admission_unavailable' : 'service_error');
  if (
    method === 'GET' &&
    path === '/v1/capabilities' &&
    !(result.body as { acceptingNewBasePayments: boolean }).acceptingNewBasePayments
  )
    return { ...result, headers: { 'Retry-After': String(c.retrySeconds ?? 5) } };
  return [429, 503, 425].includes(result.status)
    ? {
        ...result,
        body: {
          ...(result.body as object),
          retryAfterSeconds:
            result.retrySeconds ?? (result.status === 425 ? 30 : (c.retrySeconds ?? 5)),
        },
        headers: {
          'Retry-After': String(
            result.retrySeconds ?? (result.status === 425 ? 30 : (c.retrySeconds ?? 5)),
          ),
        },
      }
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
        network: c.network ?? 'near:mainnet',
        nearUsdc: c.nearUsdc ?? NEAR_USDC,
        baseUsdc: c.usdc,
        acceptingNewBasePayments:
          !c.disabled &&
          c.policy.baseSponsorship !== false &&
          !!c.ledger &&
          !!(await c.ledger.cutover()),
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
          filesPerDay: c.policy.sponsoredFilesPerDay ?? 60,
          filesPerIpDay: c.sponsoredFilesPerIpDay ?? 2,
          fileBudget: String(c.policy.fileBudget ?? 41n * 10n ** 21n),
          listedFileBudget: String(c.policy.listedFileBudget ?? 5n * 10n ** 22n),
          topupPerFile: String(c.policy.topupPerFile ?? 82n * 10n ** 21n),
          topupPerFileDay: String(c.policy.topupPerFileDay ?? 41n * 10n ** 21n),
          topupPerDay: String(c.policy.topupPerDay ?? 5n * 10n ** 23n),
        },
        minPrice: c.policy.minPrice.toString(),
        maxDeadlineSeconds: c.policy.maxDeadlineSeconds,
        disabled: c.disabled,
      },
    };
  }
  if (method === 'GET' && path === '/healthz') return { status: 200, body: { ok: true } };
  if (method === 'POST' && path === '/v1/base-eligibility') {
    if (
      !allow(`req:${ip}`, c.perIpHour * (c.requestMultiplier ?? 10), 3600000, Date.now(), c.hitsCap)
    )
      return {
        status: 429,
        retrySeconds: remaining(`req:${ip}`),
        body: { error: 'relayer_unavailable', message: 'Try again later.' },
      };
    try {
      const request = JSON.parse(body);
      if (
        !request ||
        Object.keys(request).sort().join(',') !== 'fileId,termsHash' ||
        ![request.fileId, request.termsHash].every(
          (v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v),
        )
      )
        return {
          status: 400,
          body: { error: 'bad_request', message: 'Invalid eligibility request.' },
        };
      if (c.ledger && !(await c.ledger.cutover())) {
        c.alert?.('cutover_unsealed');
        return {
          status: 503,
          retrySeconds: 30,
          body: {
            error: 'relayer_unavailable',
            message: 'Sponsorship is temporarily unavailable.',
          },
        };
      }
      const active = eligibilityChecking.get(c) ?? 0;
      if (active >= (c.policy.maxChecking ?? 32))
        return {
          status: 503,
          retrySeconds: c.retrySeconds ?? 5,
          body: { error: 'relayer_unavailable', message: 'Eligibility checks are busy.' },
        };
      eligibilityChecking.set(c, active + 1);
      try {
        return {
          status: 200,
          body: await baseEligibility(request.fileId, request.termsHash, {
            ...c,
            acceptingNewBasePayments: !c.disabled && c.policy.baseSponsorship !== false,
          }),
        };
      } finally {
        eligibilityChecking.set(c, (eligibilityChecking.get(c) ?? 1) - 1);
      }
    } catch (e) {
      return {
        status: e instanceof SyntaxError ? 400 : 503,
        body: {
          error: e instanceof SyntaxError ? 'bad_request' : 'relayer_unavailable',
          message: 'Eligibility is unavailable.',
        },
        retrySeconds:
          e instanceof RelayError && e.retryAt !== undefined
            ? Math.max(0, Math.ceil((e.retryAt - Date.now()) / 1000))
            : 30,
      };
    }
  }
  if (method !== 'POST' || path !== '/v1/relay')
    return { status: 404, body: { error: 'not_found' } };
  if (c.disabled) {
    try {
      await deferPaidUnlock(JSON.parse(body), c, Date.now() + 30000);
    } catch (e) {
      if (!(e instanceof SyntaxError) && !(e instanceof RelayError && e.code === 'bad_request'))
        void c.monitor?.failure('store_or_rpc_unavailable');
    }
    return {
      status: 503,
      body: {
        error: isPaidRequest(body) ? 'settlement_pending' : 'relayer_unavailable',
        message: 'Relaying is paused.',
        ...purchaseEvidence(body),
      },
      retrySeconds: 30,
    };
  }
  // Coarse per-IP cap before any parsing, so polling can't be used to load the relayer.
  // Ten times the admission budget leaves room for a client polling every 5 s.
  if (
    !allow(`req:${ip}`, c.perIpHour * (c.requestMultiplier ?? 10), 3_600_000, Date.now(), c.hitsCap)
  )
    return {
      status: 429,
      retrySeconds: remaining(`req:${ip}`),
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
          body: {
            txHash: admitted.txHash,
            ...(admitted.uncertain ? { uncertain: true } : {}),
            signer: c.sender.accountId,
          },
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
      retrySeconds: remaining(`ip:${ip}`),
      body: { error: 'rate_limited', message: 'too many requests from this address' },
    };
  }
  if (!validJson)
    return { status: 400, body: { error: 'bad_request', message: 'the body is not JSON' } };
  if (c.ledger) {
    try {
      const result = await send(req, {
        ...c,
        ip,
        admissionLimits: {
          ...relayLimits(c),
          perDay: c.perDay,
          perIpHour: c.perIpHour,
          unlock: c.perMethodDay?.unlock ?? 500,
          unlockReserved: c.unlockReserved ?? 500,
          unlockListedReserved: c.unlockListedReserved ?? 250,
          filesPerIp: c.sponsoredFilesPerIpDay ?? 2,
          methods: c.perMethodDay ?? {},
        },
      });
      return {
        status: result.uncertain ? 202 : 200,
        body: {
          txHash: result.txHash,
          signer: c.sender.accountId,
          ...(result.uncertain ? { uncertain: true } : {}),
        },
      };
    } catch (e) {
      if (e instanceof RelayError) {
        if (e.code === 'in_flight')
          return { status: 202, body: { pending: true, retryAfterSeconds: c.retrySeconds ?? 5 } };
        const paid = (req as { method?: string })?.method === 'unlock';
        const pending = e.code === 'settlement_pending';
        return {
          status: pending ? (e.retryAt ? 503 : 425) : STATUS[e.code],
          body: {
            error: e.code,
            message: safeMessage(e.code),
            ...(paid ? purchaseEvidence(req) : {}),
          },
          ...(e.retryAt
            ? { retrySeconds: Math.max(0, Math.ceil((e.retryAt - Date.now()) / 1000)) }
            : {}),
        };
      }
      void c.monitor?.failure('store_or_rpc_unavailable');
      return {
        status: 503,
        body: {
          error:
            (req as { method?: string })?.method === 'unlock'
              ? 'settlement_pending'
              : 'relayer_unavailable',
          message: 'Try again later.',
        },
        retrySeconds:
          e instanceof RelayError && e.retryAt !== undefined
            ? Math.max(0, Math.ceil((e.retryAt - Date.now()) / 1000))
            : 30,
      };
    }
  }
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
      ['day:files', c.policy.sponsoredFilesPerDay ?? 60],
      [`day:files-ip:${ip}`, c.sponsoredFilesPerIpDay ?? 2],
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
        e.code === 'settlement_pending' &&
        hits.get(`ip:${ip}`) === ipAdmission &&
        ipAdmission.n > 0
      )
        ipAdmission.n--;
      if (e.code === 'in_flight')
        return { status: 202, body: { pending: true, retryAfterMs: 5000 } };
      return {
        status: STATUS[e.code],
        body: { error: e.code, message: safeMessage(e.code) },
        ...(e.retryAt !== undefined
          ? { retrySeconds: Math.max(1, Math.ceil((e.retryAt - Date.now()) / 1000)) }
          : {}),
      };
    }
    return { status: 500, body: { error: 'internal', message: 'unexpected error' } };
  }
}

const remaining = (key: string) =>
  Math.max(0, Math.ceil(((hits.get(key)?.until ?? Date.now()) - Date.now()) / 1000));
const safeMessage = (code: string) =>
  code === 'settlement_pending'
    ? 'Payment settlement is pending. Retry this purchase.'
    : 'The relay request could not be completed.';
function isPaidRequest(body: string) {
  try {
    return JSON.parse(body)?.method === 'unlock';
  } catch {
    return false;
  }
}
function purchaseEvidence(input: unknown): Record<string, string> {
  try {
    const r = (typeof input === 'string' ? JSON.parse(input) : input) as {
      args: { purchase: string };
    };
    const p = JSON.parse(r.args.purchase).purchase;
    if (
      ![p.file_id, p.purchase_id].every((v) => typeof v === 'string' && /^0x[0-9a-f]{64}$/.test(v))
    )
      return {};
    return { fileId: p.file_id, purchaseId: p.purchase_id };
  } catch {
    return {};
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
  let stopKeeper: () => Promise<void> = async () => {};
  let stopAlerts: () => Promise<void> = async () => {};
  let stopWork: () => Promise<void> = async () => {};
  let release: (() => Promise<void>)[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void respond(c, req, res).catch(() => {
      // An aborted upload or a socket gone: nothing to answer.
      if (!res.headersSent && res.writable)
        res
          .writeHead(
            400,
            corsHeaders(req.headers.origin, relayerCorsPolicy(c.cors).origins, 'Retry-After'),
          )
          .end();
    });
  });

  let draining: Promise<void> | undefined;
  const drain = () =>
    (draining ??= (async () => {
      await Promise.all([stopKeeper(), stopAlerts(), stopWork()]);
      await c.monitor?.stop();
      for (const unlock of release.reverse()) await unlock();
      release = [];
      server.emit('drained');
    })());
  server.once('close', () => {
    void drain().catch(() => {});
  });
  server.requestTimeout = 30000;
  const onTerm = () => {
    void shutdown();
  };
  const shutdown = async () => {
    const stopping = Promise.all([stopKeeper(), stopAlerts(), stopWork()]);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
    await stopping;
    await drain();
  };
  process.once('SIGTERM', onTerm);
  server.once('close', () => process.off('SIGTERM', onTerm));
  const start = async () => {
    if (c.stateDir) {
      release.push(await ownDirectory(c.stateDir));
      const records = join(c.stateDir, 'registry');
      await mkdir(records, { recursive: true, mode: 0o700 });
      c.ledger = new RelayLedger(
        fileStore<RelayState>(records, { recoverDeadLocks: true }),
        `${c.network ?? 'near:mainnet'}|${c.contractId}`,
        c.policy.holdMs,
      );
      await c.ledger.recoverPrepared();
      const monitors = join(c.stateDir, 'monitor');
      await mkdir(monitors, { recursive: true, mode: 0o700 });
      c.monitor = new ServiceMonitor(
        fileStore<MonitorRecord>(monitors, { recoverDeadLocks: true }),
        async (a) => {
          console.log(JSON.stringify({ relayer: 'alert', ...a }));
          if (c.alertWebhook) await deliverKeeperAlert(c.alertWebhook, a, fetch, 'relayer');
        },
        c.monitorSettings,
      );
      await c.monitor.boot();
      c.alert = (type) => {
        void (
          type === 'admissions_paused' || type === 'admissions_resumed'
            ? c.monitor?.admissions(type === 'admissions_paused')
            : c.monitor?.failure(type)
        )?.catch(() => {});
      };
      if (!(await c.ledger.cutover())) c.alert('cutover_unsealed');
      if (!c.archivalRpc) c.alert('historical_unavailable');
      if (c.archivalRpc)
        c.historicalFile = (file, block) =>
          getFile(c.archivalRpc as string, c.contractId, file, block);
      const deployment = await getConfig(c.nearRpc, c.contractId);
      if (
        deployment.network !== (c.network ?? 'near:mainnet') ||
        deployment.usdc !== c.usdc ||
        deployment.nearUsdc !== c.nearUsdc
      )
        throw new Error('Deployment configuration mismatch.');
    }
    if (c.keeper) release.push(await ownDirectory(c.keeper.stateDir));
    c.admissionLimits = {
      ...relayLimits(c),
      perDay: c.perDay,
      perIpHour: c.perIpHour,
      unlock: c.perMethodDay?.unlock ?? 500,
      unlockReserved: c.unlockReserved ?? 500,
      unlockListedReserved: c.unlockListedReserved ?? 250,
      filesPerIp: c.sponsoredFilesPerIpDay ?? 2,
      methods: c.perMethodDay ?? {},
    };
    stopKeeper = keeperSeconds > 0 ? keeper(c, keeperSeconds) : async () => {};
    stopAlerts = monitorRelayer(c);
    stopWork = paidWork(c);
    server.listen(port, () => console.log(`annon relayer listening on :${port}`));
  };
  void start().catch(async () => {
    await drain();
    server.emit('error', new Error('Relayer startup failed.'));
  });
  return server;
}

function paidWork(c: Config): () => Promise<void> {
  let stopped = false;
  let running: Promise<void> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout>;
  const pass = async () => {
    try {
      await reconcileRelayStorage(c);
      if (!c.disabled) await retryPaidUnlocks(c);
    } catch {
      void c.monitor?.failure('paid_work_unavailable');
    }
    if (!stopped)
      timer = setTimeout(
        () => {
          running = pass();
        },
        (c.retrySeconds ?? 5) * 1000,
      ).unref();
  };
  running = pass();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
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
          store: fileStore<KeeperRecord>(jobs, { recoverDeadLocks: true }),
          budgetStore: fileStore<BudgetRecord>(budgets, { recoverDeadLocks: true }),
          hourlyBudget: k.hourlyBudget,
          dailyBudget: k.dailyBudget,
          gasPrice: k.gasPrice,
          reserveLowWater: k.reserveLowWater,
          oldestDeliverySeconds: c.monitorSettings?.oldestSeconds ?? 1800,
          ...(k.minPayout === undefined ? {} : { minPayout: k.minPayout }),
          ...(k.balanceLowWater === undefined ? {} : { balanceLowWater: k.balanceLowWater }),
          ...(k.refunds ? { refunds: k.refunds } : {}),
          alert: (alert) => {
            console.log(JSON.stringify({ keeper: 'alert', ...alert }));
            if (k.alertWebhook) deliveries.push(deliverKeeperAlert(k.alertWebhook, alert));
          },
        };
        const result = await keep(options);
        if (!result.errors.length) c.keeperLastSuccess = Date.now();
        else void c.monitor?.failure('keeper_store_or_rpc');
        await Promise.all(deliveries);
        for (const incident of result.incidents)
          console.log(
            JSON.stringify({
              keeper: 'incident',
              classification: incident.classification,
              deliveryId: incident.deliveryId,
            }),
          );
        // Keep upstream diagnostics out of public logs.
        for (const { deliveryId } of result.errors)
          console.log(
            JSON.stringify({
              keeper: 'error',
              deliveryId,
              message: 'Keeper work is unavailable.',
            }),
          );
        for (const s of result.sent)
          console.log(
            JSON.stringify({
              at: new Date().toISOString(),
              keeper: s.method,
              ...s.args,
              txHash: s.result.txHash,
              uncertain: s.result.uncertain === true,
            }),
          );
      } catch {
        void c.monitor?.failure('keeper_store_or_rpc');
        console.log(
          JSON.stringify({
            at: new Date().toISOString(),
            keeper: 'error',
            message: 'Keeper pass failed.',
          }),
        );
      }
    }
    if (!stopped)
      timer = setTimeout(() => {
        running = pass();
      }, seconds * 1000).unref();
  };
  let running = pass();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}

async function respond(c: Config, req: IncomingMessage, res: ServerResponse) {
  const policy = relayerCorsPolicy(c.cors);
  const cross = { headers: corsHeaders(req.headers.origin, policy.origins, policy.expose) };
  if (req.method === 'OPTIONS') {
    const result = preflight(
      {
        get: (name) => {
          const value = req.headers[name.toLowerCase()];
          return typeof value === 'string' ? value : null;
        },
      },
      policy,
    );
    return void res.writeHead(result.status, result.headers).end();
  }
  if (
    req.method === 'POST' &&
    req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
  )
    return void res
      .writeHead(415, {
        ...cross.headers,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      })
      .end(JSON.stringify({ error: 'bad_request', message: 'Use application/json.' }));
  // A client can send any header: only the one a trusted proxy sets (and overwrites) counts.
  const forwarded = c.ipHeader ? req.headers[c.ipHeader] : undefined;
  const ip = clientKey(forwarded, req.socket.remoteAddress);
  const body = req.method === 'POST' ? await read(req) : '';
  const path = (req.url ?? '/').split('?')[0] as string;
  const out =
    body === null
      ? { status: 413, body: { error: 'too_large' } }
      : await handle(
          c,
          req.method ?? 'GET',
          path,
          forwarded,
          body,
          relay,
          relayStatus,
          req.socket.remoteAddress,
        );
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
      ...cross.headers,
      'Cache-Control': 'no-store',
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
  if (c.admissionFloor !== undefined) await c.monitor?.admissions(funds.balance < c.admissionFloor);
  const needed =
    funds.cost > (c.balanceLowWater ?? 3n * 10n ** 24n)
      ? funds.cost
      : (c.balanceLowWater ?? 3n * 10n ** 24n);
  const low: RelayerAlert[] = [];
  if (funds.balance < needed)
    low.push({ type: 'low_balance', balance: String(funds.balance), needed: String(needed) });
  if (BigInt(storage) < (c.storageLowWater ?? 5n * 10n ** 23n))
    low.push({ type: 'storage_low', reserve: storage });
  const old = relayerLow.get(c) ?? new Set<string>();
  relayerLow.set(c, new Set(low.map((a) => a.type)));
  return low.filter((a) => !old.has(a.type));
}
function monitorRelayer(c: Config): () => Promise<void> {
  if (c.balanceLowWater === undefined && c.storageLowWater === undefined && !c.alertWebhook)
    return async () => {};
  const monitorStarted = Date.now();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let running: Promise<void> = Promise.resolve();
  const pass = async () => {
    try {
      const now = Date.now(),
        state = await c.ledger?.read();
      const counters = state?.counters ?? {},
        day = Math.floor(now / 86400000);
      const global = Number(counters[`${day}|all`] ?? '0');
      const { diskPercent, inodePercent } = await volumeUsage(
        [c.stateDir, c.keeper?.stateDir].filter((path): path is string => path !== undefined),
      );
      let keeperBudgetPercent = 0;
      if (c.keeper) {
        const b = await fileStore<BudgetRecord>(join(c.keeper.stateDir, 'budgets')).load(
          `${c.network ?? 'near:mainnet'}|${c.keeper.sender.accountId}|keeper-spend`,
        );
        keeperBudgetPercent = c.keeper.dailyBudget
          ? Number((BigInt(b?.day === day ? b.daily : '0') * 100n) / c.keeper.dailyBudget)
          : 100;
      }
      await c.monitor?.sample({
        now,
        poolPercent: c.perDay ? (100 * global) / c.perDay : 100,
        diskPercent,
        inodePercent,
        keeperEnabled: !!c.keeper,
        keeperLastSuccess: c.keeperLastSuccess ?? monitorStarted,
        keeperBudgetPercent,
      });
      for (const alert of await relayerAlerts(c)) {
        console.log(JSON.stringify({ relayer: 'alert', ...alert }));
        if (c.alertWebhook) await deliverKeeperAlert(c.alertWebhook, alert, fetch, 'relayer');
      }
    } catch {
      /* Monitoring failure cannot interrupt admission or expose endpoint credentials. */
    }
    if (!stopped)
      timer = setTimeout(
        () => {
          running = pass();
        },
        (c.monitorSettings?.sampleSeconds ?? 60) * 1000,
      ).unref();
  };
  timer = setTimeout(
    () => {
      running = pass();
    },
    (c.monitorSettings?.sampleSeconds ?? 60) * 1000,
  ).unref();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
  };
}

function webhookUrl(value: string): string {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.hash) throw new Error();
    return u.href;
  } catch {
    throw new Error('KEEPER_ALERT_WEBHOOK must be an HTTPS URL without user info or fragment');
  }
}

/** Failures are deliberately contained; only public keeper alert fields are delivered. */
export async function deliverKeeperAlert(
  url: string,
  value: Parameters<NonNullable<KeepOptions['alert']>>[0] | RelayerAlert | ServiceAlert,
  fetcher: typeof fetch = fetch,
  source = 'keeper',
): Promise<void> {
  try {
    const alert: Record<string, string | number> = { type: value.type };
    for (const field of ['balance', 'needed', 'reserve'] as const) {
      const n = field in value ? (value as RelayerAlert)[field] : undefined;
      if (typeof n === 'string' && /^[0-9]+$/.test(n)) alert[field] = n;
    }
    if (
      'deliveryId' in value &&
      Number.isSafeInteger(value.deliveryId) &&
      (value.deliveryId ?? -1) >= 0
    )
      alert.deliveryId = value.deliveryId as number;
    for (const field of ['count', 'percent', 'seconds'] as const) {
      const n = field in value ? (value as ServiceAlert)[field] : undefined;
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) alert[field] = n;
    }
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
  const flag = (name: string, fallback: string) => {
    const v = env(name, fallback);
    if (!['0', '1'].includes(v)) throw new Error(`${name} must be 0 or 1`);
    return v === '1';
  };
  const https = (value: string, name: string) => {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.hash)
      throw new Error(`${name} must be HTTPS`);
    return value;
  };
  const origin = (value: string) => {
    https(value, 'DEMO_HOST_ORIGIN');
    if (new URL(value).origin !== value) throw new Error('DEMO_HOST_ORIGIN must be an origin');
    return value;
  };
  const list = (name: string, fallback: string) =>
    (e[name] ?? fallback)
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  relayerCorsPolicy({
    allow: list('CORS_ALLOW_ORIGINS', 'https://annon.dev,https://www.annon.dev'),
    previews: list('CORS_PREVIEW_ORIGINS', ''),
  });
  if (e.IP_HEADER && !/^[a-z0-9-]{1,64}$/i.test(e.IP_HEADER.trim()))
    throw new Error('IP_HEADER is invalid');
  if (e.DEMO_RESERVATION_PUBLIC_KEY && !/^[0-9a-f]{64}$/.test(e.DEMO_RESERVATION_PUBLIC_KEY))
    throw new Error('DEMO_RESERVATION_PUBLIC_KEY is invalid');
  if (
    count('BASE_ELIGIBILITY_MAX_AGE_SECONDS', '30') !== 30 ||
    count('SPONSORED_FILES_LISTED_RESERVED', '0') !== 0
  )
    throw new Error('Invalid fixed sponsorship setting');
  for (const [name, maximum] of Object.entries({
    MAX_FILE_BYTES: 50000000,
    MAX_DEADLINE_SECONDS: 600,
    TOPUP_MAX_DEADLINE_SECONDS: 600,
    SPONSORED_FILES_PER_DAY: 60,
    SPONSORED_FILES_PER_IP_DAY: 2,
    REGISTRATIONS_PER_SELLER_DAY: 2,
    LISTED_REGISTRATIONS_PER_SELLER_DAY: 20,
    CORS_MAX_AGE_SECONDS: 600,
  })) {
    if (count(name, String(maximum)) > maximum) throw new Error(`${name} exceeds its maximum`);
  }
  for (const [name, fallback] of Object.entries({
    PORT: 8080,
    MAX_DEADLINE_SECONDS: 600,
    TOPUP_MAX_DEADLINE_SECONDS: 600,
    HOLD_SECONDS: 900,
    RETRY_SECONDS: 5,
    HITS_CAP: 100000,
    ALERT_SAMPLE_SECONDS: 60,
    ALERT_KEEPER_STALLED_SECONDS: 300,
    ALERT_OLDEST_DELIVERY_SECONDS: 1800,
    ALERT_RELAYER_429_WINDOW_SECONDS: 600,
  })) {
    if (count(name, String(fallback)) === 0) throw new Error(`${name} must be positive`);
  }
  if (count('MIN_PRICE', '100000') === 0) throw new Error('MIN_PRICE must be positive');
  const sellers = e.SELLERS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const separator = s.indexOf(':');
      return JSON.stringify(
        parseIdentity({ kind: s.slice(0, separator), id: s.slice(separator + 1) }),
      );
    });
  env('RELAYER_STATE_DIR');
  env('DEMO_HOST_ORIGIN');
  if (flag('OPEN_POOL_ENABLED', '1') && !sellers?.length)
    throw new Error('SELLERS is required for the demo pool');
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
  for (const [name, maximum] of Object.entries({
    FILE_BUDGET: '0.041',
    LISTED_FILE_BUDGET: '0.05',
    TOPUP_PER_FILE: '0.082',
    TOPUP_PER_FILE_DAY: '0.041',
    LISTED_TOPUP_PER_FILE: '0.15',
    LISTED_TOPUP_PER_FILE_DAY: '0.05',
    TOPUP_PER_DAY: '0.5',
  })) {
    const [whole = '0', fraction = ''] = maximum.split('.');
    const cap = BigInt(whole) * 10n ** 24n + BigInt(fraction.padEnd(24, '0'));
    if (nearAmount(name, maximum) > cap) throw new Error(`${name} exceeds its maximum`);
  }
  if (nearAmount('PREPAID_UNLOCK_FLOOR', '1') < 10n ** 24n)
    throw new Error('PREPAID_UNLOCK_FLOOR must protect at least 1 NEAR');
  if (e.ADMISSION_FLOOR_NEAR !== undefined && !e.ADMISSION_FLOOR_NEAR.trim())
    throw new Error('invalid ADMISSION_FLOOR_NEAR');
  const admissionFloor = nearAmount('ADMISSION_FLOOR_NEAR', '3');
  if (admissionFloor <= 0n) throw new Error('ADMISSION_FLOOR_NEAR must be positive');
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
  if (yocto('FEE_FIXED', '30000') < 30000n)
    throw new Error('FEE_FIXED cannot discount sponsorship');
  if (count('FEE_BPS', '100') < 100) throw new Error('FEE_BPS cannot discount sponsorship');
  if (count('MIN_PRICE', '100000') < 100000)
    throw new Error('MIN_PRICE is below the sponsorship minimum');
  const keeperConfig =
    keeperSeconds > 0
      ? {
          sender: { accountId: env('KEEPER_ACCOUNT'), key: env('KEEPER_KEY') },
          stateDir: env('KEEPER_STATE_DIR'),
          hourlyBudget: yocto('KEEPER_HOURLY_BUDGET', '500000000000000000000000'),
          dailyBudget: yocto('KEEPER_DAILY_BUDGET', '1000000000000000000000000'),
          gasPrice: yocto('KEEPER_GAS_PRICE', '100000000'),
          minPayout: yocto('KEEPER_MIN_PAYOUT', '100000'),
          reserveLowWater: yocto('KEEPER_RESERVE_LOW_WATER', '40960000000000000000000'),
          balanceLowWater: yocto('KEEPER_BALANCE_LOW_WATER', '2000000000000000000000000'),
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

  const perDay = count('PER_DAY', '1000');
  const unlockReserved = count('UNLOCK_RESERVED', String(Math.min(500, perDay)));
  if (unlockReserved > perDay) throw new Error('UNLOCK_RESERVED cannot exceed PER_DAY');
  return {
    config: {
      nearRpc: env('NEAR_RPC', 'https://rpc.mainnet.fastnear.com'),
      baseRpc: env('BASE_RPC', 'https://mainnet.base.org'),
      contractId,
      stateDir: env('RELAYER_STATE_DIR'),
      network: env('NETWORK', 'near:mainnet'),
      nearUsdc: env('NEAR_USDC', NEAR_USDC),
      ...(e.NEAR_ARCHIVAL_RPC?.trim()
        ? { archivalRpc: https(e.NEAR_ARCHIVAL_RPC.trim(), 'NEAR_ARCHIVAL_RPC') }
        : {}),
      cors: {
        allow: list('CORS_ALLOW_ORIGINS', 'https://annon.dev,https://www.annon.dev'),
        previews: list('CORS_PREVIEW_ORIGINS', ''),
        maxAgeSeconds: count('CORS_MAX_AGE_SECONDS', '600'),
      },
      reservation: {
        hostOrigin: origin(env('DEMO_HOST_ORIGIN')),
        publicKey: env('DEMO_RESERVATION_PUBLIC_KEY', ''),
        maxFileBytes: count('MAX_FILE_BYTES', '50000000'),
      },
      monitorSettings: {
        sampleSeconds: count('ALERT_SAMPLE_SECONDS', '60'),
        poolPercent: count('ALERT_POOL_PERCENT', '70'),
        diskPercent: count('ALERT_DISK_PERCENT', '70'),
        stalledSeconds: count('ALERT_KEEPER_STALLED_SECONDS', '300'),
        oldestSeconds: count('ALERT_OLDEST_DELIVERY_SECONDS', '1800'),
        refusals: count('ALERT_RELAYER_429_COUNT', '20'),
        refusalWindowSeconds: count('ALERT_RELAYER_429_WINDOW_SECONDS', '600'),
        keeperBudgetPercent: count('ALERT_KEEPER_BUDGET_PERCENT', '50'),
      },
      usdc: env('USDC', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
      sender: { accountId: env('RELAYER_ACCOUNT'), key: env('RELAYER_KEY') },
      policy: {
        minPrice: BigInt(count('MIN_PRICE', '100000')),
        baseSponsorship,
        openPoolEnabled: flag('OPEN_POOL_ENABLED', '1'),
        listedRegistrationsPerSeller: count('LISTED_REGISTRATIONS_PER_SELLER_DAY', '20'),
        unlocksPerFile: count('UNLOCKS_PER_FILE_DAY', '10'),
        unlocksPerSeller: count('UNLOCKS_PER_SELLER_DAY', '20'),
        listedUnlocksPerFile: count('LISTED_UNLOCKS_PER_FILE_DAY', '100'),
        listedUnlocksPerSeller: count('LISTED_UNLOCKS_PER_SELLER_DAY', '250'),
        listedTopupPerFile: nearAmount('LISTED_TOPUP_PER_FILE', '0.15'),
        listedTopupPerFileDay: nearAmount('LISTED_TOPUP_PER_FILE_DAY', '0.05'),
        topupListedReserved: nearAmount('TOPUP_LISTED_RESERVED', '0.25'),
        prepaidUnlockFloor: nearAmount('PREPAID_UNLOCK_FLOOR', '1'),
        storagePerWrite: nearAmount('STORAGE_PER_WRITE', '0.01'),
        topupMaxDeadlineSeconds: count('TOPUP_MAX_DEADLINE_SECONDS', '600'),
        fileBudget: nearAmount('FILE_BUDGET', '0.041'),
        listedFileBudget: nearAmount('LISTED_FILE_BUDGET', '0.05'),
        sponsoredFilesPerDay: count('SPONSORED_FILES_PER_DAY', '60'),
        topupPerFile: nearAmount('TOPUP_PER_FILE', '0.082'),
        topupPerFileDay: nearAmount('TOPUP_PER_FILE_DAY', '0.041'),
        topupPerDay: nearAmount('TOPUP_PER_DAY', '0.5'),
        fee: {
          fixed: yocto('FEE_FIXED', '30000').toString(),
          bps: count('FEE_BPS', '100'),
          treasuryNear,
          treasuryEvm,
        },
        maxDeadlineSeconds: count('MAX_DEADLINE_SECONDS', '600'),
        claimsPerGrant: count('CLAIMS_PER_GRANT_DAY', '3'),
        registrationsPerSeller: count('REGISTRATIONS_PER_SELLER_DAY', '2'),
        reopensPerWalletFile: count('REOPENS_PER_PURCHASE_DAY', '10'),
        holdMs: count('HOLD_SECONDS', '900') * 1000,
        maxWaiting: count('MAX_WAITING', '32'),
        maxChecking: count('MAX_CHECKING', '32'),
        ...(sellers?.length ? { sellerAllowed: (s: string) => sellers.includes(s) } : {}),
      },
      ...(keeperConfig ? { keeper: keeperConfig } : {}),
      disabled: flag('DISABLED', '0'),
      sponsoredFilesPerIpDay: count('SPONSORED_FILES_PER_IP_DAY', '2'),
      perIpHour: count('PER_IP_HOUR', '600'),
      perDay,
      unlockReserved,
      unlockListedReserved: count('UNLOCK_LISTED_RESERVED', '250'),
      perMethodDay: Object.fromEntries(
        [
          'register',
          'unlock',
          'claim_key',
          'reopen',
          'reopen_seller',
          'stop_sales',
          'fund_file_storage',
        ].map((m) => [
          m,
          count(
            `PER_DAY_${m.toUpperCase()}`,
            String(
              (
                {
                  register: 100,
                  unlock: 500,
                  claim_key: 250,
                  reopen: 50,
                  reopen_seller: 50,
                  stop_sales: 100,
                  fund_file_storage: 50,
                } as Record<string, number>
              )[m],
            ),
          ),
        ]),
      ),
      hitsCap: Math.max(1, count('HITS_CAP', '100000')),
      requestMultiplier: count('REQUEST_MULTIPLIER', '10'),
      retrySeconds: count('RETRY_SECONDS', '5'),
      admissionFloor,
      balanceLowWater: yocto('RELAYER_BALANCE_LOW_WATER', '3000000000000000000000000'),
      storageLowWater: yocto('RELAYER_STORAGE_LOW_WATER', '500000000000000000000000'),
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
