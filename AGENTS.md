# AGENTS.md

Notes for coding agents working in this repository.

## Layout

| Path | What |
|---|---|
| `contracts/annon` | NEAR contract (Rust) |
| `packages/annon` | `@defdone/annon`: SDK, CLI and `<annon-buy>` |
| `packages/annon-mcp` | `@defdone/annon-mcp`: MCP server |
| `apps/relayer` | Submits `unlock` and `reopen` for buyers without a NEAR account |
| `apps/web` | Demo and verify page |
| `specs/` | PAY2 format, nonce, receipt and contract interface |
| `examples/` | Runnable examples, checked in CI |

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
- A published package change needs a changeset (`pnpm changeset`).
