import { parseArgs } from 'node:util';
import type { BuyRoute } from '../routes.js';
import { publicError, usage } from './errors.js';

export type Command =
  | 'shops'
  | 'shop'
  | 'catalog'
  | 'fund'
  | 'budget'
  | 'share'
  | 'sell'
  | 'buy'
  | 'open'
  | 'recover'
  | 'stop'
  | 'verify'
  | 'status'
  | 'login'
  | 'init';
export interface Input {
  command: Command;
  shop?: string;
  id?: string;
  search?: string;
  limit?: number;
  offset?: number;
  storageBudget?: string;
  listingStorage?: string;
  title?: string;
  description?: string;
  fundAmount?: string;
  agent?: boolean;
  noOpen?: boolean;
  signer?: string;
  credentialEnv?: string;
  credentialKeychain?: string;
  keyEnv?: string;
  keychainEntry?: string;
  newKey?: boolean;
  dailyBudget?: string;
  target?: string;
  json?: boolean;
  config?: string;
  contractId?: string;
  nearRpc?: string;
  baseRpc?: string;
  network?: string;
  stateDir?: string;
  relayer?: string;
  trustContract?: boolean;
  wallet?: 'evm' | 'solana' | 'near';
  evmKeyFile?: string;
  solanaKeyFile?: string;
  nearKeyFile?: string;
  nearAccount?: string;
  nearPublicKey?: string;
  backupSecretFile?: string;
  resume?: string;
  origin?: string;
  price?: string;
  split?: string;
  base?: boolean;
  force?: boolean;
  moderator?: string;
  route?: BuyRoute;
  fromChain?: string;
  fromAsset?: string;
  refundTo?: string;
  recovery?: string;
  maxPrice?: string;
  purchase?: string;
  file?: string;
  url?: string;
  output?: string;
}
const common = [
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
const perCommand: Record<Command, string[]> = {
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
  ],
  open: ['purchase', 'file', 'url', 'output'],
  recover: ['recovery', 'purchase'],
  stop: [],
  verify: [],
  status: [],
};
export function parseCli(argv: string[]): Input {
  try {
    const keys = [...new Set([...common, ...Object.values(perCommand).flat()])];
    const booleans = ['json', 'trust-contract', 'base', 'agent', 'no-open', 'new-key', 'force'];
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: Object.fromEntries(
        keys.map((k) => [k, { type: booleans.includes(k) ? 'boolean' : 'string' }]),
      ),
    });
    const [command, target, ...extra] = parsed.positionals;
    if (
      !command ||
      !(command in perCommand) ||
      (command === 'fund' || command === 'shop' ? extra.length !== 1 : extra.length !== 0)
    )
      throw usage();
    const cmd = command as Command;
    if (
      (['recover', 'login', 'init', 'shops', 'catalog'].includes(cmd) && target !== undefined) ||
      (!['recover', 'login', 'init', 'shops', 'catalog'].includes(cmd) && !target)
    )
      throw usage();
    if (cmd === 'shop' && target !== 'add') throw usage();
    const allowed = [...common, ...perCommand[cmd]];
    if (Object.keys(parsed.values).some((k) => !allowed.includes(k))) throw usage();
    const values: Record<string, string | boolean | number | undefined> = Object.fromEntries(
      Object.entries(parsed.values).map(([k, v]) => [
        k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()),
        v,
      ]),
    );
    for (const key of ['limit', 'offset']) {
      if (values[key] !== undefined) {
        if (typeof values[key] !== 'string' || !/^(0|[1-9][0-9]*)$/.test(values[key]))
          throw usage();
        const n = Number(values[key]);
        if (
          !Number.isSafeInteger(n) ||
          n < (key === 'limit' ? 1 : 0) ||
          (key === 'limit' && n > 100)
        )
          throw usage();
        values[key] = n;
      }
    }
    if (cmd === 'share') {
      if (
        values.resume
          ? !/^0x[0-9a-f]{64}$/.test(String(values.resume)) ||
            ['price', 'title', 'description', 'storageBudget', 'listingStorage'].some(
              (k) => values[k] !== undefined,
            )
          : !values.price
      )
        throw usage();
    }
    if (cmd === 'sell') {
      if (values.resume) {
        if (
          !/^0x[0-9a-f]{64}$/.test(String(values.resume)) ||
          values.price ||
          values.split ||
          values.base ||
          values.moderator ||
          values.storageBudget
        )
          throw usage();
      } else if (!values.price || !values.split) throw usage();
    }
    if (cmd === 'init' && values.agent !== true) throw usage();
    if (cmd === 'recover' && !values.recovery) throw usage();
    if (values.route && !['near', 'base', '1click'].includes(String(values.route))) throw usage();
    if (values.wallet && !['evm', 'solana', 'near'].includes(String(values.wallet))) throw usage();
    return {
      command: cmd,
      ...(target === undefined ? {} : { target: cmd === 'shop' ? extra[0] : target }),
      ...(cmd === 'fund' ? { fundAmount: extra[0] } : {}),
      ...values,
    } as Input;
  } catch {
    throw usage();
  }
}
const HELP = `annon <command> [options]
shops [--search <q>] [--limit <n>] [--offset <n>]
shop add <url> [--id <alias>]
catalog [--shop <id>] [--search <q>] [--limit <n>] [--offset <n>]
login [--wallet evm|near] [--no-open]
init --agent --daily-budget <USDC> [--recovery <kind:id>] [--key-env <name> | --keychain-entry <name> | --new-key | --signer <https origin> (--credential-env <name> | --credential-keychain <name>)]
share <file> --price <USDC> [--shop <id>] [--title <title>] [--description <text>] [--listing-storage <NEAR>] [--storage-budget <NEAR>]
share <file> --resume <file-id> [--shop <id>]
sell <file> --resume <file-id> [--output <PAY2>]
fund <file-id> <NEAR>
budget <file-id>
sell <file> [--storage-budget <NEAR>] --price <USDC> --split <kind:id:bps,...> [--base] [--moderator <account>] [--output <PAY2>]
buy <url|offer.json> [--route near|base|1click] [--origin <configured name>] [--from-chain <chain>] [--from-asset <1Click asset>] [--refund-to <address>] [--recovery <kind:id>] [--max-price <USDC> or configured cap] [--url <expected resource for offer.json>] [--moderator <trusted account>]
open <purchase-id|backup|PAY2> [--purchase <id|backup>] [--file <PAY2> | --url <url>] --output <file>
recover --recovery <kind:id> [--purchase <id>]
stop <file-id>
verify <PAY2|url>
status <purchase-id>
Common: --json --config <file> --contract-id <account> --near-rpc <url> --base-rpc <url>
--network <near:mainnet> --state-dir <dir> --relayer <url> --trust-contract
--wallet evm|solana|near --evm-key-file <file> --solana-key-file <file> --near-key-file <file>
--near-account <account> --near-public-key <ed25519:key> --backup-secret-file <file>
Secrets: env ANNON_EVM_PRIVATE_KEY, ANNON_SOLANA_KEYPAIR, ANNON_NEAR_CREDENTIALS,
ANNON_BACKUP_SECRET (64 hex); or explicitly named files. See packages/annon/CLI.md.
Exit: 0 success (buy may need deposit), 1 operation failed, 2 arguments/config, 3 trust required, 4 purchase pending.
`;
export async function runCli(
  argv: string[],
  execute: (input: Input) => Promise<unknown>,
  write: (text: string) => void,
): Promise<number> {
  const json = argv.includes('--json') || argv.includes('--json=true');
  if (argv.length === 0 || argv.includes('--help')) {
    write(HELP);
    return 0;
  }
  try {
    const input = parseCli(argv);
    const result = await execute(input);
    write(JSON.stringify({ ok: true, result }, null, json ? undefined : 2));
    return input.command === 'status' &&
      result &&
      typeof result === 'object' &&
      'state' in result &&
      result.state === 'pending'
      ? 4
      : 0;
  } catch (error) {
    const safe = publicError(error);
    write(JSON.stringify({ ok: false, error: safe }, null, json ? undefined : 2));
    return safe.exitCode;
  }
}
