import { parseArgs } from 'node:util';
import { publicError, usage } from './errors.js';

export type Command = 'sell' | 'buy' | 'open' | 'recover' | 'stop' | 'verify' | 'status';
export interface Input {
  command: Command;
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
  price?: string;
  split?: string;
  base?: boolean;
  moderator?: string;
  route?: 'near' | 'base' | '1click';
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
  sell: ['price', 'split', 'base', 'moderator', 'output'],
  buy: ['route', 'from-chain', 'from-asset', 'refund-to', 'recovery', 'max-price', 'moderator'],
  open: ['purchase', 'file', 'url', 'output'],
  recover: ['recovery', 'purchase'],
  stop: [],
  verify: [],
  status: [],
};
export function parseCli(argv: string[]): Input {
  try {
    const keys = [...new Set([...common, ...Object.values(perCommand).flat()])];
    const booleans = ['json', 'trust-contract', 'base'];
    const parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: Object.fromEntries(
        keys.map((k) => [k, { type: booleans.includes(k) ? 'boolean' : 'string' }]),
      ),
    });
    const [command, target, ...extra] = parsed.positionals;
    if (!command || !(command in perCommand) || extra.length) throw usage();
    const cmd = command as Command;
    if ((cmd === 'recover' && target !== undefined) || (cmd !== 'recover' && !target))
      throw usage();
    const allowed = [...common, ...perCommand[cmd]];
    if (Object.keys(parsed.values).some((k) => !allowed.includes(k))) throw usage();
    const values = Object.fromEntries(
      Object.entries(parsed.values).map(([k, v]) => [
        k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()),
        v,
      ]),
    );
    if (cmd === 'sell' && (!values.price || !values.split)) throw usage();
    if (cmd === 'recover' && !values.recovery) throw usage();
    if (values.route && !['near', 'base', '1click'].includes(String(values.route))) throw usage();
    if (values.wallet && !['evm', 'solana', 'near'].includes(String(values.wallet))) throw usage();
    return { command: cmd, ...(target === undefined ? {} : { target }), ...values } as Input;
  } catch {
    throw usage();
  }
}
export const HELP = `annon <command> [options]
sell <file> --price <USDC> --split <kind:id:bps,...> [--base] [--moderator <account>] [--output <PAY2>]
buy <url|offer.json> [--route near|base|1click] [--from-chain <chain>] [--from-asset <1Click asset>] [--refund-to <address>] [--recovery <kind:id>] [--max-price <USDC>] [--moderator <trusted account>]
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
    const { exitCode, ...safe } = publicError(error);
    write(JSON.stringify({ ok: false, error: safe }, null, json ? undefined : 2));
    return exitCode;
  }
}
