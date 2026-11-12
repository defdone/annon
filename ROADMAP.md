<!-- verify against merged code in the phase 2 docs pass -->

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

We plan to sponsor contract storage for NEAR accounts. Today, NEAR sellers and recovering buyers
still fund their own storage. Details for NEAR users: [docs/near-accounts.md](docs/near-accounts.md).

### Sponsored gas for NEAR accounts

We plan to sponsor gas for NEAR accounts through NEAR meta-transactions, once wallets support them.

### Instant refund of an underpayment for direct NEAR payers

A valid NEAR or 1Click payment below the price never opens the file. Today the full amount is
refunded to your NEAR Intents account, and you withdraw it from there
([how](docs/what-can-go-wrong.md#refunds-in-your-near-intents-account)). For payments sent directly
from a NEAR account, we plan to return an underpayment straight to the sending account, with no
withdrawal step.

### Selling from the browser

Today you sell from the CLI, the MCP server or the SDK. We plan a page where you pick a file, set the
price and the split, and approve with your wallet.

### A local purchases panel in the CLI

A panel, started from the CLI, that shows your purchases and sales from your local records.

### Independent audit and contract lock

During the beta defdone can upgrade the contract ([SECURITY.md](SECURITY.md)). We plan an
independent audit, then we remove the upgrade key and lock the contract.

### A testnet relayer

A relayer on NEAR testnet, so developers can try selling, buying and recovery without real money.
