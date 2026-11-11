import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { secureUrl } from '../download/download.js';
import { account, network } from '../settle-near/codec.js';
import { type Identity, parseIdentity } from '../settle-near/identity.js';
import type { Input } from './cli.js';
import { AdapterError } from './errors.js';
import { type Keychain, osKeychain } from './keychain.js';
import { remoteSigner } from './signing.js';
import { type Environment, identity } from './wallets.js';
export type SignerConfig =
  | { mode: 'browser'; identity: Identity }
  | { mode: 'file'; kind: 'evm' | 'near' | 'solana'; file: string; identity: Identity }
  | { mode: 'env'; kind: 'evm' | 'near' | 'solana'; name: string; identity: Identity }
  | {
      mode: 'keychain';
      kind: 'evm' | 'near';
      entry: string;
      identity: Identity;
      publicKey?: string;
    }
  | {
      mode: 'remote';
      url: string;
      credential: { env: string } | { keychain: string };
      identity: Identity;
      publicKey?: string;
    };
export const configPath = (o: Partial<Input>, env: Environment) => {
  const home = join(homedir(), '.config', 'annon', 'config.json');
  if (env.ANNON_AGENT !== 'true') return o.config ?? env.ANNON_CONFIG ?? home;
  // Agent mode pins the home config; a different ANNON_CONFIG is an operator mistake, not a silent override.
  if (env.ANNON_CONFIG && resolve(env.ANNON_CONFIG) !== resolve(home))
    throw new AdapterError(
      'config_conflict',
      'ANNON_AGENT=true always uses ~/.config/annon/config.json; unset ANNON_CONFIG or point it there.',
      2,
    );
  return home;
};
/** The launcher environment and its config are the agent policy anchor, never per-call flags. */
export async function agentPolicy(o: Input, env: Environment, forced = false): Promise<boolean> {
  const pinned = configPath({}, env);
  let saved: { agent?: boolean } = {};
  try {
    saved = JSON.parse(await readFile(pinned, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const agent = forced || env.ANNON_AGENT === 'true' || saved.agent === true;
  if (
    agent &&
    (o.command === 'init' ||
      o.command === 'login' ||
      (o.config !== undefined && resolve(o.config) !== resolve(pinned)) ||
      o.stateDir !== undefined ||
      [
        o.contractId,
        o.nearRpc,
        o.baseRpc,
        o.relayer,
        o.network,
        o.trustContract,
        o.moderator,
        o.maxPrice,
        o.storageBudget,
        o.fundAmount,
      ].some((v) => v !== undefined))
  )
    throw new AdapterError(
      'agent_policy',
      'Agent mode pins deployment, trust, price and state policy; per-call overrides, init and login are refused.',
      2,
    );
  return agent;
}
export async function savePublicConfig(
  path: string,
  patch: {
    signer: SignerConfig;
    dailyBudget?: string;
    agent: boolean;
    network?: string;
    nearRpc?: string;
    contractId?: string;
    baseRpc?: string;
  },
) {
  let old: Record<string, unknown> = {};
  try {
    old = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  const allowed = [
    'contractId',
    'nearRpc',
    'baseRpc',
    'network',
    'stateDir',
    'workDir',
    'relayer',
    'maxPrice',
    'trustContract',
    'mpcKey',
    'moderators',
    'origins',
    'allowedResources',
    'storageBudget',
    'maxProtocolFee',
  ];
  const publicConfig = Object.fromEntries(Object.entries(old).filter(([k]) => allowed.includes(k)));
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(
    tmp,
    JSON.stringify({ network: 'near:mainnet', ...publicConfig, ...patch }, null, 2),
    {
      mode: 0o600,
      flag: 'wx',
    },
  );
  await rename(tmp, path);
}
export async function initAgent(
  o: Input,
  env: Environment,
  keychain: Keychain = osKeychain,
): Promise<Record<string, unknown>> {
  await agentPolicy(o, env);
  if (
    (o.config !== undefined && resolve(o.config) !== resolve(configPath({}, env))) ||
    o.stateDir !== undefined
  )
    throw new AdapterError(
      'agent_policy',
      'Set the trusted ANNON_CONFIG and ANNON_STATE_DIR launcher environment before init; per-call agent paths are refused.',
      2,
    );
  if (!o.agent || !o.dailyBudget || !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(o.dailyBudget))
    throw new AdapterError('budget_required', 'init --agent requires --daily-budget in USDC.', 2);
  const kind =
    o.wallet ??
    (o.recovery
      ? identity(o.recovery).kind
      : o.evmKeyFile
        ? 'evm'
        : o.solanaKeyFile
          ? 'solana'
          : 'near');
  let selected = o.recovery
    ? identity(o.recovery)
    : o.nearAccount
      ? parseIdentity({ kind: 'near', id: o.nearAccount })
      : undefined;
  const choices = [
    o.signer,
    o.newKey,
    o.keyEnv,
    !o.newKey && o.keychainEntry,
    o.evmKeyFile,
    o.nearKeyFile,
    o.solanaKeyFile,
  ].filter(Boolean);
  if (choices.length !== 1)
    throw new AdapterError(
      'signer_required',
      'Choose exactly one key reference, new keychain key or remote signer.',
      2,
    );
  let signer: SignerConfig;
  if (o.signer) {
    remoteSigner({ url: o.signer, credential: async () => '' });
    if (
      !selected ||
      (!o.credentialEnv && !o.credentialKeychain) ||
      (o.credentialEnv && o.credentialKeychain)
    )
      throw new AdapterError(
        'signer_required',
        'Remote signing requires an identity and exactly one credential reference.',
        2,
      );
    signer = {
      mode: 'remote',
      url: o.signer,
      identity: selected,
      credential: o.credentialEnv
        ? { env: o.credentialEnv }
        : { keychain: o.credentialKeychain as string },
      ...(o.nearPublicKey ? { publicKey: o.nearPublicKey } : {}),
    };
  } else if (o.newKey) {
    if (kind === 'solana') throw new Error('new Solana keys are not supported');
    const entry = o.keychainEntry ?? `annon-agent-${randomUUID()}`;
    const created = await keychain.create(kind, entry, o.nearAccount);
    selected = parseIdentity({ kind: created.kind, id: created.id });
    signer = {
      mode: 'keychain',
      entry,
      kind,
      identity: selected,
      ...(created.publicKey ? { publicKey: created.publicKey } : {}),
    };
  } else if (o.keyEnv) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(o.keyEnv)) throw new Error('invalid environment reference');
    if (!selected) throw new Error('signer identity required');
    signer = { mode: 'env', kind, name: o.keyEnv, identity: selected };
  } else if (o.keychainEntry) {
    if (kind === 'solana' || !selected) throw new Error('keychain identity required');
    signer = {
      mode: 'keychain',
      entry: o.keychainEntry,
      kind,
      identity: selected,
      ...(o.nearPublicKey ? { publicKey: o.nearPublicKey } : {}),
    };
  } else {
    if (!selected) throw new Error('signer identity required');
    signer = {
      mode: 'file',
      kind,
      file: resolve((o.evmKeyFile ?? o.nearKeyFile ?? o.solanaKeyFile) as string),
      identity: selected,
    };
  }
  validateSigner(signer);
  const chain = o.network ?? env.ANNON_NETWORK;
  const endpoints = {
    ...(o.nearRpc ? { nearRpc: o.nearRpc } : {}),
    ...(o.baseRpc ? { baseRpc: o.baseRpc } : {}),
  };
  for (const endpoint of Object.values(endpoints)) {
    const url = secureUrl(endpoint);
    if (url.username || url.password || url.search || url.hash)
      throw new Error('invalid public endpoint');
  }
  if (o.contractId) account(o.contractId);
  if (chain) network(chain);
  await savePublicConfig(configPath(o, env), {
    signer,
    dailyBudget: o.dailyBudget,
    agent: true,
    ...endpoints,
    ...(chain ? { network: chain } : {}),
    ...(o.contractId ? { contractId: o.contractId } : {}),
  });
  return {
    configured: true,
    mode: signer.mode,
    ...(selected ? { identity: selected } : {}),
    dailyBudget: o.dailyBudget,
  };
}

/** Reject plaintext credentials and unknown persisted signer fields at the config boundary. */
export function validateSigner(s: SignerConfig): SignerConfig {
  if (!s || typeof s !== 'object') throw new TypeError('invalid signer');
  const fields: Record<SignerConfig['mode'], string[]> = {
    browser: ['mode', 'identity'],
    file: ['mode', 'kind', 'file', 'identity'],
    env: ['mode', 'kind', 'name', 'identity'],
    keychain: ['mode', 'kind', 'entry', 'identity', 'publicKey'],
    remote: ['mode', 'url', 'credential', 'identity', 'publicKey'],
  };
  if (!Object.hasOwn(fields, s.mode) || Object.keys(s).some((k) => !fields[s.mode].includes(k)))
    throw new TypeError('unexpected signer fields');
  if (s.identity) parseIdentity(s.identity);
  if (!s.identity) throw new TypeError('signer identity required');
  if ('kind' in s && s.identity && s.kind !== s.identity.kind)
    throw new TypeError('signer kind/identity mismatch');
  if ('kind' in s && !['near', 'evm', 'solana'].includes(s.kind))
    throw new TypeError('invalid signer kind');
  if (s.mode === 'file' && (typeof s.file !== 'string' || !s.file))
    throw new TypeError('key file reference required');
  if (s.mode === 'env' && !/^[A-Z_][A-Z0-9_]*$/.test(s.name))
    throw new TypeError('environment reference required');
  if (s.mode === 'keychain' && (typeof s.entry !== 'string' || !s.entry))
    throw new TypeError('keychain entry required');
  if (s.mode === 'remote') {
    remoteSigner({ url: s.url, credential: async () => '' });
    if (
      !s.credential ||
      Object.keys(s.credential).length !== 1 ||
      !('env' in s.credential || 'keychain' in s.credential)
    )
      throw new TypeError('credential reference required');
    if ('env' in s.credential && !/^[A-Z_][A-Z0-9_]*$/.test(s.credential.env))
      throw new TypeError('invalid credential environment reference');
    if (
      'keychain' in s.credential &&
      (typeof s.credential.keychain !== 'string' || !s.credential.keychain)
    )
      throw new TypeError('invalid credential keychain reference');
  }
  return s;
}
