// The real CLI entry in a child process: main.ts routing and a FIFO default, each bounded in time.
import { execFileSync, spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { defaultBackupSecretPath } from './backup-secret.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
let bin: string;
// Bundled from source next to node_modules so its package imports resolve; never a stale dist.
beforeAll(async () => {
  const dir = await mkdtemp(join(root, 'node_modules', '.annon-cli-test-'));
  bin = join(dir, 'main.mjs');
  await build({
    entryPoints: [join(root, 'src/node/main.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    outfile: bin,
    logLevel: 'error',
  });
});
afterAll(() => rm(dirname(bin), { recursive: true, force: true }));
afterEach(async () => {
  for (const dir of ['.config', '.local'])
    await rm(join(homedir(), dir), { recursive: true, force: true });
});

/** Runs the CLI with only HOME and PATH; kills it and fails after `ms`. */
function cli(args: string[], ms = 5_000) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: { HOME: homedir(), PATH: process.env.PATH ?? '' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`annon ${args.join(' ')} did not finish within ${ms} ms`));
    }, ms);
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}

it('init --json prints one JSON line on stdout and the notice on stderr, never the secret', async () => {
  const out = await cli(['init', '--json']);
  const secret = (await readFile(defaultBackupSecretPath(), 'utf8')).trim();
  expect(out.code).toBe(0);
  expect(out.stdout.trimEnd().split('\n')).toHaveLength(1);
  expect(JSON.parse(out.stdout)).toMatchObject({
    ok: true,
    result: { backupSecret: { created: true } },
  });
  expect(out.stderr).toMatch(/^Created a plaintext backup-secret file/);
  expect(out.stdout + out.stderr).not.toContain(secret);
});

it('a FIFO at the default path fails promptly with exit 2 and is neither replaced nor joined by a file', async () => {
  await mkdir(dirname(defaultBackupSecretPath()), { recursive: true, mode: 0o700 });
  execFileSync('mkfifo', ['-m', '600', defaultBackupSecretPath()]);
  const config = { contractId: 'annon.near', nearRpc: 'https://near.test', trustContract: true };
  await writeFile(join(dirname(defaultBackupSecretPath()), 'config.json'), JSON.stringify(config));
  for (const args of [
    ['init', '--json'],
    ['stop', `0x${'55'.repeat(32)}`, '--json'],
  ]) {
    const out = await cli(args);
    expect(out.code).toBe(2);
    expect(JSON.parse(out.stdout)).toMatchObject({ error: { code: 'backup_secret_required' } });
  }
  expect((await lstat(defaultBackupSecretPath())).isFIFO()).toBe(true);
  expect((await readdir(dirname(defaultBackupSecretPath()))).sort()).toEqual([
    'backup-secret',
    'config.json',
  ]);
});
