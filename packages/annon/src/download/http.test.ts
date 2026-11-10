import { describe, expect, it } from 'vitest';
import type { SellerRecord } from '../pay/settle.js';
import { memoryStore } from '../pay/store.js';
import { corsHeaders, type HttpHostOptions, handle } from './http.js';

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
      'PAYMENT-SIGNATURE, Annon-Buyer-Proof, Range, Content-Type',
    );
    expect(r.headers['Access-Control-Expose-Headers']).toBe(
      'PAYMENT-REQUIRED, PAYMENT-RESPONSE, Retry-After, Content-Range, Content-Length',
    );
    expect(r.headers['Access-Control-Allow-Credentials']).toBeUndefined();
    expect(r.headers['Cache-Control']).toBe('no-store');
  });
  it('restricts CORS to configured origins and only serves GET/OPTIONS', async () => {
    expect(corsHeaders('https://other.example', ['https://buyer.example'])).toEqual({
      Vary: 'Origin',
    });
    const r = await handle('POST', new Headers(), options);
    expect(r.status).toBe(405);
    expect(r.headers.Allow).toBe('GET, OPTIONS');
  });
});
