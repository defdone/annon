/** Relayer HTTP admission, request limits and response error mapping. */
import {
  baseEligibility,
  clientKey,
  deferPaidUnlock,
  NEAR_USDC,
  RelayError,
  type RelayErrorCode,
  relay,
  relayLimits,
  relayStatus,
} from '@defdone/annon/relay';
import type { Config } from './config.ts';
import { eligibilityChecking, hits } from './server.ts';

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
