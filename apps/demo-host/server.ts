/**
 * A public demo host for Annon files. It serves PAY2 files behind `serveFile`: an x402 402 offer
 * until a purchase is final on NEAR, then the file to the buyer who proves it. Anyone can try it with
 * the `annon` CLI or MCP server.
 *
 *   GET /                  the demo files and how to buy them (HTML)
 *   GET /files.json        the same list for scripts and agents
 *   GET /f/<name>          the PAY2 file (402 with the offer until paid)
 *   GET /f/<name>/header   its public header (checked by the buyer before paying)
 *   GET /healthz
 *
 * Settings: apps/demo-host/README.md.
 */
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import {
  type FileHostOptions,
  type HostResponse,
  serveFile,
} from '../../packages/annon/src/download/host.ts';
import { sha256 } from '../../packages/annon/src/envelope/pay2.ts';
import { authorizationCall } from '../../packages/annon/src/pay/base.ts';
import type { Facilitator, SellerRecord } from '../../packages/annon/src/pay/settle.ts';
import type { Store } from '../../packages/annon/src/pay/store.ts';
import { fileStore } from '../../packages/annon/src/pay/store-node.ts';
import { BASE_USDC } from '../../packages/annon/src/settle-near/terms.ts';

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
  path: string;
  size: number;
  header: Uint8Array;
  headerHash: string;
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
export async function loadFiles(dir: string): Promise<Loaded[]> {
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
    const path = join(dir, `${name}.pay2`);
    const size = (await stat(path)).size;
    const fh = await open(path, 'r');
    try {
      const fixed = Buffer.alloc(12);
      await fh.read(fixed, 0, 12, 0);
      const len = fixed.readUInt32BE(8);
      if (len < 65 || len > size || len > MAX_HEADER)
        throw new Error(`bad header length in ${name}`);
      const header = new Uint8Array(len);
      await fh.read(header, 0, len, 0);
      // On chain: SHA-256 of the header without its 65-byte signature.
      out.push({
        ...f,
        path,
        size,
        header,
        headerHash: hex(await sha256(header.subarray(0, len - 65))),
      });
    } finally {
      await fh.close();
    }
  }
  return out;
}

/** The client's rate-limit key: IPv4 as is, IPv6 by /64, anything else by the socket address. */
export function clientKey(
  header: string | string[] | undefined,
  socket: string | undefined,
): string {
  const v = typeof header === 'string' && !header.includes(',') ? header.trim() : socket;
  const ip = (v ?? '').replace(/^::ffff:/, '');
  if (isIP(ip) === 4) return ip;
  if (isIP(ip) === 6) {
    const [head = '', tail = ''] = ip.split('::');
    const a = head ? head.split(':') : [];
    const b = tail ? tail.split(':') : [];
    const full = ip.includes('::') ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b] : a;
    return `${full
      .slice(0, 4)
      .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''))
      .join(':')}::/64`;
  }
  return 'unknown';
}

/**
 * Fixed-window limit per key; cleared each window, and while full, unknown keys share one bucket,
 * so the map stays bounded.
 */
export function limiter(perMinute: number, now = () => Date.now(), maxKeys = 50_000) {
  let window = 0;
  let hits = new Map<string, number>();
  return (key: string) => {
    const w = Math.floor(now() / 60_000);
    if (w !== window) {
      window = w;
      hits = new Map();
    }
    const k = hits.has(key) || hits.size < maxKeys ? key : '*';
    const n = (hits.get(k) ?? 0) + 1;
    hits.set(k, n);
    return n <= perMinute;
  };
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
  const perIp = limiter(c.perIpMinute);
  // The SDK resends its payment about every 3 s while it waits, so a buyer makes ~20 a minute.
  const paymentsPerClient = limiter(c.paymentsPerClientMinute);
  return async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now();
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
      if (path === '/healthz')
        return send(200, { 'Content-Type': 'application/json' }, '{"ok":true}');
      const key = clientKey(
        c.ipHeader ? req.headers[c.ipHeader.toLowerCase()] : undefined,
        req.socket.remoteAddress,
      );
      if (!perIp(key)) return send(429, { 'Retry-After': '60' });
      // GET only: HEAD would run settlement without reading the body.
      if (req.method !== 'GET') return send(405, { Allow: 'GET' });
      if (path === '/') return send(200, { 'Content-Type': 'text/html; charset=utf-8' }, page(c));
      if (path === '/files.json') {
        const list = c.files.map(({ name, fileId, title, description, priceUsdc }) => ({
          name,
          fileId,
          title,
          description,
          priceUsdc,
          url: `${c.publicUrl}/f/${name}`,
          header: `${c.publicUrl}/f/${name}/header`,
        }));
        return send(200, { 'Content-Type': 'application/json' }, JSON.stringify(list));
      }
      const m = /^\/f\/([a-z0-9-]+)(\/header)?$/.exec(path);
      const f = m ? c.files.find((x) => x.name === m[1]) : undefined;
      if (!m || !f) return send(404, {});
      if (m[2]) return send(200, { 'Content-Type': 'application/octet-stream' }, f.header);
      if (req.headers['payment-signature']) {
        if (!c.facilitator) return send(501, {});
        if (!paymentsPerClient(key)) return send(503, { 'Retry-After': '30' });
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
          facilitator: c.facilitator ?? noFacilitator,
          file: {
            size: f.size,
            read: (start) =>
              Readable.toWeb(createReadStream(f.path, { start })) as ReadableStream<Uint8Array>,
          },
          // Operator only: the buyer gets the unchanged status. Codes and messages carry no URLs.
          onPaymentError: (e) =>
            console.log(
              JSON.stringify({
                payment_error: e.code,
                file: f.name,
                message: e.message.slice(0, 300),
              }),
            ),
        },
      );
      res.writeHead(r.status, r.headers);
      if (!r.body) return void res.end();
      // pipeline cancels the file stream when the client goes and turns read errors into a cut
      // response instead of an unhandled error.
      await pipeline(Readable.fromWeb(r.body as NodeReadableStream<Uint8Array>), res).catch(
        () => {},
      );
    } catch (e) {
      console.log(JSON.stringify({ error: (e as Error).name, path: path.slice(0, 120) }));
      if (!res.headersSent) send(500, {});
      else res.destroy();
    }
  };
}

export interface Authorization {
  from: string;
  to: string;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: string;
}
export interface Chain {
  /** USDC `authorizationState(from, nonce)`: true when the nonce is used or canceled. */
  used(from: string, nonce: string): Promise<boolean>;
  /**
   * Runs the call against USDC without sending it (balance, signature, nonce, validity window,
   * blacklist, all by USDC's own code); false when USDC would revert.
   */
  simulate(a: Authorization, signature: string): Promise<boolean>;
  /** Prepares and signs the call; null when the fee would exceed the cap. */
  sign(to: string, data: string): Promise<string | null>;
  send(signed: string): Promise<string>;
}

/**
 * The Base facilitator: submits a buyer's EIP-3009 authorization from a hot wallet, which pays the
 * gas. `settle` has already checked the payload against the registered terms; this pins Base USDC,
 * keeps one send per authorization (a repeat call gets the same hash), sends one transaction at a
 * time so wallet nonces never collide, skips authorizations USDC already marks as used, and
 * answers `settlement_pending` right after broadcast: `settle` records the hash and watches Base.
 * It simulates the call first, so a payer without the USDC costs no gas, and sends at most
 * `sendsPerMinute` transactions. A send whose answer was lost blocks its authorization for a minute,
 * then goes again only if USDC still shows the nonce unused. Entries expire after `validBefore`.
 */
export function facilitatorFor(
  chain: Chain,
  sendsPerMinute = 10,
  now = () => Date.now(),
): Facilitator {
  /** (from, nonce) → the hash sent, or '' while a lost send is unresolved; with its expiry. */
  const sent = new Map<string, { hash: string; at: number; until: number }>();
  const sends = limiter(sendsPerMinute, now);
  /** Last send per payer: one payer's authorizations go one at a time, 30 s apart. */
  const lastByPayer = new Map<string, number>();
  let queue: Promise<unknown> = Promise.resolve();
  type Auth = {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
  };
  return async (body, o) => {
    const req = body.paymentRequirements as {
      payTo: string;
      amount: string;
      asset: string;
      network: string;
    };
    const p = (
      body.paymentPayload as unknown as { payload: { authorization: Auth; signature: string } }
    ).payload;
    const a = p.authorization;
    const fail = (errorReason: string, transaction = '') =>
      ({
        success: false,
        errorReason,
        transaction,
        network: 'eip155:8453',
        payer: a.from,
      }) as const;
    if (
      req.network !== 'eip155:8453' ||
      req.asset.toLowerCase() !== BASE_USDC ||
      a.to.toLowerCase() !== req.payTo.toLowerCase() ||
      BigInt(a.value) !== BigInt(req.amount)
    )
      return fail('invalid_authorization');
    const key = `${a.from.toLowerCase()}:${a.nonce.toLowerCase()}`;
    const auth: Authorization = {
      from: a.from,
      to: a.to,
      value: BigInt(a.value),
      validAfter: BigInt(a.validAfter),
      validBefore: BigInt(a.validBefore),
      nonce: a.nonce,
    };
    const run = async () => {
      const t = now();
      for (const [k, v] of sent) if (v.until * 1000 < t) sent.delete(k);
      for (const [k, v] of lastByPayer) if (t - v > 30_000) lastByPayer.delete(k);
      const known = sent.get(key);
      if (known?.hash) return fail('settlement_pending', known.hash);
      if (known && t - known.at < 60_000) return fail('settlement_pending');
      o.signal.throwIfAborted();
      if (await chain.used(a.from, a.nonce)) return fail('authorization_used');
      if (!(await chain.simulate(auth, p.signature))) return fail('invalid_authorization');
      // A payer racing many authorizations against one balance would only burn our gas on reverts.
      if (lastByPayer.has(a.from.toLowerCase())) return fail('payer_busy');
      if (!sends('all')) return fail('facilitator_busy');
      const signed = await chain.sign(BASE_USDC, authorizationCall(auth, p.signature));
      if (!signed) return fail('gas_price_too_high');
      o.signal.throwIfAborted();
      // Marked before sending: if the answer is lost, a retry waits instead of sending again.
      sent.set(key, { hash: '', at: t, until: Number(auth.validBefore) });
      lastByPayer.set(a.from.toLowerCase(), t);
      const hash = await chain.send(signed);
      sent.set(key, { hash, at: t, until: Number(auth.validBefore) });
      console.log(JSON.stringify({ facilitator: 'submitted', hash }));
      return fail('settlement_pending', hash);
    };
    const next = queue.then(run, run);
    queue = next.catch(() => {});
    try {
      return await next;
    } catch (e) {
      // The name only: viem messages can contain the RPC URL and its key.
      console.log(JSON.stringify({ facilitator: 'error', error: (e as Error).name }));
      throw e;
    }
  };
}

/** `facilitatorFor` on Base mainnet through viem, with a fee cap and a 120k gas cap. */
export async function baseFacilitator(
  key: string,
  baseRpc: string,
  maxFeeGwei: number,
  sendsPerMinute: number,
): Promise<Facilitator> {
  const { createPublicClient, createWalletClient, http, parseGwei } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');
  const { base } = await import('viem/chains');
  const { authorizationState, dryRun, PayError } = await import(
    '../../packages/annon/src/pay/base.ts'
  );
  const account = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`);
  const transport = http(baseRpc);
  const wallet = createWalletClient({ account, chain: base, transport });
  const pub = createPublicClient({ chain: base, transport });
  const cap = parseGwei(String(maxFeeGwei));
  return facilitatorFor(
    {
      used: async (from, nonce) =>
        authorizationState(baseRpc, BASE_USDC, from, nonce, Number(await pub.getBlockNumber())),
      simulate: async (a, signature) => {
        try {
          await dryRun(baseRpc, BASE_USDC, a, signature);
          return true;
        } catch (e) {
          if (e instanceof PayError && e.code === 'payment_rejected') return false;
          throw e;
        }
      },
      sign: async (to, data) => {
        const r = await wallet.prepareTransactionRequest({
          to: to as `0x${string}`,
          data: data as `0x${string}`,
          gas: 120_000n,
        });
        if ((r.maxFeePerGas ?? 0n) > cap) return null;
        return wallet.signTransaction(r);
      },
      send: (signed) =>
        wallet.sendRawTransaction({ serializedTransaction: signed as `0x${string}` }),
    },
    sendsPerMinute,
  );
}

const noFacilitator: Facilitator = async () => {
  throw new Error('this host has no Base facilitator');
};

async function main() {
  const e = process.env;
  const need = (k: string) => {
    const v = e[k]?.trim();
    if (!v) throw new Error(`${k} is required`);
    return v;
  };
  const int = (k: string, d: number) => {
    const n = Number(e[k] ?? d);
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`${k} must be a positive integer`);
    return n;
  };
  const publicUrl = need('PUBLIC_URL').replace(/\/$/, '');
  if (
    !/^https:\/\//.test(publicUrl) &&
    !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(publicUrl)
  )
    throw new Error('PUBLIC_URL must be https (or http on localhost)');
  const baseRpc = need('BASE_RPC');
  const dataDir = join(need('DATA_DIR'), 'seller');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const key = e.FACILITATOR_KEY?.trim();
  const maxFeeGwei = Number(e.MAX_FEE_GWEI ?? 0.5);
  if (!(maxFeeGwei > 0)) throw new Error('MAX_FEE_GWEI must be positive');
  const c: HostConfig = {
    contractId: need('CONTRACT_ID'),
    nearRpc: need('NEAR_RPC'),
    baseRpc,
    publicUrl,
    files: await loadFiles(need('FILES_DIR')),
    store: fileStore<SellerRecord>(dataDir),
    ...(key
      ? {
          facilitator: await baseFacilitator(key, baseRpc, maxFeeGwei, int('SENDS_PER_MINUTE', 10)),
        }
      : {}),
    perIpMinute: int('PER_IP_MINUTE', 120),
    paymentsPerClientMinute: int('PAYMENTS_PER_CLIENT_MINUTE', 30),
    ...(e.IP_HEADER?.trim() ? { ipHeader: e.IP_HEADER.trim() } : {}),
  };
  const server = createServer(handler(c));
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  // Inactivity on a socket, sending included: a buyer cannot hold a download open by reading slowly.
  server.timeout = 120_000;
  server.maxConnections = 1_000;
  const port = int('PORT', 8080);
  server.listen(port, () =>
    console.log(
      `annon demo host on :${port}, ${c.files.length} files, Base facilitator ${key ? 'on' : 'off'}`,
    ),
  );
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
