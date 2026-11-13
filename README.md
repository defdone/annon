<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/annon-mark-dark.svg">
    <img src="docs/assets/annon-mark.svg" width="72" height="72" alt="Annon mark: a gate arch">
  </picture>
</p>

<h1 align="center">Annon</h1>

<p align="center"><b>Pay, friend, and enter.</b><br>
Files only the buyer can open. The file is encrypted before it leaves the seller, and NEAR releases
the key after it has checked the payment itself.</p>

<p align="center">
  <a href="https://annon.dev/demo">Demo</a> ·
  <a href="specs/">Specification</a> ·
  <a href="packages/annon">SDK and CLI</a> ·
  <a href="packages/annon-mcp">MCP server</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="https://annon.dev">annon.dev</a>
</p>

---

## What it is

Selling a digital file usually means trusting a platform. The platform stores the file, holds the
buyer's money, and decides who gets the download link. If it disappears, changes its rules or leaks
the file, the seller and the buyer have no recourse.

Annon is an open protocol and SDK that removes that middle role:

- The seller encrypts the file on their own machine and registers its terms on a NEAR contract: the
  price, who is paid and in what shares. The encrypted file can be hosted anywhere. The host cannot
  read it.
- The buyer pays in USDC on NEAR, on Base through [x402](https://x402.org), or from another chain
  through NEAR Intents (1Click). The contract checks the payment on chain, Base included.
- NEAR's MPC network then derives the file key for a one-time key that only the buyer holds. No
  host, relayer or platform ever sees the key.
- The money follows the registered split. USDC paid on NEAR waits in the contract until anyone calls
  `settle`, which credits every recipient's NEAR Intents account. USDC paid on Base goes straight to
  the file's Base address, an 0xSplits contract that pays the same shares on Base.

People and AI agents buy the same way: an Annon file is an ordinary URL that answers HTTP `402` with
its offers.

Three payment routes, named the same in the SDK, the CLI and the MCP server:

| Route | The buyer pays with |
|---|---|
| `near` | USDC on NEAR, sent from a NEAR account |
| `base` | USDC on Base, through x402 |
| `1click` | A supported token on another chain, swapped by NEAR Intents into USDC on NEAR |

For this release, direct `base` payments require a Base payee in the file's final on-chain terms.
The listing flow will enable Base for EVM sellers; NEAR and Solana sellers will list with
`base: null`, for `near` and `1click` purchases. A buyer holding USDC on Base uses `1click` for a
file without Base terms. Checks across the host, shop and clients are pending release.

**Status:** alpha. The contract runs on NEAR mainnet, can still be upgraded by defdone and has no
independent audit yet; see [Security](#security-and-limits).

## Try it

### In a browser

Open the demo shop at **[annon.dev/demo](https://annon.dev/demo)**, pick a file and pay from a NEAR
wallet, an EVM wallet on Base, or a wallet on another chain through 1Click. You get the decrypted
file and a receipt with links to every transaction.

You buy with your own funds: the demo file costs 0.10 USDC. The sponsorship fee comes from that
price, through the registered split. On Base you need only USDC, no ETH. On NEAR you also need a
little NEAR for gas. Through 1Click, fund the quoted source-token amount and gas on its chain; the
quote includes the swap fees.

About the demo:

- The shop is at `https://annon.dev/demo`, the encrypted files at `https://demo.annon.dev`, and the
  relayer at `https://relayer.mainnet.annon.dev`.
- It runs until 18 November 2026, at the latest 19 November.
- Open uploads are pending release. The demo's open pool will allow 60 new files per UTC day across
  unlisted sellers, with one per IP address and one per wallet per UTC day. Listed sellers have a
  separate allowance. Each file may contain at most 50 MB of plaintext.
- Uploaded files will expire seven days after first publication, except the configured canonical
  demo file. Keep your own copy of anything you buy.
- Selling from the browser is pending release: we open it once the acceptance tests pass with NEAR,
  EVM and Solana wallets.
- Questions, or a file to report: hello@annon.dev.

### From the command line

You need Node.js 22 or newer and a NEAR wallet with at least 0.10 USDC and a little NEAR for
transaction fees.

The alpha package is pending publication. Use these commands once it is published.

```sh
npm install -g @defdone/annon@alpha
```

Create `~/.config/annon/config.json`:

```json
{
  "contractId": "v1.annon.defdone.near",
  "network": "near:mainnet",
  "nearRpc": "https://rpc.mainnet.fastnear.com",
  "relayer": "https://relayer.mainnet.annon.dev",
  "stateDir": "/absolute/path/to/annon-state",
  "maxPrice": "0.10"
}
```

Create the backup secret that encrypts your local purchase records, and keep it outside any
repository:

```sh
openssl rand -hex 32 > "$HOME/.annon-backup-secret" && chmod 600 "$HOME/.annon-backup-secret"
export ANNON_BACKUP_SECRET_FILE="$HOME/.annon-backup-secret"
```

Sign in with your NEAR wallet in the browser. No key is installed; every payment is approved in the
wallet:

```sh
annon login --wallet near
```

Check the file, buy it, wait for the purchase to be accepted, and open it:

```sh
annon verify https://demo.annon.dev/f/what-we-are-building --trust-contract
annon buy https://demo.annon.dev/f/what-we-are-building --route near
annon status 0xPURCHASE_ID
annon open 0xPURCHASE_ID --output what-we-are-building.pdf
```

`--trust-contract` records once that you trust this contract to release keys. `buy` shows the terms
and asks before it pays, then prints the purchase ID. If `status` says `pending`, or a command stops
with `settlement_pending` (exit code 4), wait and ask again. Never pay a second time for the same
purchase.

On another computer, the same wallet gets the file again without paying for it a second time.
Repeat the setup above (install, configuration, backup secret, `annon login`). A NEAR account pays
the storage for the new key grant itself, so prepay a little contract storage once, for example
with [near-cli-rs](https://github.com/near/near-cli-rs):

```sh
near contract call-function as-transaction v1.annon.defdone.near storage_deposit json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0.01 NEAR' sign-as YOUR_ACCOUNT.near network-config mainnet sign-with-keychain send
```

Then recover and open:

```sh
annon recover --recovery near:YOUR_ACCOUNT.near
annon open 0xPURCHASE_ID --url https://demo.annon.dev/f/what-we-are-building --output what-we-are-building.pdf
```

The full command reference, Base and 1Click payments, and local key files are in
[packages/annon/CLI.md](packages/annon/CLI.md).

### Sell a file

`sell` encrypts a file into a `.pay2` file and registers its terms. Put the `.pay2` file behind any
web server that serves Annon files (see [apps/demo-host](apps/demo-host) for a complete one) and
share the URL. Splits are in basis points, total 10000, and can pay up to eight recipients. There
are two ways to list.

**Sponsored, with an EVM or Solana wallet.** You need no NEAR. Our relayer submits the registration,
funds the file's storage, and adds a protocol fee of 0.03 USDC plus 1% to the split. The CLI shows the
final split and asks before it registers.

```sh
annon login --wallet evm
annon sell report.pdf --price 1.00 --split evm:0xYOUR_ADDRESS:10000 --output report.pay2
```

**Self-funded, with a NEAR account.** You send the transactions and pay the storage yourself, and no
protocol fee is added. Prepay contract storage with `storage_deposit` as shown above, give the file
its own purchase storage budget, and check it before you share the URL:

```sh
annon sell report.pdf --price 1.00 --split near:YOUR_ACCOUNT.near:10000 --storage-budget 0.05 --output report.pay2
annon budget 0xFILE_ID
```

### Fees

Using the protocol, the SDK, the CLI or the MCP server on your own infrastructure costs nothing
beyond network fees. We charge only when you use infrastructure that defdone runs: sponsored
registration and storage, the relayer, a Base split created by the demo shop, and demo hosting. The
charge is our cost plus a small margin. For a sponsored listing it is 0.03 USDC plus 1% of the price,
taken as a share of the file's split. A NEAR seller who funds their own listing pays no protocol
fee. There is no shop commission.

## How it works

```
 Seller                         NEAR                                Buyer
 ──────                         ────                                ─────
 encrypt file  ──register────▶  Annon contract
 (AES-256-GCM)    terms         price, split, file hash
                                                     ◀──pay USDC──  NEAR, Base (x402)
                                verify payment                       or any chain via
                                (Base through MPC                    NEAR Intents
                                 foreign-tx check)
                                MPC derives the key  ──encrypted──▶  one-time key
                                for the buyer only     to buyer      decrypts locally
                                settle: every share ──▶ NEAR Intents accounts
                                (Base payments are split on Base by 0xSplits)
```

What NEAR does, concretely:

| Step | On NEAR |
|---|---|
| Listing | The contract stores the terms, signed by the seller, and a commitment to the encrypted file that covers the hash of every chunk. |
| Payment on NEAR | USDC arrives through `ft_transfer_call`; the contract checks the amount against the terms. |
| Payment on Base | The contract asks the MPC network to verify the Base transaction (`verify_foreign_transaction`) instead of trusting a relayer or an oracle. |
| Payment from another chain | NEAR Intents (1Click) swaps and delivers USDC to the contract; the contract accepts it like a direct payment. |
| Key release | The MPC network runs confidential key derivation for the buyer's one-time key. Only that key can read the answer. |
| Payout | For payments received on NEAR, anyone can call `settle`, which credits each recipient's share to its NEAR Intents account, from which it can withdraw to any chain. Underpayments are refunded in full, overpayments accepted with the excess refunded. |
| Recovery | The buyer's wallet signs for a new one-time key on a new device. No second payment. |

The file format, the settlement rules and the x402 profile are written as specifications with test
vectors, so anyone can build a compatible implementation:

| Document | Defines |
|---|---|
| [specs/pay2.md](specs/pay2.md) | PAY2, the encrypted file format |
| [specs/near-settlement.md](specs/near-settlement.md) | Listing, purchase, routes, key release, payouts, refunds |
| [specs/x402-annon.md](specs/x402-annon.md) | The x402 offer and the Base payment |
| [specs/download.md](specs/download.md) | Serving the file to the buyer who proves the purchase |
| [specs/nonce.md](specs/nonce.md) | Purchase and payment nonces |
| [specs/vectors/](specs/vectors) | Test vectors, checked in CI |

## For agents

An agent buys with the same CLI, or through the local MCP server, under limits its owner sets: the
contract it trusts, the most it may pay per file and per day, and the directory it may read and
write. The alpha package is pending publication. Use this configuration once it is published.

```json
{
  "mcpServers": {
    "annon": { "command": "npx", "args": ["-y", "@defdone/annon-mcp@alpha"] }
  }
}
```

The server reads the same configuration file as the CLI, plus the limits only a person can set
(`maxPrice`, `dailyBudget`, `workDir`). The tools are `annon_buy`, `annon_status`, `annon_open`, `annon_recover`, `annon_verify`,
`annon_sell` and `annon_budget`. Configuration and the safety model are in
[packages/annon-mcp](packages/annon-mcp). For agents that use skills, [skills/annon](skills/annon)
describes the whole flow, including when to wait and never pay twice.

## For developers

```ts
import { Annon } from '@defdone/annon';
import {
  BrowserPurchaseController,
  browserEvmWallet,
  browserPurchaseStorage,
} from '@defdone/annon/browser';
```

The SDK runs in Node.js and in browsers. The browser entry includes a purchase controller that
survives reloads and works across tabs, encrypted local receipts, downloads with in-browser
decryption up to 50 MB, and adapters for injected EVM, Solana and NEAR wallets. There is no hosted
checkout: a seller or a marketplace builds its own screen on the SDK. See
[packages/annon](packages/annon).

## Repository

| Path | Contents |
|---|---|
| [contracts/annon](contracts/annon) | The NEAR contract (Rust, near-sdk) |
| [packages/annon](packages/annon) | `@defdone/annon`: SDK and `annon` CLI |
| [packages/annon-mcp](packages/annon-mcp) | `@defdone/annon-mcp`: local MCP server |
| [apps/relayer](apps/relayer) | Optional relayer: sponsors NEAR transactions and runs the settlement keeper |
| [apps/demo-host](apps/demo-host) | File host for the demo, with its own x402 facilitator on Base |
| [specs](specs) | Specifications and test vectors |
| [skills/annon](skills/annon) | Agent skill |

Build and test from the repository root (pnpm 12, Node.js 22, Rust from `rust-toolchain.toml`):

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
cargo test
```

## Deployment

| | Mainnet |
|---|---|
| Contract | [`v1.annon.defdone.near`](https://nearblocks.io/address/v1.annon.defdone.near) |
| Relayer | `https://relayer.mainnet.annon.dev` |
| Demo shop | `https://annon.dev/demo` |
| Demo files | `https://demo.annon.dev` |
| MPC network | `v1.signer` |
| USDC | NEAR native USDC and Base USDC |

## Security and limits

Annon handles payments and decryption keys. Read [SECURITY.md](SECURITY.md) before you rely on it.
In short:

- During the alpha defdone can upgrade the contract. That is the largest trust we ask for. It ends
  when the contract is locked after an independent audit.
- A moderator, if a seller names one, can stop new key releases for a file. A request already sent
  to the MPC network can still complete.
- A refund that waits in the on-chain accumulator is claimed with a proof against one of the latest
  32 roots. A stale proof can be rebuilt from the refund events; no indexer is bundled yet, and
  checkpoints are planned.

To report a vulnerability, use GitHub's private reporting on this repository.

## Built at NEAR HACKATHON

All code in this repository was written during the hackathon, starting on 2 November 2026. The
`pre-hackathon` tag marks the initial commit: license, README and ignore rules, no application code.
The team is defdone. Before the hackathon we built Payaion, a closed file-selling app on Base, and
the PAY1 file format that PAY2 extends. No Payaion code is in this repository; Payaion will be the
first app to adopt Annon.

**Libraries.** The SDK uses [@noble/curves](https://github.com/paulmillr/noble-curves),
[@noble/hashes](https://github.com/paulmillr/noble-hashes), [@scure/base](https://github.com/paulmillr/scure-base),
[near-api-js](https://github.com/near/near-api-js) and [viem](https://viem.sh); the CLI's browser
login bundles [NEAR Wallet Selector](https://github.com/near/wallet-selector). The MCP server uses
the official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) and
[zod](https://zod.dev). The contract uses [near-sdk](https://github.com/near/near-sdk-rs) and the
interface crates of [near/mpc](https://github.com/near/mpc). Payments use
[0xSplits](https://splits.org) contracts on Base and the [1Click API](https://docs.near-intents.org)
of NEAR Intents.

**AI assistance.** I wrote Annon with AI coding assistants, Claude Code and Codex, for
implementation, reviews and tests. Changes are reviewed and tested in CI. Before publishing the
alpha release, I will test the payment paths by hand on mainnet with small amounts of real USDC.

## License

[Apache-2.0](LICENSE). Created by [defdone](https://defdone.com).
