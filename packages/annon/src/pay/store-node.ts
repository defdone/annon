/**
 * A store in a directory, for Node: a CLI, an agent, a small server. One file per key, written to
 * a temporary file, synced and renamed into place, with the directory synced after. A lock file per
 * key makes the read, check and write exclusive across processes on this machine. A lock is never
 * taken over, not even one left by a process that died (two processes could both see it dead and
 * one remove the other's fresh lock): after `lockWaitMs` the write is refused, naming the lock file
 * to remove once no process uses the store. Records are created readable by the owner only; keep the
 * directory private too. Not for network file systems.
 */
import { createHash, randomBytes } from 'node:crypto';
import { link, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { checkNext, holds, type Store, type Versioned } from './store.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it runs, as another user.
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

async function syncDir(dir: string) {
  const d = await open(dir, 'r');
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}

export function fileStore<T extends Versioned>(
  dir: string,
  o: { lockWaitMs?: number } = {},
): Store<T> {
  const wait = o.lockWaitMs ?? 5_000;
  const fileOf = (key: string) =>
    join(dir, `${createHash('sha256').update(key).digest('hex')}.json`);
  const load = async (file: string): Promise<T | null> => {
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  };
  /** Writes `data` to a new temporary file, synced, and returns its name. */
  const temp = async (file: string, data: string) => {
    const t = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    // Owner only: a record holds a signed authorization anyone could submit.
    const h = await open(t, 'wx', 0o600);
    try {
      await h.writeFile(data);
      await h.sync();
    } finally {
      await h.close();
    }
    return t;
  };
  const lock = async (file: string) => {
    const l = `${file}.lock`;
    // The lock appears with its owner's pid already in it: `link` of a complete file is atomic and
    // fails if the lock exists.
    const mine = await temp(file, String(process.pid));
    try {
      for (const until = Date.now() + wait; ; ) {
        try {
          await link(mine, l);
          return l;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
        if (Date.now() > until) {
          const owner = Number(await readFile(l, 'utf8').catch(() => ''));
          throw new Error(
            Number.isSafeInteger(owner) && owner > 0 && !alive(owner)
              ? `the store is locked by ${l}, left by process ${owner}, which is not running: remove that file once no other process uses the store`
              : `the store is busy: ${l} is held by a running process`,
          );
        }
        await sleep(20);
      }
    } finally {
      await unlink(mine).catch(() => {});
    }
  };
  return {
    load: (key) => load(fileOf(key)),
    compareAndSet: async (key, expected, next) => {
      checkNext(expected, next);
      const file = fileOf(key);
      const l = await lock(file);
      try {
        if (!holds(await load(file), expected)) return false;
        if (next === null) await unlink(file);
        else await rename(await temp(file, JSON.stringify(next)), file);
        await syncDir(dir);
        return true;
      } finally {
        await unlink(l);
      }
    },
  };
}
