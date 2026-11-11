import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { initAgent, validateSigner } from './agent.js';
import { parseCli } from './cli.js';

it('parses login, agent key references and remote signer flags', () => {
  expect(parseCli(['login', '--no-open'])).toMatchObject({ command: 'login', noOpen: true });
  expect(
    parseCli([
      'init',
      '--agent',
      '--signer',
      'https://sign.example',
      '--credential-env',
      'SIGNER_TOKEN',
      '--recovery',
      `evm:0x${'11'.repeat(20)}`,
      '--daily-budget',
      '1',
    ]),
  ).toMatchObject({ command: 'init', agent: true });
});
it('creates straight into an injected keychain and persists only public configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-agent-'));
  const config = join(dir, 'config.json');
  const keychain = {
    read: vi.fn(),
    create: vi.fn(async () => ({
      kind: 'near' as const,
      id: 'bot.near',
      publicKey: 'ed25519:public',
    })),
  };
  try {
    await initAgent(
      {
        command: 'init',
        agent: true,
        wallet: 'near',
        nearAccount: 'bot.near',
        newKey: true,
        keychainEntry: 'bot',
        dailyBudget: '2',
        config,
      },
      { ANNON_CONFIG: config },
      keychain,
    );
    expect(keychain.create).toHaveBeenCalledTimes(1);
    expect(keychain.read).not.toHaveBeenCalled();
    const c = JSON.parse(await readFile(config, 'utf8'));
    expect(c.signer).toMatchObject({ mode: 'keychain', entry: 'bot' });
    expect(c.dailyBudget).toBe('2');
    expect(JSON.stringify(c)).not.toMatch(/private_key|signature|token|SECRET/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('refuses plaintext signer credentials and agents without a daily budget', async () => {
  await expect(
    initAgent(
      { command: 'init', agent: true, signer: 'https://x/?token=SECRET' },
      {},
      { read: vi.fn(), create: vi.fn() },
    ),
  ).rejects.toThrow();
});

it('login works before deployment configuration and saves only public account/chain data', async () => {
  const { createAdapter } = await import('./adapter.js');
  const { privateKeyToAccount } = await import('viem/accounts');
  const signer = privateKeyToAccount(`0x${'42'.repeat(32)}`);
  const dir = await mkdtemp(join(tmpdir(), 'annon-login-'));
  const config = join(dir, 'config.json');
  const close = vi.fn(async () => {});
  const notify = vi.fn();
  try {
    const adapter = createAdapter(
      {},
      {
        notify,
        browser: async () => ({
          url: 'http://127.0.0.1:1234/#CAPABILITY',
          pairingCode: '123456',
          close,
          async request<T>(q: { id: string; expiresAt: number }, verify: (r: T) => Promise<void>) {
            const result = {
              account: signer.address.toLowerCase(),
              signature: await signer.signMessage({
                message: (q as unknown as { payload: { message: string } }).payload.message,
              }),
            } as T;
            await verify(result);
            return result;
          },
        }),
      },
    );
    expect(await adapter({ command: 'login', config })).toMatchObject({
      mode: 'browser',
    });
    const saved = await readFile(config, 'utf8');
    expect(saved).toContain(signer.address.toLowerCase());
    expect(saved).not.toMatch(/CAPABILITY|signature|Annon login/);
    expect(close).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).not.toContain('CAPABILITY');
    expect(notify.mock.calls[0]?.[0]).toContain('ssh -L 1234:127.0.0.1:1234 host');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('persists agent chain/deployment flags together with an environment reference without reading a key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-agent-chain-'));
  const config = join(dir, 'config.json');
  const keychain = { read: vi.fn(), create: vi.fn() };
  try {
    await initAgent(
      {
        command: 'init',
        agent: true,
        wallet: 'near',
        nearAccount: 'bot.testnet',
        keyEnv: 'BOT_KEY',
        network: 'near:testnet',
        nearRpc: 'https://test.rpc',
        contractId: 'files.testnet',
        dailyBudget: '1',
        config,
      },
      { ANNON_CONFIG: config },
      keychain,
    );
    const saved = JSON.parse(await readFile(config, 'utf8'));
    expect(saved).toMatchObject({
      network: 'near:testnet',
      nearRpc: 'https://test.rpc',
      contractId: 'files.testnet',
      signer: { mode: 'env', name: 'BOT_KEY' },
    });
    expect(keychain.read).not.toHaveBeenCalled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(['signer', 'credentialEnv', 'credentialKeychain'] as const)(
  'refuses per-call %s before reading any credentials',
  async (flag) => {
    const { createAdapter } = await import('./adapter.js');
    const dir = await mkdtemp(join(tmpdir(), 'annon-override-'));
    const config = join(dir, 'config.json');
    const keychain = { read: vi.fn(), create: vi.fn() };
    try {
      await writeFile(
        config,
        JSON.stringify({
          signer: {
            mode: 'remote',
            url: 'https://safe.example',
            identity: { kind: 'near', id: 'bot.near' },
            credential: { keychain: 'fake' },
          },
        }),
      );
      await expect(
        createAdapter(
          {},
          { keychain },
        )({
          command: 'buy',
          target: 'https://file.example',
          config,
          [flag]: 'https://evil.example',
        }),
      ).rejects.toMatchObject({ code: 'signer_init_only' });
      expect(keychain.read).not.toHaveBeenCalled();
      expect(() =>
        parseCli([
          'buy',
          'https://file.example',
          `--${flag.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
          'fake',
        ]),
      ).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it('pins agent config and ledger, rejects init/login and disables prompts even with a TTY callback', async () => {
  const { createAdapter } = await import('./adapter.js');
  const { loadConfig } = await import('./config.js');
  const dir = await mkdtemp(join(tmpdir(), 'annon-pinned-'));
  const config = join(dir, 'config.json'),
    stateDir = join(dir, 'ledger');
  const prompt = vi.fn(async () => true),
    keychain = { read: vi.fn(), create: vi.fn() };
  const env = { ANNON_CONFIG: config, ANNON_STATE_DIR: stateDir };
  try {
    await writeFile(
      config,
      JSON.stringify({
        agent: true,
        maxPrice: '1',
        stateDir,
        workDir: stateDir,
        dailyBudget: '1',
        contractId: 'annon.near',
        nearRpc: 'https://rpc.example',
      }),
    );
    await writeFile(join(dir, 'bypass.json'), JSON.stringify({ dailyBudget: '999' }));
    const adapter = createAdapter(env, { prompt, keychain });
    for (const flags of [{ config: join(dir, 'bypass.json') }, { stateDir: join(dir, 'fresh') }])
      await expect(
        adapter({ command: 'buy', target: 'https://file.example', ...flags }),
      ).rejects.toMatchObject({ code: 'agent_policy' });
    for (const command of ['init', 'login'] as const)
      await expect(
        adapter({ command, agent: true, dailyBudget: '999', newKey: true }),
      ).rejects.toMatchObject({ code: 'agent_policy' });
    const c = await loadConfig({ command: 'buy' }, env);
    expect(c.stateDir).toBe(stateDir);
    await expect(
      adapter({ command: 'stop', target: `0x${'11'.repeat(32)}` }),
    ).rejects.toMatchObject({ code: 'trust_required' });
    expect(prompt).not.toHaveBeenCalled();
    expect(keychain.create).not.toHaveBeenCalled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('refuses initializing an unpinned alternate config, before key creation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'annon-init-pin-'));
  const keychain = { read: vi.fn(), create: vi.fn() };
  try {
    await expect(
      initAgent(
        {
          command: 'init',
          agent: true,
          config: join(dir, 'alternate.json'),
          dailyBudget: '1',
          newKey: true,
        },
        { ANNON_CONFIG: join(dir, 'pinned.json') },
        keychain,
      ),
    ).rejects.toMatchObject({ code: 'agent_policy' });
    expect(keychain.create).not.toHaveBeenCalled();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(['file', 'env'] as const)('requires identity on saved %s signers', (mode) => {
  expect(() =>
    validateSigner({
      mode,
      kind: 'evm',
      ...(mode === 'file' ? { file: '/fake' } : { name: 'FAKE' }),
    } as Parameters<typeof validateSigner>[0]),
  ).toThrow(/identity/);
});
