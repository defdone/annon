/** Retry-After in milliseconds, preserving the full server wait. Unknown values stay unknown. */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value?.trim()) return;
  const text = value.trim();
  if (/^\d+$/.test(text)) {
    const n = Number(text) * 1000;
    return Number.isSafeInteger(n) ? n : undefined;
  }
  if (!/^[A-Za-z]{3}, /.test(text)) return;
  const time = Date.parse(text);
  return Number.isFinite(time) ? Math.max(0, time - now) : undefined;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
