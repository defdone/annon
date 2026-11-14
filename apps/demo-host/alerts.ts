import type { StartupReason } from './startup-errors.ts';

type HostAlertType =
  | 'host_file_invalid'
  | 'host_startup_failed'
  | 'facilitator_dropped'
  | 'facilitator_low_eth'
  | 'facilitator_stuck'
  | 'facilitator_revert'
  | 'facilitator_budget'
  | 'facilitator_busy'
  | 'facilitator_wait'
  | 'base_rpc_unhealthy'
  | 'relayer_unavailable'
  | 'disk'
  | 'inodes'
  | 'restart'
  | 'store_busy'
  | 'host_capacity';
interface HostAlert {
  type: HostAlertType;
  reason?: StartupReason;
  balance?: string;
  needed?: string;
  count?: number;
  seconds?: number;
  percent?: number;
  status?: number;
}
export type Alert = (value: HostAlert) => void | Promise<void>;
export function webhookUrl(value: string): string {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.hash) throw new Error();
    return u.href;
  } catch {
    throw new Error('DEMO_ALERT_WEBHOOK must be an HTTPS URL without user info or fragment');
  }
}
/** Slack delivery is bounded and contains only whitelisted numeric/status fields. */
export function hostAlerts(
  url: string,
  options: { fetcher?: typeof fetch; now?: () => number; intervalSeconds?: number } = {},
): (value: HostAlert) => Promise<void> {
  const endpoint = webhookUrl(url);
  const sent = new Map<string, number>();
  return async (value) => {
    const now = (options.now ?? Date.now)();
    if (now - (sent.get(value.type) ?? -Infinity) < (options.intervalSeconds ?? 60) * 1000) return;
    sent.set(value.type, now);
    const safe: Record<string, string | number> = { type: value.type };
    if (
      value.reason &&
      ['storage_uninitialized', 'state_missing', 'state_invalid', 'config_invalid'].includes(
        value.reason,
      )
    )
      safe.reason = value.reason;
    for (const field of ['balance', 'needed'] as const)
      if (typeof value[field] === 'string' && /^\d{1,80}$/.test(value[field]))
        safe[field] = value[field];
    for (const field of ['count', 'seconds', 'percent', 'status'] as const) {
      const n = value[field];
      if (Number.isSafeInteger(n) && (n ?? -1) >= 0) safe[field] = n as number;
    }
    try {
      const res = await (options.fetcher ?? fetch)(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `host: alert ${JSON.stringify(safe)}` }),
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
      });
      await res.body?.cancel();
    } catch {
      /* Delivery cannot change a payment result or disclose upstream diagnostics. */
    }
  };
}
export function emit(alert: Alert | undefined, value: HostAlert): void {
  try {
    void Promise.resolve(alert?.(value)).catch(() => {});
  } catch {
    /* Diagnostics are contained. */
  }
}
