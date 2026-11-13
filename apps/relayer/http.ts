/** Private service adapters until the shared network helpers are integrated. */
import { isIP } from 'node:net';
import { corsHeaders } from '../../packages/annon/src/download/http.ts';

const valid = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 45 && !v.includes('%') && isIP(v) !== 0;
export const clientAddress = (header: unknown, socket: string): string =>
  valid(header) ? header : valid(socket) ? socket : 'unknown';
export function clientBucket(header: unknown, socket: string): string {
  const ip = clientAddress(header, socket);
  if (isIP(ip) !== 6) return ip;
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const [left = '', right] = canonical.split('::');
  const a = left ? left.split(':') : [],
    b = right ? right.split(':') : [];
  const words = right === undefined ? a : [...a, ...Array(8 - a.length - b.length).fill('0'), ...b];
  if (words.slice(0, 5).every((w) => Number.parseInt(w, 16) === 0) && words[5] === 'ffff') {
    const n = Number.parseInt(words[6] ?? '0', 16) * 65536 + Number.parseInt(words[7] ?? '0', 16);
    return [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join('.');
  }
  return `${words
    .slice(0, 3)
    .map((w) => Number.parseInt(w, 16).toString(16))
    .join(':')}::/48`;
}
export interface CorsSettings {
  allow?: string[];
  previews?: string[];
  maxAgeSeconds?: number;
}
export function cors(
  origin: string | undefined,
  settings: CorsSettings = {},
  preflight?: { method: string; headers: string },
): { status?: number; headers: Record<string, string> } {
  const allow = settings.allow ?? ['https://annon.dev', 'https://www.annon.dev'];
  const previews = settings.previews ?? [];
  for (const [list, preview] of [
    [allow, false],
    [previews, true],
  ] as const)
    for (const value of list) {
      const u = new URL(value);
      if (
        u.protocol !== 'https:' ||
        u.origin !== value ||
        u.username ||
        u.password ||
        (preview && (u.port || !/^[a-z0-9-]+\.vercel\.app$/.test(u.hostname)))
      )
        throw new Error('Invalid CORS origin.');
    }
  const headers: Record<string, string> = {
    ...corsHeaders(origin, [...allow, ...previews]),
    Vary: preflight
      ? 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers'
      : 'Origin',
  };
  const accepted = headers['Access-Control-Allow-Origin'] === origin && origin !== undefined;
  if (
    preflight &&
    (!accepted ||
      !['GET', 'POST', 'OPTIONS'].includes(preflight.method) ||
      preflight.headers
        .split(',')
        .some((h) => h.trim() && h.trim().toLowerCase() !== 'content-type'))
  )
    return { status: 403, headers: { Vary: headers.Vary ?? 'Origin' } };
  if (accepted) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Expose-Headers'] = 'Retry-After';
  }
  if (preflight) {
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers['Access-Control-Max-Age'] = String(settings.maxAgeSeconds ?? 600);
    return { status: 204, headers };
  }
  return { headers };
}
