import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const read = vi.hoisted(() => vi.fn());
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof import('node:fs/promises')>()),
  readFile: read,
}));
it('pins config and ignores launcher state override with ANNON_AGENT=true', async () => {
  const { homedir } = await import('node:os');
  const { loadConfig } = await import('./config.js');
  const pinned = join(homedir(), '.config', 'annon', 'config.json');
  read.mockImplementation(async (path: unknown) => {
    if (path === pinned)
      return JSON.stringify({
        dailyBudget: '1',
        maxPrice: '1',
        workDir: '/work',
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

it.each([
  'contractId',
  'nearRpc',
  'baseRpc',
  'relayer',
  'network',
  'trustContract',
  'moderator',
  'maxPrice',
] as const)('refuses per-call %s in agent mode', async (flag) => {
  const { agentPolicy } = await import('./agent.js');
  read.mockResolvedValue(JSON.stringify({ agent: true }));
  try {
    await expect(
      agentPolicy({ command: 'buy', [flag]: flag === 'trustContract' ? true : 'override' }, {}),
    ).rejects.toMatchObject({ code: 'agent_policy' });
  } finally {
    read.mockReset();
  }
});
it('requires maxPrice in the agent config and ignores untrusted policy environment', async () => {
  const { loadConfig } = await import('./config.js');
  const saved = {
    agent: true,
    contractId: 'annon.near',
    nearRpc: 'https://fake.rpc',
    stateDir: '/pinned',
    workDir: '/work',
    maxPrice: '1',
    allowedResources: ['https://files.example/a'],
  };
  read.mockResolvedValue(JSON.stringify(saved));
  try {
    const c = await loadConfig(
      { command: 'buy' },
      {
        ANNON_MAX_PRICE: '99',
        ANNON_STATE_DIR: '/evil',
        ANNON_ALLOWED_RESOURCES: 'https://evil.example/a',
      },
    );
    expect(c).toMatchObject({
      maxPrice: '1',
      stateDir: '/pinned',
      allowedResources: [],
    });
    read.mockResolvedValue(JSON.stringify({ ...saved, maxPrice: undefined }));
    await expect(loadConfig({ command: 'buy' }, { ANNON_MAX_PRICE: '1' })).rejects.toMatchObject({
      code: 'max_price_required',
    });
  } finally {
    read.mockReset();
  }
});

it.each(['config', 'launcher', 'forced'] as const)(
  'only tightens price and allowlist in %s agent mode',
  async (trigger) => {
    const { loadConfig } = await import('./config.js');
    const saved = {
      agent: trigger === 'config',
      contractId: 'annon.near',
      nearRpc: 'https://fake.rpc',
      stateDir: '/ledger',
      workDir: '/work',
      maxPrice: '1',
      allowedResources: ['https://files.example/a', 'https://files.example/b'],
    };
    read.mockResolvedValue(JSON.stringify(saved));
    const env = {
      ...(trigger === 'launcher' ? { ANNON_AGENT: 'true' } : {}),
      ANNON_MAX_PRICE: '0.5',
      ANNON_ALLOWED_RESOURCES: 'https://files.example/a,https://evil.example/',
      ANNON_STATE_DIR: '/evil',
    };
    try {
      expect(await loadConfig({ command: 'buy' }, env, false, trigger === 'forced')).toMatchObject({
        stateDir: '/ledger',
        maxPrice: '0.5',
        allowedResources: ['https://files.example/a'],
      });
      expect(
        await loadConfig(
          { command: 'buy' },
          { ...env, ANNON_MAX_PRICE: '99' },
          false,
          trigger === 'forced',
        ),
      ).toMatchObject({ maxPrice: '1' });
    } finally {
      read.mockReset();
    }
  },
);
it('requires config workDir and permits its environment override only for an explicit agent launcher', async () => {
  const { loadConfig } = await import('./config.js');
  const saved = {
    agent: true,
    contractId: 'annon.near',
    nearRpc: 'https://fake.rpc',
    maxPrice: '1',
    workDir: '/work',
  };
  read.mockResolvedValue(JSON.stringify(saved));
  try {
    expect(await loadConfig({ command: 'buy' }, { ANNON_WORK_DIR: '/other' })).toMatchObject({
      workDir: '/work',
    });
    expect(
      await loadConfig({ command: 'buy' }, { ANNON_AGENT: 'true', ANNON_WORK_DIR: '/other' }),
    ).toMatchObject({ workDir: '/other' });
    read.mockResolvedValue(JSON.stringify({ ...saved, workDir: undefined }));
    await expect(
      loadConfig({ command: 'buy' }, { ANNON_WORK_DIR: '/other' }),
    ).rejects.toMatchObject({ code: 'work_dir_required' });
  } finally {
    read.mockReset();
  }
});
