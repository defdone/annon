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
USDC `maxPrice` / `ANNON_MAX_PRICE` before using `annon_buy`; a tool cannot override this cap.
Set `ANNON_MODERATORS` (comma-separated) or config `moderators` for buyer moderator trust.

Tools use camelCase versions of CLI flags, with `target` as the positional operand:

| Tool | Required arguments | Result |
| --- | --- | --- |
| `annon_sell` | `target` plus `price`, `split` or `resume` | File ID, PAY2 path, public terms |
| `annon_buy` | `target` | Purchase ID, route, encrypted backup path; 1Click deposit instructions when applicable |
| `annon_open` | `target`, `output` | Plaintext output path and byte count |
| `annon_verify` | `target` | Registered file ID, verification scope |
| `annon_recover` | `recovery` | Purchase IDs, final grant numbers, encrypted backup paths |
| `annon_status` | `target` | Final NEAR purchase state; pending does not mean payment failed |

`annon_buy` accepts `route: "near" | "base" | "1click"`, `origin`, `recovery`, and `url`.
`origin` names an entry in human config `origins` or JSON `ANNON_ORIGINS`; its `fromChain`,
`fromAsset` and optional `refundTo` cannot be supplied by a tool. Refunds use human configuration
or the matching wallet address. Tools cannot choose arbitrary source assets or redirect refunds.
For an offer file, `url` must match both the offer and human config `allowedResources`
(or comma-separated `ANNON_ALLOWED_RESOURCES`). Two agent-controlled matching strings establish
consistency only; the allowlist supplies independent authorization. A direct HTTPS target is itself
the selected resource and must match its advertised offer.
`annon_sell` resumes with `{ target: "original.pdf", resume: "0xFILE_ID", output: "new.pay2" }`;
price/split are required for new listings and forbidden during resume. Failed saved sells include
`error.fileId`. Published jobs and current backups retain public metadata, clearing file/CKD/one-time
secrets; see the CLI documentation for recovery requirements and external-backup limits.
`annon_open` accepts `purchase`, `file`, `url`. See tool schemas for the complete list.
`annon_status` and `annon_open` can resume saved paid Base purchases by submitting unlock
before downloading. Status is therefore not annotated read-only. Expired/canceled Base payments are marked in the
local encrypted record and current backup; the purchase and recovery material remain available. Batch recovery reports
per-purchase errors alongside successful grants.

Every tool returns `structuredContent: { ok: true, result: ... }` and matching text JSON.
Errors set `isError: true` and return `{ ok: false, error: { code, message } }`.
Outputs omit keys, signed authorizations and plaintext. 1Click instructions must be funded
externally; check `annon_status` before opening. Existing output files are never overwritten.
