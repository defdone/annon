import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { secureUrl } from '../download/download.js';
import { fileStore } from '../pay/store-node.js';
import { account, network } from '../settle-near/codec.js';
import { agentPolicy, configPath, type SignerConfig, validateSigner } from './agent.js';
import type { Input } from './cli.js';
import { AdapterError } from './errors.js';
import type { Environment } from './wallets.js';

export interface Config {
  signer?: SignerConfig;
  dailyBudget?: string;
  agent?: boolean;
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
  origins?: Record<string, { fromChain: string; fromAsset: string; refundTo?: string }>;
  allowedResources?: string[];
}
export async function loadConfig(o: Input, env: Environment, login = false): Promise<Config> {
  const pinnedAgent = await agentPolicy(o, env);
  try {
    let file: Partial<Config> = {};
    const path = configPath(o, env);
    try {
      file = JSON.parse(await readFile(path, 'utf8')) as Partial<Config>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const c: Config = {
      contractId: o.contractId ?? env.ANNON_CONTRACT_ID ?? file.contractId ?? '',
      nearRpc:
        o.nearRpc ??
        env.ANNON_NEAR_RPC ??
        file.nearRpc ??
        (login
          ? (o.network ?? env.ANNON_NETWORK ?? file.network ?? 'near:mainnet') === 'near:testnet'
            ? 'https://rpc.testnet.fastnear.com'
            : 'https://rpc.mainnet.fastnear.com'
          : ''),
      baseRpc: o.baseRpc ?? env.ANNON_BASE_RPC ?? file.baseRpc ?? '',
      network: o.network ?? env.ANNON_NETWORK ?? file.network ?? 'near:mainnet',
      stateDir:
        o.stateDir ??
        (env.ANNON_AGENT === 'true' ? undefined : env.ANNON_STATE_DIR) ??
        file.stateDir ??
        join(homedir(), '.local', 'share', 'annon'),
    };
    if (file.signer) c.signer = validateSigner(file.signer);
    if (file.dailyBudget !== undefined) {
      if (
        typeof file.dailyBudget !== 'string' ||
        !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(file.dailyBudget)
      )
        throw new Error('invalid daily budget');
      c.dailyBudget = file.dailyBudget;
    }
    c.agent = pinnedAgent || file.agent === true;
    if (file.agent === true && resolve(path) !== resolve(configPath({}, env)))
      throw new AdapterError(
        'agent_policy',
        'Agent configs must be pinned by the launcher environment.',
        2,
      );
    const origins = env.ANNON_ORIGINS ? JSON.parse(env.ANNON_ORIGINS) : file.origins;
    if (origins) {
      if (typeof origins !== 'object' || Array.isArray(origins)) throw new Error('invalid origins');
      for (const value of Object.values(origins) as NonNullable<Config['origins']>[string][]) {
        if (
          !value ||
          typeof value.fromChain !== 'string' ||
          !value.fromChain ||
          typeof value.fromAsset !== 'string' ||
          !value.fromAsset.startsWith('nep141:') ||
          (value.refundTo !== undefined && (typeof value.refundTo !== 'string' || !value.refundTo))
        )
          throw new Error('invalid origin');
      }
      c.origins = origins;
    }
    const allowedResources = env.ANNON_ALLOWED_RESOURCES?.split(',') ?? file.allowedResources;
    if (allowedResources) {
      if (!Array.isArray(allowedResources)) throw new Error('invalid allowed resources');
      for (const url of allowedResources) secureUrl(url);
      c.allowedResources = allowedResources;
    }
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
    if (!login || c.contractId) account(c.contractId);
    network(c.network);
    for (const endpoint of [
      c.nearRpc,
      ...(c.baseRpc ? [c.baseRpc] : []),
      ...(c.relayer ? [c.relayer] : []),
    ]) {
      const url = secureUrl(endpoint);
      if (url.username || url.password || url.search || url.hash)
        throw new Error('endpoint credentials must not appear in prompts');
    }
    if (!c.stateDir || typeof c.stateDir !== 'string') throw new Error('missing state directory');
    return c;
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError(
      'invalid_config',
      'Set contractId, network and nearRpc (plus baseRpc for Base operations) in the config file, environment or flags. Endpoints must use HTTPS (HTTP only on localhost).',
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
