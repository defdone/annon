/**
 * `serveFile` over HTTP: the browser rules of profile section 9, for Node's `http` server or any
 * framework that can hand over a method, headers and a response writer. CORS only for origins the
 * host lists; the grant proof travels in a header, so credentialed CORS is unnecessary.
 */
import { type FileHostOptions, type HostResponse, serveFile } from './host.js';

const ALLOW_HEADERS = 'PAYMENT-SIGNATURE, Annon-Buyer-Proof, Range, Content-Type';
const EXPOSE_HEADERS =
  'PAYMENT-REQUIRED, PAYMENT-RESPONSE, Retry-After, Content-Range, Content-Length';

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
