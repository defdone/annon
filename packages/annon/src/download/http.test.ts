import { describe, expect, it } from 'vitest';
import type { SellerRecord } from '../pay/settle.js';
import { memoryStore } from '../pay/store.js';
import {
  corsHeaders,
  corsPolicy,
  DEFAULT_ORIGINS,
  type HttpHostOptions,
  handle,
  preflight,
} from './http.js';

describe('one-model HTTP transport without sockets', () => {
  const options: HttpHostOptions = {
    allowedOrigins: ['https://buyer.example'],
    headerHash: `0x${'11'.repeat(32)}`,
    file: {
      size: 0,
      read: () =>
        new ReadableStream({
          start(c) {
            c.close();
          },
        }),
    },
    nearRpc: 'https://near.rpc',
    baseRpc: 'https://base.rpc',
    contractId: 'annon.near',
    fileId: `0x${'22'.repeat(32)}`,
    url: 'https://files.example/f',
    header: 'https://files.example/header',
    store: memoryStore<SellerRecord>(),
    facilitator: async () => ({ success: false }),
  };
  it('allows grant proofs and Range with no credentials or retired wallet/session headers', async () => {
    const r = await handle('OPTIONS', new Headers({ Origin: 'https://buyer.example' }), options);
    expect(r.status).toBe(204);
    expect(r.headers['Access-Control-Allow-Headers']).toBe(
      'Content-Type, PAYMENT-SIGNATURE, Annon-Buyer-Proof, Range, Annon-Upload-Authorization',
    );
    expect(r.headers['Access-Control-Expose-Headers']).toBe(
      'PAYMENT-REQUIRED, PAYMENT-RESPONSE, Retry-After, Accept-Ranges, Content-Range, Content-Length, Content-Disposition',
    );
    expect(r.headers['Access-Control-Allow-Credentials']).toBeUndefined();
    expect(r.headers['Cache-Control']).toBe('no-store');
  });
  it('keeps the library origin allow-list empty unless configured', async () => {
    const defaults = { ...options };
    delete defaults.allowedOrigins;
    const r = await handle('OPTIONS', new Headers({ Origin: 'https://annon.dev' }), defaults);
    expect(r.status).toBe(403);
    expect(r.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });
  it('restricts CORS to configured origins and only serves GET/OPTIONS', async () => {
    expect(corsHeaders('https://other.example', ['https://buyer.example'])).toEqual({
      Vary: 'Origin',
    });
    const r = await handle('POST', new Headers({ 'Content-Type': 'application/json' }), options);
    expect(r.status).toBe(405);
    expect(r.headers.Allow).toBe('GET, OPTIONS');
  });
});

it('validates exact origins, configured previews and requested preflight headers', async () => {
  const { corsPolicy, preflight } = await import('./http.js');
  const policy = corsPolicy(DEFAULT_ORIGINS, ['https://verified-build.vercel.app']);
  for (const origin of [
    'https://annon.dev',
    'https://www.annon.dev',
    'https://verified-build.vercel.app',
  ]) {
    const r = preflight(
      new Headers({
        Origin: origin,
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Range, Annon-Buyer-Proof',
      }),
      policy,
    );
    expect(r.status).toBe(204);
    expect(r.headers['Access-Control-Allow-Origin']).toBe(origin);
  }
  for (const origin of [
    'https://annon.dev/',
    'http://annon.dev',
    'https://evilannon.dev',
    'https://annon.dev.evil.com',
    'https://unverified.vercel.app',
    'null',
  ]) {
    const r = preflight(
      new Headers({ Origin: origin, 'Access-Control-Request-Method': 'GET' }),
      policy,
    );
    expect(r.status).toBe(403);
    expect(r.headers['Access-Control-Allow-Origin']).toBeUndefined();
  }
  expect(
    preflight(
      new Headers({ Origin: 'https://annon.dev', 'Access-Control-Request-Method': 'DELETE' }),
      policy,
    ).status,
  ).toBe(403);
  expect(
    preflight(
      new Headers({
        Origin: 'https://annon.dev',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'Authorization',
      }),
      policy,
    ).status,
  ).toBe(403);
  expect(() => corsPolicy(['https://annon.dev/'])).toThrow();
  expect(() => corsPolicy(undefined, ['https://a.b.vercel.app'])).toThrow();
});

it('requires JSON content type on POST and PUT before reading any request', async () => {
  for (const method of ['POST', 'PUT']) {
    const r = await handle(
      method,
      new Headers({ 'Content-Type': 'text/plain' }),
      {} as HttpHostOptions,
    );
    expect(r.status).toBe(415);
  }
});

it('defaults the shared policy and preflight to no allowed origins', () => {
  expect(corsPolicy().origins).toEqual([]);
  expect(corsHeaders('https://annon.dev')).toEqual({ Vary: 'Origin' });
  expect(corsHeaders('https://annon.dev', DEFAULT_ORIGINS)).toMatchObject({
    'Access-Control-Allow-Origin': 'https://annon.dev',
  });
  expect(
    preflight(new Headers({ Origin: 'https://annon.dev', 'Access-Control-Request-Method': 'POST' }))
      .status,
  ).toBe(403);
});
