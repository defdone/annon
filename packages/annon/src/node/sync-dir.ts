/** Sync a directory after an atomic filesystem update. */
import { open } from 'node:fs/promises';

export async function syncDir(dir: string) {
  const d = await open(dir, 'r');
  try {
    await d.sync();
  } finally {
    await d.close();
  }
}
