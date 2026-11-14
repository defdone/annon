/** Atomic, synced records with per-key CAS locks and exclusive service-directory ownership. */

import { createHash, randomBytes } from 'node:crypto';
import { link, mkdir, open, readdir, readFile, rename, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { sleep } from '../net/retry.js';
import { syncDir } from '../node/sync-dir.js';
import { checkNext, holds, type Store, type Versioned } from './store.js';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it runs, as another user.
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

const started = async (pid: number) => {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const boot = await readFile('/proc/sys/kernel/random/boot_id', 'utf8');
    return `${boot.trim()}|${
      stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/)[19]
    }`;
  } catch {
    return '';
  }
};

type LockOwner = { pid: number; started?: string };
const ownerOf = (text: string): LockOwner => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'number' ? { pid: value } : (value as LockOwner);
  } catch {
    return { pid: 0 };
  }
};
const ownerAlive = async (o: LockOwner) =>
  alive(o.pid) && (!o.started || o.started === (await started(o.pid)));

export function fileStore<T extends Versioned>(
  dir: string,
  o: { lockWaitMs?: number; recoverDeadLocks?: boolean } = {},
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
    const metadata = { pid: process.pid, started: await started(process.pid) };
    const mine = await temp(file, JSON.stringify(metadata));
    try {
      for (const until = Date.now() + wait; ; ) {
        try {
          await link(mine, l);
          return l;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
        if (o.recoverDeadLocks) {
          const owner = ownerOf(await readFile(l, 'utf8').catch(() => ''));
          if (Number.isSafeInteger(owner.pid) && owner.pid > 0 && !(await ownerAlive(owner))) {
            // Each contender has its own atomic choosing/ticket file. A dead contender can be
            // removed without ever unlinking a successor's coordination file.
            const prefix = `${file.slice(file.lastIndexOf('/') + 1)}.recovery.`;
            const participant = `${l.slice(0, -5)}.recovery.${process.pid}.${randomBytes(8).toString('hex')}.participant`;
            const peers = async () => {
              const result: { name: string; pid: number; choosing: boolean; ticket: number }[] = [];
              for (const name of await readdir(dir)) {
                if (!name.startsWith(prefix) || !name.endsWith('.participant')) continue;
                const path = join(dir, name);
                let peer: { pid: number; choosing: boolean; ticket: number };
                try {
                  peer = JSON.parse(await readFile(path, 'utf8'));
                } catch (e) {
                  if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
                  throw e;
                }
                if (
                  !Number.isSafeInteger(peer.pid) ||
                  peer.pid <= 0 ||
                  !Number.isSafeInteger(peer.ticket) ||
                  peer.ticket < 0 ||
                  typeof peer.choosing !== 'boolean'
                )
                  throw new Error('invalid store recovery state');
                if (!(await ownerAlive(peer))) {
                  await unlink(path).catch((e: NodeJS.ErrnoException) => {
                    if (e.code !== 'ENOENT') throw e;
                  });
                  continue;
                }
                result.push({ ...peer, name });
              }
              return result;
            };
            const choosing = await temp(
              file,
              JSON.stringify({ ...metadata, choosing: true, ticket: 0 }),
            );
            await rename(choosing, participant);
            try {
              const ticket = 1 + Math.max(0, ...(await peers()).map((p) => p.ticket));
              await rename(
                await temp(file, JSON.stringify({ ...metadata, choosing: false, ticket })),
                participant,
              );
              const name = participant.slice(participant.lastIndexOf('/') + 1);
              while (
                (await peers()).some(
                  (p) =>
                    p.name !== name &&
                    (p.choosing || p.ticket < ticket || (p.ticket === ticket && p.name < name)),
                )
              ) {
                if (Date.now() > until) throw new Error('the store is busy: recovery is running');
                await sleep(20);
              }
              const current = ownerOf(await readFile(l, 'utf8').catch(() => ''));
              if (
                Number.isSafeInteger(current.pid) &&
                current.pid > 0 &&
                !(await ownerAlive(current))
              )
                await unlink(l).catch((e: NodeJS.ErrnoException) => {
                  if (e.code !== 'ENOENT') throw e;
                });
            } finally {
              await unlink(participant).catch(() => {});
            }
            continue;
          }
        }
        if (Date.now() > until) {
          const owner = ownerOf(await readFile(l, 'utf8').catch(() => ''));
          throw new Error(
            Number.isSafeInteger(owner.pid) && owner.pid > 0 && !(await ownerAlive(owner))
              ? `the store is locked by ${l}, left by process ${owner.pid}, which is not running: remove that file once no other process uses the store`
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

/** Call before opening service stores; release only after all in-flight writes have drained. */
export async function ownDirectory(dir: string): Promise<() => Promise<void>> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const store = fileStore<Versioned & { pid: number; started: string }>(dir, {
    lockWaitMs: 0,
    recoverDeadLocks: true,
  });
  const key = 'exclusive-process-owner';
  const old = await store.load(key);
  if (old && (await ownerAlive(old))) throw new Error('the store is busy: another process owns it');
  const mine = {
    id: key,
    revision: (old?.revision ?? -1) + 1,
    pid: process.pid,
    started: await started(process.pid),
  };
  if (!(await store.compareAndSet(key, old, mine)))
    throw new Error('the store is busy: another process owns it');
  const sweep = async (path: string) => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.lock.recovery')) await rmdir(file);
        else await sweep(file);
      } else if (
        entry.name.endsWith('.lock') ||
        entry.name.endsWith('.tmp') ||
        entry.name.endsWith('.participant')
      )
        await unlink(file);
    }
  };
  await sweep(dir);
  let released: Promise<void> | undefined;
  return () =>
    (released ??= (async () => {
      await store.compareAndSet(key, mine, null);
    })());
}
