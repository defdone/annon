import { expect, it } from 'vitest';
import { startBrowserSession } from './browser-login.js';

it('delivers the next action in the accepted response and ends it cleanly on close', async () => {
  const session = await startBrowserSession({ noOpen: true, asset: '', notify() {} });
  const url = new URL(session.url);
  const headers = {
    origin: url.origin,
    authorization: `Bearer ${url.hash.slice(1)}`,
    'content-type': 'application/json',
  };
  const action = (id: string) => ({ id, expiresAt: Date.now() + 10000 });
  try {
    const first = session.request(action('first'), async () => {});
    const response = await fetch(new URL('/api/result', url), {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'first', result: {}, follow: true }),
    });
    expect(response.status).toBe(200);
    await first;
    const second = session.request(action('second'), async () => {});
    expect(await response.json()).toMatchObject({ action: { id: 'second' } });
    const final = await fetch(new URL('/api/result', url), {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'second', result: {}, follow: true }),
    });
    await second;
    await session.close();
    expect(await final.json()).toEqual({ action: null });
  } finally {
    await session.close();
  }
});

it.each(['missing bearer', 'bad bearer', 'origin', 'host'])(
  'refuses follow with %s without consuming the request',
  async (bad) => {
    const session = await startBrowserSession({ noOpen: true, asset: '', notify() {} });
    const url = new URL(session.url);
    const headers: Record<string, string> = {
      origin: url.origin,
      authorization: `Bearer ${url.hash.slice(1)}`,
      'content-type': 'application/json',
    };
    const action = { id: 'secure', expiresAt: Date.now() + 10000 };
    let verified = 0;
    const pending = session.request(action, async () => {
      verified++;
    });
    try {
      const invalid = { ...headers };
      if (bad === 'missing bearer') delete invalid.authorization;
      if (bad === 'bad bearer') invalid.authorization = 'Bearer wrong';
      if (bad === 'origin') invalid.origin = 'https://evil.example';
      const body = JSON.stringify({ id: action.id, result: {}, follow: true });
      if (bad === 'host') {
        const { connect } = await import('node:net');
        const raw = await new Promise<string>((resolve, reject) => {
          const socket = connect(Number(url.port), '127.0.0.1', () => {
            socket.write(
              `POST /api/result HTTP/1.1\r\nHost: evil.example\r\nOrigin: ${url.origin}\r\nAuthorization: ${headers.authorization}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
            );
          });
          let text = '';
          socket.on('data', (data) => {
            text += data;
          });
          socket.on('end', () => resolve(text));
          socket.on('error', reject);
        });
        expect(raw).toContain('403');
        expect(raw).not.toContain('"action"');
      } else {
        const response = await fetch(new URL('/api/result', url), {
          method: 'POST',
          headers: invalid,
          body,
        });
        expect(response.status).toBe(403);
        expect(await response.text()).not.toContain('"action"');
      }
      expect(verified).toBe(0);
      const good = await fetch(new URL('/api/result', url), { method: 'POST', headers, body });
      expect(good.status).toBe(200);
      await pending;
      const next = session
        .request({ id: 'next', expiresAt: Date.now() + 10000 }, async () => {})
        .catch(() => {});
      expect(await good.json()).toMatchObject({ action: { id: 'next' } });
      await session.close();
      await next;
    } finally {
      await session.close();
    }
  },
);

it('closes half-sent requests and a never-resolving verify while flushing followers', async () => {
  const { connect } = await import('node:net');
  const session = await startBrowserSession({ noOpen: true, asset: '', notify() {} });
  const url = new URL(session.url);
  const headers = {
    origin: url.origin,
    authorization: `Bearer ${url.hash.slice(1)}`,
    'content-type': 'application/json',
  };
  const first = session.request({ id: 'first', expiresAt: Date.now() + 10000 }, async () => {});
  const follower = await fetch(new URL('/api/result', url), {
    method: 'POST',
    headers,
    body: JSON.stringify({ id: 'first', result: {}, follow: true }),
  });
  await first;
  // Keep this follower open while a second result is being verified.
  // A separate session provides the concurrent hung verification.
  const hanging = await startBrowserSession({ noOpen: true, asset: '', notify() {} });
  const hu = new URL(hanging.url);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = hanging
    .request({ id: 'hang', expiresAt: Date.now() + 10000 }, async () => {
      entered();
      await new Promise(() => {});
    })
    .catch(() => {});
  const result = fetch(new URL('/api/result', hu), {
    method: 'POST',
    headers: { ...headers, origin: hu.origin, authorization: `Bearer ${hu.hash.slice(1)}` },
    body: JSON.stringify({ id: 'hang', result: {}, follow: true }),
  }).catch(() => {});
  const socket = connect(Number(url.port), '127.0.0.1');
  try {
    await new Promise<void>((resolve) =>
      socket.once('connect', () => {
        socket.write(`GET / HTTP/1.1\r\nHost: ${url.host}\r\n`);
        resolve();
      }),
    );
    await started;
    const start = Date.now();
    await Promise.all([session.close(), hanging.close()]);
    expect(Date.now() - start).toBeLessThan(1500);
    expect(await follower.json()).toEqual({ action: null });
    await pending;
    await result;
  } finally {
    socket.destroy();
    await Promise.all([session.close(), hanging.close()]);
  }
}, 3000);
