/** Relayer HTTP server lifecycle, request transport and module-load state. */
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
import { getConfig, getFile } from '@defdone/annon/near/rpc';
import { fileStore, ownDirectory } from '@defdone/annon/pay/store-node';
import {
  clientKey,
  RelayLedger,
  type RelayState,
  relay,
  relayLimits,
  relayStatus,
} from '@defdone/annon/relay';
import { handle } from './admission.ts';
import { type MonitorRecord, ServiceMonitor } from './alerts.ts';
import { keeper, paidWork } from './background-work.ts';
import { type Config, fromEnv } from './config.ts';
import { relayerCorsPolicy } from './http.ts';
import { deliverKeeperAlert, monitorRelayer, webhookUrl } from './monitoring.ts';

export { handle, ipBucket } from './admission.ts';
export { keeper } from './background-work.ts';
export { type Config, fromEnv } from './config.ts';
export { deliverKeeperAlert, relayerAlerts } from './monitoring.ts';

const MAX_BODY = 64 * 1024;

// Note: counters in memory, reset on restart; one machine. Shared store if it ever scales out.
export const hits = new Map<string, { n: number; until: number }>();

const eligibilityChecking = new WeakMap<Config, number>();

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

const relayerLow = new WeakMap<Config, Set<string>>();

if (import.meta.url === `file://${process.argv[1]}`) {
  const { config, port, keeperSeconds } = fromEnv(process.env);
  serve(config, port, keeperSeconds);
}

// Shared state stays here to preserve module initialization order.
export { eligibilityChecking, relayerLow };
