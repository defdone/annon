import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WalletFailure } from '../browser/login-status.js';
import { TransactionUncertain } from '../wallet/uncertain.js';
import {
  APPROVED_LINE,
  cancelledError,
  expiredError,
  failureLine,
  isPageReport,
  openingLine,
  sendUncertain,
  usableHash,
  waitingLine,
} from './approval-status.js';
import { LOGIN_PAGE_CSS, LOGIN_PAGE_HTML } from './login-page.js';
import type { SigningRequest } from './signing.js';

const equal = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
/**
 * The approval page talks only to this loopback server, the NEAR RPC its Wallet Selector uses
 * (fixed per network in browser/login.ts, independent of the CLI's configured RPC) and HOT
 * Wallet's relay; it frames only the HOT widget. EVM wallets are reached through the injected
 * provider, which needs no connection from the page.
 */
export const LOGIN_PAGE_CSP =
  "default-src 'none'; script-src 'self'; connect-src 'self' https://free.rpc.fastnear.com https://test.rpc.fastnear.com https://h4n.app; frame-src https://hot-labs.org; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
export interface BrowserSession {
  url: string;
  pairingCode: string;
  request<T>(
    action: { id: string; expiresAt: number; exact?: unknown },
    verify: (result: T) => Promise<void>,
  ): Promise<T>;
  close(): Promise<void>;
}
export async function startBrowserSession(o: {
  noOpen?: boolean;
  open?: (url: string) => void;
  asset?: string;
  timeoutMs?: number;
  /** Human progress lines; stderr by default, never stdout. */
  notify?: (line: string) => void;
  /** Human mode: a line naming each request, printed before its waiting line. */
  describe?: (action: SigningRequest) => string;
}): Promise<BrowserSession> {
  const notify = o.notify ?? ((line: string) => void process.stderr.write(`${line}\n`));
  let asset = o.asset;
  if (asset === undefined) {
    try {
      asset = await readFile(new URL('../browser/login-bundle.js', import.meta.url), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        asset = await readFile(
          new URL('../../dist/browser/login-bundle.js', import.meta.url),
          'utf8',
        );
      } catch {
        throw new Error(
          'Browser login requires the bundle. Run pnpm --filter @defdone/annon build first.',
        );
      }
    }
  }
  const capability = randomBytes(32).toString('base64url'),
    pairingCode = randomBytes(3).toString('hex').toUpperCase();
  let origin = '',
    closed = false;
  let bootstrapped = false;
  // Keep in-flight and completed outcomes so popup/opener races verify only once.
  const results = new Map<string, { key: string; expiresAt: number; outcome: Promise<number> }>();
  const canonical = (v: unknown): string =>
    v && typeof v === 'object'
      ? Array.isArray(v)
        ? `[${v.map(canonical)}]`
        : `{${Object.keys(v)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
            .join(',')}}`
      : JSON.stringify(v);

  type Pending = {
    action: { id: string; expiresAt: number };
    busy: boolean;
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    verify: (r: unknown) => Promise<void>;
    timer: ReturnType<typeof setTimeout>;
    /** The last wallet failure the page reported for this request. */
    failure?: WalletFailure;
    /** The page called the wallet's send: the request can only end as sent or uncertain. */
    sending?: boolean;
  };
  /** Ends a request whose transaction may be on chain, with the CLI's own warning. */
  const uncertain = (p: Pending, txHash?: string) => {
    const { line, error } = sendUncertain(p.action, txHash);
    notify(line);
    return error;
  };
  /** A transaction request whose send started, or that returned transaction evidence at all. */
  const sent = (p: Pending) =>
    p.sending === true ||
    (p.action as { operation?: unknown }).operation === 'near.signTransaction';
  let pending: Pending | undefined;
  const followers = new Set<ServerResponse>();
  const advance = (action: unknown = null) => {
    for (const response of followers) response.end(JSON.stringify({ action }));
    followers.clear();
  };
  const server = createServer((req, res) => {
    void (async () => {
      const headers = {
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'content-security-policy': LOGIN_PAGE_CSP,
      };
      const send = (status: number, body: string, type = 'application/json') =>
        res.writeHead(status, { ...headers, 'content-type': type }).end(body);
      if (closed || req.headers.host !== new URL(origin).host) return void send(403, '{}');
      const path = req.url;
      if (path === '/api/bootstrap' && req.method === 'POST') {
        if (o.noOpen || bootstrapped) return void send(404, '{}');
        if (req.headers.origin !== origin) return void send(403, '{}');
        bootstrapped = true;
        return void send(200, JSON.stringify({ capability }));
      }
      if (path?.startsWith('/api/')) {
        if (
          req.headers.origin !== origin ||
          !equal(req.headers.authorization ?? '', `Bearer ${capability}`)
        )
          return void send(403, '{}');
        if (path === '/api/action' && ['GET', 'POST'].includes(req.method ?? ''))
          return void send(
            200,
            JSON.stringify({
              pairingCode,
              action: pending?.action ?? null,
              sendStarted: pending?.sending === true,
            }),
          );
        if (!['/api/result', '/api/report'].includes(path) || req.method !== 'POST')
          return void send(404, '{}');
        let size = 0;
        const parts: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 131072) return void send(413, '{}');
          parts.push(chunk);
        }
        const b = JSON.parse(Buffer.concat(parts).toString());
        if (path === '/api/report') {
          // A fixed reason for the current, unconsumed request. Only `cancelled` and
          // `send_uncertain` end it, and never as cancelled once the page started a send.
          const p = pending;
          if (!p || p.busy || b.id !== p.action.id || !isPageReport(b.reason))
            return void send(409, '{}');
          if (b.reason === 'send_started') {
            // One send per request: a reloaded or second page cannot start another.
            if (p.sending) return void send(409, '{}');
            p.sending = true;
          } else if (b.reason === 'cancelled' || b.reason === 'send_uncertain') {
            clearTimeout(p.timer);
            pending = undefined;
            armIdle();
            p.reject(p.sending || b.reason === 'send_uncertain' ? uncertain(p) : cancelledError());
          } else if (!p.sending && p.failure !== b.reason) {
            // After a send started no failure can be retried, so none is announced as one.
            p.failure = b.reason;
            notify(failureLine(b.reason, p.action.expiresAt - Date.now()));
          }
          return void send(200, '{}');
        }
        const key = canonical(b.result);
        const previous = results.get(b.id);
        if (previous && Date.now() < previous.expiresAt) {
          if (previous.key !== key) return void send(409, '{}');
          return void send(await previous.outcome, '{}');
        }
        const p = pending;
        if (!p || p.busy || b.id !== p.action.id || Date.now() >= p.action.expiresAt)
          return void send(409, '{}');
        p.busy = true; // consumed before async verification, including forged results
        let complete: (status: number) => void = () => {};
        const outcome = new Promise<number>((resolve) => {
          complete = resolve;
        });
        results.set(b.id, { key, expiresAt: p.action.expiresAt, outcome });
        try {
          await p.verify(b.result);
          if (closed || pending !== p || Date.now() >= p.action.expiresAt)
            throw new Error('expired');
          clearTimeout(p.timer);
          if (pending === p) {
            pending = undefined;
            armIdle();
          }
          notify(APPROVED_LINE);
          complete(200);
          if (b.follow === true) {
            res.writeHead(200, { ...headers, 'content-type': 'application/json' });
            res.flushHeaders();
            followers.add(res);
            res.on('close', () => followers.delete(res));
          } else send(200, '{}');
          p.resolve(b.result);
        } catch (error) {
          clearTimeout(p.timer);
          if (pending === p) {
            pending = undefined;
            armIdle();
          }
          // After a send, a result that cannot be verified is never evidence of success or of
          // failure: the request ends as uncertain, with any usable hash, so it stays saved.
          p.reject(
            sent(p)
              ? uncertain(
                  p,
                  usableHash(
                    error instanceof TransactionUncertain ? error.txHash : b?.result?.txHash,
                  ),
                )
              : error instanceof TransactionUncertain
                ? error
                : new Error('wallet result rejected'),
          );
          complete(400);
          send(400, '{}');
        }
        return;
      }
      if (req.method !== 'GET') return void send(405, '{}');
      if (path === '/app.js') return void send(200, asset, 'text/javascript');
      if (path === '/app.css') return void send(200, LOGIN_PAGE_CSS, 'text/css; charset=utf-8');
      if (path === '/' || path === '/callback')
        return void send(200, LOGIN_PAGE_HTML, 'text/html; charset=utf-8');
      send(404, '{}');
    })().catch(() => {
      if (!res.headersSent) res.writeHead(400, { 'cache-control': 'no-store' }).end();
    });
  });
  server.on('upgrade', (_req, socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('session closed'));
      pending = undefined;
    }
    const flushed = [...followers].map(
      (response) =>
        new Promise<void>((resolve) => response.end(JSON.stringify({ action: null }), resolve)),
    );
    followers.clear();
    const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(flushed),
      new Promise<void>((resolve) => {
        flushTimer = setTimeout(resolve, 1000);
      }),
    ]);
    clearTimeout(flushTimer);
    server.closeAllConnections();
    await stopped;
  };
  let timeout: ReturnType<typeof setTimeout>;
  const armIdle = () => {
    clearTimeout(timeout);
    if (!closed && !pending)
      timeout = setTimeout(() => {
        void close();
      }, o.timeoutMs ?? 300000);
  };
  armIdle();
  const url = `${origin}/#${capability}`;
  // The capability-free page URL: in open mode the page bootstraps the capability once.
  if (!o.noOpen) notify(openingLine(`${origin}/`));
  if (!o.noOpen)
    (
      o.open ??
      ((target) => {
        execFile(
          process.platform === 'darwin'
            ? 'open'
            : process.platform === 'win32'
              ? 'explorer.exe'
              : 'xdg-open',
          [target],
          { env: browserOpenerEnv(process.env) },
          () => {},
        );
      })
    )(`${origin}/`);
  return {
    url,
    pairingCode,
    close,
    request: (action, verify) =>
      new Promise((resolve, reject) => {
        for (const [id, r] of results) if (Date.now() >= r.expiresAt) results.delete(id);
        if (closed || pending || results.has(action.id) || action.expiresAt <= Date.now()) {
          reject(new Error('session closed, busy or expired'));
          return;
        }
        clearTimeout(timeout);
        const entry: Pending = {
          action: JSON.parse(JSON.stringify(action)),
          busy: false,
          resolve: resolve as (v: unknown) => void,
          reject,
          verify: verify as (v: unknown) => Promise<void>,
          timer: setTimeout(() => {
            if (pending === entry) {
              pending = undefined;
              armIdle();
            }
            reject(entry.sending ? uncertain(entry) : expiredError(entry.failure));
          }, action.expiresAt - Date.now()),
        };
        pending = entry;
        advance(entry.action);
        if (o.describe) notify(o.describe(action as SigningRequest));
        notify(waitingLine(action.expiresAt - Date.now()));
      }),
  };
}

/** Only desktop routing and executable lookup reach the browser opener. */
export function browserOpenerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    [
      'PATH',
      'HOME',
      'DISPLAY',
      'BROWSER',
      'XDG_CURRENT_DESKTOP',
      'DESKTOP_SESSION',
      'LANG',
      'WAYLAND_DISPLAY',
      'XDG_RUNTIME_DIR',
      'DBUS_SESSION_BUS_ADDRESS',
      'SystemRoot',
    ].flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])),
  );
}
