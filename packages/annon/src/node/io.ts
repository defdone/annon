import { randomBytes } from 'node:crypto';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AdapterError } from './errors.js';

export async function newOutput(path: string) {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new AdapterError(
    'output_exists',
    'Choose a new output path; the existing file will not be overwritten.',
    2,
  );
}
/** Portable backups are complete and synced before the SDK proceeds to payment or key release. */
export async function writeBackup(path: string, content: string) {
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
    const dir = await open(dirname(path), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } finally {
    await unlink(temp).catch(() => {});
  }
}
