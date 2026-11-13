import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { hostStorage } from './storage.ts';

it('takes exclusive ownership before cleaning orphan files and refuses missing state on populated storage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-state-'));
  try {
    const first = await hostStorage(dir);
    await expect(hostStorage(dir)).rejects.toThrow();
    await writeFile(join(dir, 'seller', 'orphan.tmp'), 'orphan');
    await writeFile(join(dir, 'seller', 'orphan.lock'), 'orphan');
    await first.ready();
    await first.close();
    const second = await hostStorage(dir);
    await expect(readFile(join(dir, 'seller', 'orphan.tmp'))).rejects.toThrow();
    await second.close();
    await rm(join(dir, 'downloads'), { recursive: true });
    await expect(hostStorage(dir)).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const populated = await mkdtemp(join(tmpdir(), 'host-unknown-'));
  try {
    await mkdir(join(populated, 'seller'));
    await writeFile(join(populated, 'seller', 'record.json'), '{}');
    const migrated = await hostStorage(populated);
    expect(await readFile(join(populated, 'seller', 'record.json'), 'utf8')).toBe('{}');
    await migrated.close();
  } finally {
    await rm(populated, { recursive: true, force: true });
  }
});
it('recovers a reused container PID using its process start stamp and keeps ownership on close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-reused-pid-'));
  try {
    const first = await hostStorage(dir, { processStamp: async () => 'old' });
    await first.ready();
    const second = await hostStorage(dir, { processStamp: async () => 'new' });
    await first.close();
    await expect(hostStorage(dir, { processStamp: async () => 'new' })).rejects.toThrow('busy');
    await second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('seeds every state and commits readiness before returning on a legacy or empty first boot', async () => {
  for (const legacy of [false, true]) {
    const dir = await mkdtemp(join(tmpdir(), 'host-seed-'));
    try {
      if (legacy) {
        await mkdir(join(dir, 'seller'));
        await writeFile(join(dir, 'seller', 'evidence.json'), 'preserved');
      }
      const first = await hostStorage(dir);
      expect(await readFile(join(dir, '.host-ready'), 'utf8')).toBe('2');
      await first.close();
      const second = await hostStorage(dir);
      const { hostCapacity } = await import('./capacity.ts');
      const { facilitatorFor } = await import('./facilitator.ts');
      const { fileStore } = await import('../../packages/annon/src/pay/store-node.ts');
      await (await hostCapacity(join(dir, 'capacity'), { requireState: true })).sweep();
      const f = facilitatorFor({ ethBalance: async () => 10n ** 18n } as never, 10, Date.now, {
        store: fileStore(join(dir, 'facilitator')),
        requireState: true,
      });
      await f.sample();
      if (legacy)
        expect(await readFile(join(dir, 'seller', 'evidence.json'), 'utf8')).toBe('preserved');
      await second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});
it('refuses partial manual seeding and unknown populated layouts', async () => {
  for (const entry of ['capacity', 'downloads', 'facilitator', 'unknown']) {
    const dir = await mkdtemp(join(tmpdir(), 'host-partial-'));
    try {
      await mkdir(join(dir, entry));
      await expect(hostStorage(dir)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

it('refuses a seller entry that is not a directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-legacy-file-'));
  try {
    await writeFile(join(dir, 'seller'), 'not a directory');
    await expect(hostStorage(dir)).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('recovers an interrupted first initialization without resetting an existing ledger', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-init-crash-'));
  try {
    await writeFile(join(dir, '.host-initializing'), '1');
    await mkdir(join(dir, 'seller'));
    await mkdir(join(dir, 'capacity'));
    const host = await hostStorage(dir);
    expect(await readFile(join(dir, '.host-ready'), 'utf8')).toBe('2');
    await host.close();
    const next = await hostStorage(dir);
    await next.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects invalid readiness versions and a changed owner during recovery', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'host-owner-race-'));
  try {
    const host = await hostStorage(dir);
    await host.close();
    await writeFile(join(dir, '.host-ready'), '3');
    await expect(hostStorage(dir)).rejects.toMatchObject({ reason: 'state_invalid' });
    await writeFile(join(dir, '.host-ready'), '2');
    await mkdir(join(dir, '.host-lock'));
    const old = { pid: process.pid, stamp: 'old', token: 'old' };
    await writeFile(join(dir, '.host-lock/pid'), JSON.stringify(old));
    let calls = 0;
    await expect(
      hostStorage(dir, {
        processStamp: async () => {
          if (++calls === 2)
            await writeFile(
              join(dir, '.host-lock/pid'),
              JSON.stringify({ ...old, token: 'changed' }),
            );
          return 'new';
        },
      }),
    ).rejects.toThrow('owner changed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
