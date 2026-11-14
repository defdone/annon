/** Where the CLI backup secret comes from: an explicit source, else the managed default file. */
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { bytes } from '../settle-near/codec.js';
import type { Input } from './cli.js';
import { AdapterError } from './errors.js';
import type { Environment } from './wallets.js';

export type BackupSecretSource = 'flag-file' | 'env-file' | 'env' | 'default-file';
export interface ResolvedSecret {
  secret: Uint8Array;
  source: BackupSecretSource;
  /** Set for file sources only; never the value of ANNON_BACKUP_SECRET. */
  path?: string;
}

/** Fixed home, like the config anchor: neither XDG nor --config/--state-dir move it. */
export const defaultBackupSecretPath = () => join(homedir(), '.config', 'annon', 'backup-secret');

const secretError = (message: string) => new AdapterError('backup_secret_required', message, 2);
const missingSecret = () =>
  secretError(
    'No backup secret is available. For first-time human setup, run `annon init` before enabling agent mode. If you have saved records or backups, restore their matching secret instead. Unattended callers must ask their operator to provision it.',
  );
const invalidExplicit = () =>
  secretError(
    'The selected backup secret source could not be read as a 32-byte secret (64 hex characters). Fix that source; Annon does not fall back to another one.',
  );
export const unsafeDefault = () =>
  secretError(
    'The backup secret file at ~/.config/annon/backup-secret is unreadable, malformed or not private (owner-only regular file required). Fix or restore it; Annon never repairs or replaces it.',
  );

/** Trimmed lowercase hex with an optional 0x prefix, exactly 32 bytes. */
export function parseSecret(text: string): Uint8Array {
  const value = text.trim();
  return bytes(value.startsWith('0x') ? value : `0x${value}`, 32);
}

/**
 * Reads the managed default without following a symlink and checks the opened file itself.
 * Returns undefined only when nothing exists at the path.
 */
export async function readDefaultSecret(path = defaultBackupSecretPath()) {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw unsafeDefault();
  }
  try {
    const s = await handle.stat();
    if (
      !s.isFile() ||
      s.uid !== process.getuid?.() ||
      (s.mode & 0o077) !== 0 ||
      (s.mode & 0o400) === 0 ||
      s.size > 256
    )
      throw new Error('unsafe');
    return parseSecret(await handle.readFile('utf8'));
  } catch {
    throw unsafeDefault();
  } finally {
    await handle.close();
  }
}

/**
 * Today's explicit precedence first: the file selector (flag ?? environment), then
 * ANNON_BACKUP_SECRET; empty values select nothing. A selected source that fails is final.
 * Only with no explicit source is the default file read. Nothing here ever creates a secret.
 * Returns undefined only when no source is selected and no default file exists.
 */
export async function findBackupSecret(
  o: Partial<Input>,
  env: Environment,
): Promise<ResolvedSecret | undefined> {
  const file = o.backupSecretFile ?? env.ANNON_BACKUP_SECRET_FILE;
  if (file || env.ANNON_BACKUP_SECRET) {
    try {
      if (file)
        return {
          secret: parseSecret(await readFile(file, 'utf8')),
          source: o.backupSecretFile ? 'flag-file' : 'env-file',
          path: resolve(file),
        };
      return { secret: parseSecret(env.ANNON_BACKUP_SECRET as string), source: 'env' };
    } catch {
      throw invalidExplicit();
    }
  }
  const path = defaultBackupSecretPath();
  const secret = await readDefaultSecret(path);
  return secret && { secret, source: 'default-file', path };
}

/** The secret a command needs; missing input fails before any side effect that uses it. */
export async function readBackupSecret(o: Partial<Input>, env: Environment): Promise<Uint8Array> {
  const found = await findBackupSecret(o, env);
  if (!found) throw missingSecret();
  return found.secret;
}
