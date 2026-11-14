# Architecture

A map of the code for reviewers who want to reproduce the project, find where a feature lives and
check it. For what Annon does and why, start with the [README](README.md).

## What is in this repository

This monorepo holds the whole Annon stack. A NEAR contract in Rust stores each file's terms,
accepts or verifies payments and asks the NEAR MPC network to release file keys. A TypeScript SDK
encrypts and decrypts PAY2 files, pays on every route and talks to the contract, and ships with the
`annon` CLI and a browser bundle. An MCP server exposes the same commands to agents. Two services
run a shop: a relayer that sponsors NEAR transactions and settles payouts, and a demo file host that
serves files behind HTTP 402 and accepts hosted uploads. The formats are specified in `specs/`, with
test vectors that both the SDK and the contract check.

## Layout

| Path | What | Main entry files |
|---|---|---|
| [contracts/annon](contracts/annon) | NEAR contract (Rust, near-sdk) | `src/lib.rs`, `src/register.rs`, `src/receive.rs`, `src/unlock.rs`, `src/keys.rs`, `src/payout.rs`, `tests/sandbox.rs` |
| [contracts/mock-mpc](contracts/mock-mpc), [contracts/mock-token](contracts/mock-token) | MPC and USDC stand-ins for the sandbox tests | `src/lib.rs` |
| [packages/annon](packages/annon) | `@defdone/annon`: SDK, `annon` CLI, browser bundle | `src/index.ts` (SDK), `src/node/main.ts` (CLI), `src/browser/index.ts` (browser), `src/relay/index.ts` (service side), `scripts/build-browser.ts` |
| [packages/annon-mcp](packages/annon-mcp) | `@defdone/annon-mcp`: local MCP server over the CLI adapter | `src/main.ts`, `src/server.ts` |
| [apps/relayer](apps/relayer) | Relayer: sponsored NEAR calls and the settlement keeper | `server.ts`, `admission.ts`, `config.ts`, `background-work.ts`, `monitoring.ts`, `cutover.ts` |
| [apps/demo-host](apps/demo-host) | File host: x402 offers, proof-gated downloads, hosted uploads, Base facilitator | `server.ts`, `uploads.ts`, `downloads.ts`, `facilitator.ts` |
| [specs](specs) | Formats and protocol, shared test vectors and their generators | `pay2.md`, `near-settlement.md`, `x402-annon.md`, `download.md`, `nonce.md`, `vectors/*.mjs` |
| [skills/annon](skills/annon) | Agent skill for the CLI and MCP tools | `SKILL.md` |
| [docs](docs) | User guides: buying, selling, agents, limits, failures | `quickstart.md`, `selling.md`, `agents.md` |

Inside `packages/annon/src`, each folder is one concern: `envelope/` (PAY2 format and streaming),
`keys/` (CKD one-time keys), `settle-near/` and `near/` (contract encoding, texts, RPC), `pay/`
(Base payments, x402, splits, purchase records, backups), `oneclick/` (1Click), `download/` (file
serving, buyer proofs, hosted uploads), `wallet/` (NEAR, EVM and Solana wallets), `relay/`
(relayer and keeper logic), `shops/` (shop discovery), `api/` (the `Annon` client and hosted
selling), `browser/` and `node/` (the two runtimes).

## Purchase flow

```text
Buyer client               File host            NEAR contract            NEAR MPC
(SDK, CLI, MCP, browser)   (serveFile)          (contracts/annon)        network
  |                          |                    |                        |
  |-- GET /f/<name> -------->|                    |                        |
  |<-- 402, x402 offers -----|                    |                        |
  |-- get_file: terms, commitment --------------->|                        |
  |                          |                    |                        |
  |-- near: ft_transfer_call, USDC on NEAR ------>| ft_on_transfer         |
  |-- 1click: source chain deposit, swapped by    |                        |
  |   1Click into USDC on NEAR ------------------>| ft_on_transfer         |
  |-- base: EIP-3009 sig. -->|                    |                        |
  |                          | pays USDC on Base  |                        |
  |-- base: unlock, sent by relayer or buyer ---->|-- verify Base tx ----->|
  |                          |                    |<-- verified -----------|
  |-- claim_key (near, 1click; base: in unlock) ->|-- CKD request -------->|
  |<-- answer encrypted to the one-time key ------|<-- CKD answer ---------|
  |-- GET /f/<name>, proof ->|                    |                        |
  |                          |-- get_purchase --->|                        |
  |<-- PAY2 ciphertext ------|                    |                        |
  |                          |                    |                        |
  check every chunk, unwrap the file key, decrypt locally
```

## Selling flow

Hosted selling through a shop (`annon share`). Self-hosted selling (`annon sell`) skips the shop
and registers from the seller's own NEAR account or through the relayer.

```text
Seller client          Shop host            Relayer              NEAR contract       Base
(CLI, SDK, MCP)        (demo-host)          (apps/relayer)
  |                      |                    |                    |                   |
  | encrypt locally (PAY2), save an encrypted backup               |                   |
  |-- stage: upload ---->|                    |                    |                   |
  |   body and header    | check ciphertext   |                    |                   |
  |                      |                    |                    |                   |
  |-- split (EVM) ------>|-- create the split contract for the file's shares --------->|
  |                      |                    |                    |                   |
  |-- register, EVM or Solana seller -------->|                    |                   |
  |                      |<-- reservation ----|                    |                   |
  |                      |                    | checks reservation |                   |
  |                      |                    | quota, fee share   |                   |
  |                      |                    |-- register ------->|                   |
  |                      |                    |                    |                   |
  |-- register, NEAR seller: storage_deposit, |                    |                   |
  |   register, fund_file_storage -------------------------------->|                   |
  |                      |                    |                    |                   |
  |-- publish ---------->|-- check terms ------------------------->|                   |
  |                      | serve at /f/<name> |                    |                   |
```

The steps per seller kind are fixed in `packages/annon/src/api/hosted-record.ts`: NEAR sellers run
`stage, deposit, register, fund, publish`, EVM sellers `stage, split, register, publish`, Solana
sellers `stage, register, publish`. Each step is checkpointed, so `--resume` continues a stopped sale.

## Where each flow lives

Paths without a top-level folder are under `packages/annon/src/`. The host and relayer column names
the SDK modules those services use, their own files under `apps/`, and the relayer methods involved.

| Flow | Client: SDK, CLI, browser | Host and relayer | Contract (`contracts/annon/src/`) |
|---|---|---|---|
| Buy on NEAR | `api/annon.ts` (`buy`), `wallet/wallet.ts` (`transferPurchase`), `settle-near/purchase.ts`, `node/buy-commands.ts`, `node/purchase-guard.ts`, `node/budget.ts` | `pay/seller.ts` and `download/host.ts` (402 offer) | `receive.rs`, `purchase.rs` |
| Buy on Base | `api/annon.ts` (`buy`), `pay/pay.ts`, `pay/x402.ts`, `pay/eip3009.ts`, `pay/base.ts`, `pay/purchase.ts`, `node/buy-commands.ts`, `node/offers.ts` | `pay/seller.ts`, `pay/settle.ts`, `apps/demo-host/facilitator.ts`, relayer `unlock` | `unlock.rs`, `mpc.rs`, `evm.rs` |
| Buy via 1Click | `api/annon.ts` (`buy`), `oneclick/oneclick.ts`, `node/origin.ts`, `node/buy-commands.ts` | `pay/seller.ts` and `download/host.ts` (402 offer) | `receive.rs` |
| Open or recover a purchase | `api/annon.ts` (`open`, `recover`, `proveRecovery`), `keys/near-ckd.ts`, `download/download.ts`, `download/proof.ts`, `envelope/stream.ts`, `pay/backup.ts`, `pay/recover.ts`, `node/purchase-commands.ts`, `browser/purchases.ts`, `browser/download.ts` | `download/host.ts` (`serveFile`), `apps/demo-host/downloads.ts`, relayer `claim_key`, `reopen` | `keys.rs`, `mpc.rs` |
| Sell from the CLI or SDK | `api/annon.ts` (`sell`, `resumeSell`, `reopenSeller`), `envelope/pay2.ts`, `envelope/stream.ts`, `settle-near/terms.ts`, `near/texts.ts`, `pay/split.ts`, `node/seller-commands.ts`, `node/relay-transport.ts`, `node/core-adapter.ts` | relayer `register` | `register.rs`, `terms.rs`, `storage.rs` |
| Hosted share through a shop | `api/sharing.ts` (`HostedSelling`), `api/hosted-record.ts`, `api/sharing-types.ts`, `download/upload.ts`, `relay/reservation.ts`, `shops/discovery.ts`, `node/seller-commands.ts`, `node/sharing.ts`, `node/shops.ts`, `browser/selling.ts` | `apps/demo-host/uploads.ts`, `apps/demo-host/upload-http.ts`, `apps/demo-host/capacity.ts`, `apps/demo-host/eligibility.ts`, `apps/demo-host/split-policy.ts`, `apps/demo-host/facilitator.ts` | `register.rs`, `storage.rs` |
| Stop sales | `api/annon.ts` (`stop`), `node/seller-commands.ts` | relayer `stop_sales` | `moderation.rs` |
| Relayer admission and sponsorship | `relay/relay.ts`, `relay/relay-checks.ts`, `relay/relay-request.ts`, `relay/relay-transactions.ts`, `relay/relay-reconciliation.ts`, `relay/sponsorship.ts`, `relay/ledger.ts`, `relay/fees.ts`, `relay/capabilities.ts`, `relay/admission.ts` | `apps/relayer/server.ts`, `apps/relayer/admission.ts`, `apps/relayer/config.ts`, `apps/relayer/monitoring.ts` | `storage.rs` |
| Keeper settlement | `relay/keeper.ts`, `relay/keeper-runner.ts`, `relay/keeper-balance.ts` | `apps/relayer/background-work.ts` | `payout.rs`, `merkle.rs` |
| Relayer cutover | `relay/ledger.ts` | `apps/relayer/cutover.ts`, `apps/relayer/cutover-scan.ts` | none |

The CLI runs through `node/main.ts`, `node/cli.ts` (argument parsing), `node/adapter.ts` and
`node/core-adapter.ts`, which dispatches to the command modules above. The MCP server calls the
same adapter, so every MCP tool behaves like the matching CLI command.

## How to check it

You need Node.js `^22.18.0 || >=23.6.0` (from `package.json` engines; CI runs Node 26), pnpm 12
(`corepack enable` picks the pinned version), and Rust 1.97.1 with the `wasm32-unknown-unknown`
target from `rust-toolchain.toml`. Everything runs from the repository root, locally, and sends no
transactions. These are the steps of `.github/workflows/ci.yml`.

Install:

```sh
pnpm install --frozen-lockfile
```

Dependency audit (needs network access):

```sh
pnpm audit --prod
```

Lint and format check (Biome):

```sh
pnpm check
```

Spec vectors: regenerate them and fail if a committed file differs from its generator:

```sh
node specs/vectors/near-settlement.mjs && node specs/vectors/pay2.mjs && node specs/vectors/texts.mjs && node specs/vectors/base-headers.mjs && node specs/vectors/nonce.mjs > /dev/null && node specs/vectors/buyer-proof.mjs > /dev/null && node specs/vectors/upload.mjs && git diff --exit-code specs/vectors
```

Typecheck and build. Every package's `build` script runs `tsc --noEmit` first:

```sh
pnpm build
```

Test suite (SDK, CLI, MCP server, relayer, demo host):

```sh
pnpm test
```

Container tests of the relayer and the demo host (need Docker):

```sh
ANNON_TEST_CONTAINER=1 pnpm --filter @defdone/annon-relayer exec vitest run -t "starts after the Docker prod-filter install"
```

```sh
ANNON_TEST_CONTAINER=1 pnpm --filter @defdone/annon-demo-host exec vitest run -t "starts after the Docker prod-filter install"
```

Contract format check, lint, wasm build and tests. `build.sh` builds the wasm the sandbox tests
deploy:

```sh
cargo fmt --check
```

```sh
cargo clippy --all-targets -- -D warnings
```

```sh
contracts/annon/build.sh
```

```sh
cargo test
```

## Direction

The two largest remaining files are the `Annon` client class (`packages/annon/src/api/annon.ts`)
and the hosted selling class (`packages/annon/src/api/sharing.ts`); after the hackathon we plan to
split them by purchase route and selling step, and to move the demo host to the SDK's public entry
points ([ROADMAP.md](ROADMAP.md#smaller-client-and-selling-modules)).
