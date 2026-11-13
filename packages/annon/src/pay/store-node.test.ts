import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { fileStore, ownDirectory } from './store-node.js';

it('takes over a dead writer lock with competing CAS writers, retaining a live lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-store-recover-'));
  try {
    const name = `${createHash('sha256').update('k').digest('hex')}.json.lock`;
    const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], {
      encoding: 'utf8',
    }).stdout.trim();
    await writeFile(join(dir, name), dead);
    const store = fileStore<{ id: string; revision: number }>(dir, {
      lockWaitMs: 1000,
      recoverDeadLocks: true,
    });
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => store.compareAndSet('k', null, { id: 'k', revision: 0 })),
    );
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    await writeFile(join(dir, name), String(process.pid));
    await expect(
      store.compareAndSet('k', { id: 'k', revision: 0 }, { id: 'k', revision: 1 }),
    ).rejects.toThrow(/busy/);
    expect(await readFile(join(dir, name), 'utf8')).toBe(String(process.pid));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('owns the mounted directory exclusively and sweeps crash remnants only after ownership', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-process-lock-'));
  try {
    await writeFile(join(dir, 'orphan.tmp'), 'partial');
    await writeFile(join(dir, 'orphan.lock'), '99999999');
    const release = await ownDirectory(dir);
    await expect(ownDirectory(dir)).rejects.toThrow(/busy/);
    expect(await readdir(dir)).not.toContain('orphan.tmp');
    await release();
    const again = await ownDirectory(dir);
    await again();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('does not let a repeated shutdown release the next process owner', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-owner-handoff-'));
  try {
    const release = await ownDirectory(dir);
    await release();
    const next = await ownDirectory(dir);
    await release();
    await expect(ownDirectory(dir)).rejects.toThrow(/busy/);
    await next();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('recovers even when a crashed recovery attempt left its coordination directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-reaper-crash-'));
  try {
    const file = join(dir, `${createHash('sha256').update('k').digest('hex')}.json.lock`);
    const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], {
      encoding: 'utf8',
    }).stdout.trim();
    await writeFile(file, dead);
    await (await import('node:fs/promises')).mkdir(`${file}.recovery`);
    const store = fileStore<{ id: string; revision: number }>(dir, {
      recoverDeadLocks: true,
      lockWaitMs: 100,
    });
    expect(await store.compareAndSet('k', null, { id: 'k', revision: 0 })).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('recognizes a reused PID by its process birth stamp before reclaiming a lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-pid-reuse-'));
  try {
    const file = join(dir, `${createHash('sha256').update('k').digest('hex')}.json.lock`);
    await writeFile(file, JSON.stringify({ pid: process.pid, started: 'previous-process' }));
    const store = fileStore<{ id: string; revision: number }>(dir, {
      recoverDeadLocks: true,
      lockWaitMs: 100,
    });
    expect(await store.compareAndSet('k', null, { id: 'k', revision: 0 })).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
