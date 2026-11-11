import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { secureUrl } from '../download/download.js';
import { fileStore } from '../pay/store-node.js';
import { account, network } from '../settle-near/codec.js';
import type { Input } from './cli.js';
import { AdapterError } from './errors.js';
import type { Environment } from './wallets.js';

export interface Config {
  contractId: string;
  nearRpc: string;
  baseRpc: string;
  network: string;
  stateDir: string;
  relayer?: string;
  maxPrice?: string;
  trustContract?: boolean;
  mpcKey?: string;
  moderators?: string[];
}
export async function loadConfig(o: Input, env: Environment): Promise<Config> {
  try {
    let file: Partial<Config> = {};
    const path = o.config ?? env.ANNON_CONFIG ?? join(homedir(), '.config', 'annon', 'config.json');
    try {
      file = JSON.parse(await readFile(path, 'utf8')) as Partial<Config>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const c: Config = {
      contractId: o.contractId ?? env.ANNON_CONTRACT_ID ?? file.contractId ?? '',
      nearRpc: o.nearRpc ?? env.ANNON_NEAR_RPC ?? file.nearRpc ?? '',
      baseRpc: o.baseRpc ?? env.ANNON_BASE_RPC ?? file.baseRpc ?? '',
      network: o.network ?? env.ANNON_NETWORK ?? file.network ?? 'near:mainnet',
      stateDir:
        o.stateDir ??
        env.ANNON_STATE_DIR ??
        file.stateDir ??
        join(homedir(), '.local', 'share', 'annon'),
    };
    const maxPrice = env.ANNON_MAX_PRICE ?? file.maxPrice;
    if (maxPrice !== undefined) c.maxPrice = maxPrice;
    c.trustContract =
      env.ANNON_TRUST_CONTRACT === undefined
        ? file.trustContract === true
        : env.ANNON_TRUST_CONTRACT === 'true';
    const moderators = env.ANNON_MODERATORS?.split(',') ?? file.moderators;
    if (moderators) {
      for (const moderator of moderators) account(moderator);
      c.moderators = moderators;
    }
    const mpcKey = env.ANNON_MPC_KEY ?? file.mpcKey;
    if (mpcKey) c.mpcKey = mpcKey;
    const relayer = o.relayer ?? env.ANNON_RELAYER ?? file.relayer;
    if (relayer) c.relayer = relayer;
    account(c.contractId);
    network(c.network);
    for (const endpoint of [c.nearRpc, c.baseRpc, ...(c.relayer ? [c.relayer] : [])]) {
      const url = secureUrl(endpoint);
      if (url.username || url.password || url.search || url.hash)
        throw new Error('endpoint credentials must not appear in prompts');
    }
    if (!c.stateDir || typeof c.stateDir !== 'string') throw new Error('missing state directory');
    return c;
  } catch {
    throw new AdapterError(
      'invalid_config',
      'Set contractId, network, nearRpc and baseRpc in the config file, environment or flags. Endpoints must use HTTPS (HTTP only on localhost).',
      2,
    );
  }
}
export type TrustPrompt = (description: string) => Promise<boolean>;
export async function trustContract(c: Config, explicit: boolean, prompt?: TrustPrompt) {
  const dir = join(c.stateDir, 'trust');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const store = fileStore<{ id: string; revision: number }>(dir);
  const id = JSON.stringify([c.network, c.nearRpc, c.contractId]);
  if (await store.load(id)) return;
  if (
    !explicit &&
    !(await prompt?.(
      `Trust contract ${c.contractId} on ${c.network} via ${c.nearRpc}? This contract controls file key release. Type yes: `,
    ))
  )
    throw new AdapterError(
      'trust_required',
      'Review the configured deployment, then use --trust-contract or trustContract: true. Interactive CLI users can answer the first-use prompt.',
      3,
    );
  await store.compareAndSet(id, null, { id, revision: 0 });
}
