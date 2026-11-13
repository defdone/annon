/**
 * A public demo host for Annon files. It serves PAY2 files behind `serveFile`: an x402 402 offer
 * until a purchase is final on NEAR, then the file to the buyer who proves it. Anyone can try it with
 * the `annon` CLI or MCP server.
 *
 *   GET /                  the demo files and how to buy them (HTML)
 *   GET /files.json        the same list for clients
 *   GET /f/<name>          the PAY2 file (402 with the offer until paid)
 *   GET /f/<name>/header   its public header (checked by the buyer before paying)
 *   GET /healthz
 *
 * Settings: apps/demo-host/README.md.
 */
import { createReadStream } from 'node:fs';
import { open, readFile, stat, statfs, unlink } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  type FileHostOptions,
  type HostResponse,
  serveFile,
} from '../../packages/annon/src/download/host.ts';
import type { CorsPolicy } from '../../packages/annon/src/download/http.ts';
import {
  corsHeaders,
  corsPolicy,
  DEFAULT_ORIGINS,
  hasContentType,
  preflight,
} from '../../packages/annon/src/download/http.ts';
import { sha256 } from '../../packages/annon/src/envelope/pay2.ts';
import { isTransient } from '../../packages/annon/src/errors.ts';
import { type FileInfo, getFile } from '../../packages/annon/src/near/rpc.ts';
import { clientKey, fixedWindowLimiter } from '../../packages/annon/src/net/ip.ts';
import type { Facilitator, SellerRecord } from '../../packages/annon/src/pay/settle.ts';
import type { Store } from '../../packages/annon/src/pay/store.ts';
import { fileStore } from '../../packages/annon/src/pay/store-node.ts';
import { BASE_USDC, NEAR_USDC } from '../../packages/annon/src/settle-near/terms.ts';
import { type Alert, emit, hostAlerts } from './alerts.ts';
import { hostCapacity } from './capacity.ts';
import { hostSettings } from './config.ts';
import { downloadLedger } from './downloads.ts';
import { requireEligibility } from './eligibility.ts';
import { baseFacilitator, initFacilitatorState } from './facilitator.ts';
import { sweepSellerRecords } from './maintenance.ts';
import { StartupError, type StartupReason } from './startup-errors.ts';
import { hostStorage } from './storage.ts';
import { sendBody } from './stream.ts';
import { uploadHttp } from './upload-http.ts';
import { uploadService } from './uploads.ts';

export { clientKey, limiter } from '../../packages/annon/src/net/ip.ts';
export type { Chain } from './facilitator.ts';
export { facilitatorFor } from './facilitator.ts';

export interface DemoFile {
  /** URL path segment: lowercase letters, digits and dashes. */
  name: string;
  fileId: string;
  title: string;
  description?: string;
  /** Shown on the index only; the contract's registered price is what buyers pay. */
  priceUsdc?: string;
}
export interface Loaded extends DemoFile {
  verify?: () => Promise<void>;
  filename?: string;
  lifecycleId?: string;
  path: string;
  size: number;
  header: Uint8Array;
  headerHash: string;
  plaintextSize: number;
}
export interface HostConfig {
  contractId: string;
  nearRpc: string;
  baseRpc: string;
  publicUrl: string;
  files: Loaded[];
  store: Store<SellerRecord>;
  /** Absent: Base payments are refused with 501 before any settlement work. */
  facilitator?: Facilitator;
  cors?: CorsPolicy;
  capacity?: Awaited<ReturnType<typeof hostCapacity>>;
  uploads?: Awaited<ReturnType<typeof uploadService>>;
  uploadLimits?: Parameters<typeof uploadHttp>[5];
  downloads?: FileHostOptions['downloads'];
  relayerOrigin?: string;
  alert?: Alert;
  settlementPollSeconds?: number;
  paymentMinValiditySeconds?: number;
  active?: Map<string, number>;
  getFile?: (fileId: string) => Promise<FileInfo | null>;
  perIpMinute: number;
  /** Requests carrying PAYMENT-SIGNATURE per client per minute. */
  paymentsPerClientMinute: number;
  /** A single-value client IP header that the proxy overwrites (e.g. fly-client-ip). */
  ipHeader?: string;
}
type Serve = (
  req: { headers: { get(n: string): string | null } },
  o: FileHostOptions,
) => Promise<HostResponse>;

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The client reads at most this much header (PAY2 fixed part plus the hash table). */
const MAX_HEADER = 65_536;
const hex = (b: Uint8Array) => `0x${Buffer.from(b).toString('hex')}`;
const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
const text = (v: unknown, what: string, max: number): string => {
  if (typeof v !== 'string' || v.length === 0 || v.length > max) throw new Error(`bad ${what}`);
  return v;
};
const optional = (v: unknown, what: string, max: number) =>
  v === undefined ? undefined : text(v, what, max);

/** Reads `files.json` and each PAY2 file's header (its length is the u32 at byte 8). */
export async function loadFiles(
  dir: string,
  expired?: (id: string) => Promise<boolean>,
  limits: { maxFileBytes?: number; maxPay2Bytes?: number; maxHeaderBytes?: number } = {},
): Promise<Loaded[]> {
  const list = JSON.parse(await readFile(join(dir, 'files.json'), 'utf8')) as unknown;
  if (!Array.isArray(list)) throw new Error('files.json must be a list');
  const out: Loaded[] = [];
  for (const raw of list as Record<string, unknown>[]) {
    const name = text(raw.name, 'name', 64);
    const fileId = text(raw.fileId, 'fileId', 66);
    if (!NAME.test(name) || !/^0x[0-9a-f]{64}$/.test(fileId)) throw new Error(`bad entry ${name}`);
    if (out.some((o) => o.name === name)) throw new Error(`duplicate name ${name}`);
    const priceUsdc = optional(raw.priceUsdc, 'priceUsdc', 20);
    if (priceUsdc !== undefined && !/^\d+(\.\d{1,6})?$/.test(priceUsdc))
      throw new Error('bad priceUsdc');
    const description = optional(raw.description, 'description', 500);
    const f: DemoFile = {
      name,
      fileId,
      title: text(raw.title, 'title', 120),
      ...(description ? { description } : {}),
      ...(priceUsdc ? { priceUsdc } : {}),
    };
    if (await expired?.(fileId)) continue;
    const path = join(dir, `${name}.pay2`);
    const size = (await stat(path)).size;
    if (size > (limits.maxPay2Bytes ?? 50_086_016)) throw new Error('file is too large');
    const fh = await open(path, 'r');
    try {
      const fixed = Buffer.alloc(12);
      await fh.read(fixed, 0, 12, 0);
      const len = fixed.readUInt32BE(8);
      if (len < 65 || len > size || len > (limits.maxHeaderBytes ?? MAX_HEADER))
        throw new Error(`bad header length in ${name}`);
      const header = new Uint8Array(len);
      await fh.read(header, 0, len, 0);
      const framing = new DataView(header.buffer, header.byteOffset, header.byteLength);
      const plaintextSize = size - len - framing.getUint16(44) - 16 * framing.getUint32(50);
      if (plaintextSize < 0 || plaintextSize > (limits.maxFileBytes ?? 50_000_000))
        throw new Error('file is too large');
      // On chain: SHA-256 of the header without its 65-byte signature.
      out.push({
        ...f,
        path,
        size,
        plaintextSize,
        header,
        headerHash: hex(await sha256(header.subarray(0, len - 65))),
      });
    } finally {
      await fh.close();
    }
  }
  return out;
}

function page(c: HostConfig): string {
  const items = c.files
    .map((f) => {
      const url = esc(`${c.publicUrl}/f/${f.name}`);
      const cap = f.priceUsdc ? ` --max-price ${esc(f.priceUsdc)}` : '';
      const routes = c.facilitator ? ['base', 'near'] : ['near'];
      return `<li><h2>${esc(f.title)}</h2>${f.description ? `<p>${esc(f.description)}</p>` : ''}
<p>${f.priceUsdc ? `${esc(f.priceUsdc)} USDC. ` : ''}File ID <code>${f.fileId}</code></p>
<pre>annon verify ${url}
${routes.map((r) => `annon buy ${url} --route ${r}${cap}`).join('\n')}</pre></li>`;
    })
    .join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Annon demo files</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem}pre,code{background:#f3f3f3;padding:.2rem .4rem;border-radius:4px;overflow-x:auto}pre{padding:.8rem}li{list-style:none;margin:0 0 2rem}ul{padding:0}</style></head>
<body><h1>Annon demo files</h1>
<p>Each file is encrypted. NEAR releases its key only after it has verified your USDC payment${c.facilitator ? ', on NEAR or on Base' : ' on NEAR'}.
Pay with the <code>annon</code> CLI or the Annon MCP server, then <code>annon open</code> the purchase.</p>
<ul>${items}</ul><p><a href="/files.json">files.json</a></p></body></html>`;
}

export function handler(c: HostConfig, serve: Serve = serveFile) {
  const perIp = fixedWindowLimiter(c.perIpMinute);
  const cors = c.cors ?? corsPolicy(DEFAULT_ORIGINS);
  const active = c.active ?? new Map<string, number>();
  const allFiles = async (
    snapshot?: Awaited<ReturnType<NonNullable<HostConfig['capacity']>['snapshot']>>,
  ) => [...c.files, ...((await c.uploads?.files(snapshot)) ?? [])];
  const checked = async () => {
    const snapshot = await c.capacity?.snapshot();
    return Promise.all(
      (await allFiles(snapshot)).map(async (f) => {
        if (snapshot?.expiredIds.has(f.fileId)) return null;
        const info = await (c.getFile?.(f.fileId) ?? getFile(c.nearRpc, c.contractId, f.fileId));
        if (!info || info.takenDown !== null || info.salesStoppedAt !== null) return null;
        const life = snapshot?.objects[f.lifecycleId ?? `operator:${f.fileId}`];
        return { f, info, life };
      }),
    );
  };
  // The SDK resends its payment about every 3 s while it waits, so a buyer makes ~20 a minute.
  const paymentsPerClient = fixedWindowLimiter(c.paymentsPerClientMinute);
  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
    const requestHeaders = {
      get: (name: string) => (req.headers[name.toLowerCase()] as string | undefined) ?? null,
    };
    for (const [name, value] of Object.entries(
      corsHeaders(requestHeaders.get('Origin'), cors.origins, cors.expose),
    ))
      res.setHeader(name, value);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    const path = (req.url ?? '/').split('?')[0] as string;
    res.on('close', () =>
      console.log(
        JSON.stringify({
          method: req.method,
          path: path.slice(0, 120),
          status: res.statusCode,
          ms: Date.now() - started,
        }),
      ),
    );
    const send = (code: number, headers: Record<string, string>, body?: string | Uint8Array) => {
      res.writeHead(code, { 'Cache-Control': 'no-store', ...headers }).end(body);
    };
    try {
      if (req.method === 'OPTIONS') {
        const result = preflight(requestHeaders, cors);
        if (result.status === 403) res.removeHeader('Access-Control-Allow-Origin');
        return send(result.status, result.headers);
      }
      if (
        (req.method === 'POST' || req.method === 'PUT') &&
        !path.startsWith('/v1/uploads') &&
        !hasContentType(requestHeaders.get('Content-Type'), 'application/json')
      )
        return send(415, {});
      if (path === '/healthz')
        return send(200, { 'Content-Type': 'application/json' }, '{"ok":true}');
      const key = clientKey(
        c.ipHeader ? req.headers[c.ipHeader.toLowerCase()] : undefined,
        req.socket.remoteAddress,
      );
      const admission = perIp(key);
      if (!admission.allowed)
        return send(
          429,
          {
            'Retry-After': String(admission.retryAfterSeconds),
            'Content-Type': 'application/json',
          },
          JSON.stringify({
            error: 'rate_limited',
            message: 'Too many requests. Try again later.',
            retryAfterSeconds: admission.retryAfterSeconds,
          }),
        );
      if (await uploadHttp(req, res, path, key, c.uploads, c.uploadLimits)) return;
      // GET only: HEAD would run settlement without reading the body.
      if (req.method !== 'GET') return send(405, { Allow: 'GET' });
      if (path === '/' || path === '/files.json') {
        const entries = (await checked()).filter((entry) => entry !== null);
        if (path === '/')
          return send(
            200,
            { 'Content-Type': 'text/html; charset=utf-8' },
            page({
              ...c,
              files: entries.map(({ f, info }) => ({
                ...f,
                priceUsdc: `${info.price / 1_000_000n}.${String(info.price % 1_000_000n).padStart(6, '0')}`,
              })),
            }),
          );
        const list = entries.map(({ f, info, life }) => ({
          name: f.name,
          fileId: f.fileId,
          title: f.title,
          description: f.description ?? '',
          url: `${c.publicUrl}/f/${f.name}`,
          header: `${c.publicUrl}/f/${f.name}/header`,
          byteSize: f.size,
          plaintextSize: f.plaintextSize,
          createdAt: life?.createdAt === undefined ? 0 : Math.floor(life.createdAt / 1000),
          expiresAt:
            life?.expiresAt === null
              ? null
              : life?.expiresAt === undefined
                ? 0
                : Math.floor(life.expiresAt / 1000),
          termsHash: info.termsHash,
          terms: info.terms,
          salesStopped: info.salesStoppedAt !== null,
          takenDown: info.takenDown !== null,
        }));
        return send(200, { 'Content-Type': 'application/json' }, JSON.stringify(list));
      }
      const m = /^\/f\/([a-z0-9-]+)(\/header)?$/.exec(path);
      const snapshot = m ? await c.capacity?.snapshot() : undefined;
      if (m && snapshot?.expiredSlugs.has(m[1] as string))
        return send(
          410,
          { 'Content-Type': 'application/json' },
          JSON.stringify({ error: 'file_expired', message: 'This hosted file has expired.' }),
        );
      const f = m ? (await allFiles(snapshot)).find((x) => x.name === m[1]) : undefined;
      if (!m || !f) return send(404, {});
      if (snapshot?.expiredIds.has(f.fileId))
        return send(
          410,
          { 'Content-Type': 'application/json' },
          JSON.stringify({ error: 'file_expired', message: 'This hosted file has expired.' }),
        );
      await f.verify?.();
      if (m[2]) return send(200, { 'Content-Type': 'application/octet-stream' }, f.header);
      if (req.headers['payment-signature']) {
        if (!c.facilitator) return send(501, {});
        const paymentAdmission = paymentsPerClient(key);
        if (!paymentAdmission.allowed)
          return send(
            429,
            {
              'Retry-After': String(paymentAdmission.retryAfterSeconds),
              'Content-Type': 'application/json',
            },
            JSON.stringify({
              error: 'rate_limited',
              message: 'Too many requests. Try again later.',
              retryAfterSeconds: paymentAdmission.retryAfterSeconds,
            }),
          );
      }
      const r = await serve(
        { headers: { get: (n) => (req.headers[n.toLowerCase()] as string | undefined) ?? null } },
        {
          nearRpc: c.nearRpc,
          baseRpc: c.baseRpc,
          contractId: c.contractId,
          fileId: f.fileId,
          url: `${c.publicUrl}/f/${f.name}`,
          header: `${c.publicUrl}/f/${f.name}/header`,
          headerHash: f.headerHash,
          store: c.store,
          ...(c.downloads ? { downloads: c.downloads } : {}),
          settlementPollSeconds: c.settlementPollSeconds ?? 10,
          paymentMinValiditySeconds: c.paymentMinValiditySeconds ?? 60,
          beforeSettle: (file) =>
            requireEligibility(file, {
              origin: c.relayerOrigin ?? '',
              contract: c.contractId,
              fileId: f.fileId,
            }),
          facilitator: c.facilitator ?? noFacilitator,
          file: {
            size: f.size,
            headerLength: f.header.length,
            read: (start) =>
              Readable.toWeb(createReadStream(f.path, { start })) as ReadableStream<Uint8Array>,
          },
          // Diagnostics contain only the checked code and public file slug.
          onPaymentError: (e) => {
            if (isTransient(e)) emit(c.alert, { type: 'base_rpc_unhealthy' });
            if (e.code === 'relayer_unavailable') emit(c.alert, { type: 'relayer_unavailable' });
            if (e.code === 'facilitator_busy') emit(c.alert, { type: 'facilitator_busy' });
            console.log(
              JSON.stringify({
                payment_error: e.code,
                file: f.name,
              }),
            );
          },
        },
      );
      if (f.filename && (r.status === 200 || r.status === 206)) {
        const suggestion =
          f.filename
            .split(/[\\/]/)
            .at(-1)
            ?.replace(/[\p{Cc}\p{Cs}\p{Cf}\p{Zl}\p{Zp}]/gu, '') ?? '';
        const filename =
          !suggestion || suggestion === '.' || suggestion === '..' ? 'download' : suggestion;
        r.headers['Content-Disposition'] =
          `attachment; filename*=UTF-8''${encodeURIComponent(filename).replace(/[!'()*]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)}`;
      }
      res.writeHead(r.status, r.headers);
      active.set(f.fileId, (active.get(f.fileId) ?? 0) + 1);
      try {
        await sendBody(r, res);
      } finally {
        active.set(f.fileId, (active.get(f.fileId) ?? 1) - 1);
      }
    } catch (e) {
      emit(c.alert, { type: 'store_busy' });
      console.log(JSON.stringify({ error: (e as Error).name, path: path.slice(0, 120) }));
      if (!res.headersSent)
        send(
          path === '/' || path === '/files.json' ? 503 : 500,
          path === '/' || path === '/files.json' ? { 'Retry-After': '30' } : {},
        );
      else res.destroy();
    }
  };
}

const noFacilitator: Facilitator = async () => {
  throw new Error('this host has no Base facilitator');
};

export async function main(e: Record<string, string | undefined> = process.env) {
  let reason: StartupReason = 'config_invalid';
  let ownership: Awaited<ReturnType<typeof hostStorage>> | undefined;
  try {
    const settings = hostSettings(e);
    const port = settings.int('PORT', 8080, 1, 65535);
    const need = (name: string) => {
      const value = e[name]?.trim();
      if (!value) throw new Error(`${name} is required`);
      return value;
    };
    const dataDir = need('DATA_DIR');
    const alert = hostAlerts(need('DEMO_ALERT_WEBHOOK'));
    reason = 'storage_uninitialized';
    ownership = await hostStorage(dataDir);
    reason = 'state_invalid';
    await initFacilitatorState(fileStore(join(dataDir, 'facilitator')), true);
    const store = fileStore<SellerRecord>(join(dataDir, 'seller'));
    const capacity = await hostCapacity(join(dataDir, 'capacity'), {
      ...settings.capacity,
      requireState: true,
    });
    const downloads = await downloadLedger(join(dataDir, 'downloads'), settings.downloads);
    reason = 'config_invalid';
    const files = await loadFiles(need('FILES_DIR'), (id) => capacity.expired(id), settings);
    reason = 'state_invalid';
    const signingKey = e.DEMO_RESERVATION_SIGNING_KEY?.trim();
    const uploads = signingKey
      ? await uploadService({
          dir: join(dataDir, 'uploads'),
          capacity,
          requireState: true,
          network: 'near:mainnet',
          contract: need('CONTRACT_ID'),
          hostOrigin: settings.publicUrl,
          nearRpc: need('NEAR_RPC'),
          signingKey: Buffer.from(signingKey, 'hex'),
          sellers: settings.sellers,
          getFile: (id) => getFile(need('NEAR_RPC'), need('CONTRACT_ID'), id),
          assets: { nearUsdc: NEAR_USDC, baseUsdc: BASE_USDC },
          ...settings.uploads,
        })
      : undefined;
    const active = new Map<string, number>();
    for (const f of files)
      await capacity.importFile({
        id: `operator:${f.fileId}`,
        fileId: f.fileId,
        slug: f.name,
        seller: 'operator',
        ip: 'operator',
        listed: true,
        byteSize: f.size,
        bodyBytes: f.size - f.header.length,
        plaintextSize: f.plaintextSize,
      });
    const key = e.FACILITATOR_KEY?.trim();
    const baseRpc = need('BASE_RPC');
    const facilitator = key
      ? await baseFacilitator(key, baseRpc, settings.maxFeeGwei, settings.sendsPerMinute, {
          ...settings.facilitator,
          store: fileStore(join(dataDir, 'facilitator')),
          alert,
          requireState: true,
          rpcTimeout: settings.rpcTimeout,
          rpcRetries: settings.rpcRetries,
          gasLimit: settings.gasLimit,
        })
      : undefined;
    const c: HostConfig = {
      contractId: need('CONTRACT_ID'),
      nearRpc: need('NEAR_RPC'),
      baseRpc,
      publicUrl: settings.publicUrl,
      files,
      ...(uploads ? { uploads, uploadLimits: settings.uploadHttp } : {}),
      store,
      capacity,
      downloads,
      active,
      alert,
      cors: settings.cors,
      relayerOrigin: settings.relayerOrigin,
      settlementPollSeconds: settings.pollSeconds,
      paymentMinValiditySeconds: settings.facilitator.minValiditySeconds,
      perIpMinute: settings.perIpMinute,
      paymentsPerClientMinute: settings.paymentsPerClientMinute,
      ...(facilitator ? { facilitator } : {}),
      ...(e.IP_HEADER?.trim() ? { ipHeader: e.IP_HEADER.trim() } : {}),
    };
    const cleanup = async (retry = true) => {
      await uploads?.cleanup(active, retry);
      for (const id of await capacity.sweep()) {
        const record = await capacity.info(id);
        if (
          !record ||
          !id.startsWith('operator:') ||
          !NAME.test(record.slug) ||
          (active.get(record.fileId) ?? 0) > 0
        )
          continue;
        await unlink(join(need('FILES_DIR'), `${record.slug}.pay2`)).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
        await capacity.removed(id);
      }
      await sweepSellerRecords(join(dataDir, 'seller'), store, Date.now(), settings.graceSeconds);
    };
    const sample = async () => {
      if (facilitator && (await facilitator.selfCheck())) await facilitator.sample();
      for (const path of [dataDir, need('FILES_DIR')]) {
        const fs = await statfs(path);
        const percent = Math.ceil((100 * (fs.blocks - fs.bavail)) / Math.max(1, fs.blocks));
        const inodes = Math.ceil((100 * (fs.files - fs.ffree)) / Math.max(1, fs.files));
        if (percent >= settings.diskPercent) emit(alert, { type: 'disk', percent });
        if (inodes >= settings.diskPercent) emit(alert, { type: 'inodes', percent: inodes });
      }
    };
    await cleanup(false);

    emit(alert, { type: 'restart' });
    const handle = handler(c);
    const requests = new Set<Promise<void>>();
    const server = createServer((req, res) => {
      const ordinary = !(
        req.method === 'PUT' &&
        /^\/v1\/uploads\/[a-f0-9]{64}\/(body|header)$/.test((req.url ?? '').split('?')[0] as string)
      );
      const requestTimer = ordinary ? setTimeout(() => req.destroy(), 30000) : undefined;
      const clear = () => {
        if (requestTimer) clearTimeout(requestTimer);
      };
      req.once('end', clear);
      req.once('close', clear);
      if (req.complete) clear();
      const task = handle(req, res);
      requests.add(task);
      void task.then(
        () => requests.delete(task),
        () => requests.delete(task),
      );
    });
    server.requestTimeout = settings.uploadHttp.requestSeconds * 1000;
    server.headersTimeout = 10_000;
    server.timeout = 120000;
    server.maxConnections = 1_000;
    let maintenance = Promise.resolve();
    const enqueue = (job: () => Promise<void>, type: 'store_busy' | 'base_rpc_unhealthy') => {
      maintenance = maintenance.then(job).catch(() => {
        emit(alert, { type });
      });
    };
    const schedule = (
      job: () => Promise<void>,
      seconds: number,
      type: 'store_busy' | 'base_rpc_unhealthy',
    ) => setInterval(() => enqueue(job, type), seconds * 1000);
    const timers = [
      schedule(() => cleanup(), settings.sweepSeconds, 'store_busy'),
      schedule(sample, settings.sampleSeconds, 'base_rpc_unhealthy'),
    ];
    reason = 'config_invalid';
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    } catch (error) {
      for (const timer of timers) clearInterval(timer);
      throw error;
    }
    enqueue(sample, 'base_rpc_unhealthy');
    const close = async () => {
      for (const timer of timers) clearInterval(timer);
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await Promise.allSettled([...requests, maintenance]);
      await ownership?.close();
      process.removeListener('SIGTERM', shutdown);
      process.removeListener('SIGINT', shutdown);
    };
    const shutdown = () => {
      void close().then(() => process.exit(0));
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    return { server, close };
  } catch (error) {
    await ownership?.close();
    if (error instanceof StartupError) throw error;
    throw new StartupError(reason);
  }
}

export async function reportStartupFailure(
  error: unknown,
  env: Record<string, string | undefined>,
) {
  const reason = error instanceof StartupError ? error.reason : 'config_invalid';
  console.error(JSON.stringify({ error: 'host_startup_failed', reason }));
  if (env.DEMO_ALERT_WEBHOOK) {
    try {
      await hostAlerts(env.DEMO_ALERT_WEBHOOK)({ type: 'host_startup_failed', reason });
    } catch {
      /* Invalid webhook configuration cannot expose diagnostics. */
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (error) {
    await reportStartupFailure(error, process.env);
    process.exitCode = 1;
  }
}
