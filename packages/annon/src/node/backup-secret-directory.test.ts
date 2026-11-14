import type { Stats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultBackupSecretPath, readBackupSecret } from './backup-secret.js';
import { initBackupSecret } from './backup-secret-init.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});
const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

const app = () => dirname(defaultBackupSecretPath());
const D = 'd4'.repeat(32);
const refused = { code: 'backup_secret_required', exitCode: 2 };
async function seed() {
  await mkdir(app(), { recursive: true, mode: 0o700 });
  await writeFile(defaultBackupSecretPath(), D, { mode: 0o600 });
}
/** The opened default reports altered metadata, as if the file had changed underneath. */
const openedAs = (change: (s: Stats) => object) =>
  vi.mocked(open).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args);
    const s = await handle.stat();
    vi.spyOn(handle, 'stat').mockResolvedValue({ ...s, ...change(s), isFile: () => true } as never);
    return handle;
  });
afterEach(async () => {
  for (const fn of [lstat, open]) vi.mocked(fn).mockReset();
  for (const name of ['.config', 'elsewhere'])
    await rm(join(homedir(), name), { recursive: true, force: true });
});

describe('the opened default descriptor', () => {
  it('is refused when owned by another uid', async () => {
    await seed();
    openedAs((s) => ({ uid: s.uid + 1 }));
    await expect(readBackupSecret({}, {})).rejects.toMatchObject(refused);
  });

  it('is judged by fstat permissions, not pathname metadata', async () => {
    await seed();
    openedAs((s) => ({ mode: s.mode | 0o040 }));
    await expect(readBackupSecret({}, {})).rejects.toMatchObject(refused);
  });
});

describe('an existing default in an unsafe application directory', () => {
  it.each([
    ['writable by others', async () => chmod(app(), 0o777)],
    ['writable by group', async () => chmod(app(), 0o770)],
    [
      'owned by another user',
      async () => {
        vi.mocked(lstat).mockImplementation(async (path, ...rest) => {
          const s = (await actual.lstat(path, ...rest)) as Stats;
          return (path === app() ? { ...s, uid: s.uid + 1, isDirectory: () => true } : s) as never;
        });
      },
    ],
    [
      'a symlink',
      async () => {
        await rename(app(), join(homedir(), 'elsewhere'));
        await symlink(join(homedir(), 'elsewhere'), app());
      },
    ],
  ])(
    'is refused when the directory is %s, by init and by readers, without changes',
    async (_, unsafe) => {
      await seed();
      await unsafe();
      const before = await actual.lstat(app());
      await expect(initBackupSecret({}, {})).rejects.toMatchObject(refused);
      await expect(readBackupSecret({}, {})).rejects.toMatchObject({
        ...refused,
        message: expect.stringMatching(/does not change existing directories/),
      });
      expect((await actual.lstat(app())).mode).toBe(before.mode);
      expect(await readFile(defaultBackupSecretPath(), 'utf8')).toBe(D);
    },
  );

  it('accepts an existing 0755 directory', async () => {
    await seed();
    await chmod(app(), 0o755);
    expect(await initBackupSecret({}, {})).toMatchObject({ backupSecret: { created: false } });
    expect((await lstat(app())).mode & 0o777).toBe(0o755);
  });

  it('adds no restriction to an explicit source', async () => {
    await seed();
    await chmod(app(), 0o777);
    const file = join(homedir(), 'elsewhere', 'secret');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, D, { mode: 0o644 });
    expect(await initBackupSecret({ backupSecretFile: file }, {})).toMatchObject({
      backupSecret: { source: 'flag-file', created: false },
    });
    expect(await readBackupSecret({}, { ANNON_BACKUP_SECRET: D })).toHaveLength(32);
  });
});
