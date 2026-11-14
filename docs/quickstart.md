# Quick start: buy a file from the command line

This page sets up the `annon` CLI, buys a file, opens it, and gets it back on another computer. For
selling see [selling.md](selling.md), for agents see [agents.md](agents.md). Every command is in
[CLI.md](../packages/annon/CLI.md).

## 1. Install

You need Node.js 22.18 or newer.

```sh
npm install -g @defdone/annon@alpha
```

The packages are on the npm `alpha` tag. To use a build from source instead (see
[Build and test](../README.md#build-and-test)), run `node packages/annon/dist/node/main.js` in place
of `annon`.

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

`maxPrice` is the most a single purchase may cost, in USDC. To pay on Base, also add `"baseRpc"`
([Pay on Base](#pay-on-base)).

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

Check the file, buy it, wait until the purchase is accepted, and open it. Pick the path that matches
where your money is. Each path starts with `login`; skip it if you already signed in with that
wallet in step 3. Login remembers one wallet, so sign in again to switch.

- `--trust-contract` records once that you trust this contract to release keys.
- `buy` shows the price, the recipients and the route, and asks before it pays. It prints the
  purchase ID.
- Your purchase is saved, encrypted, before you pay. If `status` says `pending`, or a command stops
  with `settlement_pending` (exit code 4), wait and check again; resume the same purchase with
  `annon status` and `annon open` instead of starting a new one. While it is live or accepted, a
  second `annon buy` of the same file is refused with `purchase_open` unless you pass `--force`.

### Pay on NEAR

You need a NEAR wallet with USDC on NEAR and a little NEAR for gas.

```sh
annon login --wallet near
annon verify https://demo.annon.dev/f/what-we-are-building --trust-contract
annon buy https://demo.annon.dev/f/what-we-are-building --route near
annon status 0xPURCHASE_ID
annon open 0xPURCHASE_ID --output what-we-are-building.pdf
```

You approve the USDC transfer in your wallet, `status` says `accepted`, and `open` writes the
decrypted file.

### Pay on Base

You need an EVM wallet with USDC on Base. No ETH: you sign a USDC authorization and the host submits
it. First add `"baseRpc"` to your config, with a Base RPC endpoint that has an API key: the CLI reads
the Base payment through it, and the public endpoint rate-limits those reads.

```sh
annon login --wallet evm
annon verify https://host.example/f/FILE --trust-contract
annon buy https://host.example/f/FILE --route base
annon status 0xPURCHASE_ID
annon open 0xPURCHASE_ID --output file.pdf
```

`status` says `pending` until the payment reaches Safe finality on Base and NEAR has verified it. Run
it again after `retryAfterSeconds` until it says `accepted`, then `open` writes the decrypted file.

This route works only for a file whose on-chain terms include a Base payee; only files from EVM
sellers can have one. For any other file, `buy --route base` stops with
`route_unavailable` before any wallet or payment step; pay it with 1Click from Base instead.

### Pay from another chain with 1Click

You need a supported token on the source chain, plus that chain's gas. The quote includes the swap
fees.

```sh
annon login --wallet evm
annon verify https://demo.annon.dev/f/what-we-are-building --trust-contract
annon buy https://demo.annon.dev/f/what-we-are-building --route 1click --from-chain base
annon status 0xPURCHASE_ID
annon open 0xPURCHASE_ID --output what-we-are-building.pdf
```

`buy` returns deposit instructions: an address, an amount in the token's base units, the asset, a
memo if one is needed, and `depositBefore`. Send exactly that amount, with the memo, from your own
wallet before `depositBefore`. Then run `status` until it says `accepted`; a 1Click `SUCCESS` alone
is not acceptance. `open` writes the decrypted file.

For another chain, change `--from-chain` (for example `arbitrum`, `ethereum`, `polygon` or
`solana`). Without `--from-asset` the CLI picks that chain's USDC; for any other token pass
`--from-asset` with its exact 1Click `nep141:` asset ID. Source-chain refunds go to your signed-in
wallet when it is on the same kind of chain. Otherwise, or to get refunds at the wallet you pay
from, add `--refund-to` with an address on the source chain. Supported chains and options:
[CLI.md](../packages/annon/CLI.md).

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
