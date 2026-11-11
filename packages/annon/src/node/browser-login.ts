import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TransactionUncertain } from '../wallet/uncertain.js';

const equal = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
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
}): Promise<BrowserSession> {
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

  let pending:
    | {
        action: { id: string; expiresAt: number };
        busy: boolean;
        resolve: (v: unknown) => void;
        reject: (e: Error) => void;
        verify: (r: unknown) => Promise<void>;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  const server = createServer((req, res) => {
    void (async () => {
      const headers = {
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'content-security-policy':
          "default-src 'none'; script-src 'self'; connect-src 'self' https:; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
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
          return void send(200, JSON.stringify({ pairingCode, action: pending?.action ?? null }));
        if (path !== '/api/result' || req.method !== 'POST') return void send(404, '{}');
        let size = 0;
        const parts: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 131072) return void send(413, '{}');
          parts.push(chunk);
        }
        const b = JSON.parse(Buffer.concat(parts).toString());
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
          p.resolve(b.result);
          complete(200);
          send(200, '{}');
        } catch (error) {
          clearTimeout(p.timer);
          if (pending === p) {
            pending = undefined;
            armIdle();
          }
          p.reject(
            error instanceof TransactionUncertain ? error : new Error('wallet result rejected'),
          );
          complete(400);
          send(400, '{}');
        }
        return;
      }
      if (req.method !== 'GET') return void send(405, '{}');
      if (path === '/app.js') return void send(200, asset, 'text/javascript');
      if (path === '/' || path === '/callback')
        return void send(
          200,
          '<!doctype html><html><head><meta charset="utf-8"><title>Annon wallet approval</title><script src="/app.js" defer></script></head><body><h1>Annon wallet approval</h1><p id="pair"></p><pre id="action"></pre><button id="approve">Review in wallet</button><p id="status"></p></body></html>',
          'text/html; charset=utf-8',
        );
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
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
        const timer = setTimeout(() => {
          if (pending?.timer === timer) {
            pending = undefined;
            armIdle();
          }
          reject(new Error('action expired'));
        }, action.expiresAt - Date.now());
        pending = {
          action: JSON.parse(JSON.stringify(action)),
          busy: false,
          resolve: resolve as (v: unknown) => void,
          reject,
          verify: verify as (v: unknown) => Promise<void>,
          timer,
        };
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
