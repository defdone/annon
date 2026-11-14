/** Canonical proxy/socket client buckets shared by the services. IPv6 uses /48. */
function canonical(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length > 64 ||
    value !== value.trim() ||
    /[%\s,[\]]/.test(value)
  )
    return;
  if (!value.includes(':')) {
    const parts = value.split('.');
    if (parts.length === 4 && parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255))
      return parts.join('.');
    return;
  }
  try {
    const host = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    const [head = '', tail = ''] = host.split('::');
    const a = head ? head.split(':') : [];
    const b = tail ? tail.split(':') : [];
    const words = host.includes('::')
      ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b]
      : a;
    if (words.length !== 8) return;
    const n = words.map((w) => Number.parseInt(w, 16));
    if (n.slice(0, 5).every((w) => w === 0) && n[5] === 65535) {
      const hi = n[6] as number;
      const lo = n[7] as number;
      return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
    }
    return `${n
      .slice(0, 3)
      .map((w) => w.toString(16))
      .join(':')}::/48`;
  } catch {
    return;
  }
}

export function clientKey(
  header: string | string[] | undefined,
  socket: string | undefined,
): string {
  return canonical(header) ?? canonical(socket) ?? 'unknown';
}

/** Bounded fixed windows; overflow shares a bucket instead of bypassing admission. */
export function fixedWindowLimiter(
  limit: number,
  windowMs = 60_000,
  now = () => Date.now(),
  maxKeys = 50_000,
) {
  let window = -1;
  let hits = new Map<string, number>();
  return (key: string): { allowed: boolean; retryAfterSeconds: number } => {
    const t = now();
    const w = Math.floor(t / windowMs);
    if (w !== window) {
      window = w;
      hits = new Map();
    }
    const k = hits.has(key) || hits.size < maxKeys ? key : '*';
    const n = (hits.get(k) ?? 0) + 1;
    hits.set(k, n);
    return { allowed: n <= limit, retryAfterSeconds: Math.ceil(((w + 1) * windowMs - t) / 1000) };
  };
}

export function limiter(perMinute: number, now = () => Date.now(), maxKeys = 50_000) {
  const check = fixedWindowLimiter(perMinute, 60_000, now, maxKeys);
  return (key: string) => check(key).allowed;
}
