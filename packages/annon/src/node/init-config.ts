/** Bare `annon init`: an optional deployment preset as the config, then the backup secret. */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { configPath } from './agent.js';
import { initBackupSecret } from './backup-secret-init.js';
import type { Input } from './cli.js';
import type { Dependencies } from './command-context.js';
import { defaultStateDir } from './config.js';
import { AdapterError } from './errors.js';
import { syncDir } from './sync-dir.js';
import type { Environment } from './wallets.js';

const network = 'near:mainnet';
const contractId = 'v1.annon.defdone.near';
const nearRpc = 'https://rpc.mainnet.fastnear.com';
const relayer = 'https://relayer.mainnet.annon.dev';

/**
 * The `defdone` preset: the Annon deployment run by defdone, as in docs/quickstart.md section 2.
 * The demo shop's profile approves this same deployment, so catalog, buy by row and share work.
 * The only source of these values in code.
 */
export const defdoneConfig = (stateDir: string) => ({
  contractId,
  network,
  nearRpc,
  relayer,
  stateDir,
  maxPrice: '0.10',
  shops: [
    {
      id: 'demo',
      manifest: 'https://annon.dev/.well-known/annon-shop.json',
      profile: { network, contract: contractId, nearRpc, relayer, host: 'https://demo.annon.dev' },
    },
  ],
  defaultShop: 'demo',
});

export const deploymentQuestion = `Use the Annon deployment run by defdone (contract ${contractId}, relayer ${new URL(relayer).host}, demo shop)? [Y/n] `;
const ownConfig = 'https://github.com/defdone/annon/blob/master/docs/quickstart.md#2-configure';
const howTo = `Add one with annon init --deployment defdone, or write your own: ${ownConfig}`;

const printable = (path: string) => (/\p{Cc}/u.test(path) ? JSON.stringify(path) : path);
const configError = (message: string) => new AdapterError('invalid_config', message, 2);

/** True when anything (file, symlink, directory, other) exists at the path itself. */
async function existing(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Writes an exclusive owner-only temporary file and publishes it with link(), which never
 * replaces or writes through anything at the path. False when something appeared there meanwhile.
 */
async function createConfig(path: string): Promise<boolean> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${basename(path)}.${randomBytes(8).toString('hex')}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let published: boolean;
  try {
    try {
      await handle.writeFile(`${JSON.stringify(defdoneConfig(defaultStateDir()), null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    published = await link(temp, path).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'EEXIST') return false;
        throw error;
      },
    );
  } finally {
    await unlink(temp).catch(() => {});
  }
  if (published) await syncDir(dir);
  return published;
}

/**
 * Writes only when nothing exists at the path; never changes, replaces or writes through what is
 * there. With nothing there, writes the preset for `--deployment defdone` or a
 * yes in a terminal; otherwise writes nothing and says how to add one.
 */
export async function initConfig(o: Partial<Input>, env: Environment, ask?: Dependencies['ask']) {
  const path = resolve(configPath(o, env));
  try {
    if (await existing(path)) return { path, state: 'kept' };
    const chosen =
      o.deployment === 'defdone' ||
      (!o.json && ask !== undefined && /^(y|yes)?$/i.test((await ask(deploymentQuestion)) ?? 'n'));
    if (!chosen) return { path, state: 'none', howTo };
    return (await createConfig(path))
      ? { path, state: 'created', deployment: 'defdone' }
      : { path, state: 'kept' };
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw configError(
      `The config file could not be created at ${printable(path)}. Fix its directory or select another file with --config, then rerun annon init.`,
    );
  }
}

/** Configuration first, then the backup secret step exactly as before; the result reports both. */
export async function initHuman(
  o: Partial<Input>,
  env: Environment,
  d: Pick<Dependencies, 'ask' | 'notify'>,
): Promise<Record<string, unknown>> {
  const config = await initConfig(o, env, d.ask);
  return { ...(await initBackupSecret(o, env, d.notify)), config };
}
