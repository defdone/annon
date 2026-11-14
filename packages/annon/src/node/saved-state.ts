/** Refuses a new backup secret where saved state already depends on an older one. */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { configPath } from './agent.js';
import type { Input } from './cli.js';
import { defaultStateDir } from './config.js';
import { AdapterError } from './errors.js';
import type { Environment } from './wallets.js';

const savedState = () =>
  new AdapterError(
    'backup_secret_required',
    'Saved records or backups already exist. Restore their matching backup secret or select its existing file. A new secret cannot decrypt them. For wallet recovery with a new secret, preserve the old state and choose a separate empty state directory.',
    2,
  );
const uncheckable = () =>
  new AdapterError(
    'backup_secret_required',
    'Annon could not check the state directory for saved records or backups (unreadable config or state). Fix it before creating a backup secret.',
    2,
  );

async function hasEntries(dir: string) {
  try {
    return (await readdir(dir)).length > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Human state precedence (flag, environment, config, default), read locally without the
 * deployment checks of loadConfig. The legacy default is checked too when it differs.
 */
async function stateDirs(o: Partial<Input>, env: Environment) {
  let file: { stateDir?: unknown } = {};
  try {
    file = JSON.parse(await readFile(configPath(o, env), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const stateDir = o.stateDir ?? env.ANNON_STATE_DIR ?? file.stateDir ?? defaultStateDir();
  if (typeof stateDir !== 'string' || !stateDir) throw new Error('invalid state directory');
  return new Set([resolve(stateDir), resolve(defaultStateDir())]);
}

/** Directory entries only: this cannot see unrelated custom directories or offline backups. */
export async function assertNoSavedState(o: Partial<Input>, env: Environment) {
  let found = false;
  try {
    for (const dir of await stateDirs(o, env))
      for (const name of ['records', 'backups']) found ||= await hasEntries(join(dir, name));
  } catch {
    throw uncheckable();
  }
  if (found) throw savedState();
}
