import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import type {
  DownloadAccounting,
  DownloadInput,
  DownloadReservation,
} from '../../packages/annon/src/download/host.ts';
import type { Versioned } from '../../packages/annon/src/pay/store.ts';
import { fileStore } from '../../packages/annon/src/pay/store-node.ts';

interface Attempt {
  id: string;
  owner: string;
  status: 'active' | 'interrupted' | 'completion_pending' | 'completed';
  version: string;
  offset: number;
  startedAt: number;
  activityAt: number;
}
interface Ledger extends Versioned {
  completedCount: number;
  lastCompletedAt: number;
  nextAllowedAt: number;
  attempt?: Attempt;
}
export interface DownloadLimits {
  now?: () => number;
  immediateCount?: number;
  fourthWaitSeconds?: number;
  fifthWaitSeconds?: number;
  laterWaitSeconds?: number;
  resumeSeconds?: number;
  attemptSeconds?: number;
  busyRetrySeconds?: number;
}

/** Durable per-purchase accounting. A new instance interrupts old leases without billing them. */
export async function downloadLedger(
  dir: string,
  limits: DownloadLimits = {},
): Promise<DownloadAccounting> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const store = fileStore<Ledger>(dir);
  const owner = randomUUID();
  const now = limits.now ?? Date.now;
  const active = new Set<string>();
  const busy = (): DownloadReservation => ({
    ok: false,
    status: 429,
    code: 'download_in_progress',
    retryAfterSeconds: limits.busyRetrySeconds ?? 5,
  });
  return {
    async reserve(i: DownloadInput): Promise<DownloadReservation> {
      const key = JSON.stringify([i.network, i.contract, i.purchaseId, i.fileId]);
      for (let tries = 0; tries < 16; tries++) {
        const old = await store.load(key);
        const integer = (n: number) => Number.isSafeInteger(n) && n >= 0;
        if (
          old &&
          (old.id !== key ||
            !integer(old.revision) ||
            !integer(old.completedCount) ||
            !integer(old.lastCompletedAt) ||
            !integer(old.nextAllowedAt) ||
            (old.attempt &&
              (typeof old.attempt.id !== 'string' ||
                typeof old.attempt.owner !== 'string' ||
                typeof old.attempt.version !== 'string' ||
                !['active', 'interrupted', 'completion_pending', 'completed'].includes(
                  old.attempt.status,
                ) ||
                !integer(old.attempt.offset) ||
                !integer(old.attempt.startedAt) ||
                !integer(old.attempt.activityAt))))
        )
          throw new Error('invalid download ledger');

        const t = now();
        const a = old?.attempt;
        if (active.has(key)) return busy();
        const resume =
          i.range &&
          !!a &&
          a.status !== 'completed' &&
          a.version === i.version &&
          t - a.activityAt <= (limits.resumeSeconds ?? 600) * 1000 &&
          t - a.startedAt <= (limits.attemptSeconds ?? 1800) * 1000 &&
          (i.start === 0 || i.start >= i.headerLength) &&
          i.start <= a.offset &&
          i.start < i.size;
        if (!resume && i.start !== 0 && i.start !== i.headerLength)
          return { ok: false, status: 416, code: 'bad_request' };
        if (!resume && (old?.nextAllowedAt ?? 0) > t)
          return {
            ok: false,
            status: 429,
            code: 'download_limited',
            retryAfterSeconds: Math.ceil(((old?.nextAllowedAt ?? 0) - t) / 1000),
          };
        const attempt: Attempt =
          resume && a
            ? { ...a, owner, status: 'active' }
            : {
                id: randomUUID(),
                owner,
                status: 'active',
                version: i.version,
                offset: i.headerLength,
                startedAt: t,
                activityAt: t,
              };
        let current: Ledger = {
          id: key,
          revision: old ? old.revision + 1 : 0,
          completedCount: old?.completedCount ?? 0,
          lastCompletedAt: old?.lastCompletedAt ?? 0,
          nextAllowedAt: old?.nextAllowedAt ?? 0,
          attempt,
        };
        if (!(await store.compareAndSet(key, old, current))) continue;
        active.add(key);
        let closed = false;
        const update = async (change: (r: Ledger) => Ledger) => {
          const next = { ...change(current), revision: current.revision + 1 };
          if (!(await store.compareAndSet(key, current, next)))
            throw new Error('download lease changed');
          current = next;
        };
        let transmitted = i.start;
        let checkpointOffset = i.start;
        let checkpointAt = now();
        let activityAt = attempt.activityAt;
        const coverage = (status: Attempt['status']): Attempt => ({
          ...attempt,
          status,
          offset: Math.max(attempt.offset, transmitted),
          activityAt,
        });
        return {
          ok: true,
          delivery: {
            async wrote(offset) {
              if (closed || offset < transmitted || offset > i.size)
                throw new Error('invalid download coverage');
              transmitted = offset;
              activityAt = now();
              if (
                transmitted - checkpointOffset >= 1_048_576 ||
                activityAt - checkpointAt >= 1000
              ) {
                await update((r) => ({ ...r, attempt: coverage('active') }));
                checkpointOffset = transmitted;
                checkpointAt = activityAt;
              }
            },
            async prepare() {
              if (closed || transmitted !== i.size) throw new Error('incomplete download');
              await update((r) => ({ ...r, attempt: coverage('completion_pending') }));
            },
            async finish() {
              if (closed) return;
              if (transmitted !== i.size || current.attempt?.status !== 'completion_pending')
                throw new Error('incomplete download');
              const count = current.completedCount + 1;
              const delay =
                count < (limits.immediateCount ?? 3)
                  ? 0
                  : count === (limits.immediateCount ?? 3)
                    ? (limits.fourthWaitSeconds ?? 900)
                    : count === (limits.immediateCount ?? 3) + 1
                      ? (limits.fifthWaitSeconds ?? 7200)
                      : (limits.laterWaitSeconds ?? 86400);
              const finished = now();
              await update((r) => ({
                ...r,
                completedCount: count,
                lastCompletedAt: finished,
                nextAllowedAt: finished + delay * 1000,
                attempt: { ...(r.attempt as Attempt), status: 'completed' },
              }));
              closed = true;
              active.delete(key);
            },
            async interrupt() {
              if (closed) return;
              try {
                await update((r) => ({ ...r, attempt: coverage('interrupted') }));
              } finally {
                closed = true;
                active.delete(key);
              }
            },
          },
        };
      }
      return busy();
    },
  };
}
