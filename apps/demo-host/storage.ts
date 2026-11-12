import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { fileStore } from '../../packages/annon/src/pay/store-node.ts';
import { hostCapacity } from './capacity.ts';
import { initFacilitatorState } from './facilitator.ts';
import { StartupError } from './startup-errors.ts';

const areas = ['seller', 'downloads', 'capacity', 'facilitator'] as const;
async function processStamp(pid: number): Promise<string | undefined> {
  try {
    const [boot, record] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'),
    ]);
    const start = record.slice(record.lastIndexOf(')') + 2).split(' ')[19];
    return start ? `${boot.trim()}:${start}` : undefined;
  } catch {
    return undefined;
  }
}
interface Owner {
  pid: number;
  stamp: string | null;
  token: string;
}
/** One mounted-volume owner. Refuse unknown storage rather than resetting durable allowances. */
export async function hostStorage(
  dir: string,
  options: { processStamp?: (pid: number) => Promise<string | undefined> } = {},
) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, '.host-lock');
  const stamp = options.processStamp ?? processStamp;
  const readOwner = async (): Promise<Owner> => {
    const owner = JSON.parse(await readFile(join(lock, 'pid'), 'utf8')) as Owner;
    if (
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.token !== 'string' ||
      !owner.token
    )
      throw new Error('host storage owner is unknown');
    return owner;
  };
  const owner: Owner = {
    pid: process.pid,
    stamp: (await stamp(process.pid)) ?? null,
    token: randomUUID(),
  };
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const old = await readOwner();
    let alive = true;
    try {
      process.kill(old.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
      else throw error;
    }
    const current = await stamp(old.pid);
    if (alive && (!old.stamp || !current || old.stamp === current))
      throw new Error('host storage is busy');
    const recovery = join(dir, '.host-recovery');
    await mkdir(recovery, { mode: 0o700 });
    try {
      if ((await readOwner()).token !== old.token) throw new Error('host storage owner changed');
      await unlink(join(lock, 'pid'));
      await rmdir(lock);
      await mkdir(lock, { mode: 0o700 });
    } finally {
      await rmdir(recovery);
    }
  }
  await writeFile(join(lock, 'pid'), JSON.stringify(owner), { mode: 0o600 });
  const close = async () => {
    if ((await readOwner()).token !== owner.token) return;
    await unlink(join(lock, 'pid'));
    await rmdir(lock);
  };
  try {
    const entries = await readdir(dir);
    const initialized = entries.includes('.host-ready');
    if (!initialized && entries.some((name) => name !== '.host-lock' && name !== 'seller'))
      throw new StartupError('storage_uninitialized');
    for (const area of areas) {
      const path = join(dir, area);
      if (initialized || entries.includes(area)) {
        let exists = false;
        try {
          exists = (await stat(path)).isDirectory();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (!exists) throw new StartupError('state_missing');
      }
      await mkdir(path, { recursive: true, mode: 0o700 });
      for (const name of await readdir(path))
        if (name.endsWith('.lock') || name.endsWith('.tmp')) await unlink(join(path, name));
    }
    if (!initialized) {
      // Only a fresh volume or the seller-only layout can establish empty counters.
      await (await hostCapacity(join(dir, 'capacity'))).sweep();
      await initFacilitatorState(fileStore(join(dir, 'facilitator')));
      const temporary = join(dir, '.host-ready.tmp');
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile('1');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, join(dir, '.host-ready'));
      const handle = await open(dir, 'r');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    return { initialized, close, async ready() {} };
  } catch (e) {
    await close();
    throw e;
  }
}
