# Annon payment profile for x402 v2 (v1.1 draft)

How a server sells an Annon file over x402 v2, and what an Annon client sends. It is plain x402 v2
([spec](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md),
[HTTP transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md),
[exact on EVM](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md))
with one scheme of its own, one extension, `annon`, the standard
[`payment-identifier`](https://github.com/x402-foundation/x402/blob/main/specs/extensions/payment_identifier.md)
and [`sign-in-with-x`](https://github.com/x402-foundation/x402/blob/main/specs/extensions/sign-in-with-x.md)
extensions, and the payment nonce of [nonce.md](nonce.md). The resource is the PAY2 file itself:
the paid request returns it, and a buyer signs in at the same URL to get it again
([download.md](download.md)).
The SDK builds and checks all of it (`offerFor`, `verifyPayment`, `forFacilitator` on the seller's
side; `discover`, `preflight`, `authorize` on the buyer's); integrators don't write these objects.

Status: v1.1, draft. v1 was frozen on 9 Nov 2026 (commit `1676d96`); section 12 lists what v1.1
changes. Any change to what a client or server sends or checks is a new version.

## 1. Why its own scheme

A payment for an Annon file must sign the Annon nonce, or the money moves and the key can never be
released. The official x402 client signs any `exact` offer with a random nonce and ignores `extra`
keys it doesn't know; it refuses an offer whose scheme it has no handler for ("No network/scheme
registered"). So the offer uses the scheme `annon-exact`, and a client without Annon signs nothing.

The payment itself is plain EIP-3009 `TransferWithAuthorization` of USDC to the file's `pay_to`. The
seller settles it through any standard x402 facilitator as `exact` (section 4); the scheme label is
not part of what the buyer signs.

## 2. Payment required

A `402` with the `PAYMENT-REQUIRED` header (base64 JSON `PaymentRequired`, `x402Version: 2`).

`extensions.annon.info`:

| Field | Value |
|---|---|
| `version` | `2` (v1.1; `1` was v1) |
| `network` | `near:mainnet` |
| `contract` | the Annon contract account, e.g. `v1.annon.defdone.near` |
| `fileId` | `0x` and 32 bytes, lowercase |
| `header` | URL of the complete PAY2 header, public (section 7) |
| `public` | optional, `true` when the seller publishes the body too |

`resource.url` is the PAY2 file (section 7). v1's `info.download` is gone: the file is at
`resource.url` for the paid request and for every download after it.

`extensions.annon.schema` is the JSON Schema of that object (`ANNON_SCHEMA` in the SDK); in v1.1
its `version` is `const: 2`.

`accepts` holds one offer, every value from the registration (`get_file`) and the contract's
configuration (`get_config`):

| Field | Value |
|---|---|
| `scheme` | `annon-exact` |
| `network` | `eip155:8453` |
| `asset` | `usdc` from `get_config` |
| `amount` | the registered price |
| `payTo` | the registered `pay_to` |
| `maxTimeoutSeconds` | the server's choice; the Annon client signs for at most 180 seconds |
| `extra` | `name: "USD Coin"`, `version: "2"`, `paymentFlow: "upfront"`; `assetTransferMethod` absent or `eip3009`; no `splits` |

`paymentFlow: "upfront"` ([x402 v2 §6.1](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md#61-asset-transfer-methods-and-payment-flow-models)):
the payment is settled before the file is served, so the body goes only to a buyer whose payment
is on Base (section 7). A client refuses a v1.1 offer (`version: 2`) with any other flow, a v1 offer
(`version: 1`) with any flow but `authorization`, an `assetTransferMethod` other than `eip3009`, and
a non-empty `extra.splits` (a split there would take part of the payment away from `pay_to`).

`extensions["payment-identifier"]`: as the extension defines it, with `info.required: false`
(section 10).

`extensions["sign-in-with-x"]`: a single-use challenge for a buyer who already paid
([download.md](download.md) section 2).

A file whose sales are stopped answers `402` with `accepts: []` and the sign-in challenge only:
past buyers still download it. (x402's own `wrapFetchWithSIWx` takes the network to sign for from
`accepts[0]` and does not sign without an offer; a client takes it from `supportedChains`, as the
Annon client does.) A taken-down file answers `410`.

## 3. Payment

The client sends `PAYMENT-SIGNATURE` (base64 JSON `PaymentPayload`, `x402Version: 2`):

- `accepted`: the offer, unchanged; `resource` and other advertised extensions echoed.
- `payload.signature`: 65 bytes, `0x` hex, low `s`, `v` 27 or 28.
- `payload.authorization`: `from`, `to` (= `payTo`), `value` (= `amount`), `validAfter: "0"`,
  `validBefore`, `nonce` (= `annonNonce(contract, fileId, buyerKey)`), as strings, as in exact on
  EVM.
- `extensions.annon.info`: the info received, plus `buyerKey`: the buyer's one-time BLS12-381 G1
  key, `0x` and 48 bytes compressed, not the identity.
- `extensions["payment-identifier"]`: when the server advertised it, the advertised object with
  `info.id` added (section 10).

EIP-712: primary type `TransferWithAuthorization`; domain `name`, `version` from `extra`, chain
8453, `verifyingContract` = `asset`.

The Annon client signs for at most 180 seconds, from the earlier of Base's time and its own clock,
both read (and refused if more than 60 seconds apart) before it reads the registration again. With that, a payment authorized while the file was on
sale always lands inside the contract's 300 seconds after a stop.

## 4. What the server checks, then how it settles

Before settling (`verifyPayment`), with "now" taken from the earlier of the server's clock and
Base's, read before the registration is read again:

1. The file is still on sale; the offer is echoed unchanged (compared as data, not as text).
2. `extensions.annon.info` holds the advertised info unchanged and a valid `buyerKey`.
3. The nonce is `annonNonce` computed by the server from `buyerKey`; the signature recovers to
   `from` over it; `validAfter` is 0; `validBefore` is at most 240 seconds after "now".

Anything else: refuse, settle nothing. A retry of a payment already settled or being settled is
recognized first and never reaches these checks (section 10). Then `forFacilitator` renames the
scheme to `exact` in both the payload's `accepted` and the requirements (the official facilitator
checks both), keeps every extension of the payload but `bazaar` (section 11), and returns the
facilitator's request body with `x402Version: 2`; any standard facilitator settles it.

## 5. Settlement response: paid is not opened

`PAYMENT-RESPONSE` (base64 JSON `SettlementResponse`) with `success: true` says the payment is on
Base at `safe` (section 10). It does not say the buyer can open the file: the key comes only after
`unlock` records the payment on NEAR (anyone may send it, a relayer included) and NEAR MPC releases
the key to the buyer's one-time key. A client tells the buyer "paid" on this response, and "ready"
only once it has opened the file. The client does not depend on the response either: it finds the
payment on Base by its nonce (section 10).

## 6. What the client trusts

Nothing in the 402. The client:

- takes `extensions.annon.info.contract` only if it is on its trusted list (the SDK ships
  `v1.annon.defdone.near`; an application may add others explicitly);
- reads `get_file` and `get_config` from that contract through the NEAR RPC it was configured
  with, never one named by the server, and refuses an offer whose price, recipient, token, network
  or scheme differ;
- trusts its NEAR and Base RPCs. A lying NEAR RPC can hide a stop or describe a forged
  registration; NEAR MPC then refuses the key, but the payment has moved. Use RPCs you trust.

## 7. The PAY2 bytes: pay first, then download

The encrypted body is not public. Each file has its own random key, so a leaked file key opens one
file. But anyone who collects every encrypted file of a marketplace needs only one later break of
NEAR MPC (a compromise of its master secret, or a computer that breaks BLS12-381 and reads the CKD
answers stored on NEAR) to open all of them. Without the bodies, a recovered key opens nothing.

**Before payment, only the header is public.** `info.header` serves the complete final PAY2 header
(at most 65,536 bytes; no body bytes). The client checks it before signing: `fileId`, the
registered `cipherHash` recomputed from the header, the seller's signature, and a `near-ckd/v1`
stanza for the trusted contract. This proves which bytes the buyer will pay for, not that the host
holds them, and not that the wrapped key is right (a dishonest seller can sign a broken file; the
signature is the evidence).

**The paid request returns the file, to the buyer only.** With `paymentFlow: "upfront"` the file
is served only for a purchase that is settled (section 10). A payment payload alone never gets the
body: the facilitator sees the whole payload, and the payment signature binds neither the host nor
the client. What only the buyer holds is the one-time key's secret (the key the nonce commits to;
the client needs it to open the file). So the paid request also carries `Annon-Buyer-Proof`
([download.md](download.md) section 3): a signature by that key over `resource.url`, which no
facilitator can make and no other host can use.

The answer to a request with a payload, after the checks of section 10, unless the request is
entitled to the file anyway (download.md section 1):

- settled, with a valid `Annon-Buyer-Proof` for the payload's `buyerKey`: `200`, the success
  `PAYMENT-RESPONSE`, and the complete PAY2 file as the body, with `Cache-Control: private,
  no-store`; `Range` resumes a broken download the same way;
- settled, without one: `402`, the success `PAYMENT-RESPONSE` and a fresh sign-in challenge;
- broadcast and not yet at `safe` (`submitted`): `402` with `PAYMENT-RESPONSE`
  `errorReason: "settlement_pending"` and its transaction;
- settling with no transaction known yet (`processing`): `503` with `Retry-After`, and no
  `PAYMENT-RESPONSE`.

In the last two the client asks again with the same payload and proof (section 10) until the body
comes. A client that lost the one-time secret signs in to download, and uses `reopen` for the key.

**A buyer signs in to download again.** Any later request, from any device, uses the standard x402
sign-in ([download.md](download.md)): the `402` carries a single-use `sign-in-with-x` challenge,
the wallet signs it, and the host checks the signature, that the wallet bought the file, and that
the file exists and is not taken down, for every request. "Bought" is `is_buyer(fileId, wallet)` on
the trusted contract at final state, or, until NEAR records it, a purchase by that wallet this host
has settled. One sign-in gets a session of at most two hours for that wallet on that host:
parallel downloads and resumes need no further signature. A payment payload or a transaction hash
is never an entitlement.

**The client checks every byte.** It checks every chunk against the hash list of the header it
checked before paying (its `SHA256`, as `0x` and lowercase hex of every byte of the final header as
served at `info.header`, stanzas and seller signature included, is recorded with the purchase), and
marks the file complete only when all checks pass. The guarantee is: verifiable downloads and
repeat access while a host or mirror holds the file and the moderator has not taken it down (a
takedown also blocks `reopen`).

**A seller may publish the body** (e.g. on IPFS): `info.public: true`. The client then downloads
and checks the whole file before signing.

## 8. Revenue splits: through the address

Annon checks one thing about where the money goes: the USDC `Transfer` reached the registered
`pay_to`, the address the seller signed. What that address is, is the seller's and the platform's
choice:

| `pay_to` | Who gets the money |
|---|---|
| The seller's wallet | 100% the seller |
| A platform's wallet | the platform, which pays the seller on its own terms (the seller trusts it) |
| An immutable revenue split, e.g. 0xSplits v2 with owner 0 | the split's recipients, in its fixed shares, once someone calls `distribute` (the seller trusts the split's code, not the platform) |

For a split the SDK checks, from the split's terms and its creation salt or nonce (both in its
`SplitCreated` event), that `pay_to` is the address an 0xSplits V2.2 factory on Base gives those
terms with owner 0, that its code is that factory's clone, that it is on chain and not paused, that
it has at most 100 recipients and none is the zero address (USDC refuses to pay it), and that
`0 < totalAllocation < 2^128`. `distribute` computes `amount * allocation / totalAllocation` in
uint256, so below `2^128` no USDC amount can overflow it; above, a large enough payment would,
and that money would stay in the split.
A split created with an owner is refused even if the owner later renounced it (an owner could
have approved its USDC to anyone first). The integrator then shows the seller who gets what percent
before they sign. The SDK can also build the transaction that creates such a split (owner 0, a
salt the platform keeps) and the transactions that pay it out.

The key is released when the payment reaches the split. The money then waits in the split until
someone calls `distribute`; nothing has to happen by a deadline, and anyone may call it and pay its
gas: the platform after a sale or once a day, the seller, or the 0xSplits app.

A split's distribution reward (`distributionIncentive`, in millionths, at most 65 535 or 6.5535%) comes off each payment
before the shares and goes to whoever the caller of `distribute` names, so it is a tip for
running the payout, not a platform fee. A platform takes its fee as a recipient and sets the
reward to 0.

- **Push:** `distribute` pays every recipient's wallet in one transaction. If USDC blacklists any
  one recipient, the transfer to it fails and nobody is paid.
- **Pull:** `distribute` credits each recipient in the SplitsWarehouse; a second transaction,
  `withdraw(recipient, token)`, pays that recipient's wallet, and anyone may send it for them,
  unless that recipient paused its own withdrawals in the warehouse (then only it can). A
  blacklisted recipient blocks only itself, as long as each withdrawal is its own transaction.
  A distribution reward is credited in the warehouse too and withdrawn the same way. This is the
  safer default for a platform with many sellers.

What the check proves is the terms, not that a payout will go through. Circle can blacklist a
recipient, the split or the warehouse, the same way it can freeze a seller's own wallet. Each
share rounds down, and a few units of the token stay behind: one in the split at each
`distribute`, and for pull one in each warehouse balance at withdrawal. Tiny payments may pay
nobody until more arrive.

## 9. Browser clients

As the HTTP transport requires ([browser clients](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md#browser-clients)),
for the file URL:

- `Access-Control-Allow-Origin` for the calling origin on every response: the `402`, the paid
  response, a download, a retry's answer and every error. Without it the browser hides the whole
  response;
- `Access-Control-Expose-Headers: PAYMENT-REQUIRED, PAYMENT-RESPONSE, Annon-Session, Retry-After,
  Content-Range, Content-Length`, merged with any value already there (a browser reads no other
  response header across origins);
- a preflight answered without payment or sign-in, allowing `GET`,
  `Access-Control-Allow-Headers: PAYMENT-SIGNATURE, Annon-Buyer-Proof, SIGN-IN-WITH-X,
  Authorization, Range, Content-Type`, and a non-trivial `Access-Control-Max-Age`;
- no credentialed CORS: the session travels in `Authorization`, never in a cookie, and the client
  sends no cookies (`credentials: "omit"`);
- `Vary: Origin` on every response of a host that reflects origins, also to a request without
  one, and every answer `Cache-Control: no-store`: each depends on who asks.

## 10. Retries: one purchase, one settlement

A buyer may lose the answer, close the tab or crash anywhere between signing and settlement. The
rules below make every retry land on the same payment, so a buyer never pays twice for one
purchase and a seller never refuses a buyer who already paid.

**A purchase** is identified by `(network, asset, from, nonce)`. The nonce commits to the contract,
the file and the one-time key ([nonce.md](nonce.md)), and USDC executes at most one transfer per
`(from, nonce)`. A client keeps at most one open purchase per wallet and file: it does not make a
second one-time key, and so a second nonce, while the first purchase is open.

**The client records before it acts.** Before the wallet is asked to sign, the client durably
records the purchase, the authorization it is about to sign (all six fields), the Base block to
search from, the `PaymentRequired` it answers, and the PAY2 header it checked (its bytes, or their
`SHA256` as defined in section 7, so that a download after a crash is checked against exactly those
bytes). After signing, and before the payload leaves the client in any form (a dry run on an RPC
included), it durably records the complete `PaymentPayload`. That record is a signed authorization
anyone can submit until `validBefore`: keep it as such.

**When a purchase closes.** It closes when the buyer is recorded on NEAR (`is_buyer`), or when it
is unpaid: every recorded authorization has expired at a finalized Base block, or was canceled by
an `AuthorizationCanceled` in a finalized block, and no payment was found. A payment found on Base
but not yet recorded on NEAR keeps the purchase open; the next step is `unlock`, never a new
purchase.

**A retry resends the recorded payload.** It is the same `PaymentPayload`, with the same
`payment-identifier` id, never one rebuilt from a new `402`. Signing a new authorization for the
same purchase (a new deadline, the same nonce) is not part of v1.1.

**`payment-identifier`.** The id names one payload, not the purchase: the same payload is sent with
the same id; a changed payload gets a new id. The id follows the extension (16 to 128 characters,
letters, digits, `-` and `_`); the SDK makes `pay_` and 32 random hex digits. The id is a
correlation key, never an entitlement, and it never opens a session.

**What the server keeps.** Two records, each updated atomically:

1. **The id binding.** The id, scoped to the seller and the route, is bound to the payload it first
   came with. The same id with another payload is refused with `409`. The binding is kept at least
   until that payload can no longer settle (its `validBefore` has passed at a finalized Base block);
   while it is kept, the `409` holds. After that the purchase record still prevents a second
   settlement.
2. **The purchase.** `(network, asset, from, nonce)` has one state:

| State | Meaning | Answer to the payload |
|---|---|---|
| `processing` | accepted and recorded before the facilitator is called; a settle call may be in flight or may have broadcast, but no transaction hash is known | the server reconciles first (below); if that does not settle it, a retryable error with no transaction: never `settlement_pending` without a hash, never a made-up hash |
| `submitted` | broadcast; the transaction hash is known | `PAYMENT-RESPONSE` with `errorReason: "settlement_pending"`, the `transaction` and `network` ([x402 v2 §9](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md#9-error-handling)) |
| `settled` | the payment of this purchase is on Base in a block at or before Base `safe` | the success `PAYMENT-RESPONSE` with that `transaction`, however often asked |
| `unpaid` | every authorization of the purchase expired at a finalized block, or was canceled in one, with no payment | refused like a new payment would be |

The answer always follows the purchase's state at the time of the request, never a frozen first
answer. A retry of a `processing` or `submitted` purchase, and any such purchase left behind by a
crash, is reconciled from Base by its nonce, whether or not a hash is known: if its payment is on
Base it is `settled`; if not and the payload can still settle, the server calls the facilitator
again with the same payload (the same nonce settles at most once), at most once per `Retry-After`
interval after a call that did not settle; if it can no longer settle, it is `unpaid`. The purchase
stays open until one of these is certain. A host also does this for a signed-in wallet's open
purchases on this host, from their recorded payloads (`download.md` section 1).

**Payment evidence.** A purchase is `settled` only on the same evidence NEAR's `unlock` checks: a
successful Base transaction whose USDC `AuthorizationUsed(from, nonce)` log is followed by the
`Transfer` from `from` to the registered `pay_to` of at least the registered price, with `nonce` =
`annonNonce` of the payload's `buyerKey`. `authorizationState(from, nonce)` alone is not a payment:
it is also true after a cancellation. A server with no state for a purchase (its first sight of
the payload, or state lost to a restart) reads Base for that evidence before deciding, searching
the blocks from `validBefore` minus 240 seconds to `validBefore`; it never asks for a new payment
because it forgot one.

**Order of checks for a payload.** First a takedown refuses (`410`), whatever the state. Then the
purchase terms, which come from the registration and the contract's configuration and never
change: `accepted.scheme`, `network`, `asset`, `amount` and `payTo`, and the EIP-712 `name` and
`version` in `extra`; `extensions.annon.info.contract` and `fileId` naming this file; a valid
`buyerKey`; the nonce; the signature recovering to `from`; `validAfter` 0. Then the purchase state
above: a purchase that is `processing`, `submitted` or `settled` is answered from its state, even
if sales have stopped or the seller's settings have changed since, or the authorization has
expired. Only a purchase the server has not started settling goes through the rest of section 4:
"still on sale", the deadline, and the comparison of the whole offer and info, seller settings
(`maxTimeoutSeconds`, the `header` URL, `public`) included. A facilitator may also
use the id; a seller does not rely on it.

## 11. Extensions

**Which ones.** A server advertises `annon` and `sign-in-with-x` always, `payment-identifier`
(section 10), and may advertise `builder-code` and `bazaar`. A client echoes every advertised
extension with at least the `info` it received, adds only what this profile names (`annon.info
.buyerKey`, `payment-identifier.info.id`, the `builder-code` fields below), and echoes an extension
it does not know unchanged. A server checks the extensions it advertised and ignores others.
`forFacilitator` passes the payload's extensions on, except `bazaar` (below).

**`builder-code`**
([extension](https://github.com/x402-foundation/x402/blob/main/specs/extensions/builder_code.md)).
A server may declare its app code as x402's `declareBuilderCodeExtension` does (`info.a`, and
optionally its own service codes in `info.s`). The Annon client sends `extensions["builder-code"]`
as x402's client merge does: the declared `info` (none if nothing was declared) with `info.s` set
to the Annon SDK's service code `bc_lq0mq0v9` followed by the declared codes, duplicates removed.
`info.s` may also be one code as a plain string, as the extension allows; it counts as a list of
one. The server refuses, before anything is settled, a payload without the extension when it
advertised it, whose `info.a` differs from the one it declared or is present when it declared
none, whose `info.s` leaves out a code it declared, or whose codes break the extension's format
(`^[a-z0-9_]{1,32}$`) and limits (at most 10 echoed service codes). The
facilitator turns the codes into an ERC-8021 suffix on the settlement; none of this changes the
payment evidence (section 10).

**`bazaar`**
([extension](https://github.com/x402-foundation/x402/blob/main/specs/extensions/bazaar.md)). A
server may describe the file for discovery, in the shape of x402's `declareDiscoveryExtension`:
`info.input` `{ "type": "http", "method": "GET" }`, `info.output` `{ "type": "binary", "format":
"application/vnd.annon.pay2" }`, and the `resource` fields `description`, `mimeType`,
`serviceName`, `tags` and `iconUrl` as the extension's service metadata rules keep them: a name
and up to five tags, distinct ignoring case, of 1 to 32 printable ASCII characters, and an icon
URL of at most 2048 characters with no credentials and a host name that is not an IP address or
loopback. An Annon server uses an `https` icon URL and refuses metadata outside these rules
rather than trimming it.
It is never part of the payment: the client echoes it, the server does not check it, and
`forFacilitator` leaves it out, because a facilitator would catalog the offer renamed `exact`
(section 4), which an ordinary x402 client cannot pay. Discovery reads the seller's own `402`.

## 12. Changes from v1

| Section | v1.1 |
|---|---|
| 2 | `extensions.annon.info.version` is `2`; the server advertises `payment-identifier` and `sign-in-with-x`; `paymentFlow: "upfront"`; `info.download` is gone (the file is `resource.url`); a stopped file answers `402` with `accepts: []`; `extra.splits` refused |
| 3 | the client sends a `payment-identifier` id when advertised |
| 4 | retries are recognized before the checks of a new payment; `forFacilitator` keeps every extension but `bazaar` and returns `x402Version: 2` |
| 5 | `success` means paid on Base at `safe`, not that the key is released |
| 7 | the paid request returns the file to a request with a proof by the purchase's one-time key (`Annon-Buyer-Proof`); a payload alone never gets the body; `processing` answers `503`; later downloads use x402 sign-in and a session of at most two hours instead of v1's per-download challenge |
| 9 | `Access-Control-Allow-Origin` on every response; the sign-in, session and range headers allowed and exposed; no cookies |
| 10 | new: purchase identity, what the client records and when, when a purchase closes, retries, the id binding and its lifetime, purchase states and their answers, reconciliation by nonce, payment evidence, order of checks (purchase terms before seller settings) |
| 11 | new: which extensions a server advertises and a client echoes; `builder-code` (the Annon client's service code `bc_lq0mq0v9`); `bazaar` for discovery, never sent to a facilitator |
