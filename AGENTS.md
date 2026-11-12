# AGENTS.md

Notes for coding agents working in this repository.

## Layout

| Path | What |
|---|---|
| `contracts/annon` | NEAR contract (Rust) |
| `contracts/mock-mpc`, `contracts/mock-token` | Stand-ins for local sandbox tests |
| `packages/annon` | `@defdone/annon`: SDK, CLI and browser wallet adapters |
| `packages/annon-mcp` | `@defdone/annon-mcp`: MCP server |
| `apps/relayer` | Relays `register`, `unlock`, `claim_key`, `reopen`, `reopen_seller`, `stop_sales` and `fund_file_storage`; optional settlement keeper |
| `apps/demo-host` | x402 offers, purchase grant downloads and optional Base facilitator |
| `specs/` | PAY2 format, nonce, download, x402 profile, NEAR settlement and vectors |
| `skills/annon` | Agent instructions for the CLI and MCP tools |

A directory exists only once it has code.

## Commands

```sh
pnpm install
pnpm check        # Biome lint + format check
pnpm format       # apply Biome fixes
pnpm test
pnpm build
```

## Rules

- ESM only, TypeScript strict. Browser and Node share one code path (WebCrypto).
- Tests first for anything that touches payments, keys or the contract.
- Never commit keys, `.env` files or wallet secrets.
- Packages are private for now; record package changes in a changeset (`pnpm changeset`).
