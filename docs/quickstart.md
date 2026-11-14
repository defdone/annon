# Quick start: buy a file from the command line

This page sets up the `annon` CLI, buys a file, opens it, and gets it back on another computer. For
selling see [selling.md](selling.md), for agents see [agents.md](agents.md). Every command is in
[CLI.md](../packages/annon/CLI.md).

## 1. Install

You need Node.js 22.18 or newer.

```sh
npm install -g @defdone/annon@alpha
```

The alpha packages are pending publication. Once published, install them with the npm `alpha` tag.
Until then, build from source (see [Build and test](../README.md#build-and-test)) and run
`node packages/annon/dist/node/main.js` in place of `annon`.

## 2. Configure

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

`maxPrice` is the most a single purchase may cost, in USDC. To pay on Base, add `"baseRpc"` with a
Base RPC endpoint that has an API key; the public endpoint rate-limits the reads a payment needs.

Create the backup secret that encrypts your local purchase records, and keep it outside any
repository:

```sh
openssl rand -hex 32 > "$HOME/.annon-backup-secret" && chmod 600 "$HOME/.annon-backup-secret"
export ANNON_BACKUP_SECRET_FILE="$HOME/.annon-backup-secret"
```

Keep this secret and your purchase IDs. With them you can check, resume and open a purchase. If you
lose them, the same wallet can still recover the file (step 5).

## 3. Sign in with your wallet

```sh
annon login --wallet near    # or: annon login --wallet evm
```

Login opens a local page in your browser and proves you control the wallet. It installs no key.
Every payment is approved in the wallet.

## 4. Buy and open

Check the file, buy it, wait until the purchase is accepted, and open it:

```sh
annon verify https://demo.annon.dev/f/what-we-are-building --trust-contract
annon buy https://demo.annon.dev/f/what-we-are-building --route near
annon status 0xPURCHASE_ID
annon open 0xPURCHASE_ID --output what-we-are-building.pdf
```

- `--trust-contract` records once that you trust this contract to release keys.
- `buy` shows the price, the recipients and the route, and asks before it pays. It prints the
  purchase ID.
- If `status` says `pending`, or a command stops with `settlement_pending` (exit code 4), wait and
  ask again. A Base payment must reach Safe finality before NEAR can verify it. Poll `status` and
  honor `retryAfterSeconds`.
- **Never pay a second time for the same purchase.** Resume the existing purchase with `status` and
  `open`. A saved live or accepted purchase blocks another buy with `purchase_open`. Only an explicit
  `--force` creates another purchase despite that saved purchase.

What you need for each route:

| Route | Command | You need |
|---|---|---|
| `near` | `annon buy URL --route near` | A NEAR wallet with USDC on NEAR and a little NEAR for gas |
| `base` | `annon buy URL --route base` | An EVM wallet with USDC on Base. No ETH: you sign an authorization and the host submits it |
| `1click` | `annon buy URL --route 1click --from-chain base` | A supported token on the source chain, plus that chain's gas. The quote includes the swap fees |

`base` works only for a file whose on-chain terms include a Base payee. For any other file the CLI
stops with `route_unavailable` before any wallet or payment step. Pay that file with `1click` and
Base as the source chain, as in the last row. Source-chain refunds go to your EVM wallet's address;
with another wallet, add `--refund-to` with an address on the source chain. For 1Click, `buy`
returns deposit instructions: send
exactly that amount from your own wallet before `depositBefore`, then check `status`.

## 5. Open it on another computer

The same wallet gets the file again without paying a second time. Repeat steps 1 to 3 on the new
computer, then recover and open:

```sh
annon recover --recovery near:YOUR_ACCOUNT.near
annon open 0xPURCHASE_ID --url https://demo.annon.dev/f/what-we-are-building --output what-we-are-building.pdf
```

An EVM or Solana wallet can recover through the relayer without paying NEAR. A NEAR account funds
storage for its new key grant. Before `recover`, use the SDK's `storageDeposit` with your NEAR wallet
and an amount you choose, for example 0.01 NEAR:

```ts
import { storageDeposit } from '@defdone/annon';
await storageDeposit(nearWallet, 'v1.annon.defdone.near', 10_000_000_000_000_000_000_000n);
```

`nearWallet` is your NEAR transaction wallet in the SDK, for example `nearKeyPairWallet(account)` as
in the [SDK README](../packages/annon/README.md). It approves and pays this storage deposit.

Details on NEAR storage: [near-accounts.md](near-accounts.md). If something goes wrong:
[what-can-go-wrong.md](what-can-go-wrong.md).
