# @defdone/annon-mcp

Local stdio MCP server over `@defdone/annon`. Build with `pnpm build`, then configure your
MCP client to run `annon-mcp` (or `node /absolute/checkout/packages/annon-mcp/dist/main.js`).
Stdout is exclusively MCP transport. The official `@modelcontextprotocol/sdk` is pinned to
1.32.2 (published 23 October 2026), older than the workspace's 14-day release-age minimum
as of 11 November 2026. This includes upstream security fixes absent from older cached SDKs.

Use the [CLI configuration and secret sources](../annon/CLI.md). Supply the same `ANNON_*`
environment variables to the server process. Tool arguments accept named key/backup-secret
file paths, never secret key values. No tool scans for wallets. Contract trust must have
been recorded by the CLI, or explicitly supplied with `trustContract: true`.

Tools use camelCase versions of CLI flags, with `target` as the positional operand:

| Tool | Required arguments | Result |
| --- | --- | --- |
| `annon_sell` | `target`, `price`, `split` | File ID, PAY2 path, public terms |
| `annon_buy` | `target` | Purchase ID, route, encrypted backup path; 1Click deposit instructions when applicable |
| `annon_open` | `target`, `output` | Plaintext output path and byte count |
| `annon_verify` | `target` | Registered file ID, verification scope |
| `annon_recover` | `recovery` | Purchase IDs, final grant numbers, encrypted backup paths |
| `annon_status` | `target` | Final NEAR purchase state; pending does not mean payment failed |

Common optional arguments: `config`, `contractId`, `nearRpc`, `baseRpc`, `network`,
`stateDir`, `relayer`, `trustContract`, `wallet`, `evmKeyFile`, `solanaKeyFile`,
`nearKeyFile`, `nearAccount`, `nearPublicKey`, `backupSecretFile`.
`annon_buy` additionally accepts `route: "near" | "base" | "1click"`, `fromChain`,
`fromAsset`, `refundTo`, `recovery`, `maxPrice`, `moderator`. `annon_open` accepts
`purchase`, `file`, `url`. See tool schemas for the complete list.

Every tool returns `structuredContent: { ok: true, result: ... }` and matching text JSON.
Errors set `isError: true` and return `{ ok: false, error: { code, message } }`.
Outputs omit keys, signed authorizations and plaintext. 1Click instructions must be funded
externally; check `annon_status` before opening. Existing output files are never overwritten.
