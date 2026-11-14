# Contributing

## Setup

- Node 22.22.2 or newer, on Node 23 use 23.6 or newer (CI runs 26), pnpm 12 (`npm i -g pnpm@12`; the exact version is pinned in `package.json`)
- Rust from `rust-toolchain.toml`, for the contract: run `rustup toolchain install` in the repository

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
