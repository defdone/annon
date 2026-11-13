/** Shared exact-origin CORS policy for the file host and relayer. */
import { type FileHostOptions, type HostResponse, serveFile } from './host.js';

export const DEFAULT_ORIGINS = ['https://annon.dev', 'https://www.annon.dev'] as const;
const HOST_HEADERS =
  'Content-Type, PAYMENT-SIGNATURE, Annon-Buyer-Proof, Range, Annon-Upload-Authorization';
const HOST_EXPOSE =
  'PAYMENT-REQUIRED, PAYMENT-RESPONSE, Retry-After, Accept-Ranges, Content-Range, Content-Length, Content-Disposition';
export interface CorsPolicy {
  origins: readonly string[];
  methods: string;
  headers: string;
  expose: string;
  maxAge: number;
}
function validOrigin(value: string, preview = false): boolean {
  try {
    const u = new URL(value);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      u.origin === value &&
      (!preview || (!u.port && /^[a-z0-9-]+\.vercel\.app$/.test(u.hostname)))
    );
  } catch {
    return false;
  }
}
export function corsPolicy(
  allowed: readonly string[] = [],
  previews: readonly string[] = [],
  service: 'host' | 'relayer' = 'host',
  maxAge = 600,
): CorsPolicy {
  if (!allowed.every((v) => validOrigin(v)) || !previews.every((v) => validOrigin(v, true)))
    throw new TypeError('invalid CORS origin');
  return {
    origins: [...new Set([...allowed, ...previews])],
    methods: service === 'host' ? 'GET, POST, PUT, OPTIONS' : 'GET, POST, OPTIONS',
    headers: service === 'host' ? HOST_HEADERS : 'Content-Type',
    expose: service === 'host' ? HOST_EXPOSE : 'Retry-After',
    maxAge,
  };
}
export function corsHeaders(
  origin: string | null | undefined,
  allowed: readonly string[] = [],
  expose = HOST_EXPOSE,
): Record<string, string> {
  if (!origin || !validOrigin(origin) || !allowed.includes(origin)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': expose,
    Vary: 'Origin',
  };
}
export function preflight(
  headers: { get(name: string): string | null },
  policy: CorsPolicy = corsPolicy(),
): HostResponse {
  const origin = headers.get('Origin');
  const method = headers.get('Access-Control-Request-Method');
  const requested = headers.get('Access-Control-Request-Headers');
  const allowedHeaders = policy.headers
    .toLowerCase()
    .split(',')
    .map((s) => s.trim());
  const base = {
    'Cache-Control': 'no-store',
    Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
  };
  if (
    !origin ||
    !validOrigin(origin) ||
    !policy.origins.includes(origin) ||
    (method !== null && !policy.methods.split(', ').includes(method)) ||
    (requested !== null &&
      !requested.split(',').every((s) => allowedHeaders.includes(s.trim().toLowerCase())))
  )
    return { status: 403, headers: base };
  return {
    status: 204,
    headers: {
      ...corsHeaders(origin, policy.origins, policy.expose),
      ...base,
      'Access-Control-Allow-Methods': policy.methods,
      'Access-Control-Allow-Headers': policy.headers,
      'Access-Control-Max-Age': String(policy.maxAge),
    },
  };
}
export function hasContentType(
  value: string | null | undefined,
  expected: 'application/json' | 'application/octet-stream',
): boolean {
  return value?.split(';')[0]?.trim().toLowerCase() === expected;
}
export interface HttpHostOptions extends FileHostOptions {
  allowedOrigins?: readonly string[];
  previewOrigins?: readonly string[];
}
export async function handle(
  method: string,
  headers: { get(name: string): string | null },
  o: HttpHostOptions,
): Promise<HostResponse> {
  const policy = corsPolicy(o.allowedOrigins ?? [], o.previewOrigins);
  const cors = {
    'Cache-Control': 'no-store',
    ...corsHeaders(headers.get('Origin'), policy.origins, policy.expose),
  };
  if (method === 'OPTIONS') return preflight(headers, policy);
  if (
    (method === 'POST' || method === 'PUT') &&
    !hasContentType(headers.get('Content-Type'), 'application/json')
  )
    return { status: 415, headers: cors };
  if (method !== 'GET') return { status: 405, headers: { ...cors, Allow: 'GET, OPTIONS' } };
  const r = await serveFile({ headers }, o);
  return { ...r, headers: { ...cors, ...r.headers } };
}
