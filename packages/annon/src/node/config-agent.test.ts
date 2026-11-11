import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const read = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  readFile: read,
}));
it('ignores config and state environment redirection in forced agent mode', async () => {
  const { homedir } = await import('node:os');
  const { loadConfig } = await import('./config.js');
  const pinned = join(homedir(), '.config', 'annon', 'config.json');
  read.mockImplementation(async (path: unknown) => {
    if (path === pinned)
      return JSON.stringify({
        dailyBudget: '1',
        stateDir: '/pinned/ledger',
        contractId: 'annon.near',
        nearRpc: 'https://fake.rpc',
      });
    throw new Error('read redirected config');
  });
  try {
    const c = await loadConfig(
      { command: 'buy' },
      { ANNON_AGENT: 'true', ANNON_STATE_DIR: '/evil/ledger' },
    );
    expect(c).toMatchObject({ agent: true, dailyBudget: '1', stateDir: '/pinned/ledger' });
    expect(read.mock.calls.every(([path]) => path === pinned)).toBe(true);
  } finally {
    read.mockReset();
  }
});

it('refuses a different ANNON_CONFIG in forced agent mode instead of ignoring it', async () => {
  const { loadConfig } = await import('./config.js');
  await expect(
    loadConfig({ command: 'buy' }, { ANNON_AGENT: 'true', ANNON_CONFIG: '/evil/config.json' }),
  ).rejects.toMatchObject({ code: 'config_conflict' });
});
