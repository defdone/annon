import { constants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultBackupSecretPath } from './backup-secret.js';
import { initBackupSecret } from './backup-secret-init.js';
import { publicError } from './errors.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    link: vi.fn(actual.link),
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
    unlink: vi.fn(actual.unlink),
  };
});
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

const appDir = () => dirname(defaultBackupSecretPath());
const D = 'd4'.repeat(32);
const init = (o = {}, env: Record<string, string> = {}) => {
  const notify = vi.fn();
  return { notify, run: initBackupSecret(o, env, notify) };
};
const failure = async (promise: Promise<unknown>) => publicError(await promise.catch((e) => e));
const leftovers = async () => (await readdir(appDir())).filter((n) => n.endsWith('.tmp'));
const creates = () =>
  vi
    .mocked(open)
    .mock.calls.filter(([, flags]) => typeof flags === 'number' && flags & constants.O_CREAT);
afterEach(async () => {
  // Back to the real implementations, with call history cleared.
  for (const fn of [link, open, rename, unlink]) vi.mocked(fn).mockReset();
  for (const dir of ['.config', '.local', 'scratch'])
    await rm(join(homedir(), dir), { recursive: true, force: true });
});

it('runs with an isolated HOME, never the developer home', () => {
  expect(homedir()).not.toBe(userInfo().homedir);
});

describe('creation', () => {
  it('creates 32 random bytes as 64 lowercase hex, owner-only from the first write under umask 0', async () => {
    const old = process.umask(0);
    try {
      const { notify, run } = init();
      expect(await run).toEqual({
        configured: true,
        backupSecret: { source: 'default-file', path: defaultBackupSecretPath(), created: true },
      });
      const text = await readFile(defaultBackupSecretPath(), 'utf8');
      expect(text).toMatch(/^[0-9a-f]{64}\n$/);
      expect((await stat(defaultBackupSecretPath())).mode & 0o777).toBe(0o600);
      expect((await stat(appDir())).mode & 0o777).toBe(0o700);
      expect((await stat(dirname(appDir()))).mode & 0o777).toBe(0o700);
      const [temp, flags, mode] = creates()[0] ?? [];
      expect(String(temp)).toMatch(/\.backup-secret\.[0-9a-f]{16}\.tmp$/);
      expect(flags).toBe(constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      expect(mode).toBe(0o600);
      expect(await leftovers()).toEqual([]);
      expect(notify).toHaveBeenCalledOnce();
      expect(notify.mock.calls[0]?.[0]).not.toContain(text.trim());
    } finally {
      process.umask(old);
    }
  });

  it('publishes with a non-overwriting link, never rename, and keeps a secret that appeared first', async () => {
    vi.mocked(link).mockImplementationOnce(async (temp, path) => {
      expect(await readFile(temp, 'utf8')).toMatch(/^[0-9a-f]{64}\n$/);
      // A concurrent invocation publishes between this one's write and its link.
      await writeFile(path, `${D}\n`, { mode: 0o600 });
      await actual.link(temp, path);
    });
    const { notify, run } = init();
    expect(await run).toMatchObject({ backupSecret: { created: false } });
    expect(await readFile(defaultBackupSecretPath(), 'utf8')).toBe(`${D}\n`);
    expect(rename).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(await leftovers()).toEqual([]);
  });

  it('converges concurrent init calls on one complete secret with one creation and one notice', async () => {
    const runs = Array.from({ length: 8 }, () => init());
    const results = await Promise.all(runs.map((r) => r.run));
    const created = results.filter((r) => (r.backupSecret as { created: boolean }).created);
    expect(created).toHaveLength(1);
    expect(runs.flatMap((r) => r.notify.mock.calls)).toHaveLength(1);
    expect(await readFile(defaultBackupSecretPath(), 'utf8')).toMatch(/^[0-9a-f]{64}\n$/);
    expect(await leftovers()).toEqual([]);
  });

  it('repeats without rewriting: same bytes, inode, mode and no second notice', async () => {
    await init().run;
    const before = await stat(defaultBackupSecretPath());
    const text = await readFile(defaultBackupSecretPath(), 'utf8');
    const { notify, run } = init();
    expect(await run).toMatchObject({ backupSecret: { source: 'default-file', created: false } });
    const after = await stat(defaultBackupSecretPath());
    expect([after.ino, after.mode, after.mtimeMs]).toEqual([
      before.ino,
      before.mode,
      before.mtimeMs,
    ]);
    expect(await readFile(defaultBackupSecretPath(), 'utf8')).toBe(text);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('never overwrites or repairs', () => {
  it.each([
    ['malformed', async () => writeFile(defaultBackupSecretPath(), 'not hex', { mode: 0o600 })],
    ['group-readable', async () => writeFile(defaultBackupSecretPath(), D, { mode: 0o640 })],
    [
      'a symlink to a valid secret',
      async () => {
        await mkdir(join(homedir(), 'scratch'));
        await writeFile(join(homedir(), 'scratch', 's'), D, { mode: 0o600 });
        await symlink(join(homedir(), 'scratch', 's'), defaultBackupSecretPath());
      },
    ],
    [
      'a dangling symlink',
      async () => symlink(join(homedir(), 'nowhere'), defaultBackupSecretPath()),
    ],
  ])('refuses a %s default', async (_, setup) => {
    await mkdir(appDir(), { recursive: true, mode: 0o700 });
    await setup();
    const before = await lstat(defaultBackupSecretPath());
    const { notify, run } = init();
    expect(await failure(run)).toMatchObject({ code: 'backup_secret_required', exitCode: 2 });
    const after = await lstat(defaultBackupSecretPath());
    expect([after.ino, after.mode, after.size]).toEqual([before.ino, before.mode, before.size]);
    if (after.isSymbolicLink()) expect(await readlink(defaultBackupSecretPath())).toBeTruthy();
    await expect(lstat(join(homedir(), 'nowhere'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(link).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('validates an explicit file as input only, never writing, chmodding or creating anything', async () => {
    const scratch = join(homedir(), 'scratch');
    await mkdir(scratch);
    const legacy = join(scratch, 'legacy');
    await writeFile(legacy, D, { mode: 0o644 });
    const before = await stat(legacy);
    expect(await init({ backupSecretFile: legacy }).run).toEqual({
      configured: true,
      backupSecret: { source: 'flag-file', path: legacy, created: false },
    });
    expect(await init({}, { ANNON_BACKUP_SECRET_FILE: legacy }).run).toMatchObject({
      backupSecret: { source: 'env-file', created: false },
    });
    const after = await stat(legacy);
    expect([after.mode, after.mtimeMs]).toEqual([before.mode, before.mtimeMs]);
    const missing = join(scratch, 'missing');
    expect(await failure(init({ backupSecretFile: missing }).run)).toMatchObject({
      code: 'backup_secret_required',
    });
    expect(await failure(init({}, { ANNON_BACKUP_SECRET_FILE: missing }).run)).toMatchObject({
      code: 'backup_secret_required',
    });
    await expect(lstat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(appDir())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reports an environment value without its content or a path', async () => {
    const result = await init({}, { ANNON_BACKUP_SECRET: D }).run;
    expect(result).toEqual({ configured: true, backupSecret: { source: 'env', created: false } });
    expect(JSON.stringify(result)).not.toContain(D);
    await expect(lstat(appDir())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    [
      'writable by others',
      async () => mkdir(appDir(), { recursive: true }).then(() => chmod(appDir(), 0o777)),
    ],
    [
      'a symlink',
      async () => {
        await mkdir(join(homedir(), 'scratch'), { mode: 0o700 });
        await mkdir(dirname(appDir()), { recursive: true });
        await symlink(join(homedir(), 'scratch'), appDir());
      },
    ],
  ])('refuses an application directory that is %s without changing it', async (_, setup) => {
    await setup();
    const before = await lstat(appDir());
    expect(await failure(init().run)).toMatchObject({ code: 'backup_secret_required' });
    expect((await lstat(appDir())).mode).toBe(before.mode);
    expect(creates()).toEqual([]);
    await expect(lstat(join(homedir(), 'scratch', 'backup-secret'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('interrupted creation', () => {
  const failingHandle = (method: 'writeFile' | 'sync', onlyFor?: string) =>
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args);
      if (!onlyFor || args[0] === onlyFor)
        vi.spyOn(handle, method).mockRejectedValue(
          Object.assign(new Error('EIO'), { code: 'EIO' }),
        );
      return handle;
    });

  it.each(['writeFile', 'sync'] as const)(
    'a failed %s leaves no final or temporary file',
    async (method) => {
      failingHandle(method);
      const { notify, run } = init();
      const error = await failure(run);
      expect(error).toMatchObject({ code: 'backup_secret_required', exitCode: 2 });
      expect(error.message).not.toMatch(/EIO/);
      await expect(lstat(defaultBackupSecretPath())).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await leftovers()).toEqual([]);
      expect(link).not.toHaveBeenCalled();
      expect(notify).not.toHaveBeenCalled();
    },
  );

  it('a failed publication switches to nothing else and leaves no file', async () => {
    vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    const { run } = init();
    expect(await failure(run)).toMatchObject({ code: 'backup_secret_required' });
    await expect(lstat(defaultBackupSecretPath())).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await leftovers()).toEqual([]);
    expect(rename).not.toHaveBeenCalled();
  });

  it('a failed directory sync keeps the published secret, and a rerun validates it', async () => {
    failingHandle('sync', appDir());
    const { notify, run } = init();
    expect((await failure(run)).message).toMatch(/created but its directory could not be synced/);
    const text = await readFile(defaultBackupSecretPath(), 'utf8');
    expect(notify).not.toHaveBeenCalled();
    vi.mocked(open).mockReset();
    expect(await init().run).toMatchObject({ backupSecret: { created: false } });
    expect(await readFile(defaultBackupSecretPath(), 'utf8')).toBe(text);
  });
});

describe('saved state guard', () => {
  const state = join(homedir(), 'scratch', 'state');
  const legacy = () => join(homedir(), '.local', 'share', 'annon');
  const seed = async (dir: string, name: 'records' | 'backups') => {
    await mkdir(join(dir, name), { recursive: true });
    await writeFile(join(dir, name, 'entry.json'), '{}');
  };

  it.each([
    ['--state-dir records', async () => seed(state, 'records'), { stateDir: state }, {}],
    ['ANNON_STATE_DIR backups', async () => seed(state, 'backups'), {}, { ANNON_STATE_DIR: state }],
    [
      'config stateDir records',
      async () => {
        await seed(state, 'records');
        await mkdir(join(homedir(), 'scratch'), { recursive: true });
        await writeFile(
          join(homedir(), 'scratch', 'config.json'),
          JSON.stringify({ stateDir: state }),
        );
      },
      { config: join(homedir(), 'scratch', 'config.json') },
      {},
    ],
    [
      'legacy default backups beside another state dir',
      async () => seed(legacy(), 'backups'),
      { stateDir: state },
      {},
    ],
    ['default records', async () => seed(legacy(), 'records'), {}, {}],
  ])('refuses to create over %s', async (_, setup, o, env) => {
    await setup();
    const error = await failure(init(o, env).run);
    expect(error).toMatchObject({ code: 'backup_secret_required', exitCode: 2 });
    expect(error.message).toMatch(/Saved records or backups already exist/);
    await expect(lstat(defaultBackupSecretPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses when the config cannot be read and allows empty state directories', async () => {
    await mkdir(join(homedir(), 'scratch'), { recursive: true });
    const config = join(homedir(), 'scratch', 'config.json');
    await writeFile(config, '{not json');
    expect((await failure(init({ config }).run)).message).toMatch(/could not check the state/);
    await mkdir(join(legacy(), 'records'), { recursive: true });
    await mkdir(join(legacy(), 'backups'), { recursive: true });
    expect(await init().run).toMatchObject({ backupSecret: { created: true } });
  });

  it('does not block validating an existing secret', async () => {
    await seed(legacy(), 'records');
    await mkdir(appDir(), { recursive: true, mode: 0o700 });
    await writeFile(defaultBackupSecretPath(), D, { mode: 0o600 });
    expect(await init().run).toMatchObject({ backupSecret: { created: false } });
  });
});
