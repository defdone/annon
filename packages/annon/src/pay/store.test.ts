import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { afterAll, describe, expect, it } from 'vitest';
import { fromKeyValue, indexedDbStore, memoryStore, type Store, type Versioned } from './store.js';
import { fileStore } from './store-node.js';

type Rec = Versioned & { value: string };
const rec = (id: string, revision: number, value = `v${revision}`): Rec => ({
  id,
  revision,
  value,
});

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'annon-store-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A key-value store with no atomicity of its own, and a lock per key around each operation. */
const kvStore = () => {
  const m = new Map<string, string>();
  const tails = new Map<string, Promise<unknown>>();
  return fromKeyValue<Rec>(
    {
      get: async (k) => {
        await Promise.resolve();
        return m.get(k) ?? null;
      },
      set: async (k, v) => {
        await Promise.resolve();
        m.set(k, v);
      },
      remove: async (k) => {
        await Promise.resolve();
        m.delete(k);
      },
    },
    (key, fn) => {
      const run = (tails.get(key) ?? Promise.resolve()).then(fn, fn);
      tails.set(
        key,
        run.catch(() => {}),
      );
      return run;
    },
  );
};

const stores: [string, () => Store<Rec>][] = [
  ['memoryStore', () => memoryStore<Rec>()],
  ['fromKeyValue', kvStore],
  ['indexedDbStore', () => indexedDbStore<Rec>({ factory: new IDBFactory(), name: 'annon-test' })],
  ['fileStore', () => fileStore<Rec>(tmp())],
];

describe.each(stores)('%s keeps the store contract', (_, make) => {
  it('creates once: a second create of the same key is refused', async () => {
    const s = make();
    expect(await s.load('k')).toBeNull();
    expect(await s.compareAndSet('k', null, rec('a', 0))).toBe(true);
    expect(await s.compareAndSet('k', null, rec('b', 0))).toBe(false);
    expect(await s.load('k')).toEqual(rec('a', 0));
  });

  it('updates only from the revision and record it read', async () => {
    const s = make();
    await s.compareAndSet('k', null, rec('a', 0));
    expect(await s.compareAndSet('k', { id: 'a', revision: 1 }, rec('a', 2))).toBe(false);
    expect(await s.compareAndSet('k', { id: 'b', revision: 0 }, rec('b', 1))).toBe(false);
    expect(await s.compareAndSet('k', { id: 'a', revision: 0 }, rec('a', 1, 'x'))).toBe(true);
    expect(await s.load('k')).toEqual(rec('a', 1, 'x'));
    // A writer that read revision 0 is stale now.
    expect(await s.compareAndSet('k', { id: 'a', revision: 0 }, rec('a', 1, 'y'))).toBe(false);
    expect(await s.load('k')).toEqual(rec('a', 1, 'x'));
  });

  it('removes only from the revision it read, and a removed key can be created again', async () => {
    const s = make();
    await s.compareAndSet('k', null, rec('a', 0));
    expect(await s.compareAndSet('k', { id: 'a', revision: 3 }, null)).toBe(false);
    expect(await s.compareAndSet('k', { id: 'a', revision: 0 }, null)).toBe(true);
    expect(await s.load('k')).toBeNull();
    expect(await s.compareAndSet('k', null, rec('c', 0))).toBe(true);
  });

  it('keeps keys apart, whatever characters they hold', async () => {
    const s = make();
    const keys = ['a/b', 'a:b', '../x', 'A', 'a', 'eip155:8453/0xAb'];
    for (const [i, k] of keys.entries()) {
      expect(await s.compareAndSet(k, null, rec(`r${i}`, 0))).toBe(true);
    }
    for (const [i, k] of keys.entries()) expect((await s.load(k))?.id).toBe(`r${i}`);
  });

  it('lets exactly one of many concurrent creates or updates win', async () => {
    const s = make();
    const creates = await Promise.all(
      Array.from({ length: 12 }, (_, i) => s.compareAndSet('k', null, rec(`c${i}`, 0))),
    );
    expect(creates.filter(Boolean)).toHaveLength(1);
    const winner = (await s.load('k')) as Rec;
    const updates = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        s.compareAndSet('k', { id: winner.id, revision: 0 }, rec(winner.id, 1, `u${i}`)),
      ),
    );
    expect(updates.filter(Boolean)).toHaveLength(1);
    expect((await s.load('k'))?.revision).toBe(1);
  });

  it('refuses a next record that does not follow the expected one', async () => {
    const s = make();
    await expect(s.compareAndSet('k', null, rec('a', 1))).rejects.toThrow(TypeError);
    await s.compareAndSet('k', null, rec('a', 0));
    await expect(s.compareAndSet('k', { id: 'a', revision: 0 }, rec('a', 0))).rejects.toThrow(
      TypeError,
    );
    await expect(s.compareAndSet('k', { id: 'a', revision: 0 }, rec('b', 1))).rejects.toThrow(
      TypeError,
    );
    expect(await s.load('k')).toEqual(rec('a', 0));
  });
});

describe('indexedDbStore', () => {
  it('writes with durability strict, so a write resolves only once committed', async () => {
    const factory = new IDBFactory();
    const modes: unknown[] = [];
    const open = factory.open.bind(factory);
    factory.open = ((...a: Parameters<IDBFactory['open']>) => {
      const r = open(...a);
      r.addEventListener('success', () => {
        const db = r.result;
        const tx = db.transaction.bind(db);
        db.transaction = ((names: string, mode?: IDBTransactionMode, o?: IDBTransactionOptions) => {
          modes.push([mode, o?.durability]);
          return tx(names, mode, o);
        }) as typeof db.transaction;
      });
      return r;
    }) as typeof factory.open;
    const s = indexedDbStore<Rec>({ factory, name: 'durability' });
    await s.compareAndSet('k', null, rec('a', 0));
    expect(modes).toContainEqual(['readwrite', 'strict']);
  });
});

describe('indexedDbStore commits before it answers', () => {
  /** A factory whose transactions report their events to `log`, and abort on `put` when asked. */
  const watched = (log: string[], abortOnPut: false | 'pending' | 'done' = false) => {
    const factory = new IDBFactory();
    const open = factory.open.bind(factory);
    factory.open = ((...a: Parameters<IDBFactory['open']>) => {
      const r = open(...a);
      r.addEventListener('success', () => {
        const db = r.result;
        const tx = db.transaction.bind(db);
        db.transaction = ((n: string, m?: IDBTransactionMode, o?: IDBTransactionOptions) => {
          const t = tx(n, m, o);
          t.addEventListener('complete', () => log.push('complete'));
          if (abortOnPut) {
            const os = t.objectStore.bind(t);
            t.objectStore = ((name: string) => {
              const store = os(name);
              const put = store.put.bind(store);
              store.put = ((...p: Parameters<IDBObjectStore['put']>) => {
                const req = put(...p);
                // While the put is pending (its request fails too), or after it succeeded (only
                // the transaction fails: IndexedDB allows that).
                if (abortOnPut === 'pending') t.abort();
                else req.addEventListener('success', () => t.abort());
                return req;
              }) as typeof store.put;
              return store;
            }) as typeof t.objectStore;
          }
          return t;
        }) as typeof db.transaction;
      });
      return r;
    }) as typeof factory.open;
    return factory;
  };

  it('resolves a write only after its transaction completed', async () => {
    const log: string[] = [];
    const s = indexedDbStore<Rec>({ factory: watched(log), name: 'order' });
    await s.compareAndSet('k', null, rec('a', 0));
    log.push('resolved');
    expect(log.indexOf('complete')).toBeGreaterThanOrEqual(0);
    expect(log.indexOf('complete')).toBeLessThan(log.indexOf('resolved'));
  });

  it('rejects a write whose transaction aborted, during the put or after it, and keeps nothing', async () => {
    for (const when of ['pending', 'done'] as const) {
      const s = indexedDbStore<Rec>({ factory: watched([], when), name: `abort-${when}` });
      await expect(s.compareAndSet('k', null, rec('a', 0))).rejects.toBeInstanceOf(Error);
      expect(await s.load('k')).toBeNull();
    }
  });
});

describe('fileStore', () => {
  it('writes through a temporary file and leaves only the record behind', async () => {
    const d = tmp();
    const s = fileStore<Rec>(d);
    await s.compareAndSet('k', null, rec('a', 0));
    await s.compareAndSet('k', { id: 'a', revision: 0 }, rec('a', 1));
    const files = readdirSync(d);
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(d, files[0] as string), 'utf8'))).toEqual(rec('a', 1));
  });

  it('creates records readable by the owner only: they hold signed authorizations', async () => {
    const d = tmp();
    const s = fileStore<Rec>(d);
    await s.compareAndSet('k', null, rec('a', 0));
    const f = readdirSync(d)[0] as string;
    expect(statSync(join(d, f)).mode & 0o777).toBe(0o600);
  });

  it('two processes on one directory: exactly one create wins', async () => {
    const d = tmp();
    const script = `
      import { fileStore } from ${JSON.stringify(new URL('./store-node.ts', import.meta.url).pathname)};
      const s = fileStore(process.argv[1]);
      const ok = await s.compareAndSet('k', null, { id: process.argv[2], revision: 0, value: 'p' });
      console.log(ok ? 'won' : 'lost');
    `;
    const hook = new URL('../../../../apps/relayer/ts-hook.mjs', import.meta.url).pathname;
    // Started together, so their creates race.
    const run = (id: string) =>
      new Promise<string>((resolve) => {
        const p = spawn(process.execPath, [
          '--no-warnings',
          '--import',
          hook,
          '--input-type=module',
          '-e',
          script,
          d,
          id,
        ]);
        let out = '';
        p.stdout.on('data', (c) => {
          out += c;
        });
        p.stderr.on('data', (c) => {
          out += c;
        });
        p.on('close', () => resolve(out.trim()));
      });
    const out = await Promise.all(['p1', 'p2', 'p3'].map(run));
    expect(out.filter((o) => o === 'won')).toHaveLength(1);
    expect(out.filter((o) => o === 'lost')).toHaveLength(2);
  });

  it('waits for a lock held by a live process and then refuses, never taking it over', async () => {
    const d = tmp();
    const s = fileStore<Rec>(d, { lockWaitMs: 200 });
    await s.compareAndSet('k', null, rec('a', 0));
    // This test process is alive and holds the lock.
    const lock = readdirSync(d).find((f) => !f.endsWith('.lock')) as string;
    writeFileSync(join(d, `${lock}.lock`), String(process.pid));
    await expect(s.compareAndSet('k', { id: 'a', revision: 0 }, rec('a', 1))).rejects.toThrow(
      /busy/,
    );
    expect(await s.load('k')).toEqual(rec('a', 0));
  });

  it('never takes over a lock left by a process that died: it refuses and names the file', async () => {
    const d = tmp();
    const s = fileStore<Rec>(d, { lockWaitMs: 100 });
    await s.compareAndSet('k', null, rec('a', 0));
    const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], {
      encoding: 'utf8',
    }).stdout.trim();
    const name = readdirSync(d)[0] as string;
    writeFileSync(join(d, `${name}.lock`), dead);
    await expect(s.compareAndSet('k', { id: 'a', revision: 0 }, rec('a', 1))).rejects.toThrow(
      new RegExp(`left by process ${dead}, which is not running: remove that file`),
    );
    expect(await s.load('k')).toEqual(rec('a', 0));
    // Removed by hand: the store goes on.
    rmSync(join(d, `${name}.lock`));
    expect(await s.compareAndSet('k', { id: 'a', revision: 0 }, rec('a', 1))).toBe(true);
  });
});
