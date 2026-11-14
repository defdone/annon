/** Plain-text formatting for the approval page: amounts, times and byte strings. */

/** Any value as plain text. Objects become JSON, so nothing is ever interpreted as markup. */
export const text = (v: unknown): string =>
  typeof v === 'string'
    ? v
    : typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean'
      ? String(v)
      : v === undefined || v === null
        ? ''
        : JSON.stringify(v);
export const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Base units as a decimal string, e.g. `formatUnits('200000', 6)` is `0.2`. Non-integers stay as given. */
export function formatUnits(value: unknown, decimals: number): string {
  const raw = text(value);
  if (!/^[0-9]+$/.test(raw)) return raw;
  const digits = raw.replace(/^0+(?=.)/, '').padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

/** Minutes and seconds left, e.g. `1:05`; never negative. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A local date and time, e.g. `2026-11-14 14:02:11`. */
export function localTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** The request's own expiry, e.g. `1:45 left (until 14:02:11)` or `Expired`. */
export function expiryText(expiresAt: number, now: number): string {
  return now >= expiresAt
    ? 'Expired'
    : `${clock(expiresAt - now)} left (until ${localTime(expiresAt).slice(11)})`;
}

/** A unix time in seconds (string or number) as local time, or the raw value when not one. */
export const secondsTime = (v: unknown) => {
  const raw = text(v);
  return /^[0-9]{1,12}$/.test(raw) ? `${localTime(Number(raw) * 1000)} local time` : raw;
};

/** A 32-byte NEP-413 nonce as hex. Anything else is returned unchanged. */
export function nonceHex(nonce: unknown): unknown {
  return Array.isArray(nonce) &&
    nonce.length === 32 &&
    nonce.every((n) => Number.isInteger(n) && n >= 0 && n < 256)
    ? `0x${nonce.map((n: number) => n.toString(16).padStart(2, '0')).join('')}`
    : nonce;
}
