/** The flag tables of the CLI: what every command accepts, for parsing, completion and follow-ups. */
import type { Command, Input } from './cli.js';

export const common = [
  'no-open',
  'json',
  'config',
  'contract-id',
  'near-rpc',
  'base-rpc',
  'network',
  'state-dir',
  'relayer',
  'trust-contract',
  'wallet',
  'evm-key-file',
  'solana-key-file',
  'near-key-file',
  'near-account',
  'near-public-key',
  'backup-secret-file',
];
export const perCommand: Record<Command, string[]> = {
  shops: ['search', 'limit', 'offset'],
  shop: ['id'],
  catalog: ['shop', 'search', 'limit', 'offset'],
  fund: [],
  budget: [],
  login: [],
  init: [
    'signer',
    'credential-env',
    'credential-keychain',
    'agent',
    'recovery',
    'key-env',
    'keychain-entry',
    'new-key',
    'daily-budget',
    'deployment',
  ],
  share: ['resume', 'price', 'shop', 'title', 'description', 'storage-budget', 'listing-storage'],
  sell: ['resume', 'price', 'split', 'base', 'moderator', 'output', 'storage-budget'],
  buy: [
    'force',
    'origin',
    'route',
    'from-chain',
    'from-asset',
    'refund-to',
    'recovery',
    'max-price',
    'moderator',
    'url',
    'open',
    'shop',
    'search',
  ],
  open: ['purchase', 'file', 'url', 'output'],
  recover: ['recovery', 'purchase'],
  stop: [],
  verify: [],
  status: [],
};
export const camel = (flag: string) => flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
export const commandNames = Object.keys(perCommand) as Command[];
/** Every flag a command accepts, as typed on the command line. */
export const commandFlags = (command: Command) =>
  [...perCommand[command], ...common].map((flag) => `--${flag}`);
/** The deployment, wallet and output options of one command, for a follow-up command it starts. */
export const commonInput = (input: Input): Partial<Input> =>
  Object.fromEntries(
    common
      .map((flag) => [camel(flag), (input as unknown as Record<string, unknown>)[camel(flag)]])
      .filter(([, v]) => v !== undefined),
  );
