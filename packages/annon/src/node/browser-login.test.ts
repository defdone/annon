import { execFile } from 'node:child_process';
import { request } from 'node:http';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { TransactionUncertain } from '../wallet/uncertain.js';
import { startBrowserSession } from './browser-login.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const send = (url: string, path: string, headers: Record<string, string>, body?: unknown) =>
  new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
    (resolve, reject) => {
      const r = request(
        new URL(path, url),
        { method: body === undefined ? 'GET' : 'POST', headers },
        (res) => {
          let text = '';
          res.on('data', (c) => {
            text += c;
          });
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }),
          );
        },
      );
      r.on('error', reject);
      r.end(body === undefined ? undefined : JSON.stringify(body));
    },
  );
describe('browser capability session', () => {
  it('binds before opening, checks exact Host/Origin/capability, serves strict headers, consumes once', async () => {
    const open = vi.fn();
    const s = await startBrowserSession({
      noOpen: true,
      open,
      asset: '/* bundled */',
      timeoutMs: 10000,
    });
    try {
      expect(open).not.toHaveBeenCalled();
      const u = new URL(s.url);
      const token = u.hash.slice(1);
      const headers = { host: u.host, origin: u.origin, authorization: `Bearer ${token}` };
      expect((await send(s.url, '/api/action', { ...headers, host: 'localhost' })).status).toBe(
        403,
      );
      expect(
        (await send(s.url, '/api/action', { ...headers, origin: 'https://evil.example' })).status,
      ).toBe(403);
      expect((await send(s.url, '/api/action', { ...headers, authorization: '' })).status).toBe(
        403,
      );
      const page = await send(s.url, '/', { host: u.host });
      expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.headers['access-control-allow-origin']).toBeUndefined();
      const verify = vi.fn(async () => {});
      const pending = s.request(
        {
          id: 'action',
          expiresAt: Date.now() + 10000,
          exact: { amount: '1', file: 'f', recipients: ['a'], chain: 'base' },
        },
        verify,
      );
      expect(JSON.parse((await send(s.url, '/api/action', headers)).body).pairingCode).toBe(
        s.pairingCode,
      );
      expect(
        (await send(s.url, '/api/result', headers, { id: 'action', result: { signature: 'test' } }))
          .status,
      ).toBe(200);
      await pending;
      expect((await send(s.url, '/api/result', headers, { id: 'action', result: {} })).status).toBe(
        409,
      );
      expect(verify).toHaveBeenCalledTimes(1);
    } finally {
      await s.close();
    }
  });
  it('rejects forged results and expires requests', async () => {
    const s = await startBrowserSession({ noOpen: true, open: vi.fn(), asset: '', timeoutMs: 50 });
    const p = s.request({ id: 'x', expiresAt: Date.now() + 20 }, async () => {
      throw new Error('forged');
    });
    await expect(p).rejects.toThrow(/expired|closed/);
    await s.close();
  });
});

it.each([false, true])(
  'an expired verifier cannot clear a newer action (reject=%s)',
  async (reject) => {
    const s = await startBrowserSession({
      noOpen: true,
      open: vi.fn(),
      asset: '',
      timeoutMs: 10000,
    });
    const u = new URL(s.url),
      headers = { host: u.host, origin: u.origin, authorization: `Bearer ${u.hash.slice(1)}` };
    let finish: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      const old = s.request({ id: 'old', expiresAt: Date.now() + 80 }, async () => {
        await gate;
        if (reject) throw new Error('bad');
      });
      const expired = expect(old).rejects.toThrow('expired');
      const response = send(s.url, '/api/result', headers, { id: 'old', result: {} });
      await expired;
      const next = s.request({ id: 'new', expiresAt: Date.now() + 5000 }, async () => {});
      const done = expect(next).resolves.toEqual({});
      finish();
      await response;
      expect(JSON.parse((await send(s.url, '/api/action', headers)).body).action?.id).toBe('new');
      await send(s.url, '/api/result', headers, { id: 'new', result: {} });
      await done;
    } finally {
      finish();
      await s.close();
    }
  },
);

it('keeps an active session alive beyond its idle deadline and resets idle time after approval', async () => {
  const s = await startBrowserSession({ noOpen: true, open: vi.fn(), asset: '', timeoutMs: 50 });
  const u = new URL(s.url),
    headers = { host: u.host, origin: u.origin, authorization: `Bearer ${u.hash.slice(1)}` };
  try {
    const p = s.request({ id: 'long', expiresAt: Date.now() + 5000 }, async () => {});
    const done = expect(p).resolves.toEqual({});
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect((await send(s.url, '/api/result', headers, { id: 'long', result: {} })).status).toBe(
      200,
    );
    await done;
  } finally {
    await s.close();
  }
});

it('retains known transaction evidence when browser submission cannot be verified at finality', async () => {
  const s = await startBrowserSession({ open: vi.fn(), asset: '' });
  const u = new URL(s.url);
  const headers = { host: u.host, origin: u.origin, authorization: `Bearer ${u.hash.slice(1)}` };
  try {
    const pending = s.request({ id: 'payment', expiresAt: Date.now() + 10000 }, async () => {
      throw new TransactionUncertain('FAKE-HASH');
    });
    const evidence = expect(pending).rejects.toMatchObject({
      code: 'transaction_uncertain',
      txHash: 'FAKE-HASH',
    });
    expect(
      (
        await send(s.url, '/api/result', headers, {
          id: 'payment',
          result: { txHash: 'FAKE-HASH' },
        })
      ).status,
    ).toBe(400);
    await evidence;
  } finally {
    await s.close();
  }
});

it('serves exactly the intended CSP and offers only connectable NEAR wallets', async () => {
  const s = await startBrowserSession({ open: vi.fn() });
  try {
    const u = new URL(s.url);
    const page = await send(s.url, '/', { host: u.host });
    const script = await send(s.url, '/app.js', { host: u.host });
    const parse = (header: unknown) =>
      Object.fromEntries(
        String(header ?? '')
          .split(';')
          .map((d) => d.trim().split(/\s+/))
          .filter(([name]) => name)
          .map(([name, ...sources]) => [name, sources.sort()]),
      );
    const intended = {
      'default-src': ["'none'"],
      'script-src': ["'self'"],
      'connect-src': [
        "'self'",
        'https://free.rpc.fastnear.com',
        'https://h4n.app',
        'https://test.rpc.fastnear.com',
      ],
      'frame-src': ['https://hot-labs.org'],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      'frame-ancestors': ["'none'"],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
    };
    expect(parse(page.headers['content-security-policy'])).toEqual(intended);
    expect(parse(script.headers['content-security-policy'])).toEqual(intended);
    expect([...page.body.matchAll(/<option\b[^>]*value="([^"]+)"/g)].map((m) => m[1])).toEqual([
      'meteor-wallet',
      'hot-wallet',
    ]);
    expect(page.body).toContain('<option id="near-wallet-hot" value="hot-wallet">');
    expect(page.body).not.toMatch(/my-near-wallet|MyNearWallet/i);
  } finally {
    await s.close();
  }
});

it('serves the actual built bundle from source under a CSP with no dynamic code or inline scripts', async () => {
  const s = await startBrowserSession({ open: vi.fn() });
  try {
    const u = new URL(s.url);
    const headers = { host: u.host };
    const page = await send(s.url, '/', headers);
    const script = await send(s.url, '/app.js', headers);
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.headers['content-security-policy']).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(script.headers['content-security-policy']).toBe(page.headers['content-security-policy']);
    expect(page.body.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi)).toEqual([
      '<script src="/app.js" defer></script>',
    ]);
    expect(page.body).not.toMatch(/\son\w+\s*=/i);
    expect(script.status).toBe(200);
    expect(script.body.length).toBeGreaterThan(10000);
    const file = ts.createSourceFile(
      'bundle.js',
      script.body,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const forbidden: string[] = [];
    const inspect = (node: ts.Node) => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : '';
        if (['eval', 'Function'].includes(name)) forbidden.push(name);
        if (
          ['setTimeout', 'setInterval'].includes(name) &&
          node.arguments?.[0] &&
          (ts.isStringLiteral(node.arguments[0]) ||
            ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))
        )
          forbidden.push('string timer');
      }
      if (ts.isStringLiteral(node) && /<[^>]+\son\w+\s*=/i.test(node.text))
        forbidden.push('inline event handler');
      ts.forEachChild(node, inspect);
    };
    inspect(file);
    expect(forbidden).toEqual([]);
  } finally {
    await s.close();
  }
});

it('opens only a capability-free URL and bootstraps the capability once to the same-origin page', async () => {
  const open = vi.fn();
  const s = await startBrowserSession({ asset: '', open });
  try {
    const u = new URL(s.url);
    expect(open).toHaveBeenCalledWith(`${u.origin}/`);
    const headers = { host: u.host, origin: u.origin };
    expect(
      (await send(s.url, '/api/bootstrap', { ...headers, origin: 'https://evil.example' }, {}))
        .status,
    ).toBe(403);
    const boot = await send(s.url, '/api/bootstrap', headers, {});
    expect(JSON.parse(boot.body)).toEqual({ capability: u.hash.slice(1) });
    expect((await send(s.url, '/api/bootstrap', headers, {})).status).toBe(404);
  } finally {
    await s.close();
  }
});

it('disables bootstrap in no-open mode even for a same-origin caller', async () => {
  const open = vi.fn();
  const s = await startBrowserSession({ noOpen: true, open, asset: '' });
  try {
    const u = new URL(s.url);
    const response = await send(s.url, '/api/bootstrap', { host: u.host, origin: u.origin }, {});
    expect(response.status).toBe(404);
    expect(response.body).not.toContain(u.hash.slice(1));
    expect(open).not.toHaveBeenCalled();
  } finally {
    await s.close();
  }
});

it.each([false, true])(
  'returns the first verified outcome for identical duplicate submissions (concurrent=%s)',
  async (concurrent) => {
    const s = await startBrowserSession({ noOpen: true, open: vi.fn(), asset: '' });
    const u = new URL(s.url);
    const headers = { host: u.host, origin: u.origin, authorization: `Bearer ${u.hash.slice(1)}` };
    let finish = () => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const verify = vi.fn(async () => {
      if (concurrent) await gate;
    });
    const body = { id: 'duplicate', result: { signature: 'verified', account: 'test' } };
    try {
      const pending = s.request({ id: body.id, expiresAt: Date.now() + 10000 }, verify);
      const first = send(s.url, '/api/result', headers, body);
      await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1));
      if (!concurrent) await first;
      const second = send(s.url, '/api/result', headers, {
        id: body.id,
        result: { account: 'test', signature: 'verified' },
      });
      // Keep verification blocked while both a duplicate and a conflicting result arrive.
      if (concurrent)
        expect(
          (
            await send(s.url, '/api/result', headers, {
              ...body,
              result: { signature: 'different' },
            })
          ).status,
        ).toBe(409);
      finish();
      const [a, b] = await Promise.all([first, second]);
      expect(a.status).toBe(200);
      expect(b).toMatchObject({ status: a.status, body: a.body });
      await expect(pending).resolves.toEqual(body.result);
      expect(verify).toHaveBeenCalledTimes(1);
      expect(
        (await send(s.url, '/api/result', headers, { ...body, result: { signature: 'different' } }))
          .status,
      ).toBe(409);
    } finally {
      finish();
      await s.close();
    }
  },
);

it('gives the browser opener only desktop routing variables', async () => {
  const { browserOpenerEnv } = await import('./browser-login.js');
  expect(
    browserOpenerEnv({
      PATH: '/bin',
      HOME: '/fake',
      DISPLAY: ':1',
      BROWSER: 'fake-browser',
      XDG_CURRENT_DESKTOP: 'test-desktop',
      DESKTOP_SESSION: 'test-session',
      LANG: 'C',
      ANNON_BACKUP_SECRET: 'secret',
      ANNON_EVM_PRIVATE_KEY: 'key',
      PRIVATE_KEY: 'key',
      AWS_SECRET_ACCESS_KEY: 'secret',
    }),
  ).toEqual({
    PATH: '/bin',
    HOME: '/fake',
    DISPLAY: ':1',
    BROWSER: 'fake-browser',
    XDG_CURRENT_DESKTOP: 'test-desktop',
    DESKTOP_SESSION: 'test-session',
    LANG: 'C',
  });
});

it('passes the minimal environment to the mocked opener without launching a GUI', async () => {
  vi.stubEnv('ANNON_BACKUP_SECRET', 'fake-secret');
  vi.stubEnv('PRIVATE_KEY', 'fake-key');
  const session = await startBrowserSession({});
  try {
    expect(execFile).toHaveBeenCalledWith(
      expect.any(String),
      [expect.stringMatching(/^http:\/\/127\.0\.0\.1:/)],
      { env: expect.any(Object) },
      expect.any(Function),
    );
    const env = vi.mocked(execFile).mock.calls.at(-1)?.[2] as { env: NodeJS.ProcessEnv };
    expect(env.env).not.toHaveProperty('ANNON_BACKUP_SECRET');
    expect(env.env).not.toHaveProperty('PRIVATE_KEY');
  } finally {
    await session.close();
    vi.unstubAllEnvs();
  }
});

describe('browser approval progress and page reports', () => {
  const session = async (timeoutMs = 10000) => {
    const notify = vi.fn();
    const s = await startBrowserSession({
      noOpen: true,
      open: vi.fn(),
      asset: '',
      timeoutMs,
      notify,
    });
    const u = new URL(s.url);
    const headers = { host: u.host, origin: u.origin, authorization: `Bearer ${u.hash.slice(1)}` };
    return { s, notify, headers };
  };

  it('prints a waiting line with the expiry, the reported failure and the approval on stderr lines', async () => {
    const { s, notify, headers } = await session();
    try {
      const pending = s.request({ id: 'a', expiresAt: Date.now() + 120000 }, async () => {});
      expect(notify).toHaveBeenLastCalledWith(
        expect.stringMatching(/^Waiting for approval in the browser\. Expires in (2:00|1:59)\.$/),
      );
      expect(
        (await send(s.url, '/api/report', headers, { id: 'a', reason: 'window_closed' })).status,
      ).toBe(200);
      // The same reason twice prints once.
      await send(s.url, '/api/report', headers, { id: 'a', reason: 'window_closed' });
      expect(notify.mock.calls.filter(([l]) => /window closed/.test(l))).toHaveLength(1);
      expect(notify).toHaveBeenLastCalledWith(
        expect.stringMatching(
          /^The wallet window closed before signing\. You can try again on the page for \d:\d\d\.$/,
        ),
      );
      expect((await send(s.url, '/api/result', headers, { id: 'a', result: {} })).status).toBe(200);
      await pending;
      expect(notify).toHaveBeenLastCalledWith('Approved in the browser.');
    } finally {
      await s.close();
    }
  });

  it('accepts reports only with the capability, for the current request, with a fixed reason', async () => {
    const { s, notify, headers } = await session();
    try {
      const pending = s.request({ id: 'a', expiresAt: Date.now() + 5000 }, async () => {});
      const before = notify.mock.calls.length;
      const report = (h: Record<string, string>, body: unknown) =>
        send(s.url, '/api/report', h, body).then((r) => r.status);
      expect(
        await report({ ...headers, authorization: '' }, { id: 'a', reason: 'cancelled' }),
      ).toBe(403);
      expect(
        await report(
          { ...headers, origin: 'https://evil.example' },
          { id: 'a', reason: 'cancelled' },
        ),
      ).toBe(403);
      expect(
        await report({ ...headers, host: 'localhost' }, { id: 'a', reason: 'cancelled' }),
      ).toBe(403);
      expect(await report(headers, { id: 'other', reason: 'cancelled' })).toBe(409);
      expect(await report(headers, { id: 'a', reason: '\u001b[2Jpwned' })).toBe(409);
      expect(await report(headers, { id: 'a', reason: 'toString' })).toBe(409);
      expect(notify.mock.calls.length).toBe(before);
      // A report never completes a request: the action is still pending and unconsumed.
      expect(await report(headers, { id: 'a', reason: 'rejected' })).toBe(200);
      expect(JSON.parse((await send(s.url, '/api/action', headers)).body).action?.id).toBe('a');
      expect((await send(s.url, '/api/result', headers, { id: 'a', result: {} })).status).toBe(200);
      await expect(pending).resolves.toEqual({});
    } finally {
      await s.close();
    }
  });

  it('a cancel from the page ends the request with a clear error; a consumed request cannot be cancelled', async () => {
    const { s, headers } = await session();
    try {
      const cancelled = expect(
        s.request({ id: 'a', expiresAt: Date.now() + 5000 }, async () => {}),
      ).rejects.toMatchObject({
        code: 'cancelled',
        message: 'You cancelled the approval in the browser.',
      });
      expect(
        (await send(s.url, '/api/report', headers, { id: 'a', reason: 'cancelled' })).status,
      ).toBe(200);
      await cancelled;
      expect((await send(s.url, '/api/result', headers, { id: 'a', result: {} })).status).toBe(409);
      let finish: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const verifying = s.request({ id: 'b', expiresAt: Date.now() + 5000 }, () => gate);
      const result = send(s.url, '/api/result', headers, { id: 'b', result: {} });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        (await send(s.url, '/api/report', headers, { id: 'b', reason: 'cancelled' })).status,
      ).toBe(409);
      finish();
      expect((await result).status).toBe(200);
      await expect(verifying).resolves.toEqual({});
    } finally {
      await s.close();
    }
  });

  it('an expired request names the last reported wallet failure instead of a generic error', async () => {
    const { s, headers } = await session();
    try {
      const plain = s.request({ id: 'a', expiresAt: Date.now() + 100 }, async () => {});
      await expect(plain).rejects.toMatchObject({
        code: 'cancelled',
        message: 'The browser approval expired before the wallet signed. Run the command again.',
      });
      const outcome = (p: Promise<unknown>) =>
        p.then(
          () => undefined,
          (e: unknown) => e,
        );
      const closed = outcome(s.request({ id: 'b', expiresAt: Date.now() + 300 }, async () => {}));
      await send(s.url, '/api/report', headers, { id: 'b', reason: 'popup_blocked' });
      expect(await closed).toMatchObject({
        code: 'wallet_error',
        message: expect.stringContaining('blocked the wallet window'),
      });
      const { toPublicError } = await import('../errors.js');
      const declined = outcome(s.request({ id: 'c', expiresAt: Date.now() + 300 }, async () => {}));
      await send(s.url, '/api/report', headers, { id: 'c', reason: 'rejected' });
      const error = await declined;
      expect(toPublicError(error)).toEqual({
        code: 'rejected',
        message:
          'The wallet declined the request. The browser approval then expired. Run the command again.',
        exitCode: 3,
      });
    } finally {
      await s.close();
    }
  });

  it('serves the stylesheet from its own origin under the same CSP, and the page has no inline style', async () => {
    const notify = vi.fn();
    const s = await startBrowserSession({ asset: '', open: vi.fn(), notify });
    try {
      const u = new URL(s.url);
      // Open mode prints the capability-free page URL as the fallback, never the capability.
      expect(notify).toHaveBeenCalledWith(
        `Opening your browser. If it does not open, visit ${u.origin}/`,
      );
      expect(notify.mock.calls.flat().join('\n')).not.toContain(u.hash.slice(1));
      const page = await send(s.url, '/', { host: u.host });
      const css = await send(s.url, '/app.css', { host: u.host });
      expect(css.status).toBe(200);
      expect(css.headers['content-type']).toBe('text/css; charset=utf-8');
      expect(css.headers['content-security-policy']).toBe(page.headers['content-security-policy']);
      expect(css.body).toContain('--paper:#FAF8F2');
      expect(css.body).not.toMatch(/@import|url\(|@font-face/);
      expect(page.body).toContain('<link rel="stylesheet" href="/app.css">');
      expect(page.body).not.toMatch(/<style\b|\sstyle=/i);
      expect(page.body.match(/\b(?:src|href)="([^"]+)"/g)).toEqual([
        'href="/app.css"',
        'src="/app.js"',
      ]);
    } finally {
      await s.close();
    }
  });
});
