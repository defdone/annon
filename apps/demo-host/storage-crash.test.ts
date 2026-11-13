import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const fault = vi.hoisted(() => ({ active: false }));
vi.mock('node:fs/promises', async (load) => {
  const actual = await load<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      const result = await actual.mkdir(...args);
      if (fault.active && String(args[0]).endsWith('/capacity')) {
        fault.active = false;
        throw new Error('Interrupted initialization');
      }
      return result;
    },
  };
});

import { hostStorage } from './storage.ts';

it('recovers after initialization fails between creating state directories and committing readiness', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'host-interrupted-init-'));
  try {
    fault.active = true;
    await expect(hostStorage(dir)).rejects.toThrow('Interrupted initialization');
    expect(await readFile(join(dir, '.host-initializing'), 'utf8')).toBe('1');
    const recovered = await hostStorage(dir);
    expect(await readFile(join(dir, '.host-ready'), 'utf8')).toBe('2');
    await recovered.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
