# Changelog

Changes to the specifications, the contract and the packages that users can see. Detailed changes
for the SDK and the MCP server are in [packages/annon/CHANGELOG.md](packages/annon/CHANGELOG.md)
and [packages/annon-mcp/CHANGELOG.md](packages/annon-mcp/CHANGELOG.md). Dates are UTC.

## Unreleased

- Contract build: `contracts/annon/build.sh` remaps local file paths and prints the NEAR code hash.
  `build.sh --release` builds with `cargo near build reproducible-wasm` in a NEAR container pinned
  by digest, so the same commit gives the same wasm on any machine; CI uses it and publishes the
  wasm as an artifact. The deployed contract is unchanged.
- [specs/README.md](specs/README.md): status, versioning rules and reading order of the
  specifications. Proposals for the protocol go to
  [GitHub Discussions](https://github.com/defdone/annon/discussions).

## 14 Nov 2026: @defdone/annon and @defdone/annon-mcp 0.1.0-alpha.0 through 0.1.0-alpha.5

- **alpha.5**: in a terminal, a command that stops for missing credentials says how to sign in or configure a key.
  The MCP server returns short usage instructions when it starts. Both packages need Node.js
  22.22.2 or newer.
- **alpha.4**: `annon init --deployment defdone` writes the configuration for the deployment run by
  defdone. `share` and sponsored `sell` show their terms as readable lines, and each browser
  approval is named before it opens.
- **alpha.3**: `annon` in a terminal starts an interactive session. `annon buy` takes a catalog row
  number and `--open`; `status` and `open` default to the latest purchase. Accepted browser
  approvals stay successful after the session closes.
- **alpha.2**: `BrowserPurchaseController.reconcile()` rechecks a purchase that 1Click reported as
  failed. Bare `annon init` creates the backup secret. The wallet approval page shows what the
  wallet signs.
- **alpha.1**: the Base payment search reads logs in chunks that public RPCs accept. NEAR login
  offers Meteor Wallet and HOT Wallet in place of MyNearWallet.
- **alpha.0**: first public alpha on the npm `alpha` tag. It covers PAY2 encryption, USDC purchases
  on NEAR, on Base through x402 and from other chains through NEAR Intents 1Click, key release
  through NEAR MPC and recovery on a new device. It ships the `annon` CLI and the MCP server with
  limits set by the owner.

## 12 Nov 2026: contract on mainnet

- `v1.annon.defdone.near` deployed on NEAR mainnet, code hash
  `FFuE8TCvuVTtLK7vVAsmBoj4BSHq1X64fzpuiF2MrKNU`, upgradeable by defdone during the alpha.

## 10 Nov 2026: one settlement model

- [near-settlement.md](specs/near-settlement.md) draft 3 (status dated 11 Nov),
  [PAY2 version 2](specs/pay2.md) and the [x402 profile extension version 3](specs/x402-annon.md).
  Earlier versions are neither produced nor accepted.
