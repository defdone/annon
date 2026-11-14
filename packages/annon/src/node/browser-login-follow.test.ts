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
