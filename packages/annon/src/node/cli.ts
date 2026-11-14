import { parseArgs } from 'node:util';
import type { PublicError } from '../errors.js';
import type { BuyRoute } from '../routes.js';
import { isRow } from './adapter-checks.js';
import { type BuyFollow, buyFlow } from './buy-flow.js';
import { camel, common, perCommand } from './cli-flags.js';
import { AdapterError, publicError, usage } from './errors.js';
import { humanError, humanResult } from './output/human.js';
import { version } from './version.js';

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
  /** Bare `init --deployment defdone`: write that preset config without asking. */
  deployment?: string;
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
  /** `buy --open <path>`: wait for acceptance, then write the opened file there. */
  open?: string;
}
const bareInit = ['json', 'config', 'stateDir', 'backupSecretFile', 'deployment'];
/** Without a target `status` and `open` use the latest purchase; these take none at all. */
const optionalTarget = ['status', 'open'];
const noTarget = ['recover', 'login', 'init', 'shops', 'catalog'];
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
      (noTarget.includes(cmd) && target !== undefined) ||
      (![...noTarget, ...optionalTarget].includes(cmd) && !target)
    )
      throw usage();
    if (cmd === 'shop' && target !== 'add') throw usage();
    const allowed = [...common, ...perCommand[cmd]];
    if (Object.keys(parsed.values).some((k) => !allowed.includes(k))) throw usage();
    const values: Record<string, string | boolean | number | undefined> = Object.fromEntries(
      Object.entries(parsed.values).map(([k, v]) => [camel(k), v]),
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
    // Bare init only sets up the backup secret; signer and deployment options need --agent.
    if (
      cmd === 'init' &&
      values.agent !== true &&
      Object.keys(values).some((k) => !bareInit.includes(k))
    )
      throw usage();
    // The only preset is defdone's deployment; agent init writes signer settings, never a preset.
    if (
      values.deployment !== undefined &&
      (values.agent === true || values.deployment !== 'defdone')
    )
      throw usage();
    if (cmd === 'recover' && !values.recovery) throw usage();
    // --shop and --search only select the catalog listing a row number refers to.
    if (
      cmd === 'buy' &&
      (values.shop !== undefined || values.search !== undefined) &&
      !isRow(target)
    )
      throw usage();
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
const versionFlags = ['--version', '-v'];
const HELP = `annon <command> [options]
annon (no arguments, in a terminal) or annon shell: interactive session; type help inside
shops [--search <q>] [--limit <n>] [--offset <n>]
shop add <url> [--id <alias>]
catalog [--shop <id>] [--search <q>] [--limit <n>] [--offset <n>]
init [--deployment defdone] [--backup-secret-file <file>] [--state-dir <dir>] [--config <file>]
login [--wallet evm|near] [--no-open]
init --agent --daily-budget <USDC> [--recovery <kind:id>] [--key-env <name> | --keychain-entry <name> | --new-key | --signer <https origin> (--credential-env <name> | --credential-keychain <name>)]
share <file> --price <USDC> [--shop <id>] [--title <title>] [--description <text>] [--listing-storage <NEAR>] [--storage-budget <NEAR>]
share <file> --resume <file-id> [--shop <id>]
sell <file> --resume <file-id> [--output <PAY2>]
fund <file-id> <NEAR>
budget <file-id>
sell <file> [--storage-budget <NEAR>] --price <USDC> --split <kind:id:bps,...> [--base] [--moderator <account>] [--output <PAY2>]
buy <url|offer.json|catalog row number --shop <id> [--search <q>]> [--open <file>] [--route near|base|1click] [--origin <configured name>] [--from-chain <chain>] [--from-asset <1Click asset>] [--refund-to <address>] [--recovery <kind:id>] [--max-price <USDC> or configured cap] [--url <expected resource for offer.json>] [--moderator <trusted account>]
open [purchase-id|id prefix|backup|PAY2] [--purchase <id|id prefix|backup>] [--file <PAY2> | --url <url>] --output <file>
recover --recovery <kind:id> [--purchase <id>]
stop <file-id>
verify <PAY2|url>
status [purchase-id|id prefix]
status and open without an id use this contract's latest purchase; an id prefix needs 8 or more
hex digits and a purchase saved for this contract and network.
Common: --json --config <file> --contract-id <account> --near-rpc <url> --base-rpc <url>
--network <near:mainnet> --state-dir <dir> --relayer <url> --trust-contract
--wallet evm|solana|near --evm-key-file <file> --solana-key-file <file> --near-key-file <file>
--near-account <account> --near-public-key <ed25519:key> --backup-secret-file <file>
Backup secret: run init once; it creates ~/.config/annon/backup-secret (owner-only) and never
overwrites. --backup-secret-file or ANNON_BACKUP_SECRET_FILE, then ANNON_BACKUP_SECRET, override it.
Secrets: env ANNON_EVM_PRIVATE_KEY, ANNON_SOLANA_KEYPAIR, ANNON_NEAR_CREDENTIALS; or explicitly
named files. See packages/annon/CLI.md. --version prints the installed version.
Exit: 0 success (buy may need deposit), 1 operation failed, 2 arguments/config, 3 trust required, 4 purchase pending or uncertain.
`;
/** How one command line is presented and followed up; the defaults are the script contract. */
export interface RunOptions extends BuyFollow {
  /** Readable text in place of the JSON envelope. `--json` always wins. */
  human?: boolean;
}
type Result = Record<string, unknown> | undefined;
/** 4: not settled. A pending status, or a buy whose payment may be on chain or is not accepted yet. */
function exitCode(input: Input, result: Result): number {
  if (!result) return 0;
  if (input.command === 'status' && result.state === 'pending') return 4;
  if (input.command !== 'buy') return 0;
  // A payment that may be on chain outranks a failed status check or open after it.
  if (result.state === 'uncertain') return 4;
  const failed = (result.openError ?? result.statusError) as PublicError | undefined;
  if (failed) return failed.exitCode;
  return result.state === 'uncertain' || result.settlement === 'pending' ? 4 : 0;
}
/** The script contract: shop rules as text in pretty mode, then one JSON envelope. */
function writeJson(input: Input, result: unknown, compact: boolean, write: (text: string) => void) {
  if (!compact && ['shops', 'catalog', 'share'].includes(input.command)) {
    const show = (value: unknown) => {
      const r = value as {
        rules?: { text: string };
        shop?: { manifest: string };
        manifest?: string;
        info?: { rules?: { text: string } };
      };
      const rules = r.info?.rules ?? r.rules;
      if (rules) write(`Shop rules (${r.shop?.manifest ?? r.manifest}):\n${rules.text}`);
    };
    show(result);
    const items = (result as { items?: unknown[] }).items;
    if (Array.isArray(items)) for (const item of items) show(item);
  }
  write(JSON.stringify({ ok: true, result }, null, compact ? undefined : 2));
}
export async function runCli(
  argv: string[],
  execute: (input: Input) => Promise<unknown>,
  write: (text: string) => void,
  options: RunOptions = {},
): Promise<number> {
  const json = argv.includes('--json') || argv.includes('--json=true');
  const human = options.human === true && !json;
  if (argv.length === 0 || argv.includes('--help')) {
    write(HELP);
    return 0;
  }
  // Answered before any config, agent policy, wallet, network or backup-secret step.
  if (
    argv.some((a) => versionFlags.includes(a)) &&
    argv.every((a) => [...versionFlags, '--json'].includes(a))
  ) {
    write(json ? JSON.stringify({ ok: true, result: { version } }) : version);
    return 0;
  }
  try {
    if (argv[0] === 'shell')
      throw new AdapterError(
        'invalid_arguments',
        'The interactive session needs a terminal, takes no options and is not available in agent mode.',
        2,
      );
    const input = parseCli(argv);
    const result = await buyFlow(input, execute, human, options);
    if (human) write(humanResult(input, result as Result));
    else writeJson(input, result, json, write);
    return exitCode(input, result as Result);
  } catch (error) {
    const safe = publicError(error);
    write(
      human
        ? humanError(safe)
        : JSON.stringify({ ok: false, error: safe }, null, json ? undefined : 2),
    );
    return safe.exitCode;
  }
}
