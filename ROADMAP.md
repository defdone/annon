# Roadmap

What we plan to build next. If one of these matters to you, open an issue or write to
hello@annon.dev.

## Next

### NEAR storage sponsorship for NEAR accounts

Today a NEAR account pays a little NEAR for contract storage when it sells a file or recovers a
purchase on a new device. An EVM or Solana wallet can use sponsored registration and pays nothing in
NEAR.

The difference comes from how the contract recognises each identity:

- A **NEAR account** authorizes contract actions by submitting them from that account. In the
  current flow, its wallet submits the actions and pays gas; registration and recovery use its
  prepaid storage balance.
- An **EVM or Solana** identity authorizes actions with a signed message. A relayer can submit that
  message and fund the action when it accepts the sponsorship request.

Current selling costs:

| Seller | Pays in NEAR | Protocol fee on each sale |
|---|---|---|
| NEAR account | Contract storage for the listing and the file's purchase storage | None |
| EVM or Solana wallet | No NEAR for sponsored registration | Default sponsorship fee: 0.03 USDC plus 1% of the price |

The fee pays for the infrastructure defdone runs for a sponsored listing, at cost plus a small
margin. Using the protocol, the SDK or the CLI on your own infrastructure has no fee.

We plan to sponsor contract storage for NEAR accounts. Today, NEAR sellers and recovering buyers
still fund their own storage. Details for NEAR users: [docs/near-accounts.md](docs/near-accounts.md).

### Sponsored gas for NEAR accounts

We plan to sponsor gas for NEAR accounts through NEAR meta-transactions, once wallets support them.

### Selling from the browser

A page in the demo shop where you pick a file, set the price and the split, and approve with a
NEAR, EVM or Solana wallet. It is pending release: we open it once the acceptance tests pass with
all three. Until then you sell from the CLI, the MCP server or the SDK.

### Base payouts for NEAR and Solana sellers

Direct Base payments need a Base payee in the file's terms. Hosted EVM listings get a split contract
on Base; self-hosted EVM listings get one only with `--base`. NEAR and Solana sellers list without
Base terms, so their buyers pay on NEAR or through 1Click, including 1Click from Base. After the hackathon, we plan to let a NEAR or Solana seller name a
separate EVM payout address for direct Base proceeds.

### Shop quotas that count finished listings

Today a shop's host counts an upload when it accepts it, and the relayer counts a sponsored
registration when it admits it. We plan to count only listings that are registered and published, so
a failed attempt does not use up a seller's daily allowance, with the host and the relayer agreeing
on each listing's state.

### Instant refund of an underpayment for direct NEAR payers

A valid NEAR or 1Click payment below the price never opens the file. Today the full amount is
refunded to your NEAR Intents account, and you withdraw it from there
([how](docs/what-can-go-wrong.md#refunds-in-your-near-intents-account)). For payments sent directly
from a NEAR account, we plan to return an underpayment straight to the sending account, with no
withdrawal step.

### Optional app attribution

An optional `appId` or referrer that a shop or an app can attach to a purchase, so it can count the
sales it brought. It is attribution only, not a commission: it changes neither the price nor the
split.

### Server-side catalog search and signed shop directories

Catalog search that runs on the shop's server, so a client does not have to download a whole
catalog to search it. Shop directories signed by their publisher, so a client can check where a
list of shops came from.

### Categories and tags for files

Today every file in a shop catalog has a name, a title and a description, and catalog search covers
all three. We plan seller-chosen categories and tags, set when sharing a file, signed with the rest
of the listing metadata, and a matching filter in the CLI, the MCP tools and the shop, so people and
agents can browse a shop by topic.

### Sending a file straight to someone's key

A way to send a file to one recipient without a sale: the sender encrypts the file for the
recipient's public key and hosts the ciphertext. There is no contract call and no fee, only hosting.
It suits agents that need to hand a file to another agent they already know.

### A local purchases panel in the CLI

A panel, started from the CLI, that shows your purchases and sales from your local records.

### Independent audit and contract lock

During the alpha defdone can upgrade the contract ([SECURITY.md](SECURITY.md)). We plan an
independent audit, then we remove the upgrade key and lock the contract.

### A testnet relayer

A relayer on NEAR testnet, so developers can try selling, buying and recovery without real money.
