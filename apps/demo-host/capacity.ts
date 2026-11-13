import { mkdir } from 'node:fs/promises';
import { AnnonError } from '../../packages/annon/src/errors.ts';
import type { Versioned } from '../../packages/annon/src/pay/store.ts';
import { fileStore } from '../../packages/annon/src/pay/store-node.ts';

import { StartupError } from './startup-errors.ts';

export interface CapacityLimits {
  maxFileBytes?: number;
  maxPay2Bytes?: number;
  now?: () => number;
  hostBytes?: number;
  poolBytes?: number;
  ingressPerDay?: number;
  filesPerDay?: number;
  filesPerIpDay?: number;
  filesPerSellerDay?: number;
  listedPerSellerDay?: number;
  ttlSeconds?: number;
  stagingSeconds?: number;
  idleSeconds?: number;
  concurrency?: number;
  perSeller?: number;
  perIp?: number;
  requireState?: boolean;
  canonicalFileId?: string;
  canonicalSlug?: string;
}
export interface Admission {
  id: string;
  fileId: string;
  slug: string;
  seller: string;
  ip: string;
  listed: boolean;
  byteSize: number;
  bodyBytes: number;
  plaintextSize: number;
}
interface ObjectRecord extends Admission {
  removed?: boolean;
  received: number;
  assembly?: boolean;
  attempt?: { received: number; bytes: number };
  day: number;
  activityAt: number;
  issuedAt?: number;
  createdAt?: number;
  expiresAt?: number | null;
  state: 'receiving' | 'reserved' | 'published' | 'expired';
}
interface State extends Versioned {
  objects: Record<string, ObjectRecord>;
  days: Record<
    string,
    { ingress: number; files: number; ips: Record<string, number>; sellers: Record<string, number> }
  >;
}
export class CapacityError extends AnnonError<
  'host_capacity' | 'too_large' | 'upload_incomplete' | 'upload_conflict'
> {
  constructor(code: CapacityError['code']) {
    super(code);
    this.name = 'CapacityError';
  }
}
/** Baseline admission/lifecycle state for the upload service. All holds share one durable CAS. */
export async function hostCapacity(dir: string, o: CapacityLimits = {}) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const store = fileStore<State>(dir);
  const key = 'host-capacity';
  const now = o.now ?? Date.now;
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  const integer = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const counters = (v: unknown) => object(v) && Object.values(v).every(integer);
  const validObject = (v: unknown, id: string) =>
    object(v) &&
    v.id === id &&
    ['fileId', 'slug', 'seller', 'ip'].every((k) => typeof v[k] === 'string') &&
    typeof v.listed === 'boolean' &&
    ['byteSize', 'bodyBytes', 'plaintextSize', 'received', 'day', 'activityAt'].every((k) =>
      integer(v[k]),
    ) &&
    (v.byteSize as number) > 0 &&
    (v.bodyBytes as number) <= (v.byteSize as number) &&
    ['receiving', 'reserved', 'published', 'expired'].includes(v.state as string) &&
    (v.issuedAt === undefined || integer(v.issuedAt)) &&
    (v.createdAt === undefined || integer(v.createdAt)) &&
    (v.expiresAt === undefined || v.expiresAt === null || integer(v.expiresAt)) &&
    (v.attempt === undefined ||
      (object(v.attempt) && integer(v.attempt.bytes) && integer(v.attempt.received))) &&
    (v.assembly === undefined || typeof v.assembly === 'boolean') &&
    (v.removed === undefined || typeof v.removed === 'boolean') &&
    (v.state !== 'published' ||
      (integer(v.createdAt) && (v.expiresAt === null || integer(v.expiresAt))));
  const load = async () => {
    const old = await store.load(key);
    if (!old && o.requireState) throw new StartupError('state_missing');
    if (
      old &&
      (old.id !== key ||
        !integer(old.revision) ||
        !object(old.objects) ||
        !object(old.days) ||
        !Object.entries(old.objects).every(([id, v]) => validObject(v, id)) ||
        !Object.entries(old.days).every(
          ([day, v]) =>
            /^\d+$/.test(day) &&
            object(v) &&
            integer(v.ingress) &&
            integer(v.files) &&
            counters(v.ips) &&
            counters(v.sellers),
        ))
    )
      throw new StartupError('state_invalid');
    return old;
  };
  const transact = async <T>(fn: (state: State) => T): Promise<T> => {
    for (let tries = 0; tries < 32; tries++) {
      const old = await load();
      const state: State = old
        ? structuredClone(old)
        : { id: key, revision: -1, objects: {}, days: {} };
      const result = fn(state);
      state.revision++;
      if (await store.compareAndSet(key, old, state)) return result;
    }
    throw new CapacityError('host_capacity');
  };
  const day = (s: State, n: number) =>
    (s.days[n] ??= { ingress: 0, files: 0, ips: {}, sellers: {} });
  const capacity = (s: State, pool: boolean) =>
    Object.values(s.objects).reduce(
      (n, r) =>
        n +
        ((r.state === 'expired' && r.removed) || (pool && r.listed)
          ? 0
          : r.byteSize * (r.state === 'published' && !r.assembly ? 1 : 2)),
      0,
    );
  return {
    async reserve(i: Admission) {
      if (
        ![i.byteSize, i.bodyBytes, i.plaintextSize].every(
          (n) => Number.isSafeInteger(n) && n >= 0,
        ) ||
        i.byteSize === 0 ||
        i.plaintextSize > (o.maxFileBytes ?? 50_000_000) ||
        i.byteSize > (o.maxPay2Bytes ?? 50_086_016) ||
        i.bodyBytes > i.byteSize
      )
        throw new CapacityError('too_large');
      return transact((s) => {
        const existing = s.objects[i.id];
        if (existing) {
          if (
            Object.keys(i).some((k) => existing[k as keyof Admission] !== i[k as keyof Admission])
          )
            throw new CapacityError('upload_conflict');
          return;
        }
        const t = now(),
          d = Math.floor(t / 86_400_000),
          counts = day(s, d);
        const receiving = Object.values(s.objects).filter(
          (r) => r.state === 'receiving' || r.attempt,
        );
        const ingressHolds = receiving.reduce(
          (n, r) =>
            n +
            Math.max(
              0,
              r.attempt ? r.attempt.bytes - r.attempt.received : r.bodyBytes - r.received,
            ),
          0,
        );
        const sellerKey = `${i.listed ? 'listed' : 'pool'}:${i.seller}`;
        if (
          capacity(s, false) + i.byteSize * 2 > (o.hostBytes ?? 80_000_000_000) ||
          (!i.listed && capacity(s, true) + i.byteSize * 2 > (o.poolBytes ?? 40_000_000_000)) ||
          counts.ingress + ingressHolds + i.bodyBytes > (o.ingressPerDay ?? 1_000_000_000) ||
          (!i.listed &&
            (counts.files >= (o.filesPerDay ?? 30) ||
              (counts.ips[i.ip] ?? 0) >= (o.filesPerIpDay ?? 3))) ||
          (counts.sellers[sellerKey] ?? 0) >=
            (i.listed ? (o.listedPerSellerDay ?? 20) : (o.filesPerSellerDay ?? 3)) ||
          receiving.length >= (o.concurrency ?? 4) ||
          receiving.filter((r) => r.seller === i.seller).length >= (o.perSeller ?? 1) ||
          receiving.filter((r) => r.ip === i.ip).length >= (o.perIp ?? 1)
        )
          throw new CapacityError('host_capacity');
        if (!i.listed) {
          counts.files++;
          counts.ips[i.ip] = (counts.ips[i.ip] ?? 0) + 1;
        }
        counts.sellers[sellerKey] = (counts.sellers[sellerKey] ?? 0) + 1;
        s.objects[i.id] = { ...i, received: 0, day: d, activityAt: t, state: 'receiving' };
      });
    },
    async begin(id: string, body: boolean) {
      await transact((s) => {
        const r = s.objects[id];
        if (r?.state !== 'reserved' || r.attempt) throw new CapacityError('upload_conflict');
        const streams = Object.values(s.objects).filter(
          (v) => v.state === 'receiving' || v.attempt,
        );
        const holds = streams.reduce(
          (n, v) =>
            n +
            Math.max(
              0,
              v.attempt ? v.attempt.bytes - v.attempt.received : v.bodyBytes - v.received,
            ),
          0,
        );
        if (
          streams.length >= (o.concurrency ?? 4) ||
          streams.filter((v) => v.seller === r.seller).length >= (o.perSeller ?? 1) ||
          streams.filter((v) => v.ip === r.ip).length >= (o.perIp ?? 1) ||
          day(s, Math.floor(now() / 86_400_000)).ingress + holds + (body ? r.bodyBytes : 0) >
            (o.ingressPerDay ?? 1_000_000_000)
        )
          throw new CapacityError('host_capacity');
        r.attempt = { received: 0, bytes: body ? r.bodyBytes : 0 };
      });
    },
    async end(id: string) {
      await transact((s) => {
        const r = s.objects[id];
        if (r) delete r.attempt;
      });
    },
    async recover() {
      await transact((s) => {
        for (const r of Object.values(s.objects)) {
          delete r.attempt;
          if (r.state === 'receiving') r.activityAt = 0;
        }
      });
    },
    async received(id: string, bytes: number) {
      const overflow = await transact((s) => {
        const r = s.objects[id];
        if (
          !r ||
          (r.state !== 'receiving' && !r.attempt) ||
          !Number.isSafeInteger(bytes) ||
          bytes < 0
        )
          throw new CapacityError('upload_conflict');
        const counts = day(s, Math.floor(now() / 86_400_000));
        counts.ingress += bytes;
        if (r.attempt) r.attempt.received += bytes;
        else r.received += bytes;
        r.activityAt = now();
        return (
          (r.attempt ? r.attempt.received > r.attempt.bytes : r.received > r.bodyBytes) ||
          counts.ingress > (o.ingressPerDay ?? 1_000_000_000)
        );
      });
      if (overflow) throw new CapacityError('too_large');
    },
    async verified(id: string) {
      await transact((s) => {
        const r = s.objects[id];
        if (!r || r.received !== r.bodyBytes) throw new CapacityError('upload_incomplete');
        r.state = 'reserved';
        r.issuedAt ??= now();
      });
    },
    async close(id: string) {
      await transact((s) => {
        const r = s.objects[id];
        if (r?.state !== 'receiving') return;
        if (r.issuedAt !== undefined) {
          r.state = 'reserved';
          return;
        }
        const d = day(s, r.day);
        if (!r.listed) {
          d.files--;
          d.ips[r.ip] = (d.ips[r.ip] ?? 1) - 1;
        }
        const sk = `${r.listed ? 'listed' : 'pool'}:${r.seller}`;
        d.sellers[sk] = (d.sellers[sk] ?? 1) - 1;
        delete s.objects[id];
      });
    },
    async publish(id: string) {
      await transact((s) => {
        const r = s.objects[id];
        if (!r || r.state === 'expired') throw new CapacityError('upload_conflict');
        if (r.state === 'published') return;
        if (r.received !== r.bodyBytes) throw new CapacityError('upload_incomplete');
        r.state = 'published';
        r.assembly = true;
        r.createdAt ??= now();
        r.expiresAt =
          r.fileId === o.canonicalFileId && r.slug === (o.canonicalSlug ?? 'what-we-are-building')
            ? null
            : r.createdAt + (o.ttlSeconds ?? 604800) * 1000;
      });
    },
    async resumePublication(id: string) {
      await transact((s) => {
        const r = s.objects[id];
        if (r?.state === 'published') r.state = 'reserved';
      });
    },
    async releaseAssembly(id: string) {
      await transact((s) => {
        const r = s.objects[id];
        if (r?.state === 'published') delete r.assembly;
      });
    },
    async importFile(i: Admission) {
      if (
        i.byteSize > (o.maxPay2Bytes ?? 50_086_016) ||
        i.plaintextSize > (o.maxFileBytes ?? 50_000_000)
      )
        throw new CapacityError('too_large');
      await transact((s) => {
        if (s.objects[i.id]) return;
        if (
          capacity(s, false) + i.byteSize > (o.hostBytes ?? 80_000_000_000) ||
          (!i.listed && capacity(s, true) + i.byteSize > (o.poolBytes ?? 40_000_000_000))
        )
          throw new CapacityError('host_capacity');
        const t = now();
        s.objects[i.id] = {
          ...i,
          received: i.bodyBytes,
          day: Math.floor(t / 86_400_000),
          activityAt: t,
          state: 'published',
          createdAt: t,
          expiresAt:
            i.fileId === o.canonicalFileId && i.slug === (o.canonicalSlug ?? 'what-we-are-building')
              ? null
              : t + (o.ttlSeconds ?? 604800) * 1000,
        };
      });
    },
    async snapshot() {
      const state = await load();
      const objects = state?.objects ?? {};
      const expired = Object.values(objects).filter(
        (r) =>
          (r.state === 'expired' && r.createdAt !== undefined) ||
          (r.expiresAt !== undefined && r.expiresAt !== null && now() >= r.expiresAt),
      );
      return {
        objects,
        expiredIds: new Set(expired.map((r) => r.fileId)),
        expiredSlugs: new Set(expired.map((r) => r.slug)),
      };
    },
    async expired(fileId: string) {
      const s = await load();
      const records = Object.values(s?.objects ?? {}).filter((r) => r.fileId === fileId);
      return records.some(
        (r) =>
          (r.state === 'expired' && r.createdAt !== undefined) ||
          (r.expiresAt !== undefined && r.expiresAt !== null && now() >= r.expiresAt),
      );
    },
    async expiredSlug(slug: string) {
      const s = await load();
      return Object.values(s?.objects ?? {}).some(
        (r) =>
          r.slug === slug &&
          ((r.state === 'expired' && r.createdAt !== undefined) ||
            (r.expiresAt !== undefined && r.expiresAt !== null && now() >= r.expiresAt)),
      );
    },
    async removed(id: string) {
      await transact((s) => {
        const r = s.objects[id];
        if (r?.state === 'expired') {
          if (r.createdAt === undefined) delete s.objects[id];
          else r.removed = true;
        }
      });
    },
    async info(id: string) {
      return (await load())?.objects[id];
    },
    async sweep() {
      return transact((s) => {
        const removed: string[] = [];
        for (const [id, r] of Object.entries(s.objects)) {
          if (
            r.state === 'published' &&
            r.expiresAt !== null &&
            r.expiresAt !== undefined &&
            now() >= r.expiresAt
          ) {
            r.state = 'expired';
            removed.push(id);
          } else if (r.state === 'expired' && !r.removed) {
            removed.push(id);
          } else if (
            r.state === 'reserved' &&
            now() - (r.issuedAt ?? r.activityAt) >= (o.stagingSeconds ?? 86400) * 1000
          ) {
            r.state = 'expired';
            removed.push(id);
          } else if (
            r.state === 'receiving' &&
            now() - r.activityAt >= (o.idleSeconds ?? 600) * 1000
          ) {
            const d = day(s, r.day);
            if (!r.listed) {
              d.files--;
              d.ips[r.ip] = (d.ips[r.ip] ?? 1) - 1;
            }
            const sk = `${r.listed ? 'listed' : 'pool'}:${r.seller}`;
            d.sellers[sk] = (d.sellers[sk] ?? 1) - 1;
            r.state = 'expired';
            removed.push(id);
          }
        }
        return removed;
      });
    },
  };
}
