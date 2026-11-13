/** One CAS transaction binds eligibility, operation holds, allocations and UTC quotas. */
import { sha256 } from '@noble/hashes/sha2.js';
import type { Store, Versioned } from '../pay/store.js';
import { hex } from '../settle-near/codec.js';
import { identityJson } from '../settle-near/identity.js';
import type { Terms } from '../settle-near/terms.js';
import type { ProtocolFee } from './fees.js';
import { RelayError, type RelayResult } from './relay.js';

export interface SponsorshipDecision {
  network: string;
  contract: string;
  fileId: string;
  termsHash: string;
  terms: Terms;
  eligible: true;
  tier: 'listed' | 'pool' | 'legacy' | 'external';
  listed: boolean;
  policyVersion: string;
  minPrice: string;
  fee: ProtocolFee;
  decidedAt: number;
  allocated: string | null;
  outcome: 'prepared' | 'registered';
}
export interface RelayLimits {
  perIpHour?: number;
  perDay: number;
  unlock: number;
  unlockReserved: number;
  unlockListedReserved: number;
  unlocksPerFile: number;
  unlocksPerSeller: number;
  listedUnlocksPerFile: number;
  listedUnlocksPerSeller: number;
  files: number;
  filesPerIp: number;
  registrationsPerSeller: number;
  listedRegistrationsPerSeller: number;
  methods?: Partial<Record<string, number>>;
  claimsPerGrant?: number;
  reopensPerPurchase?: number;
}
export interface Admission {
  id: string;
  requestHash: string;
  method: string;
  fileId: string;
  termsHash: string;
  seller: string;
  listed: boolean;
  ip: string;
  storage: string;
  allocation: string;
  /** Final file balance observed before a sponsored top-up is prepared. */
  fundingBalanceBefore?: string;
  limits: RelayLimits;
  decision?: SponsorshipDecision;
  reservation?: { key: string; binding: string };
  nonce?: string;
  nonceDeadline?: number;
  quota?: { key: string; limit: number };
  topup?: { lifetime: string; fileDay: string; totalDay: string; listedReserved: string };
}
export interface RelayOperation extends Admission {
  at: number;
  compact?: true;
  finishedAt?: number;
  charges: { key: string; amount: string }[];
  stage: 'prepared' | 'submitted' | 'rejected';
  tx?: { txHash: string; signed: string; signer: string; args: object; referenceHash?: string };
  result?: RelayResult;
  storageFinalized?: boolean;
  finalState?: 'released' | 'not_released' | 'done' | 'refused';
}
export interface Cutover {
  policyVersion: 'legacy-v0';
  blockHash: string;
  blockHeight: number;
  minPrice: '100000';
  fee: ProtocolFee;
  scannedThrough: number;
  inventory: string[];
}
export interface RelayState extends Versioned {
  schema: 1;
  decisions: Record<string, SponsorshipDecision>;
  operations: Record<string, RelayOperation>;
  history: Record<string, RelayOperation>;
  counters: Record<string, string>;
  reservations: Record<string, { binding: string; expiresAt: number }>;
  nonces: Record<string, { binding: string; expiresAt: number }>;
  cutover?: Cutover;
  work: Record<string, { request: unknown; requestHash: string; nextAt: number }>;
}
const DAY = 86400000;
const RECORD_CAP = 4096;
const HISTORY_CAP = 128;
interface DecisionRecord extends Versioned {
  decision: SponsorshipDecision;
  sourceRevision: number;
}
const decisionKey = (file: string, terms: string) => `${file}|${terms}`;
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v !== null && typeof v === 'object'
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, x]) => [k, canonical(x)]),
        )
      : v;
export const requestHash = (v: unknown): string =>
  hex(sha256(new TextEncoder().encode(JSON.stringify(canonical(v)))));

const amount = (v: unknown) => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v);
export class RelayLedger {
  private store: Store<RelayState>;
  private scope: string;
  private holdMs: number;
  constructor(store: Store<RelayState>, scope: string, holdMs = 900000) {
    this.store = store;
    this.scope = scope;
    this.holdMs = holdMs;
  }
  async read(): Promise<RelayState> {
    const s = await this.store.load(this.scope);
    if (
      s &&
      (s.schema !== 1 ||
        !s.decisions ||
        !s.operations ||
        !s.history ||
        !s.counters ||
        !s.reservations ||
        !s.nonces ||
        !s.work ||
        Object.values(s.counters).some((v) => !amount(v)) ||
        Object.values(s.operations).some(
          (op) =>
            !amount(op.storage) ||
            !amount(op.allocation) ||
            (op.fundingBalanceBefore !== undefined && !amount(op.fundingBalanceBefore)),
        ) ||
        Object.values(s.decisions).some((d) => d.allocated !== null && !amount(d.allocated)))
    )
      throw new RelayError('unavailable', 'Sponsorship state is unavailable.');
    return (
      s ?? {
        id: this.scope,
        revision: -1,
        schema: 1,
        decisions: {},
        operations: {},
        history: {},
        counters: {},
        reservations: {},
        nonces: {},
        work: {},
      }
    );
  }
  private async change<T>(fn: (s: RelayState) => T | Promise<T>): Promise<T> {
    for (;;) {
      const s = await this.read();
      const next = structuredClone(s);
      const now = Date.now();
      for (const [id, op] of Object.entries(next.operations)) {
        if (op.finishedAt !== undefined && op.finishedAt + this.holdMs <= now)
          delete next.operations[id];
        // Records finalized before retention timestamps were introduced have already held.
        else if (
          op.compact &&
          op.at + this.holdMs <= now &&
          (op.stage === 'rejected' ||
            (op.storageFinalized && ['released', 'done'].includes(op.finalState ?? '')))
        )
          delete next.operations[id];
      }
      for (const entries of [next.nonces, next.reservations])
        for (const [key, binding] of Object.entries(entries))
          if (binding.expiresAt <= now) delete entries[key];
      const result = await fn(next);
      const history = Object.keys(next.history);
      for (const key of history.slice(0, Math.max(0, history.length - HISTORY_CAP)))
        delete next.history[key];
      for (const key of Object.keys(next.counters)) {
        const [window = ''] = key.split('|');
        if (
          window.startsWith('hour:')
            ? Number(window.slice(5)) < Math.floor(now / 3600000)
            : Number(window) < Math.floor(now / DAY) - 1
        )
          delete next.counters[key];
      }
      next.revision++;
      if (await this.store.compareAndSet(this.scope, s.revision < 0 ? null : s, next)) {
        await this.flushDecisions(next);
        return result;
      }
    }
  }
  private decisionStore() {
    return this.store as unknown as Store<DecisionRecord>;
  }
  private recordKey(file: string, terms: string) {
    return `${this.scope}|decision|${file}|${terms}`;
  }
  private async loadDecision(s: RelayState, file: string, terms: string) {
    let d = s.decisions[decisionKey(file, terms)] ?? null;
    if (!d) {
      const record = await this.decisionStore().load(this.recordKey(file, terms));
      if (record && (!record.decision || !Number.isSafeInteger(record.sourceRevision)))
        throw new RelayError('unavailable');
      d = record?.decision ?? null;
    }
    if (
      d &&
      (d.fileId !== file || d.termsHash !== terms || (d.allocated !== null && !amount(d.allocated)))
    )
      throw new RelayError('unavailable');
    return d;
  }
  /** The registry is the write-ahead journal; frozen per-file records outlive traffic. */
  private async flushDecisions(committed: RelayState) {
    const flushed: Record<string, SponsorshipDecision> = {};
    const store = this.decisionStore();
    for (const [key, d] of Object.entries(committed.decisions)) {
      if (d.outcome !== 'registered') continue;
      const id = this.recordKey(d.fileId, d.termsHash);
      for (;;) {
        const old = await store.load(id);
        if (old && old.sourceRevision >= committed.revision) break;
        if (
          await store.compareAndSet(id, old, {
            id,
            revision: (old?.revision ?? -1) + 1,
            sourceRevision: committed.revision,
            decision: d,
          })
        )
          break;
      }
      flushed[key] = d;
    }
    if (!Object.keys(flushed).length) return;
    for (;;) {
      const current = await this.read();
      const next = structuredClone(current);
      let changed = false;
      for (const [key, d] of Object.entries(flushed)) {
        if (next.decisions[key] && requestHash(next.decisions[key]) === requestHash(d)) {
          delete next.decisions[key];
          changed = true;
        }
      }
      if (!changed) return;
      next.revision++;
      if (await this.store.compareAndSet(this.scope, current, next)) return;
    }
  }
  async decision(file: string, terms: string) {
    return this.loadDecision(await this.read(), file, terms);
  }
  async remember(d: SponsorshipDecision): Promise<SponsorshipDecision> {
    return this.change(async (s) => {
      const key = decisionKey(d.fileId, d.termsHash);
      const old = await this.loadDecision(s, d.fileId, d.termsHash);
      s.decisions[key] = old ?? structuredClone(d);
      return s.decisions[key];
    });
  }
  async cutover() {
    return (await this.read()).cutover;
  }
  async seal(cutover: Cutover, decisions: SponsorshipDecision[]) {
    if (cutover.scannedThrough !== cutover.blockHeight) throw new RelayError('unavailable');
    return this.change((s) => {
      if (s.cutover) {
        if (requestHash(s.cutover) !== requestHash(cutover)) throw new RelayError('bad_request');
        return;
      }
      for (const d of decisions)
        s.decisions[decisionKey(d.fileId, d.termsHash)] ??= structuredClone(d);
      s.cutover = structuredClone(cutover);
    });
  }
  async operation(id: string) {
    return (await this.read()).operations[id] ?? null;
  }
  async pendingStorage(_now = Date.now()): Promise<bigint> {
    return Object.values((await this.read()).operations).reduce(
      (n, op) => n + (op.stage !== 'rejected' && !op.storageFinalized ? BigInt(op.storage) : 0n),
      0n,
    );
  }
  async finalizeStorage(id: string, hash: string, state?: RelayOperation['finalState']) {
    return this.change((s) => {
      const op = s.operations[id];
      if (op?.tx?.txHash === hash) {
        op.storageFinalized = true;
        if (state !== undefined) {
          op.finalState = state;
          op.finishedAt ??= Date.now();
        }
      }
    });
  }
  async prepare(
    a: Admission,
    now = Date.now(),
  ): Promise<{ fresh: boolean; operation: RelayOperation; capacityReached?: boolean }> {
    return this.change(async (s) => {
      const old = s.operations[a.id];
      if (old) {
        if (old.stage !== 'rejected') {
          if (old.requestHash !== a.requestHash) throw new RelayError('bad_request');
          return { fresh: false, operation: old };
        }
        s.history[`${a.id}|${s.revision}`] = structuredClone(old);
      }
      let capacityReached = false;
      for (const [entries, key] of [
        [s.operations, a.id],
        [s.reservations, a.reservation?.key],
        [s.nonces, a.nonce],
      ] as const) {
        if (key && !entries[key] && Object.keys(entries).length >= RECORD_CAP) {
          capacityReached = true;
          if (a.method !== 'unlock') throw new RelayError('relayer_unavailable');
        }
      }
      if (a.reservation && a.reservation.binding !== a.requestHash)
        throw new RelayError('bad_request');
      if (
        a.reservation &&
        s.reservations[a.reservation.key] &&
        s.reservations[a.reservation.key]?.binding !== a.reservation.binding
      )
        throw new RelayError('bad_request');
      if (a.nonce && s.nonces[a.nonce] && s.nonces[a.nonce]?.binding !== a.requestHash)
        throw new RelayError('bad_request');
      const day = Math.floor(now / DAY),
        p = a.limits;
      const charges: RelayOperation['charges'] = [];
      const charge = (name: string, limit: bigint | number, amount = 1n) => {
        const key = `${day}|${name}`;
        const n = BigInt(s.counters[key] ?? '0') + amount;
        if (n > BigInt(limit)) {
          const e = new RelayError('limited', 'The daily sponsorship limit is reached.');
          e.retryAt = (day + 1) * DAY;
          throw e;
        }
        s.counters[key] = String(n);
        charges.push({ key, amount: String(amount) });
      };
      const hourKey = `hour:${Math.floor(now / 3600000)}|ip:${a.ip}`;
      const admissions = BigInt(s.counters[hourKey] ?? '0') + 1n;
      if (admissions > BigInt(p.perIpHour ?? 600)) {
        const e = new RelayError('limited');
        e.retryAt = (Math.floor(now / 3600000) + 1) * 3600000;
        throw e;
      }
      s.counters[hourKey] = String(admissions);
      charges.push({ key: hourKey, amount: '1' });
      charge('all', p.perDay);
      if (a.method === 'unlock') {
        charge('unlock', p.unlock);
        if (!a.listed) charge('unlock:pool', Math.max(0, p.unlock - p.unlockListedReserved));
        charge(`unlock:file:${a.fileId}`, a.listed ? p.listedUnlocksPerFile : p.unlocksPerFile);
        charge(
          `unlock:seller:${a.seller}`,
          a.listed ? p.listedUnlocksPerSeller : p.unlocksPerSeller,
        );
      } else {
        charge('other', Math.max(0, p.perDay - p.unlockReserved));
        if (a.method !== 'register' || !a.listed)
          charge(`method:${a.method}`, p.methods?.[a.method] ?? p.perDay);
      }
      if (a.quota) charge(a.quota.key, a.quota.limit);
      if (a.method === 'register') {
        if (!a.listed) {
          charge('files', p.files);
          charge(`files:ip:${a.ip}`, p.filesPerIp);
        }
        charge(
          `files:seller:${a.seller}`,
          a.listed ? p.listedRegistrationsPerSeller : p.registrationsPerSeller,
        );
      }
      if (a.topup) {
        const d = await this.loadDecision(s, a.fileId, a.termsHash);
        if (!d || d.allocated === null) throw new RelayError('not_sponsored');
        if (BigInt(d.allocated) + BigInt(a.allocation) > BigInt(a.topup.lifetime))
          throw new RelayError('limited');
        charge(`topup:file:${a.fileId}`, BigInt(a.topup.fileDay), BigInt(a.allocation));
        charge('topup', BigInt(a.topup.totalDay), BigInt(a.allocation));
        if (!a.listed)
          charge(
            'topup:pool',
            BigInt(a.topup.totalDay) - BigInt(a.topup.listedReserved),
            BigInt(a.allocation),
          );
        d.allocated = String(BigInt(d.allocated) + BigInt(a.allocation));
        s.decisions[decisionKey(a.fileId, a.termsHash)] = d;
      }
      if (a.decision)
        s.decisions[decisionKey(a.fileId, a.termsHash)] ??= {
          ...structuredClone(a.decision),
          outcome: 'prepared',
        };
      if (a.reservation)
        s.reservations[a.reservation.key] = {
          binding: a.reservation.binding,
          expiresAt: now + DAY,
        };
      if (a.nonce)
        s.nonces[a.nonce] = {
          binding: a.requestHash,
          expiresAt: a.nonceDeadline === undefined ? now + 601000 : (a.nonceDeadline + 1) * 1000,
        };
      const operation: RelayOperation = { ...a, at: now, charges, stage: 'prepared' };
      s.operations[a.id] = operation;
      return { fresh: true, operation, capacityReached };
    });
  }
  async signed(id: string, tx: NonNullable<RelayOperation['tx']>) {
    return this.change((s) => {
      const op = s.operations[id];
      if (op?.stage !== 'prepared') throw new RelayError('in_flight');
      op.tx = tx;
      op.stage = 'submitted';
    });
  }
  async result(id: string, result: RelayResult) {
    return this.change((s) => {
      const op = s.operations[id];
      if (op?.tx?.txHash !== result.txHash) return;
      op.result = result;
      delete s.work[id];
    });
  }
  async defer(id: string, request: unknown, hash: string, nextAt: number, max = 32) {
    return this.change((s) => {
      if (s.work[id]?.requestHash && s.work[id]?.requestHash !== hash)
        throw new RelayError('bad_request');
      if (!s.work[id] && Object.keys(s.work).length >= max)
        throw new RelayError('settlement_pending', 'Paid work capacity is reached. Retry later.');
      s.work[id] = { request: structuredClone(request), requestHash: hash, nextAt };
    });
  }
  async finishWork(id: string) {
    return this.change((s) => {
      delete s.work[id];
    });
  }
  async registered(fileId: string, hash: string) {
    return this.change(async (s) => {
      const d = await this.loadDecision(s, fileId, hash);
      if (d) s.decisions[decisionKey(fileId, hash)] = { ...d, outcome: 'registered' };
    });
  }
  async retire(id: string, hash: string) {
    return this.change((s) => {
      const op = s.operations[id];
      if (op?.tx?.txHash !== hash) return false;
      op.stage = 'rejected';
      op.finishedAt ??= Date.now();
      return true;
    });
  }
  async recoverPrepared() {
    for (const op of Object.values((await this.read()).operations))
      if (op.stage === 'prepared' && !op.tx) await this.reject(op.id);
  }
  async reject(id: string, refundCounters = true) {
    return this.change(async (s) => {
      const op = s.operations[id];
      if (!op || op.stage === 'rejected') return;
      for (const c of refundCounters ? op.charges : [])
        if (s.counters[c.key] !== undefined)
          s.counters[c.key] = String(BigInt(s.counters[c.key] ?? '0') - BigInt(c.amount));
      const key = decisionKey(op.fileId, op.termsHash),
        d = await this.loadDecision(s, op.fileId, op.termsHash);
      if (op.method === 'register' && d?.outcome === 'prepared') delete s.decisions[key];
      if (op.topup && d?.allocated) {
        d.allocated = String(BigInt(d.allocated) - BigInt(op.allocation));
        s.decisions[key] = d;
      }
      op.stage = 'rejected';
      op.finishedAt ??= Date.now();
    });
  }
  async unlockAvailable(
    d: SponsorshipDecision,
    p: RelayLimits,
    now = Date.now(),
  ): Promise<boolean> {
    const s = await this.read(),
      day = Math.floor(now / DAY);
    const n = (key: string) => Number(s.counters[`${day}|${key}`] ?? '0');
    return (
      n('all') < p.perDay &&
      n('unlock') < p.unlock &&
      (d.listed || n('unlock:pool') < Math.max(0, p.unlock - p.unlockListedReserved)) &&
      n(`unlock:file:${d.fileId}`) < (d.listed ? p.listedUnlocksPerFile : p.unlocksPerFile) &&
      n(`unlock:seller:${identityJson(d.terms.seller)}`) <
        (d.listed ? p.listedUnlocksPerSeller : p.unlocksPerSeller)
    );
  }
}
