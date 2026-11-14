import { constants } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { nearPayment, purchaseRecord, workspace } from '../../test/commands.js';
import { Annon } from '../api/annon.js';
import {
  type EncryptedRecord,
  encryptedPurchaseStore,
  exportPurchase,
  importPurchase,
} from '../pay/backup.js';
import { purchaseKey } from '../pay/purchase.js';
import { fileStore } from '../pay/store-node.js';
import { createAdapter } from './adapter.js';
import { defaultBackupSecretPath, readBackupSecret } from './backup-secret.js';
import { initBackupSecret } from './backup-secret-init.js';
import { publicError } from './errors.js';

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(join(homedir(), '.config'), { recursive: true, force: true });
});

/** status against the saved record; acceptance is scripted, decryption is real. */
const status = (configPath: string, id: string) =>
  createAdapter(
    { ANNON_CONFIG: configPath },
    {
      purchase: async () => null,
      sdk: (options) => {
        const sdk = new Annon(options);
        vi.spyOn(sdk, 'accept').mockResolvedValue(true);
        return sdk;
      },
    },
  )({ command: 'status', target: id });

it('a lost default never comes back by itself; init refuses over saved state; the restored copy opens the record', async () => {
  const ws = await workspace('loss');
  const keep = join(ws.dir, 'kept-backup-secret');
  try {
    await initBackupSecret({ stateDir: ws.dir }, {});
    const record = purchaseRecord();
    await mkdir(join(ws.dir, 'records'), { recursive: true });
    await encryptedPurchaseStore(
      fileStore<EncryptedRecord>(join(ws.dir, 'records')),
      await readBackupSecret({}, {}),
    ).compareAndSet(purchaseKey(record.id), null, record);
    expect(await status(ws.config, record.id)).toMatchObject({
      state: 'accepted',
      payment: nearPayment,
    });

    // The documented exclusive copy: refuses an existing destination and keeps mode 0600.
    await copyFile(defaultBackupSecretPath(), keep, constants.COPYFILE_EXCL);
    await expect(
      copyFile(defaultBackupSecretPath(), keep, constants.COPYFILE_EXCL),
    ).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect((await stat(keep)).mode & 0o777).toBe(0o600);

    await rm(defaultBackupSecretPath());
    expect(await status(ws.config, record.id)).toMatchObject({
      state: 'pending',
      next: expect.stringMatching(/restore its matching backup secret/),
    });
    const refused = await initBackupSecret({ config: ws.config }, {}).catch((e) => e);
    expect(publicError(refused).message).toMatch(/Saved records or backups already exist/);
    await expect(stat(defaultBackupSecretPath())).rejects.toMatchObject({ code: 'ENOENT' });

    await copyFile(keep, defaultBackupSecretPath(), constants.COPYFILE_EXCL);
    expect(await status(ws.config, record.id)).toMatchObject({
      state: 'accepted',
      payment: nearPayment,
    });
  } finally {
    await ws.remove();
  }
});

it('a wrong default secret keeps status pending instead of switching sources', async () => {
  const ws = await workspace('wrong-default');
  try {
    const record = purchaseRecord();
    await mkdir(join(ws.dir, 'records'), { recursive: true });
    await encryptedPurchaseStore(
      fileStore<EncryptedRecord>(join(ws.dir, 'records')),
      new Uint8Array(32).fill(0xcd),
    ).compareAndSet(purchaseKey(record.id), null, record);
    await mkdir(dirname(defaultBackupSecretPath()), { recursive: true, mode: 0o700 });
    await writeFile(defaultBackupSecretPath(), 'ab'.repeat(32), { mode: 0o600 });
    expect(await status(ws.config, record.id)).toMatchObject({ state: 'pending' });
  } finally {
    await ws.remove();
  }
});

it('a second machine restores by explicit file and decrypts a known portable backup', async () => {
  await initBackupSecret({}, {});
  const record = purchaseRecord();
  const portable = await exportPurchase(record, await readBackupSecret({}, {}));
  const saved = await readFile(defaultBackupSecretPath());

  const firstHome = process.env.HOME;
  const secondHome = await mkdtemp(join(tmpdir(), 'annon-second-home-'));
  process.env.HOME = secondHome;
  try {
    const restored = join(secondHome, 'private', 'restored-annon-backup-secret');
    await mkdir(dirname(restored), { mode: 0o700 });
    await writeFile(restored, saved, { mode: 0o600, flag: 'wx' });
    const secret = await readBackupSecret({}, { ANNON_BACKUP_SECRET_FILE: restored });
    expect(await importPurchase(portable, secret)).toEqual(record);
    // Restoring needs no init, and selecting the file never creates the default.
    await expect(stat(defaultBackupSecretPath())).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    process.env.HOME = firstHome;
    await rm(secondHome, { recursive: true, force: true });
  }
});
