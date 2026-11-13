import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { secureUrl } from '../download/download.js';
import { fileStore } from '../pay/store-node.js';
import { account, network } from '../settle-near/codec.js';
import { type DiscoveryConfig, validateDiscoveryConfig } from '../shops/discovery.js';
import { agentPolicy, configPath, type SignerConfig, validateSigner } from './agent.js';
import type { Input } from './cli.js';
import { AdapterError } from './errors.js';
import { resourceAllowed } from './resources.js';
import type { Environment } from './wallets.js';

export interface Config extends DiscoveryConfig {
  signer?: SignerConfig;
  dailyBudget?: string;
  agent?: boolean;
  contractId: string;
  nearRpc: string;
  baseRpc: string;
  network: string;
  stateDir: string;
  workDir?: string;
  relayer?: string;
  maxPrice?: string;
  trustContract?: boolean;
  mpcKey?: string;
  moderators?: string[];
  origins?: Record<
    string,
    {
      fromChain: string;
      fromAsset: string;
      refundTo?: string;
      maxSourceAmount?: string;
      usdcDecimals?: number;
    }
  >;
  allowedResources?: string[];
  storageBudget?: string;
  maxProtocolFee?: { fixed: string; bps: number };
}
export async function loadConfig(
  o: Input,
  env: Environment,
  login = false,
  forcedAgent = false,
): Promise<Config> {
  const pinnedAgent = await agentPolicy(o, env, forcedAgent);
  try {
    let file: Partial<Config> = {};
    const path = configPath(o, env);
    try {
      file = JSON.parse(await readFile(path, 'utf8')) as Partial<Config>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const agent = pinnedAgent || file.agent === true;
    if (
      agent &&
      (typeof file.maxPrice !== 'string' || !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(file.maxPrice))
    )
      throw new AdapterError(
        'max_price_required',
        'Agent mode requires maxPrice in the pinned config.',
        2,
      );
    const policyEnv = agent && env.ANNON_AGENT !== 'true' ? {} : env;
    const c: Config = {
      contractId: o.contractId ?? policyEnv.ANNON_CONTRACT_ID ?? file.contractId ?? '',
      nearRpc:
        o.nearRpc ??
        policyEnv.ANNON_NEAR_RPC ??
        file.nearRpc ??
        (login
          ? (o.network ?? policyEnv.ANNON_NETWORK ?? file.network ?? 'near:mainnet') ===
            'near:testnet'
            ? 'https://rpc.testnet.fastnear.com'
            : 'https://rpc.mainnet.fastnear.com'
          : ''),
      baseRpc: o.baseRpc ?? policyEnv.ANNON_BASE_RPC ?? file.baseRpc ?? '',
      network: o.network ?? policyEnv.ANNON_NETWORK ?? file.network ?? 'near:mainnet',
      stateDir:
        o.stateDir ??
        (agent ? undefined : env.ANNON_STATE_DIR) ??
        file.stateDir ??
        join(homedir(), '.local', 'share', 'annon'),
    };
    Object.assign(c, validateDiscoveryConfig(file));
    const workDir = (env.ANNON_AGENT === 'true' ? env.ANNON_WORK_DIR : undefined) ?? file.workDir;
    if (agent && (typeof workDir !== 'string' || !workDir.trim()))
      throw new AdapterError(
        'work_dir_required',
        'Agent mode requires an operator-configured workDir.',
        2,
      );
    if (workDir !== undefined) {
      if (typeof workDir !== 'string' || !workDir.trim())
        throw new Error('invalid working directory');
      c.workDir = workDir;
    }
    if (file.maxProtocolFee !== undefined) {
      const fee = file.maxProtocolFee;
      if (
        !fee ||
        typeof fee.fixed !== 'string' ||
        !/^(0|[1-9][0-9]*)$/.test(fee.fixed) ||
        !Number.isSafeInteger(fee.bps) ||
        fee.bps < 0 ||
        fee.bps >= 10000
      )
        throw new Error('invalid protocol fee ceiling');
      c.maxProtocolFee = fee;
    }
    if (file.storageBudget !== undefined) c.storageBudget = file.storageBudget;
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
    const origins = policyEnv.ANNON_ORIGINS ? JSON.parse(policyEnv.ANNON_ORIGINS) : file.origins;
    if (origins) {
      if (typeof origins !== 'object' || Array.isArray(origins)) throw new Error('invalid origins');
      for (const value of Object.values(origins) as NonNullable<Config['origins']>[string][]) {
        if (
          !value ||
          typeof value.fromChain !== 'string' ||
          !value.fromChain ||
          typeof value.fromAsset !== 'string' ||
          !value.fromAsset.startsWith('nep141:') ||
          (value.maxSourceAmount !== undefined &&
            (typeof value.maxSourceAmount !== 'string' ||
              !/^[1-9][0-9]{0,38}$/.test(value.maxSourceAmount) ||
              BigInt(value.maxSourceAmount) >= 2n ** 128n)) ||
          (value.usdcDecimals !== undefined &&
            (!Number.isSafeInteger(value.usdcDecimals) ||
              value.usdcDecimals < 0 ||
              value.usdcDecimals > 255)) ||
          (value.refundTo !== undefined && (typeof value.refundTo !== 'string' || !value.refundTo))
        )
          throw new Error('invalid origin');
        if (agent && value.usdcDecimals === undefined && value.maxSourceAmount === undefined)
          throw new AdapterError(
            'origin_not_allowed',
            'Configure usdcDecimals or maxSourceAmount for every origin.',
            2,
          );
      }
      c.origins = origins;
    }
    const envResources = env.ANNON_ALLOWED_RESOURCES?.split(',');
    for (const list of [file.allowedResources, envResources]) {
      if (list !== undefined) {
        if (!Array.isArray(list)) throw new Error('invalid allowed resources');
        for (const url of list) secureUrl(url);
      }
    }
    const allowedResources = agent
      ? file.allowedResources === undefined
        ? envResources
        : envResources === undefined
          ? file.allowedResources
          : Array.from(
              new Set(
                file.allowedResources.flatMap((rule) =>
                  envResources
                    .filter((other) => resourceAllowed([rule], other))
                    .concat(
                      envResources.some((other) => resourceAllowed([other], rule)) ? [rule] : [],
                    ),
                ),
              ),
            )
      : (envResources ?? file.allowedResources);
    if (allowedResources !== undefined) c.allowedResources = allowedResources;
    const envMax = env.ANNON_MAX_PRICE;
    const units = (value: string) => {
      if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value)) throw new Error('invalid price cap');
      const [whole = '', fraction = ''] = value.split('.');
      return BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
    };
    const maxPrice =
      agent && envMax !== undefined && file.maxPrice !== undefined
        ? units(envMax) < units(file.maxPrice)
          ? envMax
          : file.maxPrice
        : (envMax ?? file.maxPrice);
    if (maxPrice !== undefined) c.maxPrice = maxPrice;
    c.trustContract =
      policyEnv.ANNON_TRUST_CONTRACT === undefined
        ? file.trustContract === true
        : policyEnv.ANNON_TRUST_CONTRACT === 'true';
    const moderators = policyEnv.ANNON_MODERATORS?.split(',') ?? file.moderators;
    if (moderators) {
      for (const moderator of moderators) account(moderator);
      c.moderators = moderators;
    }
    const mpcKey = policyEnv.ANNON_MPC_KEY ?? file.mpcKey;
    if (mpcKey) c.mpcKey = mpcKey;
    const relayer = o.relayer ?? policyEnv.ANNON_RELAYER ?? file.relayer;
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
