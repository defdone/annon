# Security

Annon moves money and releases decryption keys, so we treat every report as urgent.

## Reporting a vulnerability

Please do not open a public issue. Report privately through GitHub: the **Security** tab of this
repository, then **Report a vulnerability**. We reply within 72 hours and keep you informed until
the fix ships. If the issue can lose funds or leak keys on mainnet, say so in the title. If you
cannot use GitHub, write to hello@annon.dev and we will set up a private channel; do not include
exploit details in that first message.

In scope:

- the NEAR contract in [`contracts/annon`](contracts/annon), deployed as `v1.annon.defdone.near`;
- the SDK, CLI and MCP server in [`packages/`](packages);
- the relayer in [`apps/relayer`](apps/relayer) and the demo host in [`apps/demo-host`](apps/demo-host);
- the specifications in [`specs/`](specs), where a flaw in the protocol itself is in scope even if
  our code happens to avoid it.

## Status: alpha

| | |
|---|---|
| Contract | `v1.annon.defdone.near` on NEAR mainnet, upgradeable by defdone |
| Packages | `@defdone/annon` and `@defdone/annon-mcp`, release series `0.1.0-alpha.N` on the npm `alpha` tag |
| Audits | Internal reviews and mutation testing only. No independent audit yet. |

During the alpha defdone keeps a full-access key to the contract account so that a bug can be fixed
in place. That key can change the contract's code, and therefore its rules. It is the largest trust
Annon asks for. After an independent audit we will remove the key and lock the contract; a later fix
then ships as a new contract that sellers move to.

## Trust model

| Party | Can | Cannot |
|---|---|---|
| Seller | List a file, stop its sales for good | Take back a key already released, change the split or price of a listed file |
| Moderator (optional, named by the seller) | Refuse new key releases for that file | Move money, read files |
| Host | Refuse to serve a file | Read it, see keys, redirect payouts |
| Relayer | Refuse to sponsor a transaction | Sign as the buyer or seller, redirect payouts, see keys |
| NEAR MPC network | Derive keys when the contract asks | Release a key the contract did not request |
| defdone | Upgrade the contract during the alpha | Read a file key from the chain |

The buyer's one-time key and the decrypted file stay on the buyer's device. Buyer records never
keep a released file key or decrypted content: the browser decrypts in memory, and the CLI writes
plaintext only to the output path you name. A seller's pending listing keeps its file key, encrypted
with the backup secret, until registration and publication finish, then clears it. Copies of a
backup you made elsewhere need your own cleanup.

## Known limits

These are known and accepted for the alpha. Please do not report them as new findings, but do tell
us if you can make one worse than described.

- **Takedown after a key request.** A moderator's takedown refuses new key requests. A request
  already sent to the MPC network can still complete, because the network publishes its answer on
  chain.
- **Refund proof window.** When the contract cannot pay a refund right away it records it in an
  on-chain accumulator, and the refund is claimed later with a proof against a recent root. Only a
  bounded number of recent roots are kept, so a refund left unclaimed for very long needs a newer
  proof. Checkpoints that remove this window are planned.
- **A failed payout callback** leaves that step marked in flight. It is never reset automatically:
  a timeout cannot tell a completed transfer from a delayed one, and a reset could pay twice. During
  the alpha a reviewed upgrade can repair a provable accounting error.
- **1Click refunds.** If NEAR Intents delivers a payment the contract refuses (for example after the
  purchase expired), the refund stays in the NEAR Intents account named in the quote, not on the
  source chain.
- **USDC issuer controls.** Circle can freeze a recipient address or a Base split. A frozen push split
  pays nobody until it is unfrozen; the contract's own records stay correct.
- **Browser storage.** In the browser, encrypted purchase records and the secret that protects them
  live in the same IndexedDB origin. They protect against accidental disclosure, not against code
  running on the same page. Export receipts with a separate secret for anything you want to keep.
- **Local agents.** The MCP server enforces the owner's price limits, daily budget and working
  directory against tool calls. It does not contain a shell agent running as the same operating
  system user, which can edit the configuration directly. Use separate OS users when that matters.
- **Real browsers.** Browser code is tested against stubbed wallets and IndexedDB, and its bundles are
  checked for CSP compatibility. Behaviour in specific browsers and wallet extensions is tested by
  hand, not in CI.
- **Previews.** A PAY2 file can carry a preview, but clients do not verify previews for buyers in
  this release. A page must not present a preview as checked.
- **Not DRM.** The seller knows the content and a buyer can share what they decrypted. Listing terms,
  titles, descriptions and file sizes are public.
- **Hosting.** Key release does not keep a file online. A shop's host can refuse, expire or lose a
  file; the purchase stays on chain and opens from any host that serves the same checked file.

## Supported versions

After publication, only the latest alpha release on npm and the contract listed above will receive
fixes.
