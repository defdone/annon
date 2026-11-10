/**
 * `serveFile` over HTTP: the browser rules of profile section 9, for Node's `http` server or any
 * framework that can hand over a method, headers and a response writer. CORS only for origins the
 * host lists; the session travels in `Authorization`, so no credentialed CORS is ever needed.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { type FileHostOptions, type HostResponse, serveFile } from './host.js';

const ALLOW_HEADERS =
  'PAYMENT-SIGNATURE, Annon-Buyer-Proof, SIGN-IN-WITH-X, Authorization, Range, Content-Type';
const EXPOSE_HEADERS =
  'PAYMENT-REQUIRED, PAYMENT-RESPONSE, Annon-Session, Retry-After, Content-Range, Content-Length';

/**
 * The CORS headers for a request from `origin`: `Vary: Origin` always, the rest only for an origin
 * the host serves.
 */
export function corsHeaders(
  origin: string | null | undefined,
  allowed: readonly string[],
): Record<string, string> {
  if (!origin || !allowed.includes(origin)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': EXPOSE_HEADERS,
    Vary: 'Origin',
  };
}

export interface HttpHostOptions extends FileHostOptions {
  /** Page origins that may call the file URL from a browser, e.g. `https://market.example`. */
  allowedOrigins?: readonly string[];
}

/** One request: the preflight answered without payment, anything else through `serveFile`. */
export async function handle(
  method: string,
  headers: { get(name: string): string | null },
  o: HttpHostOptions,
): Promise<HostResponse> {
  // No answer of the file URL is cached (profile section 9), the preflight and errors included.
  const cors: Record<string, string> = {
    'Cache-Control': 'no-store',
    ...corsHeaders(headers.get('Origin'), o.allowedOrigins ?? []),
  };
  if (method === 'OPTIONS') {
    return {
      status: 204,
      headers: {
        ...cors,
        ...(cors['Access-Control-Allow-Origin']
          ? {
              'Access-Control-Allow-Methods': 'GET',
              'Access-Control-Allow-Headers': ALLOW_HEADERS,
              'Access-Control-Max-Age': '600',
            }
          : {}),
      },
    };
  }
  if (method !== 'GET') return { status: 405, headers: { ...cors, Allow: 'GET, OPTIONS' } };
  const r = await serveFile({ headers }, o);
  return { ...r, headers: { ...cors, ...r.headers } };
}

/** A Node `http` request handler for the file URL. */
export function nodeHandler(o: HttpHostOptions) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const get = (name: string) => {
      const v = req.headers[name.toLowerCase()];
      return v === undefined ? null : Array.isArray(v) ? v.join(', ') : v;
    };
    let r: HostResponse;
    try {
      r = await handle(req.method ?? 'GET', { get }, o);
    } catch {
      r = {
        status: 500,
        headers: {
          'Cache-Control': 'no-store',
          ...corsHeaders(get('Origin'), o.allowedOrigins ?? []),
        },
      };
    }
    // Lists set earlier (by middleware) are merged, never replaced (profile section 9).
    for (const name of ['Access-Control-Expose-Headers', 'Vary']) {
      const before = res.getHeader(name);
      if (before === undefined || r.headers[name] === undefined) continue;
      const all = [String(before), r.headers[name]]
        .join(',')
        .split(',')
        .map((v) => v.trim());
      r.headers[name] = [
        ...new Map(all.filter(Boolean).map((v) => [v.toLowerCase(), v])).values(),
      ].join(', ');
    }
    res.writeHead(r.status, r.headers);
    if (!r.body) return void res.end();
    // pipeline waits for the socket, cancels the file when the client goes, and on a read error
    // destroys the response, so the client sees a cut file, never a whole one.
    await pipeline(Readable.fromWeb(r.body as NodeReadableStream<Uint8Array>), res).catch(() => {});
  };
}
