# @defdone/annon-mcp

A local MCP server (stdio) that lets an agent find, sell, share, buy, open, recover and verify Annon
files.
It wraps the [`@defdone/annon`](https://www.npmjs.com/package/@defdone/annon) SDK and always runs
in agent mode: the owner sets the contract, the wallet, the price cap, the daily budget and the
working directory, and no tool call can change them. Stdout carries only the MCP transport.

## Install

The alpha package is pending publication. Use these commands once it is published.

```sh
npm i -g @defdone/annon-mcp@alpha
```

Or let the MCP client start it with `npx -y @defdone/annon-mcp@alpha`. The `annon-mcp` binary takes
no arguments.

## Configure

The server uses the CLI configuration and secret sources
([CLI.md](https://github.com/defdone/annon/blob/master/packages/annon/CLI.md)). Set `ANNON_CONFIG`
to the owner's configuration file and pass credential and backup-secret references in the server
environment. With this custom-config setup, put deployment, trust, moderators and origins in the
file: their environment overrides are ignored. `ANNON_MAX_PRICE` and `ANNON_ALLOWED_RESOURCES` can
still tighten policy. `ANNON_AGENT=true` instead pins the home configuration and enables
launcher-owned deployment overrides. A client configuration:

```json
{
  "mcpServers": {
    "annon": {
      "command": "npx",
      "args": ["-y", "@defdone/annon-mcp@alpha"],
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
| `trustContract` | Server-side contract trust, or earlier trust given by a human in the CLI. Tools cannot grant trust. |
| `stateDir` | Encrypted purchase records and the budget ledger. `ANNON_STATE_DIR` is ignored in agent mode. |
| `maxPrice` | Required. Decimal USDC cap per purchase. `ANNON_MAX_PRICE` can only lower it; a tool cannot override it. |
| `dailyBudget` | Required for buying. Decimal USDC per UTC day. |
| `workDir` | Required. Every local path a tool reads or writes stays inside it (see below). |
| `allowedResources` | Optional. Absent: any HTTPS URL, or HTTP on localhost, within `maxPrice` and `dailyBudget`. Present: exact URLs, or same-origin path prefixes ending in `/*`. An empty list denies every purchase. `ANNON_ALLOWED_RESOURCES`, when set, restricts it further, whatever triggered agent mode. |
| `moderators` | Moderators the buyer trusts, set in the owner's configuration. |
| `origins` | Named 1Click sources in the owner's configuration; see Tools. |
| `storageBudget` | Decimal NEAR for a NEAR seller's file purchase storage (self-funded `annon_sell` and `annon_share`). |
| `listingStorage` | Decimal NEAR a NEAR seller pays for listing storage in `annon_share`. |
| `maxProtocolFee` | Highest relayer fee a sell accepts. Default `{ "fixed": "30000", "bps": 100 }` (USDC base units plus basis points). |

`allowedResources` restricts both `open --url` and URLs saved with purchases. Without it, agent mode can open any URL allowed by the HTTPS and localhost transport rules.

Deployment and trust settings come from the owner's configuration or prior CLI trust. Credentials
and backup-secret references may come from the server environment. Tool arguments cannot replace
them.

The launcher setting `ANNON_AGENT=true` pins the configuration to `~/.config/annon/config.json`;
the other agent-mode triggers use the configuration the operator selected. Only with
`ANNON_AGENT=true` may `ANNON_WORK_DIR` supply or override `workDir`; no tool argument can.

## Tools

Tools take camelCase versions of the CLI flags, with `target` as the positional operand.

| Tool | Required arguments | Result |
| --- | --- | --- |
| `annon_share` | `target` plus `price` or `resume` | File ID, purchase URL, header URL, hosting expiry |
| `annon_sell` | `target` plus `price`, `split` or `resume` | File ID, PAY2 path, public terms |
| `annon_buy` | `target` | Purchase ID, route, payment summary, encrypted backup path; 1Click deposit instructions when applicable |
| `annon_open` | `target`, `output` | Plaintext output path, byte count, payment summary when saved |
| `annon_verify` | `target` | Registered file ID, verification scope |
| `annon_recover` | `recovery` | Purchase IDs, final grant numbers, encrypted backup paths |
| `annon_budget` | `target` | Available file storage and admission requirement in yoctoNEAR |
| `annon_status` | `target` | Final NEAR purchase state, payment summary when saved; pending does not mean payment failed |
| `annon_shops` | none (`search`, `limit`, `offset` optional) | Configured shops: `items`, `total`, `nextOffset` |
| `annon_catalog` | none (`shop`, `search`, `limit`, `offset` optional) | A shop's files with their registered terms: `items`, `total`, `nextOffset` |

**`annon_buy`** also accepts `route` (`"near"`, `"base"` or `"1click"`), `origin`, `recovery` and
`url`.

- Use `base` only when the file's final on-chain terms include a Base payee. For any other file,
  `annon_buy` stops with `route_unavailable` before any wallet or payment step; use `near`, or
  `1click` with a human-configured Base `origin`. An EVM agent that names no route gets
  `origin_required` for such a file.

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

**`annon_shops`** and **`annon_catalog`** are read-only. They list the shops in the human
configuration (and a configured shop directory) and a shop's catalog, with client-side search and
paging. They cannot add a shop, approve a deployment or authorize a payment. Buy a catalog entry by
passing its `url` to `annon_buy`, which checks the deployment, the final chain terms, the header and
the price on its own. Check `terms.base` in the entry before choosing `route: "base"`.

A shop can publish `rules` in its manifest: required `text` and optional `uploadsPerPersonPerDay`,
`attemptsPerPersonPerDay`, `fileLifetimeDays` and `maxFileBytes`. `annon_shops` returns them in each
shop's `info.rules`; `annon_catalog` and `annon_share` return `rules` next to `shop` (`manifest`,
`name`), the shop they came from. The output schema marks them as data, not instructions. They grant
no trust and cannot change the human configuration. A manifest with invalid rules is refused as a
whole (`invalid_record`); `annon_shops` then lists that shop with an `error` code.

**`annon_share`** encrypts a file inside `workDir` and sells it through a shop: it uploads the
encrypted file to the shop's host, registers the terms and publishes the file. It accepts `shop`
(otherwise the configured `defaultShop`), `title` and `description`. The shop must have a deployment
`profile` in the human configuration that matches the configured deployment. The pending seller
backup is saved before any signature or transaction. Resume with
`{ "target": "original.pdf", "resume": "0xFILE_ID" }`, without new terms. The split pays the seller,
plus the relayer's fee share for EVM and Solana sellers; a fee above `maxProtocolFee` is refused with
`protocol_fee_above_max`. A NEAR seller's listing and purchase storage come only from `listingStorage`
and `storageBudget` in the human configuration (`storage_required` without them).

**`annon_budget`** is read-only. Funding a file is for humans only: there is no funding tool, and
`fund` in agent mode returns `human_only`. NEAR and 1Click buys return `file_storage_low` before
paying when the file's storage budget is too low.

## How a purchase runs

1. `annon_buy` creates the purchase. For 1Click it returns deposit instructions; someone funds the
   deposit from their own wallet before the cutoff. Annon never sends it.
2. After `submitted`, call `annon_status` about every 30 seconds until `accepted`. A `pending`
   state and a `settlement_pending` error mean wait, never failure. Resumable pending results and
   `settlement_pending` errors carry `retryAfterSeconds` (30 when nothing more precise is known); a
   setup that needs a human has no retry hint. The server refuses a retry before that time.
3. Open with `annon_open` once the status is `accepted`.

Never pay again for a purchase in flight. `annon_status` and `annon_open` can resume a saved paid
Base purchase by sending `unlock` before downloading, which is why status is not annotated
read-only. Expired or canceled Base payments are marked in the local encrypted record and the
current backup; the purchase and its recovery material stay available. Batch recovery reports
per-purchase errors next to the successful grants.

## Safety model

The operator owns the configuration, the environment, the credentials and the working directory.
MCP is the policy boundary between them and the agent.

**Paths.** `annon_open.output`, `annon_open.file`, `annon_share.target`, `annon_sell.target` and `annon_sell.output`
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
set `isError: true` and return `{ ok: false, error }`, where `error` has `code`, `message` and
`exitCode` (1 other failure, 2 invalid input or configuration, 3 human approval or trust needed,
4 pending, retry later), and, when known, `fileId`, `purchaseId`, `txHash`, `minimumAmountUsdc` and
`retryAfterSeconds`. The CLI's `--json` errors use the same object. Results never contain keys,
signed authorizations or plaintext.

## Payment summary

`payment` reports, from the verified purchase terms:

| Field | Meaning |
| --- | --- |
| `amountUsdc` | Price in decimal USDC |
| `amountBaseUnits` | Price in USDC base units |
| `asset` | `symbol` and `id` |
| `network` | Network of the payment |
| `route` | How the buyer paid: `near`, `base` or `1click` |
| `source` | For 1Click only, the reviewed source asset and amount |

Top-level `route` in buy, status and open results uses the same names and matches `payment.route`.
Status and open include the summary when the saved purchase and the backup secret are available;
without them, `status` and `open` omit `route` rather than guess it. The summary never contains a
deposit address or a signed authorization. Reporting is best-effort: an unreadable record or secret
omits `payment` without blocking an accepted status or a recovery open.

## License

Apache-2.0. Part of [Annon](https://annon.dev), created by [defdone](https://defdone.com).
