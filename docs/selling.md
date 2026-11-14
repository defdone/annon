# Selling a file

A file is encrypted on your machine before it goes anywhere. Its terms (price, recipients and their
shares, and a commitment to the encrypted file) are registered on the Annon contract on NEAR. The
encrypted file can then sit on any host.

There are two ways to sell:

| | Hosted, with a shop | Self-hosted |
|---|---|---|
| Command | `annon share`, MCP `annon_share` | `annon sell`, MCP `annon_sell` |
| Who stores the encrypted file | The shop's host | You |
| What you get | A purchase URL | A `.pay2` file to put on your own server |

Set up the CLI first: install, configuration, backup secret and wallet, as in
[quickstart.md](quickstart.md).

## Hosted: `annon share`

```sh
annon shop add https://shop.example --id SHOP_ID
annon share report.pdf --price 1.00 --shop SHOP_ID --title "Q3 report" --description "40 pages"
```

`--shop` names a shop from your local configuration; without it the CLI uses `defaultShop`. Adding a
shop grants no trust. Before the first share, give that shop a deployment `profile` in your
configuration (network, contract, RPCs, relayer and host) that matches the deployment you use:
without one the CLI stops with `trust_required`, and a mismatch stops it with `config_conflict`
([CLI.md](../packages/annon/CLI.md#shop-discovery)).

What happens, in order:

1. The CLI encrypts the file locally and works out the final terms and split without sending
   anything.
2. It shows the final terms and asks you to type `yes`: seller, host, contract, price, the split with
   the relayer's fee share, and for a NEAR seller the listing storage and purchase storage it will
   pay. Nothing is saved or signed before you approve.
3. It saves an encrypted record of the sale and a backup of it before any signature or transaction.
   Keep the backup secret and the original file: resuming needs both.
4. You sign the upload. The encrypted file goes to the shop's host, which checks it and reserves a
   place for it.
5. For an EVM seller, the shop's host creates the file's split contract on Base at its own gas cost.
6. The terms are registered on NEAR. EVM and Solana sellers sign once and the shop's relayer submits
   and pays. NEAR sellers send the transactions from their own wallet and pay the storage.
7. The host publishes the file. The result is `fileId`, the purchase `url`, the `header` URL and
   `expiresAt`, when the shop stops hosting the file.

Each shop sets its own upload and listing limits and file lifetime. `annon shops` shows the rules a
shop publishes in its manifest, and `annon share` prints them again with the result. The demo's
open pool allows up to 10 upload admissions and 2 sponsored listings per wallet and per IP bucket per
UTC day. Listed sellers have a separate allowance of 20 per wallet per day. Hosted files normally
expire seven days after publication; keep your own copy. Limits and refusal codes:
[shops-and-limits.md](shops-and-limits.md#shop-limits).

The whole price goes to you, minus the relayer's fee share on a sponsored listing. `share` takes no
`--split`; for several recipients, use `annon sell`.

A NEAR seller pays two amounts in NEAR: listing storage (`--listing-storage`, default 0.01) and the
file's purchase storage (`--storage-budget`, default 0.05). With `--json`, give both flags or set
`listingStorage` and `storageBudget` in the configuration. Agents always use the configured values.

If a step stops, resume the saved sale with the same file; never start a second one for the same
file:

```sh
annon share report.pdf --resume 0xFILE_ID --shop SHOP_ID
```

Resume keeps the original terms and checks the chain before it repeats any step, so a transaction
whose outcome is unknown is never sent twice blindly.

An unfinished verified upload is kept for 24 hours from body verification. After that, requests
return `upload_expired`. The host permits restaging unfinished uploads, but this does not guarantee
that every saved CLI checkpoint can resume automatically. Keep the original file and saved seller
state; if resumption cannot finish, serve the same registered ciphertext from another host. A file
that was published and later expired cannot be republished on that host under the same file ID.

With `--json` and in agent mode there is no prompt. A relayer fee above your `maxProtocolFee` then
stops the share with `protocol_fee_above_max` before anything is saved or signed.

For web pages, the browser SDK runs the same sale: `createBrowserSeller` from
`@defdone/annon/browser` quotes without signing, saves the backup first, and resumes after a closed
tab. Selling from the browser in the demo shop is pending release. We open it once the acceptance tests
pass with NEAR, EVM and Solana wallets.

## Self-hosted: `annon sell`

`sell` encrypts a file into a `.pay2` file and registers its terms. You put the `.pay2` file behind a
server that answers with the 402 offer and serves the file to proven buyers.
[apps/demo-host](../apps/demo-host) is a complete one; `serveFile` from the SDK is the building block.

### With a NEAR account

You send the transactions and pay the storage yourself. No protocol fee is added.

```sh
annon sell report.pdf --wallet near --price 1.00 --split near:YOUR_ACCOUNT.near:10000 --storage-budget 0.05 --output report.pay2
annon budget 0xFILE_ID
```

Prepay contract storage with `storage_deposit` first, as in
[quickstart.md](quickstart.md#5-open-it-on-another-computer). `--storage-budget` gives the file NEAR
for the storage each purchase needs. Check it with `annon budget` before you share the URL, and add
more with `annon fund 0xFILE_ID 0.05 --wallet near`. Costs and the reasons behind them:
[near-accounts.md](near-accounts.md).

### With an EVM or Solana wallet

An EVM or Solana seller signs the registration, and a relayer submits it and pays the NEAR. The
relayer adds its fee share to the split and the CLI shows the final split before it registers.

```sh
annon sell report.pdf --wallet evm --price 1.00 --split evm:0xYOUR_ADDRESS:10000 --output report.pay2
```

A relayer decides which registrations it sponsors. defdone's relayer sponsors files that its shop
hosts, which is what `annon share` uses, and the sellers it lists. For a self-hosted file with an
EVM or Solana wallet, run your own relayer ([apps/relayer](../apps/relayer)) or use the hosted path.
Otherwise registration stops with `not_sponsored` before anything is sent.

## Which routes your buyers get

| Seller | Routes | Base payments |
|---|---|---|
| EVM wallet, all recipients EVM, with Base terms (`share`, or `sell --base`) | `near`, `base`, `1click` | Go to the file's split contract on Base, which pays the same shares |
| EVM wallet without Base terms | `near`, `1click` | Buyers with USDC on Base use `1click` with Base as the source chain |
| NEAR account | `near`, `1click` | None. Buyers with USDC on Base pay through `1click` with Base as the source chain |
| Solana wallet | `near`, `1click` | As for NEAR |

Payments on NEAR wait in the contract until anyone calls `settle`, which credits each recipient's
NEAR Intents account. From there a recipient can withdraw to other chains.

With `annon sell`, `--base` adds Base terms. It needs a local EVM key, all-EVM recipients and a little
ETH on Base, because your wallet creates the split contract. With `annon share`, the shop's host
creates it, and NEAR and Solana sellers get no Base terms.

## Splits and fees

- Recipients are `kind:id:bps`, for example `evm:0x1111111111111111111111111111111111111111:7000,near:alice.near:3000`.
  Shares are basis points and total 10000. Up to 8 recipients. The first recipient gets the
  rounding remainder.
- A sponsored listing adds the relayer's treasury share: on defdone's relayer 0.03 USDC plus 1% of
  the price. The other shares are scaled down to make room. The config field `maxProtocolFee` caps
  what you accept.
- The terms of a listed file never change. To change the price or the split, stop sales and list
  again.

Fees in general: [shops-and-limits.md](shops-and-limits.md).

## After listing

- `annon stop 0xFILE_ID` stops new sales for good. Earlier buyers keep their access.
- A moderator, if you name one with `--moderator account.near`, can stop new key releases for the
  file. Buyers must accept that moderator before they pay.
- Keep your own copy of the original file. A hosted file expires when the shop's file lifetime
  ends.
- Previews: `sell` can build a PAY2 file with a preview, but clients do not verify previews for
  buyers in this release. Do not present a preview as checked.
