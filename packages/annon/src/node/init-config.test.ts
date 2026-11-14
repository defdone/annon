import { lstat, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { terms } from '../../test/fixtures.js';
import { termsHash } from '../settle-near/terms.js';
import { createAdapter, type Dependencies } from './adapter.js';
import { defaultBackupSecretPath } from './backup-secret.js';
import { runCli } from './cli.js';
import { defaultStateDir, loadConfig } from './config.js';
import { deploymentQuestion } from './init-config.js';
import { shareHost } from './sharing.js';
import { catalogRow } from './shops.js';

const homeConfig = () => join(homedir(), '.config', 'annon', 'config.json');
const absent = (path: string) => expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
const howTo =
  'Add one with annon init --deployment defdone, or write your own: https://github.com/defdone/annon/blob/master/docs/quickstart.md#2-configure';

/** The JSON in docs/quickstart.md section 2 is what the preset writes, with the real stateDir. */
async function documented() {
  const doc = await readFile(new URL('../../../../docs/quickstart.md', import.meta.url), 'utf8');
  const section = doc.slice(doc.indexOf('## 2.'), doc.indexOf('## 3.'));
  const json = /```json\n([\s\S]*?)```/.exec(section)?.[1];
  return { ...JSON.parse(json as string), stateDir: defaultStateDir() };
}

/** Like main.ts: human text unless --json; `ask` stands for a terminal. */
async function cli(argv: string[], env: Record<string, string> = {}, d: Dependencies = {}) {
  const stdout: string[] = [];
  const code = await runCli(
    argv,
    createAdapter(env, { notify: () => {}, ...d }),
    (t) => stdout.push(t),
    { human: !argv.includes('--json') },
  );
  const text = stdout.join('\n');
  return { code, text, json: argv.includes('--json') ? JSON.parse(text) : undefined };
}
const terminal = (answer: string | undefined) => vi.fn(async (_: string) => answer);

afterEach(async () => {
  for (const dir of ['.config', '.local', 'custom'])
    await rm(join(homedir(), dir), { recursive: true, force: true });
});

describe('init --deployment defdone', () => {
  it('writes the preset owner-only, reports both files, and the CLI loads it with the demo shop approved', async () => {
    const out = await cli(['init', '--deployment', 'defdone', '--json']);
    expect(out.code).toBe(0);
    expect(out.json).toEqual({
      ok: true,
      result: {
        configured: true,
        backupSecret: { source: 'default-file', path: defaultBackupSecretPath(), created: true },
        config: { path: homeConfig(), state: 'created', deployment: 'defdone' },
      },
    });
    const expected = await documented();
    expect(JSON.parse(await readFile(homeConfig(), 'utf8'))).toEqual(expected);
    expect((await stat(homeConfig())).mode & 0o777).toBe(0o600);
    expect((await readdir(dirname(homeConfig()))).filter((n) => n.endsWith('.tmp'))).toEqual([]);

    const config = await loadConfig({ command: 'share', target: 'f' }, {});
    expect(config).toMatchObject({
      contractId: expected.contractId,
      network: expected.network,
      nearRpc: expected.nearRpc,
      relayer: expected.relayer,
      maxPrice: expected.maxPrice,
      stateDir: expected.stateDir,
      defaultShop: 'demo',
    });

    const profile = expected.shops[0].profile;
    const contractTerms = { ...terms, contract: profile.contract };
    const manifest = {
      version: 1,
      name: 'Demo',
      shopUrl: 'https://annon.dev/',
      network: profile.network,
      contract: profile.contract,
      relayer: profile.relayer,
      host: profile.host,
      catalog: {
        url: `${profile.host}/files.json`,
        format: 'annon-catalog-array-v1',
        search: 'client',
      },
    };
    const entry = {
      name: 'notes',
      fileId: contractTerms.file_id,
      title: 'Notes',
      description: 'A file',
      url: `${profile.host}/f/notes`,
      header: `${profile.host}/f/notes/header`,
      byteSize: 100,
      plaintextSize: 1,
      createdAt: 1,
      expiresAt: null,
      termsHash: termsHash(contractTerms),
      terms: contractTerms,
      salesStopped: false,
      takenDown: false,
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url) === expected.shops[0].manifest) return Response.json(manifest);
      if (String(url) === manifest.catalog.url) return Response.json([entry]);
      throw new Error(`unexpected fetch ${url}`);
    });
    expect(await shareHost(config, undefined, fetch)).toBe(profile.host);
    const adapter = createAdapter({}, { fetch });
    expect(await adapter({ command: 'shops' })).toMatchObject({
      items: [{ id: 'demo', trusted: true }],
    });
    expect(await adapter({ command: 'catalog' })).toMatchObject({
      items: [{ url: entry.url }],
      total: 1,
    });
    expect(await catalogRow({ command: 'buy', target: '1' }, {}, undefined, fetch)).toMatchObject({
      target: entry.url,
    });
  });

  it('writes to --config or ANNON_CONFIG, never the home path, without asking', async () => {
    const flag = join(homedir(), 'custom', 'flag', 'config.json');
    const env = join(homedir(), 'custom', 'env', 'config.json');
    const ask = terminal('n');
    const a = await cli(
      ['init', '--deployment', 'defdone', '--json', '--config', flag],
      {},
      { ask },
    );
    expect(a.json.result.config).toEqual({ path: flag, state: 'created', deployment: 'defdone' });
    const b = await cli(['init', '--deployment', 'defdone'], { ANNON_CONFIG: env }, { ask });
    expect(b.text.split('\n')[0]).toBe(`Config created (defdone deployment): ${env}`);
    expect(ask).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(env, 'utf8'))).toEqual(await documented());
    await absent(homeConfig());
  });

  it.each([
    [['init', '--deployment', 'other']],
    [['init', '--deployment', '']],
    [['init', '--deployment', 'DEFDONE']],
    [['init', '--agent', '--daily-budget', '1', '--new-key', '--deployment', 'defdone']],
    [['status', '--deployment', 'defdone']],
  ])('refuses %j with invalid_arguments, exit 2, before writing anything', async (argv) => {
    const out = await cli([...argv, '--json']);
    expect(out.code).toBe(2);
    expect(out.json).toMatchObject({ ok: false, error: { code: 'invalid_arguments' } });
    await absent(dirname(homeConfig()));
  });
});

describe('bare init in a terminal asks once', () => {
  it.each(['', 'y', 'Yes'])('answer %j writes the preset', async (answer) => {
    const ask = terminal(answer);
    const out = await cli(['init'], {}, { ask });
    expect(ask.mock.calls).toEqual([[deploymentQuestion]]);
    expect(deploymentQuestion).toBe(
      'Use the Annon deployment run by defdone (contract v1.annon.defdone.near, relayer relayer.mainnet.annon.dev, demo shop)? [Y/n] ',
    );
    expect(out.text).toBe(
      [
        `Config created (defdone deployment): ${homeConfig()}`,
        `Backup secret created: ${defaultBackupSecretPath()}`,
        'Next: annon login --wallet near',
      ].join('\n'),
    );
    expect(JSON.parse(await readFile(homeConfig(), 'utf8'))).toEqual(await documented());
  });

  it.each(['n', 'no', 'later', undefined])(
    'answer %j writes no config, says how to add one and still creates the secret',
    async (answer) => {
      const out = await cli(['init'], {}, { ask: terminal(answer) });
      expect(out.code).toBe(0);
      expect(out.text).toBe(
        [
          `No config written. ${howTo}`,
          `Backup secret created: ${defaultBackupSecretPath()}`,
          'Next: annon login --wallet near',
        ].join('\n'),
      );
      await absent(homeConfig());
    },
  );
});

describe('without a terminal or the flag', () => {
  it('creates no config, only the backup secret, and says how to add one', async () => {
    const ask = terminal('y');
    for (const out of [await cli(['init', '--json']), await cli(['init', '--json'], {}, { ask })])
      expect(out.json.result).toEqual({
        configured: true,
        backupSecret: expect.objectContaining({ source: 'default-file' }),
        config: { path: homeConfig(), state: 'none', howTo },
      });
    expect(ask).not.toHaveBeenCalled();
    expect((await cli(['init'])).text.split('\n')[0]).toBe(`No config written. ${howTo}`);
    await absent(homeConfig());
    await expect(lstat(defaultBackupSecretPath())).resolves.toBeTruthy();
  });
});

describe('an existing path is never changed', () => {
  it('keeps an existing config byte for byte in every mode, without asking', async () => {
    const text = '{"contractId":"mine.near", "nearRpc":"https://near.test"}';
    await mkdir(dirname(homeConfig()), { recursive: true, mode: 0o700 });
    await writeFile(homeConfig(), text, { mode: 0o644 });
    const ask = terminal('y');
    const flag = await cli(['init', '--deployment', 'defdone', '--json']);
    expect(flag.json.result).toMatchObject({
      config: { path: homeConfig(), state: 'kept' },
      backupSecret: { created: true },
    });
    expect((await cli(['init', '--json'])).json.result.config.state).toBe('kept');
    expect((await cli(['init'], {}, { ask })).text).toBe(
      [
        `Config kept: ${homeConfig()} (existing file, not changed)`,
        `Backup secret checked: ${defaultBackupSecretPath()}`,
        'Next: annon login --wallet near',
      ].join('\n'),
    );
    expect(ask).not.toHaveBeenCalled();
    expect(await readFile(homeConfig(), 'utf8')).toBe(text);
    expect((await stat(homeConfig())).mode & 0o777).toBe(0o644);
  });

  it.each([
    [
      'a dangling symlink',
      'invalid_config',
      async (path: string) => symlink(join(dirname(path), 'target.json'), path),
    ],
    [
      'a symlink to a file',
      'invalid_config',
      async (path: string) => {
        await writeFile(join(dirname(path), 'target.json'), '{}');
        await symlink(join(dirname(path), 'target.json'), path);
      },
    ],
    // The agent-policy read already stops at a directory, as before.
    ['a directory', 'backup_secret_required', async (path: string) => mkdir(path)],
  ])(
    'refuses %s at the path, exit 2, without following it or creating the secret',
    async (_, code, setup) => {
      await mkdir(dirname(homeConfig()), { recursive: true, mode: 0o700 });
      await setup(homeConfig());
      const before = await readdir(dirname(homeConfig()));
      const target = join(dirname(homeConfig()), 'target.json');
      const targetText = await readFile(target, 'utf8').catch(() => undefined);
      const out = await cli(['init', '--deployment', 'defdone', '--json']);
      expect(out.code).toBe(2);
      expect(out.json.error.code).toBe(code);
      expect(await readdir(dirname(homeConfig()))).toEqual(before);
      expect(await readFile(target, 'utf8').catch(() => undefined)).toBe(targetText);
      await absent(defaultBackupSecretPath());
    },
  );
});

describe('agent mode is unchanged', () => {
  it('init --agent writes only its signer settings, asks nothing and reports no config field', async () => {
    const ask = terminal('y');
    const out = await cli(
      [
        'init',
        '--agent',
        '--daily-budget',
        '1',
        '--recovery',
        'near:agent.near',
        '--key-env',
        'AGENT_KEY',
        '--json',
      ],
      {},
      { ask },
    );
    expect(out.json.result.config).toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
    const saved = JSON.parse(await readFile(homeConfig(), 'utf8'));
    expect(saved.shops).toBeUndefined();
    expect(saved.relayer).toBeUndefined();
    expect(saved.maxPrice).toBeUndefined();
  });

  it('active agent policy refuses bare init, with or without the flag, and creates no config', async () => {
    for (const out of [
      await cli(['init', '--json'], {}, { agent: true }),
      await cli(['init', '--deployment', 'defdone', '--json'], { ANNON_AGENT: 'true' }),
    ])
      expect(out.json).toMatchObject({ error: { code: 'agent_policy' } });
    await absent(homeConfig());
  });
});
