import { execFile, spawn } from 'node:child_process';
import { access, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
import { contract, fileId, nearRpc, sealedFile, workspace } from '../../test/commands.js';
import { createAdapter, type Dependencies } from './adapter.js';
import { defaultBackupSecretPath } from './backup-secret.js';
import { type Input, runCli } from './cli.js';
import { publicError } from './errors.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn(), spawn: vi.fn(), exec: vi.fn() }));

const purchaseId = `0x${'77'.repeat(32)}`;
const homeConfig = () => join(homedir(), '.config', 'annon', 'config.json');
const absent = (path: string) => expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });

/** Runs the CLI like main.ts does, capturing stdout lines and stderr notices separately. */
async function cli(argv: string[], env: Record<string, string> = {}, d: Dependencies = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runCli(
    argv,
    createAdapter(env, { ...d, notify: (m) => stderr.push(m) }),
    (t) => stdout.push(t),
  );
  return { code, stdout, stderr };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of ['.config', '.local'])
    await rm(join(homedir(), dir), { recursive: true, force: true });
});

describe('annon init', () => {
  it('--json writes one stdout object; the one-time notice goes to stderr; the secret appears nowhere', async () => {
    const consoleCalls = ['log', 'info', 'warn', 'error', 'debug'].map((m) =>
      vi.spyOn(console, m as 'log').mockImplementation(() => {}),
    );
    const first = await cli(['init', '--json']);
    const secret = (await readFile(defaultBackupSecretPath(), 'utf8')).trim();
    expect(first.code).toBe(0);
    expect(first.stdout).toEqual([
      JSON.stringify({
        ok: true,
        result: {
          configured: true,
          backupSecret: { source: 'default-file', path: defaultBackupSecretPath(), created: true },
          // Added by the config step; without a terminal or --deployment it writes nothing.
          config: {
            path: homeConfig(),
            state: 'none',
            howTo:
              'Add one with annon init --deployment defdone, or write your own: https://github.com/defdone/annon/blob/master/docs/quickstart.md#2-configure',
          },
        },
      }),
    ]);
    expect(first.stderr).toEqual([
      [
        `Created a plaintext backup-secret file with owner-only permissions: ${defaultBackupSecretPath()}`,
        'Back up this file separately in protected storage. Losing it loses access to local saved purchase and sell records and backup files. Wallet-based purchase recovery through the contract still works.',
        'Copy the file without displaying its contents. To restore it, select the copied file with ANNON_BACKUP_SECRET_FILE.',
      ].join('\n'),
    ]);
    const again = await cli(['init']);
    expect(JSON.parse(again.stdout.join(''))).toMatchObject({
      result: { backupSecret: { created: false } },
    });
    expect(again.stderr).toEqual([]);
    const ws = await workspace('init-exposure');
    try {
      const outputs = [
        await cli(
          ['status', purchaseId, '--json', '--config', ws.config],
          {},
          { purchase: async () => null },
        ),
        await cli(
          ['stop', fileId, '--json', '--config', ws.config],
          {},
          {
            sdk: () => {
              throw new Error(`boom ${secret}`);
            },
          },
        ),
      ];
      const bad = join(ws.dir, 'bad-secret');
      await writeFile(bad, `${secret.slice(0, 63)}z`);
      outputs.push(await cli(['init', '--json', '--backup-secret-file', bad]));
      outputs.push(await cli(['init', '--json'], { ANNON_BACKUP_SECRET: `${secret}zz` }));
      const everything = JSON.stringify([
        first,
        again,
        outputs,
        consoleCalls.map((c) => c.mock.calls),
      ]);
      expect(everything).not.toContain(secret);
      expect(everything).not.toContain(secret.slice(0, 32));
      expect(outputs.slice(2).map((o) => o.code)).toEqual([2, 2]);
    } finally {
      await ws.remove();
    }
    for (const fn of [execFile, spawn]) expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    ['--daily-budget', '1'],
    ['--new-key'],
    ['--key-env', 'KEY'],
    ['--recovery', 'near:buyer.near'],
    ['--wallet', 'evm'],
    ['--near-key-file', 'key.json'],
    ['--contract-id', 'annon.near'],
    ['--trust-contract'],
  ])('bare init refuses %s instead of ignoring it, before writing', async (...flag) => {
    const out = await cli(['init', ...flag, '--json']);
    expect(out.code).toBe(2);
    expect(JSON.parse(out.stdout.join(''))).toMatchObject({
      ok: false,
      error: { code: 'invalid_arguments' },
    });
    await absent(dirname(defaultBackupSecretPath()));
  });

  it('active agent policy refuses bare init before any secret work', async () => {
    const forced = await cli(['init', '--json'], {}, { agent: true });
    const env = await cli(['init', '--json'], { ANNON_AGENT: 'true' });
    await mkdir(dirname(homeConfig()), { recursive: true });
    await writeFile(homeConfig(), JSON.stringify({ agent: true }));
    const saved = await cli(['init', '--json']);
    for (const out of [forced, env, saved])
      expect(JSON.parse(out.stdout.join(''))).toMatchObject({ error: { code: 'agent_policy' } });
    await absent(defaultBackupSecretPath());
  });

  it('init --agent keeps its signer result and neither creates nor requires a backup secret', async () => {
    const out = await cli([
      'init',
      '--agent',
      '--daily-budget',
      '1',
      '--recovery',
      'near:agent.near',
      '--key-env',
      'AGENT_KEY',
      '--json',
    ]);
    expect(JSON.parse(out.stdout.join(''))).toEqual({
      ok: true,
      result: {
        configured: true,
        mode: 'env',
        identity: { kind: 'near', id: 'agent.near' },
        dailyBudget: '1',
      },
    });
    expect(out.stderr).toEqual([]);
    await absent(defaultBackupSecretPath());
  });
});

describe('no accidental creation', () => {
  const agentConfig = async (stateDir: string) => {
    await mkdir(dirname(homeConfig()), { recursive: true });
    await writeFile(
      homeConfig(),
      JSON.stringify({
        contractId: contract,
        nearRpc,
        stateDir,
        trustContract: true,
        workDir: stateDir,
        maxPrice: '1',
        dailyBudget: '1',
      }),
    );
  };

  it.each([
    ['human TTY', {}, { prompt: async () => true }],
    ['--json', { json: true }, {}],
    ['non-TTY', {}, {}],
    ['forced agent', {}, { agent: true }],
  ] as const)(
    '%s: consuming commands fail or report pending without creating a secret',
    async (_, extra, deps) => {
      const ws = await workspace('no-create');
      const agent = 'agent' in deps;
      if (agent) await agentConfig(ws.dir);
      const wallet = vi.fn();
      const sdk = vi.fn();
      const sealed = await sealedFile();
      const local = join(ws.dir, 'file.pay2');
      await writeFile(local, sealed.file);
      try {
        const run = createAdapter(agent ? {} : { ANNON_CONFIG: ws.config }, {
          ...deps,
          wallet,
          sdk,
          purchase: async () => null,
          file: async () => sealed.info,
          browser: async () => {
            throw new Error('no browser in tests');
          },
        });
        const call = (o: Omit<Input, 'json'>) => run({ ...o, ...extra } as Input).catch((e) => e);
        expect(await call({ command: 'status', target: purchaseId })).toMatchObject({
          state: 'pending',
        });
        expect(await call({ command: 'verify', target: local })).toMatchObject({ verified: true });
        for (const o of [
          { command: 'stop', target: fileId },
          { command: 'recover', recovery: 'near:buyer.near' },
          { command: 'open', target: purchaseId, file: local, output: join(ws.dir, 'out') },
        ] as const)
          expect(publicError(await call(o))).toMatchObject({
            code: 'backup_secret_required',
            exitCode: 2,
          });
        if (!agent) expect(publicError(await call({ command: 'login' }))).toBeTruthy();
        expect(wallet).not.toHaveBeenCalled();
        expect(sdk).not.toHaveBeenCalled();
        for (const dir of ['records', 'backups', 'out']) await absent(join(ws.dir, dir));
        await absent(defaultBackupSecretPath());
      } finally {
        await ws.remove();
      }
    },
  );
});

describe('annon --version', () => {
  it.each([[['--version']], [['-v']]])(
    '%s prints the bare package version without running a command',
    async (argv) => {
      const execute = vi.fn();
      const lines: string[] = [];
      expect(await runCli(argv, execute, (t) => lines.push(t))).toBe(0);
      expect(lines).toEqual([pkg.version]);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('--json returns one object, and agent mode does not refuse it', async () => {
    const lines: string[] = [];
    const agentAdapter = createAdapter({ ANNON_AGENT: 'true' }, { agent: true });
    expect(await runCli(['--version', '--json'], agentAdapter, (t) => lines.push(t))).toBe(0);
    expect(lines).toEqual([JSON.stringify({ ok: true, result: { version: pkg.version } })]);
    await expect(access(homeConfig())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('is not a command option', async () => {
    const lines: string[] = [];
    expect(await runCli(['status', purchaseId, '--version'], vi.fn(), (t) => lines.push(t))).toBe(
      2,
    );
  });
});
