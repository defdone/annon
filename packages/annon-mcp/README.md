# @defdone/annon-mcp

Local stdio MCP server over `@defdone/annon`. Build with `pnpm build`, then configure your
MCP client to run `annon-mcp` (or `node /absolute/checkout/packages/annon-mcp/dist/main.js`).
Stdout is exclusively MCP transport. The official `@modelcontextprotocol/sdk` is pinned to
1.32.2 (published 23 October 2026), older than the workspace's 14-day release-age minimum
as of 11 November 2026. This includes upstream security fixes absent from older cached SDKs.

Use the [CLI configuration and secret sources](../annon/CLI.md). Supply the same `ANNON_*`
environment variables to the server process. Deployment IDs, RPCs, relayer, wallet/key-file
selection, state/backup locations, moderator trust and contract trust come only from server
env/config or prior human CLI trust. They are rejected as tool arguments. Configure a decimal
USDC `maxPrice` in the pinned config before using `annon_buy`; a tool cannot override this cap.
MCP always applies agent policy. `ANNON_STATE_DIR` is ignored; configure `stateDir` in the
operator config. Config `maxPrice` is required and `ANNON_MAX_PRICE` can only lower it.
`allowedResources` is optional: absence permits any HTTPS URL or HTTP localhost URL
within mandatory `maxPrice` and `dailyBudget`. When present, exact URLs and same-origin
path prefixes ending in `/*` restrict purchases; an empty list denies all.
`ANNON_ALLOWED_RESOURCES`, when present, further restricts this policy. This applies to every agent-mode trigger. The launcher flag `ANNON_AGENT=true` pins the
config to `~/.config/annon/config.json`; the other triggers use the operator-selected config.
Set `ANNON_MODERATORS` (comma-separated) or config `moderators` for buyer moderator trust.

Tools use camelCase versions of CLI flags, with `target` as the positional operand:

| Tool | Required arguments | Result |
| --- | --- | --- |
| `annon_sell` | `target` plus `price`, `split` or `resume` | File ID, PAY2 path, public terms |
| `annon_buy` | `target` | Purchase ID, route, payment summary, encrypted backup path; 1Click deposit instructions when applicable |
| `annon_open` | `target`, `output` | Plaintext output path, byte count, payment summary when saved |
| `annon_verify` | `target` | Registered file ID, verification scope |
| `annon_recover` | `recovery` | Purchase IDs, final grant numbers, encrypted backup paths |
| `annon_budget` | `target` | Available file storage and admission requirement in yoctoNEAR |
| `annon_status` | `target` | Final NEAR purchase state, payment summary when saved; pending does not mean payment failed |

`annon_buy` accepts `route: "near" | "base" | "1click"`, `origin`, `recovery`, and `url`.
`origin` names an entry in human config `origins` or JSON `ANNON_ORIGINS`; its `fromChain`,
`fromAsset` and optional `refundTo` cannot be supplied by a tool. Refunds use human configuration
or the matching wallet address. Tools cannot choose arbitrary source assets or redirect refunds.
Agent purchases refuse local offer files. `target` must be a secure resource URL within any configured allowlist.
The adapter fetches its offer from that URL and checks that the advertised resource matches it.
The offer header must share the resource origin. An optional `url` cannot authorize an offer file.
URLs accept HTTPS, and plain HTTP only for `localhost`, `127.0.0.1` or `[::1]`,
for example `http://localhost:8790/file`. The same rule applies to `annon_verify`.
`annon_sell` resumes with `{ target: "original.pdf", resume: "0xFILE_ID", output: "new.pay2" }`;
price/split are required for new listings and forbidden during resume. Failed saved sells include
`error.fileId`. Published jobs and current backups retain public metadata, clearing file/CKD/one-time
secrets; see the CLI documentation for recovery requirements and external-backup limits.
`annon_open` accepts `purchase`, `file`, `url`. See tool schemas for the complete list.

Agent mode requires a human-set config `workDir`. Only an explicit launcher setting
`ANNON_AGENT=true` permits `ANNON_WORK_DIR` to supply or override it. It has no tool argument.
`annon_open.output`, `annon_open.file`, `annon_sell.target` and `annon_sell.output` must resolve
inside this directory. Local `annon_verify.target` files, non-ID `annon_open.target` inputs and
non-ID `annon_open.purchase` backups follow the same rule. Verify URLs remain remote, and open
purchase IDs remain identifiers. Relative paths start there; existing inputs and output parents use
`realpath`. Symlink escapes, dangling symlinks, paths outside the directory and any `..` segment
are refused with fixed code `path_not_allowed`. The default sell output is checked too; output
parents must already exist. Returned paths are canonical. Existing outputs are never overwritten.

MCP is the policy boundary, with configuration, environment, credentials and directory ownership
controlled by the operator. These checks do not contain a shell agent running as the same OS
user: it can edit that user's config, change files or invoke another client. Use separate OS
permissions when those capabilities must be restricted.

`annon_status` and `annon_open` can resume saved paid Base purchases by submitting unlock
before downloading. Status is therefore not annotated read-only. Expired/canceled Base payments are marked in the
local encrypted record and current backup; the purchase and recovery material remain available. Batch recovery reports
per-purchase errors alongside successful grants.

Every tool returns `structuredContent: { ok: true, result: ... }` and matching text JSON.
Errors set `isError: true` and return `{ ok: false, error: { code, message } }`.
Outputs omit keys, signed authorizations and plaintext. 1Click instructions must be funded
externally; check `annon_status` before opening. Existing output files are never overwritten.

Waiting: after `submitted`, poll `annon_status` (or `annon status`) about every 30 seconds
until `accepted`, then open. `payment_not_safe` and `pending` mean wait, not failure;
never pay again. For 1Click, fund the deposit first. Resumable pending status and
`payment_not_safe` include `retryAfterSeconds: 30`; setup needing human action has no retry hint.

`payment` reports `amountUsdc` (decimal USDC), `amountBaseUnits`, `asset` (`symbol`, `id`),
`network` and `route` (`near`, `base` or `1click`) from verified purchase terms. For 1Click,
`payment.source` retains the reviewed source asset and amount. Status/open include this
summary when the saved purchase and backup secret are available; older records can lack
source details. Payment summaries contain no deposit address or signed authorization.
Payment reporting is best-effort: unreadable records or secrets omit `payment` without blocking accepted status or recovery open.
Top-level `route` is the contract route (`near-usdc`/`base-usdc`); `payment.route` is how the buyer paid (`near`/`base`/`1click`).

`annon_sell` accepts no storage-budget argument. A self-funded NEAR listing uses decimal
NEAR `storageBudget` from human configuration; sponsored listings receive the relayer's
bounded allocation. Result `terms` includes the final treasury split. NEAR and 1Click buys
return fixed code `file_storage_low` before paying when storage funding is insufficient.
`annon_budget` is read-only. Funding is human-only and has no MCP tool; agent-mode
`fund` returns `human_only`. The human CLI can allocate nonwithdrawable file funding.
Config `maxProtocolFee` defaults to `{ "fixed": "30000", "bps": 100 }` in USDC base units
plus basis points. MCP sells refuse higher advertised fees with `protocol_fee_above_max`.
Agent resource URLs refuse encoded path separators `%2f` and `%5c` in every case.
