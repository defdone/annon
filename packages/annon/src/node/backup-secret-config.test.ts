import { lstat, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createAdapter } from './adapter.js';
import { defaultBackupSecretPath } from './backup-secret.js';
import { runCli } from './cli.js';

const homeConfig = () => join(homedir(), '.config', 'annon', 'config.json');
const launcherConfig = () => join(homedir(), 'launcher', 'config.json');

async function initJson(env: Record<string, string> = {}, extra: string[] = []) {
  const out: string[] = [];
  const code = await runCli(['init', '--json', ...extra], createAdapter(env), (t) => out.push(t));
  expect(out).toHaveLength(1);
  return {
    code,
    ...(JSON.parse(out[0] as string) as { error?: { code: string; message: string } }),
  };
}
const write = async (path: string, text: string, mode = 0o600) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, { mode });
};
afterEach(async () => {
  for (const name of ['.config', 'launcher'])
    await rm(join(homedir(), name), { recursive: true, force: true });
});

it.each([
  ['malformed home config', async () => write(homeConfig(), '{bad'), {}],
  ['unreadable home config', async () => write(homeConfig(), '{}', 0o000), {}],
  [
    'malformed launcher config',
    async () => write(launcherConfig(), '{bad'),
    { ANNON_CONFIG: launcherConfig() },
  ],
  [
    'unreadable launcher config',
    async () => write(launcherConfig(), '{}', 0o000),
    { ANNON_CONFIG: launcherConfig() },
  ],
  [
    'launcher config beside a malformed home config',
    async () => {
      await write(homeConfig(), '{bad');
      await write(launcherConfig(), '{}');
    },
    { ANNON_CONFIG: launcherConfig() },
  ],
])('bare init with a %s fails as setup, exit 2, and creates nothing', async (_, setup, env) => {
  await setup();
  const result = await initJson(env);
  expect(result).toMatchObject({ code: 2, error: { code: 'backup_secret_required' } });
  expect(result.error?.message).toMatch(/config could not be read to check agent policy/);
  await expect(lstat(defaultBackupSecretPath())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('a malformed --config is caught by the saved-state check with the same exit code', async () => {
  await write(launcherConfig(), '{bad');
  expect(await initJson({}, ['--config', launcherConfig()])).toMatchObject({
    code: 2,
    error: { code: 'backup_secret_required', message: expect.stringMatching(/could not check/) },
  });
});

it('keeps policy refusals unchanged', async () => {
  await write(homeConfig(), JSON.stringify({ agent: true }));
  expect(await initJson()).toMatchObject({ code: 2, error: { code: 'agent_policy' } });
  await write(launcherConfig(), '{}');
  expect(await initJson({ ANNON_CONFIG: launcherConfig() })).toMatchObject({
    code: 2,
    error: { code: 'config_conflict' },
  });
  await expect(lstat(defaultBackupSecretPath())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('leaves init --agent errors as they were', async () => {
  await write(homeConfig(), '{bad');
  const out: string[] = [];
  const argv = ['init', '--agent', '--daily-budget', '1', '--new-key', '--json'];
  expect(await runCli(argv, createAdapter({}), (t) => out.push(t))).toBe(1);
  expect(JSON.parse(out[0] as string)).toMatchObject({ error: { code: 'operation_failed' } });
});
