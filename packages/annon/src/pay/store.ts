/**
 * Where a purchase in progress is kept (x402-annon.md sections 5 and 10): by the buyer's client, and by a seller
 * for the payments it settles. A store has two operations; `compareAndSet` stops a stale tab or process from overwriting a newer record. Ready-made stores: `memoryStore` (one process), `indexedDbStore` (a browser), `fileStore`
 * in `store-node.ts` (Node, CLI, agents), and `fromKeyValue` for a store you already have.
 */

/** A record a store keeps: its id, and how often it was written since it was created (from 0). */
export interface Versioned {
  id: string;
  revision: number;
}

export interface Store<T extends Versioned> {
  load(key: string): Promise<T | null>;
  /**
   * Writes `next` under `key`, or removes the key when `next` is null, only if the key holds the
   * record `expected` names (its id and revision), or nothing when `expected` is null. Atomic: of
   * two writers that read the same state, one gets true. Resolves only once the write is durable.
   */
  compareAndSet(key: string, expected: Versioned | null, next: T | null): Promise<boolean>;
}

export interface StoreWrite<T extends Versioned> {
  key: string;
  expected: Versioned | null;
  next: T | null;
}
export interface AtomicStore<T extends Versioned> extends Store<T> {
  /** All comparisons and writes commit together, or none do. */
  compareAndSetMany(writes: readonly StoreWrite<T>[]): Promise<boolean>;
}

/** `next` must be `expected`'s next revision: a create starts at 0, an update adds 1. */
export function checkNext(expected: Versioned | null, next: Versioned | null) {
  if (next === null) {
    if (expected === null) throw new TypeError('nothing to remove');
    return;
  }
  if (next.revision !== (expected === null ? 0 : expected.revision + 1)) {
    throw new TypeError("next must be the expected record's next revision");
  }
  if (expected !== null && next.id !== expected.id) {
    throw new TypeError('next must keep the id of the record it replaces');
  }
}

export const holds = (current: Versioned | null, expected: Versioned | null) =>
  expected === null
    ? current === null
    : current !== null && current.id === expected.id && current.revision === expected.revision;

const read = <T>(s: string | null | undefined): T | null =>
  s === null || s === undefined ? null : (JSON.parse(s) as T);

/** One process, in memory: for tests, a short-lived agent, or a server with one instance. */
export function memoryStore<T extends Versioned>(): Store<T> {
  const m = new Map<string, string>();
  return {
    load: async (key) => read<T>(m.get(key)),
    compareAndSet: async (key, expected, next) => {
      checkNext(expected, next);
      if (!holds(read<T>(m.get(key)), expected)) return false;
      if (next === null) m.delete(key);
      else m.set(key, JSON.stringify(next));
      return true;
    },
  };
}

export interface KeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * A store over a plain key-value store. `runExclusive` must run `fn` with no other `runExclusive`
 * for the same key running anywhere that shares the store (e.g. a database row lock, or the Web
 * Locks API for the tabs of one origin): the whole read, check and write run inside it.
 */
export function fromKeyValue<T extends Versioned>(
  kv: KeyValue,
  runExclusive: <R>(key: string, fn: () => Promise<R>) => Promise<R>,
): Store<T> {
  return {
    load: async (key) => read<T>(await kv.get(key)),
    compareAndSet: async (key, expected, next) => {
      checkNext(expected, next);
      return runExclusive(key, async () => {
        if (!holds(read<T>(await kv.get(key)), expected)) return false;
        if (next === null) await kv.remove(key);
        else await kv.set(key, JSON.stringify(next));
        return true;
      });
    },
  };
}

/**
 * A browser store: one IndexedDB object store, each check and write in one `readwrite`
 * transaction (IndexedDB runs those one at a time for a store, across the tabs of an origin),
 * committed with `durability: 'strict'`. What a browser keeps is still the user's: clearing site
 * data removes it.
 */
export function indexedDbStore<T extends Versioned>(
  o: { name?: string; factory?: IDBFactory } = {},
): AtomicStore<T> {
  const factory = o.factory ?? globalThis.indexedDB;
  if (!factory) throw new TypeError('no IndexedDB here: pass a factory or use another store');
  const name = o.name ?? 'annon';
  let db: Promise<IDBDatabase> | undefined;
  const open = () => {
    db ??= new Promise((resolve, reject) => {
      const r = factory.open(name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('records');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return db;
  };
  const tx = async (mode: IDBTransactionMode) =>
    (await open()).transaction('records', mode, { durability: 'strict' }).objectStore('records');
  const compareAndSetMany = async (writes: readonly StoreWrite<T>[]): Promise<boolean> => {
    if (!writes.length || new Set(writes.map((w) => w.key)).size !== writes.length)
      throw new TypeError('empty or duplicate CAS keys');
    for (const write of writes) checkNext(write.expected, write.next);
    const s = await tx('readwrite');
    return new Promise((resolve, reject) => {
      let remaining = writes.length;
      let matches = true;
      let wrote = false;
      for (const write of writes) {
        const r = s.get(write.key);
        r.onsuccess = () => {
          try {
            if (!holds(read<T>(r.result as string | undefined), write.expected)) matches = false;
            if (--remaining !== 0 || !matches) return;
            for (const item of writes) {
              if (item.next === null) s.delete(item.key);
              else s.put(JSON.stringify(item.next), item.key);
            }
            wrote = true;
          } catch (error) {
            reject(error);
            s.transaction.abort();
          }
        };
      }
      s.transaction.oncomplete = () => resolve(wrote);
      const failed = () =>
        reject(s.transaction.error ?? new Error('the IndexedDB transaction was aborted'));
      s.transaction.onerror = failed;
      s.transaction.onabort = failed;
    });
  };
  return {
    load: async (key) => {
      const s = await tx('readonly');
      return new Promise((resolve, reject) => {
        const r = s.get(key);
        r.onsuccess = () => resolve(read<T>(r.result as string | undefined));
        r.onerror = () => reject(r.error);
      });
    },
    compareAndSet: (key, expected, next) => compareAndSetMany([{ key, expected, next }]),
    compareAndSetMany,
  };
}
