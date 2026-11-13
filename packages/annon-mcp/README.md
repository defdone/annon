# @defdone/annon-mcp

A local MCP server (stdio) that lets an agent sell, buy, open, recover and verify Annon files.
It wraps the [`@defdone/annon`](https://www.npmjs.com/package/@defdone/annon) SDK and always runs
in agent mode: the owner sets the contract, the wallet, the price cap, the daily budget and the
working directory, and no tool call can change them. Stdout carries only the MCP transport.

## Install

```sh
npm i -g @defdone/annon-mcp@beta
```

Or let the MCP client start it with `npx -y @defdone/annon-mcp@beta`. The `annon-mcp` binary takes
no arguments.

## Configure

The server reads the same configuration and secret sources as the CLI
([CLI.md](https://github.com/defdone/annon/blob/master/packages/annon/CLI.md)). Pass the same
`ANNON_*` variables to the server process. A client configuration:

```json
{
  "mcpServers": {
    "annon": {
      "command": "npx",
      "args": ["-y", "@defdone/annon-mcp@beta"],
      "env": {
        "ANNON_CONFIG": "/absolute/path/annon-agent.json",
        "ANNON_WALLET": "evm",
        "ANNON_EVM_KEY_FILE": "/absolute/private/agent-evm.key",
        "ANNON_BACKUP_SECRET_FILE": "/absolute/private/backup-secret"
      }
    }
  }
}
```

The configuration file, written by a human:

```json
{
  "contractId": "v1.annon.defdone.near",
  "network": "near:mainnet",
  "nearRpc": "https://rpc.mainnet.fastnear.com",
  "baseRpc": "https://your-base-rpc-with-api-key.example",
  "relayer": "https://relayer.mainnet.annon.dev",
  "stateDir": "/absolute/private/annon-state",
  "trustContract": true,
  "maxPrice": "0.2",
  "dailyBudget": "1",
  "workDir": "/absolute/annon-work",
  "allowedResources": ["https://demo.annon.dev/f/*"]
}
```

| Field | Meaning |
| --- | --- |
| `contractId`, `network`, `nearRpc`, `baseRpc`, `relayer` | The deployment. Tools cannot supply these. |
| `trustContract` | Server-side contract trust (or `ANNON_TRUST_CONTRACT=true`, or earlier trust given by a human in the CLI). Tools cannot grant trust. |
| `stateDir` | Encrypted purchase records and the budget ledger. `ANNON_STATE_DIR` is ignored in agent mode. |
| `maxPrice` | Required. Decimal USDC cap per purchase. `ANNON_MAX_PRICE` can only lower it; a tool cannot override it. |
| `dailyBudget` | Required for buying. Decimal USDC per UTC day. |
| `workDir` | Required. Every local path a tool reads or writes stays inside it (see below). |
| `allowedResources` | Optional. Absent: any HTTPS URL, or HTTP on localhost, within `maxPrice` and `dailyBudget`. Present: exact URLs, or same-origin path prefixes ending in `/*`. An empty list denies every purchase. `ANNON_ALLOWED_RESOURCES`, when set, restricts it further, whatever triggered agent mode. |
| `moderators` | Moderators the buyer trusts (or `ANNON_MODERATORS`, comma-separated). |
| `origins` | Named 1Click sources (or JSON in `ANNON_ORIGINS`), see Tools. |
| `storageBudget` | Decimal NEAR for self-funded NEAR listings. |
| `maxProtocolFee` | Highest relayer fee a sell accepts. Default `{ "fixed": "30000", "bps": 100 }` (USDC base units plus basis points). |

`allowedResources` restricts both `open --url` and URLs saved with purchases. Without it, agent mode can open any URL allowed by the HTTPS and localhost transport rules.

Deployment IDs, RPCs, the relayer, wallet and key-file selection, state and backup locations,
moderator trust and contract trust come only from this configuration, the server environment, or
trust a human already gave in the CLI. Passed as tool arguments, they are rejected.

The launcher setting `ANNON_AGENT=true` pins the configuration to `~/.config/annon/config.json`;
the other agent-mode triggers use the configuration the operator selected. Only with
`ANNON_AGENT=true` may `ANNON_WORK_DIR` supply or override `workDir`; no tool argument can.

## Tools

Tools take camelCase versions of the CLI flags, with `target` as the positional operand.

| Tool | Required arguments | Result |
| --- | --- | --- |
| `annon_sell` | `target` plus `price`, `split` or `resume` | File ID, PAY2 path, public terms |
| `annon_buy` | `target` | Purchase ID, route, payment summary, encrypted backup path; 1Click deposit instructions when applicable |
| `annon_open` | `target`, `output` | Plaintext output path, byte count, payment summary when saved |
| `annon_verify` | `target` | Registered file ID, verification scope |
| `annon_recover` | `recovery` | Purchase IDs, final grant numbers, encrypted backup paths |
| `annon_budget` | `target` | Available file storage and admission requirement in yoctoNEAR |
| `annon_status` | `target` | Final NEAR purchase state, payment summary when saved; pending does not mean payment failed |

**`annon_buy`** also accepts `route` (`"near"`, `"base"` or `"1click"`), `origin`, `recovery` and
`url`.

- `target` must be a secure resource URL within any configured allowlist. Local offer files are
  refused, and an optional `url` cannot authorize one.
- The server fetches the offer from that URL and checks that the advertised resource matches it.
  The offer's header must share the resource's origin.
- URLs use HTTPS, or plain HTTP only on `localhost`, `127.0.0.1` or `[::1]` (for example
  `http://localhost:8790/file`). The same rule applies to `annon_verify`.
- Encoded path separators `%2f` and `%5c` are refused in every case.
- `origin` names an entry in the human configuration `origins` or in `ANNON_ORIGINS`. Its
  `fromChain`, `fromAsset` and optional `refundTo` cannot come from a tool. Refunds go to the human
  configuration or the matching wallet address, so a tool cannot pick an arbitrary source asset or
  redirect a refund.

**`annon_sell`** needs `price` and `split` for a new listing and refuses them on resume. Resume
with `{ "target": "original.pdf", "resume": "0xFILE_ID", "output": "new.pay2" }`. A failed saved
sell returns `error.fileId`. Published jobs and current backups keep public metadata and clear the
file key, CKD and one-time secrets; see CLI.md for recovery requirements and the limits of external
backups. There is no storage-budget argument: a self-funded NEAR listing uses `storageBudget` from
the human configuration, and a sponsored listing gets the relayer's bounded allocation. The result's
`terms` include the final split with the treasury share. A sell whose advertised fee is above
`maxProtocolFee` is refused with `protocol_fee_above_max`; only the human configuration can raise it.

**`annon_open`** also accepts `purchase`, `file` and `url`. See the tool schemas for the full list.

**`annon_budget`** is read-only. Funding a file is for humans only: there is no funding tool, and
`fund` in agent mode returns `human_only`. NEAR and 1Click buys return `file_storage_low` before
paying when the file's storage budget is too low.

## How a purchase runs

1. `annon_buy` creates the purchase. For 1Click it returns deposit instructions; someone funds the
   deposit from their own wallet before the cutoff. Annon never sends it.
2. After `submitted`, call `annon_status` about every 30 seconds until `accepted`. `pending` and
   `payment_not_safe` mean wait, never failure. Resumable pending results and `payment_not_safe`
   carry `retryAfterSeconds: 30`; a setup that needs a human has no retry hint.
3. Open with `annon_open` once the status is `accepted`.

Never pay again for a purchase in flight. `annon_status` and `annon_open` can resume a saved paid
Base purchase by sending `unlock` before downloading, which is why status is not annotated
read-only. Expired or canceled Base payments are marked in the local encrypted record and the
current backup; the purchase and its recovery material stay available. Batch recovery reports
per-purchase errors next to the successful grants.

## Safety model

The operator owns the configuration, the environment, the credentials and the working directory.
MCP is the policy boundary between them and the agent.

**Paths.** `annon_open.output`, `annon_open.file`, `annon_sell.target` and `annon_sell.output`
must resolve inside `workDir`. So must local `annon_verify.target` files, `annon_open.target`
inputs that are not purchase IDs, and `annon_open.purchase` backups that are not IDs. Verify URLs
stay remote and purchase IDs stay identifiers. Relative paths start at `workDir`; existing inputs
and the parents of outputs are resolved with `realpath`. Symlink escapes, dangling symlinks, paths
outside the directory and any `..` segment fail with the fixed code `path_not_allowed`. The default
sell output is checked too, output parents must already exist, and returned paths are canonical.
Existing outputs are never overwritten.

**Limit.** These checks do not contain a shell agent running as the same OS user. It can edit that
user's configuration, change files or start another client. When those capabilities must be
restricted, use separate OS permissions.

## Results and errors

Every tool returns `structuredContent: { ok: true, result: ... }` and the same JSON as text. Errors
set `isError: true` and return `{ ok: false, error: { code, message } }`. Results never contain
keys, signed authorizations or plaintext.

## Payment summary

`payment` reports, from the verified purchase terms:

| Field | Meaning |
| --- | --- |
| `amountUsdc` | Price in decimal USDC |
| `amountBaseUnits` | Price in USDC base units |
| `asset` | `symbol` and `id` |
| `network` | Network of the payment |
| `route` | How the buyer paid: `near`, `base` or `1click` |
| `source` | For 1Click, the reviewed source asset and amount |

Top-level `route` is the contract route (`near-usdc`/`base-usdc`); `payment.route` is how the buyer paid (`near`/`base`/`1click`).
Status and open include the summary when the saved purchase and the backup secret are
available; older records can lack source details. The summary never contains a deposit address or
a signed authorization. Reporting is best-effort: an unreadable record or secret omits `payment`
without blocking an accepted status or a recovery open.

## License

Apache-2.0. Part of [Annon](https://annon.dev), created by [defdone](https://defdone.com).
