import { mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultBackupSecretPath, findBackupSecret, readBackupSecret } from './backup-secret.js';
import { publicError } from './errors.js';

const A = 'a1'.repeat(32);
const B = 'b2'.repeat(32);
const C = 'c3'.repeat(32);
const D = 'd4'.repeat(32);
const scratch = () => join(homedir(), 'scratch');
const file = async (name: string, text: string, mode = 0o600) => {
  const path = join(scratch(), name);
  await mkdir(scratch(), { recursive: true });
  await writeFile(path, text, { mode });
  return path;
};
const provisionDefault = async (text = `${D}\n`, mode = 0o600) => {
  await mkdir(dirname(defaultBackupSecretPath()), { recursive: true, mode: 0o700 });
  await writeFile(defaultBackupSecretPath(), text, { mode });
};
const hexOf = (secret: Uint8Array) => Buffer.from(secret).toString('hex');
afterEach(async () => {
  for (const dir of ['.config', 'scratch'])
    await rm(join(homedir(), dir), { recursive: true, force: true });
});

describe('precedence', () => {
  it('uses the flag file, then the environment file, then the environment value, then the default', async () => {
    await provisionDefault();
    const flag = await file('flag', A);
    const envFile = await file('env', B);
    const env = { ANNON_BACKUP_SECRET_FILE: envFile, ANNON_BACKUP_SECRET: C };
    const pick = async (o: { backupSecretFile?: string }, e: Record<string, string>) => {
      const found = await findBackupSecret(o, e);
      return {
        hex: hexOf(found?.secret ?? new Uint8Array()),
        source: found?.source,
        path: found?.path,
      };
    };
    expect(await pick({ backupSecretFile: flag }, env)).toEqual({
      hex: A,
      source: 'flag-file',
      path: flag,
    });
    expect(await pick({}, env)).toEqual({ hex: B, source: 'env-file', path: envFile });
    expect(await pick({}, { ANNON_BACKUP_SECRET: C })).toEqual({
      hex: C,
      source: 'env',
      path: undefined,
    });
    expect(await pick({}, {})).toEqual({
      hex: D,
      source: 'default-file',
      path: defaultBackupSecretPath(),
    });
  });

  it('keeps the empty-selector behavior: an empty file selector falls through to the value, then the default', async () => {
    await provisionDefault();
    const envFile = await file('env', B);
    // `??` keeps an empty flag, which selects no file even when the environment names one.
    expect(
      hexOf(
        await readBackupSecret(
          { backupSecretFile: '' },
          { ANNON_BACKUP_SECRET_FILE: envFile, ANNON_BACKUP_SECRET: C },
        ),
      ),
    ).toBe(C);
    expect(
      hexOf(
        await readBackupSecret({ backupSecretFile: '' }, { ANNON_BACKUP_SECRET_FILE: envFile }),
      ),
    ).toBe(D);
    expect(
      hexOf(await readBackupSecret({}, { ANNON_BACKUP_SECRET_FILE: '', ANNON_BACKUP_SECRET: '' })),
    ).toBe(D);
  });

  it('accepts an optional 0x prefix and surrounding whitespace, and keeps rejecting uppercase hex', async () => {
    expect(hexOf(await readBackupSecret({}, { ANNON_BACKUP_SECRET: ` 0x${A}\n` }))).toBe(A);
    expect(
      hexOf(await readBackupSecret({ backupSecretFile: await file('x', `\n0x${A}  \n`) }, {})),
    ).toBe(A);
    await expect(readBackupSecret({}, { ANNON_BACKUP_SECRET: A.toUpperCase() })).rejects.toThrow();
    await provisionDefault(`0x${D}\r\n`);
    expect(hexOf(await readBackupSecret({}, {}))).toBe(D);
  });

  it('keeps accepting an explicit legacy file with broad permissions and never changes it', async () => {
    const legacy = await file('legacy', A, 0o644);
    expect(hexOf(await readBackupSecret({ backupSecretFile: legacy }, {}))).toBe(A);
    expect((await stat(legacy)).mode & 0o777).toBe(0o644);
    expect(await readFile(legacy, 'utf8')).toBe(A);
  });
});

describe('no silent fallback', () => {
  it.each([
    [
      'a missing flag file',
      async () => ({
        o: { backupSecretFile: join(scratch(), 'missing') },
        env: { ANNON_BACKUP_SECRET_FILE: await file('ok', B), ANNON_BACKUP_SECRET: C },
      }),
    ],
    [
      'a malformed flag file',
      async () => ({
        o: { backupSecretFile: await file('bad', 'ab'.repeat(31)) },
        env: { ANNON_BACKUP_SECRET: C },
      }),
    ],
    [
      'a missing environment file',
      async () => ({
        o: {},
        env: { ANNON_BACKUP_SECRET_FILE: join(scratch(), 'missing'), ANNON_BACKUP_SECRET: C },
      }),
    ],
    [
      'a directory as environment file',
      async () => ({ o: {}, env: { ANNON_BACKUP_SECRET_FILE: scratch() } }),
    ],
    [
      'an invalid environment value',
      async () => ({ o: {}, env: { ANNON_BACKUP_SECRET: 'not-a-secret' } }),
    ],
  ])('fails on %s even with a valid default and lower-priority values', async (_, setup) => {
    await provisionDefault();
    await mkdir(scratch(), { recursive: true });
    const { o, env } = await setup();
    const error = await readBackupSecret(o, env).catch((e) => e);
    expect(publicError(error)).toMatchObject({ code: 'backup_secret_required', exitCode: 2 });
    expect(publicError(error).message).toMatch(/selected backup secret source/);
    expect(publicError(error).message).not.toMatch(/annon init/);
  });

  it('reports a missing secret with the setup instructions when nothing is selected or present', async () => {
    const error = await readBackupSecret({}, {}).catch((e) => e);
    expect(publicError(error)).toMatchObject({ code: 'backup_secret_required', exitCode: 2 });
    expect(publicError(error).message).toMatch(/run `annon init` before enabling agent mode/);
    expect(await findBackupSecret({}, {})).toBeUndefined();
  });
});

describe('managed default file', () => {
  it.each([
    ['group-readable', async () => provisionDefault(`${D}\n`, 0o640)],
    ['other-readable', async () => provisionDefault(`${D}\n`, 0o604)],
    ['owner-unreadable', async () => provisionDefault(`${D}\n`, 0o200)],
    ['malformed', async () => provisionDefault('d4'.repeat(31))],
    ['oversized', async () => provisionDefault(`${D}\n${' '.repeat(300)}`)],
    ['a directory', async () => mkdir(defaultBackupSecretPath(), { recursive: true })],
    [
      'a symlink to a valid private secret',
      async () => {
        await mkdir(dirname(defaultBackupSecretPath()), { recursive: true });
        await symlink(await file('target', D), defaultBackupSecretPath());
      },
    ],
    [
      'a dangling symlink',
      async () => {
        await mkdir(dirname(defaultBackupSecretPath()), { recursive: true });
        await symlink(join(scratch(), 'nowhere'), defaultBackupSecretPath());
      },
    ],
  ])('refuses a %s default without repairing it', async (_, setup) => {
    await setup();
    const before = await stat(defaultBackupSecretPath()).catch(() => undefined);
    const error = await readBackupSecret({}, {}).catch((e) => e);
    expect(publicError(error)).toMatchObject({ code: 'backup_secret_required', exitCode: 2 });
    expect(publicError(error).message).toMatch(/never repairs or replaces it/);
    expect(JSON.stringify(publicError(error))).not.toContain('d4d4');
    const after = await stat(defaultBackupSecretPath()).catch(() => undefined);
    expect(after?.mode).toBe(before?.mode);
    expect(after?.size).toBe(before?.size);
  });
});
