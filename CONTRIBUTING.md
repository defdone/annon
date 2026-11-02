# Contributing

## Setup

- Node 20.19 or newer, pnpm 10 (`corepack enable`)
- Rust from `rust-toolchain.toml`, for the contract

```sh
pnpm install
pnpm check   # Biome: lint and format
pnpm test
```

## Changes

- One topic per pull request. Tests come with the change.
- A change to a published package needs a changeset: `pnpm changeset`.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`).
- Security issues go through private reporting, see `SECURITY.md`.
