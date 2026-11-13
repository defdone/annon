/** Persist transitions, whitelist numeric evidence, and contain monitoring failures. */
import { statfs } from 'node:fs/promises';
import type { Store, Versioned } from '@defdone/annon/pay/store';
export interface MonitorRecord extends Versioned {
  running: boolean;
  admissionsPaused?: boolean;
  alerts: Record<string, number>;
}
export interface ServiceAlert {
  type: string;
  count?: number;
  percent?: number;
  seconds?: number;
}
export interface MonitorSettings {
  poolPercent?: number;
  diskPercent?: number;
  stalledSeconds?: number;
  oldestSeconds?: number;
  refusals?: number;
  refusalWindowSeconds?: number;
  keeperBudgetPercent?: number;
  sampleSeconds?: number;
}
export class ServiceMonitor {
  private readonly store: Store<MonitorRecord>;
  private readonly deliver: (a: ServiceAlert) => void | Promise<void>;
  private readonly settings: MonitorSettings;
  private refusals: number[] = [];
  private lastAlerts = new Map<string, number>();
  private pending = new Map<string, Promise<void>>();
  constructor(
    store: Store<MonitorRecord>,
    deliver: (a: ServiceAlert) => void | Promise<void>,
    settings: MonitorSettings = {},
  ) {
    this.store = store;
    this.deliver = deliver;
    this.settings = settings;
  }
  private async update(fn: (r: MonitorRecord) => void) {
    for (;;) {
      const old = await this.store.load('monitor');
      const next: MonitorRecord = {
        id: 'monitor',
        revision: (old?.revision ?? -1) + 1,
        running: old?.running ?? false,
        ...(old?.admissionsPaused === undefined ? {} : { admissionsPaused: old.admissionsPaused }),
        alerts: { ...old?.alerts },
      };
      fn(next);
      if (await this.store.compareAndSet('monitor', old, next)) return;
    }
  }
  async admissions(paused: boolean) {
    let changed = false;
    await this.update((r) => {
      changed = r.admissionsPaused !== paused && (paused || r.admissionsPaused !== undefined);
      r.admissionsPaused = paused;
    });
    if (changed) await this.deliver({ type: paused ? 'admissions_paused' : 'admissions_resumed' });
  }
  async boot(now = Date.now()) {
    const old = await this.store.load('monitor');
    await this.update((r) => {
      r.running = true;
    });
    await this.failure(old?.running ? 'unclean_restart' : 'started', now);
  }
  async stop() {
    await Promise.all(this.pending.values());
    await this.update((r) => {
      r.running = false;
    });
  }
  refused(now = Date.now()) {
    this.refusals = this.refusals.filter(
      (t) => t > now - (this.settings.refusalWindowSeconds ?? 600) * 1000,
    );
    if (this.refusals.length <= (this.settings.refusals ?? 20)) this.refusals.push(now);
  }
  async failure(type: string, now = Date.now(), evidence: Omit<ServiceAlert, 'type'> = {}) {
    const last = this.lastAlerts.get(type);
    if (last !== undefined && now - last < 3600000) return;
    const pending = this.pending.get(type);
    if (pending) return pending;
    const work = (async () => {
      let emit = false;
      const old = await this.store.load('monitor');
      const saved = old?.alerts[type];
      if (saved !== undefined && now - saved < 3600000) {
        this.lastAlerts.set(type, saved);
        return;
      }
      await this.update((r) => {
        const last = r.alerts[type];
        if (last === undefined || now - last >= 3600000) {
          r.alerts[type] = now;
          emit = true;
        }
      });
      this.lastAlerts.set(type, now);
      if (emit) {
        try {
          await this.deliver({ type, ...evidence });
        } catch {
          /* Delivery cannot interrupt financial work. */
        }
      }
    })();
    this.pending.set(type, work);
    try {
      await work;
    } finally {
      this.pending.delete(type);
    }
  }
  async sample(s: {
    now: number;
    poolPercent?: number;
    diskPercent?: number;
    inodePercent?: number;
    keeperEnabled?: boolean;
    keeperLastSuccess?: number;
    oldestDeliverySeconds?: number;
    keeperBudgetPercent?: number;
  }) {
    const checks: [string, boolean, Omit<ServiceAlert, 'type'>][] = [
      [
        'relayer_429',
        this.refusals.filter((t) => t > s.now - (this.settings.refusalWindowSeconds ?? 600) * 1000)
          .length > (this.settings.refusals ?? 20),
        { count: this.refusals.length },
      ],
      [
        'pool_high',
        (s.poolPercent ?? 0) >= (this.settings.poolPercent ?? 70),
        { percent: s.poolPercent ?? 0 },
      ],
      [
        'disk_high',
        (s.diskPercent ?? 0) >= (this.settings.diskPercent ?? 70),
        { percent: s.diskPercent ?? 0 },
      ],
      [
        'inodes_high',
        (s.inodePercent ?? 0) >= (this.settings.diskPercent ?? 70),
        { percent: s.inodePercent ?? 0 },
      ],
      [
        'keeper_stalled',
        !!s.keeperEnabled &&
          s.now - (s.keeperLastSuccess ?? s.now) > (this.settings.stalledSeconds ?? 300) * 1000,
        { seconds: Math.floor((s.now - (s.keeperLastSuccess ?? s.now)) / 1000) },
      ],
      [
        'old_delivery',
        (s.oldestDeliverySeconds ?? 0) >= (this.settings.oldestSeconds ?? 1800),
        { seconds: s.oldestDeliverySeconds ?? 0 },
      ],
      [
        'keeper_budget',
        (s.keeperBudgetPercent ?? 0) >= (this.settings.keeperBudgetPercent ?? 50),
        { percent: s.keeperBudgetPercent ?? 0 },
      ],
    ];
    for (const [type, active, evidence] of checks) {
      if (active) await this.failure(type, s.now, evidence);
      else {
        const old = await this.store.load('monitor');
        if (old?.alerts[type] !== undefined)
          await this.update((r) => {
            delete r.alerts[type];
          });
        this.lastAlerts.delete(type);
      }
    }
  }
}

/** Sample every mounted store, since the keeper may use a separate volume. */
export async function volumeUsage(
  paths: string[],
  read: (
    path: string,
  ) => Promise<{ blocks: number; bavail: number; files: number; ffree: number }> = (path) =>
    statfs(path),
): Promise<{ diskPercent: number; inodePercent: number }> {
  const samples = await Promise.all([...new Set(paths)].map(read));
  return samples.reduce(
    (usage, fs) => ({
      diskPercent: Math.max(
        usage.diskPercent,
        fs.blocks ? (100 * (fs.blocks - fs.bavail)) / fs.blocks : 0,
      ),
      inodePercent: Math.max(
        usage.inodePercent,
        fs.files ? (100 * (fs.files - fs.ffree)) / fs.files : 0,
      ),
    }),
    { diskPercent: 0, inodePercent: 0 },
  );
}
