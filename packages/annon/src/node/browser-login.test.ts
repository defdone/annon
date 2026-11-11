import { request } from 'node:http';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { TransactionUncertain } from '../wallet/uncertain.js';
import { startBrowserSession } from './browser-login.js';

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
