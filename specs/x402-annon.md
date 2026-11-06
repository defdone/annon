# Annon payment profile for x402 v2 (draft)

How a server sells an Annon file over x402 v2, and what an Annon client sends. It is plain x402 v2
([spec](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md),
[HTTP transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md),
[exact on EVM](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md))
with one scheme of its own, one extension, `annon`, and the payment nonce of [nonce.md](nonce.md).
The SDK builds and checks all of it (`offerFor`, `verifyPayment`, `forFacilitator` on the seller's
side; `discover`, `preflight`, `authorize` on the buyer's); integrators don't write these objects.

Status: draft, not frozen. Frozen after the owner's approval.

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
| `version` | `1` |
| `network` | `near:mainnet` |
| `contract` | the Annon contract account, e.g. `v1.annon.defdone.near` |
| `fileId` | `0x` and 32 bytes, lowercase |
| `header` | URL of the complete PAY2 header, public (section 7) |
| `download` | URL of the PAY2 file for buyers (section 7) |
| `public` | optional, `true` when the seller publishes the body too |

`extensions.annon.schema` is the JSON Schema of that object (`ANNON_SCHEMA` in the SDK).

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
| `extra` | `name: "USD Coin"`, `version: "2"`; no `assetTransferMethod`, no `paymentFlow` other than `authorization` |

A stopped or taken-down file is not offered: `410`.

## 3. Payment

The client sends `PAYMENT-SIGNATURE` (base64 JSON `PaymentPayload`, `x402Version: 2`):

- `accepted`: the offer, unchanged; `resource` and other advertised extensions echoed.
- `payload.signature`: 65 bytes, `0x` hex, low `s`, `v` 27 or 28.
- `payload.authorization`: `from`, `to` (= `payTo`), `value` (= `amount`), `validAfter: "0"`,
  `validBefore`, `nonce` (= `annonNonce(contract, fileId, buyerKey)`), as strings, as in exact on
  EVM.
- `extensions.annon.info`: the info received, plus `buyerKey`: the buyer's one-time BLS12-381 G1
  key, `0x` and 48 bytes compressed, not the identity.

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

Anything else: refuse, settle nothing. Then `forFacilitator` renames the scheme to `exact` in both
the payload's `accepted` and the requirements (the official facilitator checks both), and any
standard facilitator settles it.

## 5. Settlement response

`PAYMENT-RESPONSE` (base64 JSON `SettlementResponse`). The client does not depend on it: it finds
the payment on Base by its nonce, searching from the Base block that was finalized when it signed.

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

**After payment the buyer downloads.** Once `unlock` has recorded the buyer on NEAR (final state),
`info.download` serves the file to the paying wallet: the host issues a single-use challenge, the
wallet signs it (EIP-4361, bound to the host's domain, the contract, the `fileId`, the header's
hash and a short expiry; the header's hash is `SHA256` of every byte of the final header as served
at `info.header`, stanzas and seller signature included, as `0x` and lowercase hex), and the host checks the signature and `is_buyer(fileId, wallet)` on the
trusted contract before streaming. Range requests resume a broken download. The client checks
every chunk against the hash list of the header it checked before paying, and marks the file
complete only when all checks pass.

**Re-download is the same request, any time later.** A payment signature or a transaction hash is
never an entitlement; `is_buyer` is. The guarantee is: verifiable downloads and repeat access
while a host or mirror holds the file and the moderator has not taken it down (a takedown also
blocks `reopen`).

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
terms with owner 0, that its code is that factory's clone, that it is on chain and not paused, and
that `0 < totalAllocation < 2^128` (above that, `distribute` overflows on any real amount and the
money stays in the split).
A split created with an owner is refused even if the owner later renounced it (an owner could
have approved its USDC to anyone first). The integrator then shows the seller who gets what percent
before they sign; a push split pays the wallets at `distribute`, a pull split credits them in the
SplitsWarehouse, from which they withdraw. The key is released when the payment reaches the split, before distribution;
distribution is a separate transaction whose caller pays the gas.

## 9. Browser clients

As the HTTP transport requires: `Access-Control-Expose-Headers: PAYMENT-REQUIRED, PAYMENT-RESPONSE`,
`Access-Control-Allow-Headers: PAYMENT-SIGNATURE, Content-Type`, preflight answered without
payment, `Vary: Origin` when origins are reflected.
