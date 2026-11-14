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
  'listingStorage',
  'storageBudget',
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

it.each([false, true])(
  'pins deployment and trust env unless launcher opts in (forced=%s)',
  async (forced) => {
    const { loadConfig } = await import('./config.js');
    read.mockResolvedValue(
      JSON.stringify({
        agent: true,
        contractId: 'annon.near',
        nearRpc: 'https://near.test',
        baseRpc: 'https://base.test',
        network: 'near:mainnet',
        relayer: 'https://relay.test',
        trustContract: false,
        moderators: [],
        mpcKey: 'pinned',
        origins: {},
        workDir: '/work',
        maxPrice: '1',
      }),
    );
    const env = {
      ANNON_CONTRACT_ID: 'other.near',
      ANNON_NEAR_RPC: 'https://other.test',
      ANNON_BASE_RPC: 'https://other.test',
      ANNON_NETWORK: 'near:testnet',
      ANNON_RELAYER: 'https://other.test',
      ANNON_TRUST_CONTRACT: 'true',
      ANNON_MODERATORS: 'other.near',
      ANNON_MPC_KEY: 'other',
      ANNON_ORIGINS: '{}',
    };
    try {
      expect(await loadConfig({ command: 'buy' }, env, false, forced)).toMatchObject({
        contractId: 'annon.near',
        nearRpc: 'https://near.test',
        baseRpc: 'https://base.test',
        network: 'near:mainnet',
        relayer: 'https://relay.test',
        trustContract: false,
        moderators: [],
        mpcKey: 'pinned',
      });
      expect(
        await loadConfig({ command: 'buy' }, { ...env, ANNON_AGENT: 'true' }, false, forced),
      ).toMatchObject({ contractId: 'other.near', trustContract: true, network: 'near:testnet' });
    } finally {
      read.mockReset();
    }
  },
);

it.each([
  { maxSourceAmount: '-1' },
  { maxSourceAmount: '0' },
  { maxSourceAmount: 2 },
  { maxSourceAmount: '340282366920938463463374607431768211456' },
  { usdcDecimals: -1 },
  { usdcDecimals: 0.5 },
  { usdcDecimals: 256 },
])('rejects malformed source spending policy %j', async (patch) => {
  const { loadConfig } = await import('./config.js');
  read.mockResolvedValue(
    JSON.stringify({
      agent: true,
      contractId: 'annon.near',
      nearRpc: 'https://near.test',
      maxPrice: '1',
      workDir: '/work',
      origins: { source: { fromChain: 'base', fromAsset: 'nep141:custom', ...patch } },
    }),
  );
  try {
    await expect(loadConfig({ command: 'buy' }, {})).rejects.toMatchObject({
      code: 'invalid_config',
    });
  } finally {
    read.mockReset();
  }
});

it('requires a configured source cap or USDC precision for every agent origin', async () => {
  const { loadConfig } = await import('./config.js');
  read.mockResolvedValue(
    JSON.stringify({
      agent: true,
      contractId: 'annon.near',
      nearRpc: 'https://near.test',
      maxPrice: '1',
      workDir: '/work',
      origins: { source: { fromChain: 'base', fromAsset: 'nep141:custom' } },
    }),
  );
  try {
    await expect(loadConfig({ command: 'buy' }, {})).rejects.toMatchObject({
      code: 'origin_not_allowed',
    });
  } finally {
    read.mockReset();
  }
});

it('refuses ANNON_CONFIG that would disable home-config agent policy', async () => {
  const { homedir } = await import('node:os');
  const { loadConfig } = await import('./config.js');
  const home = join(homedir(), '.config', 'annon', 'config.json');
  read.mockImplementation(async (path: unknown) =>
    JSON.stringify(path === home ? { agent: true } : {}),
  );
  try {
    await expect(
      loadConfig({ command: 'buy' }, { ANNON_CONFIG: '/alternate/config.json' }),
    ).rejects.toMatchObject({ code: 'config_conflict' });
  } finally {
    read.mockReset();
  }
});

it('retains validated discovery fields in purchase config without weakening pinned policy', async () => {
  const { loadConfig } = await import('./config.js');
  const discovery = {
    shopDirectoryUrl: 'https://directory.test/list',
    shops: [{ manifest: 'https://shop.test/.well-known/annon-shop.json', id: 'mine' }],
    defaultShop: 'mine',
  };
  read.mockResolvedValue(
    JSON.stringify({
      ...discovery,
      agent: true,
      contractId: 'annon.near',
      nearRpc: 'https://near.test',
      workDir: '/work',
      maxPrice: '1',
    }),
  );
  try {
    expect(await loadConfig({ command: 'buy' }, {})).toMatchObject({
      ...discovery,
      agent: true,
      maxPrice: '1',
    });
  } finally {
    read.mockReset();
  }
});
