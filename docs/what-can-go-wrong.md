<!-- verify against merged code in the phase 2 docs pass -->

# What can go wrong, and what to do

Each section says what happens and what you do. The codes in `backticks` are the ones the SDK, the
CLI (with `--json`) and the MCP server return. When a result carries `retryAfterSeconds`, wait at
least that long before you try again.

Three rules cover most cases:

- **Never pay a second time for the same purchase.** Every `buy` creates a new purchase. If you are
  unsure whether a payment went through, check the one you have.
- **Keep your purchase ID and your backup secret.** They let you check, resume and open a purchase.
  Losing them does not lose the file: the same wallet can recover it.
- **Exit code 4 means wait.** The CLI exits with it, and CLI JSON and MCP errors carry it as
  `exitCode`, for anything still pending. It is not proof that the payment failed.

Exit codes: 1 other failure, 2 invalid input or configuration, 3 human approval or contract trust
needed, 4 pending.

## Before you pay

### The quote or the purchase expired

- **1Click:** after you review the terms, at least ten minutes must remain before the deposit cutoff.
  Otherwise you get `quote_expired` ("The 1Click quote expired. Run buy again."). Nothing was sent.
  Run `buy` again for a fresh quote.
- **Base:** the SDK signs a payment authorization lasting at most 180 seconds. Keep the saved
  purchase and check `status`. Start another purchase only after final chain evidence establishes
  that the authorization expired or was cancelled without payment. A payment that settled before its
  deadline can still be unlocked later.
- **NEAR:** a purchase is valid for one hour after it is prepared. The SDK pays right away, so this
  only matters if you pay by hand. A payment that arrives after expiry is not accepted and is
  refunded in full to your NEAR Intents account ([below](#refunds-in-your-near-intents-account)).

Do not use a local deadline or an uncertain response as evidence that payment failed. Check the saved
purchase before starting another one.

### The file has no Base route

Before choosing `base`, check that the file's final on-chain terms include a Base payee. If they do
not, use `near`, or `1click` with Base as the source chain. The release will report
`route_unavailable` (exit code 2) for this case; that error is pending release.

### 1Click refuses the quote

1Click can refuse a quote because of its route minimum or available liquidity. When supplied,
`minimumAmountUsdc` gives the reported minimum. Do not send a deposit without a valid quote. Use
another available payment route if the file's price cannot be quoted.

### The relayer refuses or is busy

- `not_sponsored`: the relayer does not sponsor the Base unlock for this file. You get this before
  your wallet signs the payment. Pay on NEAR or through 1Click instead.
- `relayer_unavailable` or `relayer_rate_limited`: the relayer is busy or paused. Wait for
  `retryAfterSeconds` and try again.

If you have already paid, a busy relayer delays the unlock but never cancels your purchase. See
[the payment is still pending](#the-payment-is-still-pending).

### You have no NEAR for gas

You need NEAR only on the NEAR route. Other routes:

- **Base:** only USDC on Base. You sign an authorization; you need no ETH and no NEAR.
- **1Click:** a supported source asset and enough funds for the quoted deposit and source-chain
  transaction costs.

NEAR accounts also pay a little storage to sell or recover. See [NEAR accounts](near-accounts.md).

### The wallet is on the wrong network

`wrong_chain` ("Select Base in the wallet."): the SDK asks the wallet to switch to Base. If the wallet
cannot, switch it yourself and try again. The payment was not signed.

`smart_wallet_unsupported`: the Base route needs an ordinary wallet account (an EOA), not a smart
contract wallet. Use another account or another route. `insufficient_balance` means there is not
enough USDC on Base.

### The file is moderated or taken down

A seller can name a moderator who can stop new key releases for that file. Before buying a moderated
file you must accept that moderator explicitly (`unknown_moderator`; pass `--moderator account.near`
on `buy` once you trust it). If the file is already taken down, `buy` stops with `taken_down` before
you pay, and the file host answers 410.

## While you pay

### The payment is still pending

`settlement_pending` (exit code 4) means the payment or the key release is not final yet. Keep the
saved purchase.

- **Base:** payments must reach Safe finality on Base before NEAR verifies them; this commonly takes
  one to three minutes.
- **1Click:** a swap can take several minutes, and its `SUCCESS` status alone does not prove Annon
  accepted the purchase.
- **Relayer busy:** the unlock is queued and retried. It is delayed, not cancelled.

What you do: wait for `retryAfterSeconds` (30 seconds when nothing more precise is known), then run
`annon status 0xPURCHASE_ID` again. The MCP server refuses to retry before that time.
`transaction_uncertain` (also exit code 4) means a reply was lost. It includes `txHash` and, when
known, `purchaseId`. Keep that evidence and check the existing transaction. Do not pay again to
resolve uncertainty.

### You closed the tab or the program crashed

The purchase is saved, encrypted, before payment authorization or submission. A separate wallet
signature may be requested first to prove recovery ownership.

- **Browser:** return to the same page in the same browser and resume the saved purchase.
  `lease_busy` means another tab holds it. An active tab can renew its hold; after it stops renewing,
  the hold expires within two minutes. Clearing site data deletes the local record. Export receipts
  for a separate copy, or recover accepted purchases with the same wallet.
- **CLI or MCP:** run `annon status 0xPURCHASE_ID`. The ID appears in `buy` output and encrypted
  backups under `stateDir/backups`. If you lost it, run `annon recover --recovery kind:id` with the
  same configured wallet, replacing `kind:id` with its identity. Recovery reports successful grants
  and per-purchase errors. Remove leftover `.tmp` files and `.annon-spool-*` directories beside the
  output before opening again.

## If the amount was wrong

The SDK always pays the exact price, on every route. These cases come from manual transfers or other
software.

### You paid less than the price

An underpayment never opens the file.

- **NEAR or 1Click:** a valid payment below the price is refunded in full to your NEAR Intents
  account. The purchase is not used up, so you can pay it correctly or start a new one. See
  [refunds](#refunds-in-your-near-intents-account) for how to withdraw.
- **Base:** your wallet signs for exactly the price, and the file host refuses any other amount
  before it settles anything.

### You paid more than the price

- **NEAR:** the purchase is accepted and the excess is refunded to your NEAR Intents account.
- **1Click:** the quote requests delivery of the exact file price. Source-deposit refunds follow
  1Click's quote and refund rules, including any refund fee. Check the saved swap status before
  sending more funds or starting another purchase.
- **Base:** your wallet signs for exactly the price.

On Base, always pay through an Annon client. A plain USDC transfer to a file's Base address is not a
purchase: it opens nothing, it goes to the seller's recipients, and Annon cannot send it back. Contact
the seller.

### The 1Click deposit was too small or too late

Send exactly the amount in the instructions, include the memo if there is one, and make sure the
deposit is confirmed before `depositBefore`. Do not deposit after it, even if the address still
accepts transfers.

A small deposit can remain `INCOMPLETE_DEPOSIT`; do not assume it has been refunded. A late deposit
may be refunded by 1Click, may still produce an accepted Annon purchase, or may reach Annon after
purchase expiry. With a valid Annon refund identity, a delivery refused after expiry is refunded in
full to that NEAR Intents account. Check both the saved swap status and Annon purchase status before
taking another payment action. Source-chain refunds follow the quote's refund rules and may incur a
fee.

## Refunds in your NEAR Intents account

Refunds from the contract go to the NEAR Intents account of the wallet you bought with: your EVM
address, your Solana key, or your NEAR account.

With a valid Annon refund identity, the contract records the refund for that identity's NEAR Intents
balance. Crediting the balance is asynchronous; a transfer to Annon is not proof that the refund has
already arrived.

Withdraw using a NEAR Intents interface that supports the same identity and its USDC balance. Annon's
CLI and MCP server do not provide a refund-withdrawal command. If you cannot locate or withdraw the
balance, contact hello@annon.dev with your purchase ID and transaction hash. Never send a private
key, seed phrase or backup secret.

## After you bought

### Download limit reached

`download_limited` (HTTP 429): on the demo host, each purchase can download its file three times
right away. After that you wait:

| Download | Available |
|---|---|
| 1st to 3rd | Right away |
| 4th | 15 minutes after the 3rd finished |
| 5th | 2 hours after the 4th finished |
| Each later one | 24 hours after the previous one finished |

`retryAfterSeconds` says exactly how long is left, and the browser shows a countdown. Save the file
once and keep it.

The host counts a download when it finishes transmitting the complete encrypted body. A later
decryption or local-save failure does not undo that count. Interrupted transmissions do not count.
Recovery on another device does not reset the count, and the initial automatic save uses one
download.

### The download was interrupted

A running SDK download can resume from its first unchecked chunk. The host allows an interrupted
logical attempt to resume within ten minutes of its last transmitted byte and within thirty minutes
of the attempt's start. Restarting the program does not preserve the client's checked-chunk offset:
run `open` again with the saved purchase.

`download_in_progress` means another download of the same purchase is running; the SDK waits a few
seconds and retries. Existing output files are not overwritten (`output_exists`); choose another
output name.

### Opening on a new device

Use the same wallet you bought with. You never pay again.

- **EVM or Solana:** recovery costs you nothing.
- **NEAR account:** prepay a little contract storage first. See [NEAR accounts](near-accounts.md).

Configure the reviewed deployment, NEAR wallet and backup secret first. Replace account, purchase ID
and file URL placeholders with your own values.

```sh
annon recover --wallet near --recovery near:YOUR_ACCOUNT.near
annon open 0xPURCHASE_ID --url https://demo.annon.dev/f/FILE --output file.pdf
```

### The file was deleted from the demo host

Demo-host uploads expire seven days after first publication, except the configured canonical demo
file. After expiry, new offers and downloads are refused with `file_expired` (HTTP 410); an already
active download may finish. Keep your own copy. The demo itself runs until 18 November 2026, at the
latest 19 November.

Your accepted purchase remains on chain. If another host serves the same checked encrypted file, use
`annon open 0xPURCHASE_ID --url https://OTHER_HOST/FILE --output file.pdf`. For a local encrypted
copy, use `annon open file.pay2 --purchase /path/purchase-backup.json --output file.pdf`.

### The file was taken down after you bought it

A moderator's takedown blocks new key requests, including recovery. A request already sent to MPC
can still complete. Keep any copy you have already opened. A valid NEAR or 1Click payment received
after takedown is not accepted as a purchase and is refunded in full to its designated NEAR Intents
account.

## Report a problem

- **A security vulnerability:** report it privately through the **Security** tab of the GitHub
  repository, then **Report a vulnerability**. Please do not open a public issue.
- **A file on the demo host, a missing refund, or anything else:** write to hello@annon.dev.

Include the purchase ID, file ID, transaction hash and error code when you have them. Never send your
backup secret, a private key or a seed phrase. We will never ask for them.
