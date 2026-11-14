import { describe, expect, it, vi } from 'vitest';
import { purchaseRecord } from '../../test/commands.js';
import { send } from '../../test/login-http.js';
import { toPublicError } from '../errors.js';
import { TransactionUncertain } from '../wallet/uncertain.js';
import { startBrowserSession } from './browser-login.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

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

describe('a send the wallet may have broadcast', () => {
  const record = purchaseRecord();
  const payment = (id: string, expiresAt = Date.now() + 5000) => ({
    id,
    expiresAt,
    payload: {
      receiverId: record.purchase.asset,
      method: 'ft_transfer_call',
      args: {
        receiver_id: record.purchase.contract,
        amount: record.purchase.price,
        msg: record.message,
      },
      gas: '150000000000000',
      deposit: '1',
    },
  });
  const session = async () => {
    const notify = vi.fn();
    const s = await startBrowserSession({ noOpen: true, open: vi.fn(), asset: '', notify });
    const u = new URL(s.url);
    const headers = { host: u.host, origin: u.origin, authorization: `Bearer ${u.hash.slice(1)}` };
    const report = (id: string, reason: string, h: Record<string, string> = headers) =>
      send(s.url, '/api/report', h, { id, reason }).then((r) => r.status);
    const outcome = (p: Promise<unknown>) =>
      p.then(
        () => undefined,
        (e: unknown) => e,
      );
    return { s, notify, headers, report, outcome };
  };
  const line = `The wallet may have sent the transaction. Do not pay again. Run annon status ${record.id} to check it.`;

  it('send_uncertain ends the request as transaction_uncertain with the purchase id', async () => {
    const { s, notify, headers, report, outcome } = await session();
    try {
      const pending = outcome(s.request(payment('a'), async () => {}));
      expect(await report('a', 'send_uncertain', { ...headers, authorization: '' })).toBe(403);
      expect(await report('a', 'send_started')).toBe(200);
      expect(await report('a', 'send_uncertain')).toBe(200);
      const error = await pending;
      expect(error).toBeInstanceOf(TransactionUncertain);
      expect(error).toMatchObject({ code: 'transaction_uncertain', purchaseId: record.id });
      expect(toPublicError(error)).toMatchObject({ code: 'transaction_uncertain', exitCode: 4 });
      expect(toPublicError(error)).not.toHaveProperty('txHash');
      expect(notify).toHaveBeenLastCalledWith(line);
      // Nothing can complete or retry it afterwards.
      expect((await send(s.url, '/api/result', headers, { id: 'a', result: {} })).status).toBe(409);
    } finally {
      await s.close();
    }
  });

  it('after send_started, a cancel or the expiry ends as uncertain, never as cancelled', async () => {
    const { s, notify, report, outcome } = await session();
    try {
      const cancelled = outcome(s.request(payment('a'), async () => {}));
      await report('a', 'send_started');
      await report('a', 'cancelled');
      expect(await cancelled).toMatchObject({ code: 'transaction_uncertain' });
      const expired = outcome(s.request(payment('b', Date.now() + 300), async () => {}));
      await report('b', 'send_started');
      expect(await expired).toMatchObject({ code: 'transaction_uncertain', purchaseId: record.id });
      expect(notify.mock.calls.filter(([l]) => l === line)).toHaveLength(2);
      // Without a purchase message the warning gives the general wording.
      const storage = {
        id: 'c',
        expiresAt: Date.now() + 5000,
        payload: { method: 'storage_deposit' },
      };
      const plain = outcome(s.request(storage, async () => {}));
      await report('c', 'send_uncertain');
      expect(await plain).toMatchObject({ code: 'transaction_uncertain' });
      expect(notify).toHaveBeenLastCalledWith(
        'The wallet may have sent the transaction. Do not pay again. Check the transaction in your wallet before you run the command again.',
      );
    } finally {
      await s.close();
    }
  });

  it('accepts one send start per request and tells a reloaded page that a send started', async () => {
    const { s, headers, report, outcome } = await session();
    try {
      const pending = outcome(s.request(payment('a'), async () => {}));
      const action = async () =>
        JSON.parse((await send(s.url, '/api/action', headers)).body) as {
          sendStarted: boolean;
        };
      expect((await action()).sendStarted).toBe(false);
      expect(await report('a', 'send_started')).toBe(200);
      expect(await report('a', 'send_started')).toBe(409);
      expect((await action()).sendStarted).toBe(true);
      // The page that sent can still deliver the transaction hash it received.
      expect((await send(s.url, '/api/result', headers, { id: 'a', result: {} })).status).toBe(200);
      expect(await pending).toBeUndefined();
    } finally {
      await s.close();
    }
  });
});
