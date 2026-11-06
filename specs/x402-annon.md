# Annon payment profile for x402 v2 (draft)

How a server sells an Annon file over x402 v2, and what an Annon client sends. It is plain x402 v2
([spec](https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md),
[HTTP transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md))
with two schemes of its own, one extension, `annon`, and the payment nonce of [nonce.md](nonce.md).
The SDK builds and checks all of it (`offerFor`, `checkPayment`, `forFacilitator` on the seller's
side; `discover`, `preflight`, `authorize` on the buyer's); integrators don't write these objects.

Status: draft, not frozen. A split payment kind (a shared Annon splitter on Base) is being added;
the profile is frozen only after that and the owner's approval.

## 1. Why its own schemes

A payment for an Annon file must sign the Annon nonce, or the money moves and the key can never be
released. The official x402 client signs any `exact` offer with a random nonce and ignores `extra`
keys it doesn't know; it refuses an offer whose scheme it has no handler for ("No network/scheme
registered"). So Annon offers use their own schemes, and a client without Annon signs nothing:

| Scheme | Registration source | EIP-712 primary type | Settled by |
|---|---|---|---|
| `annon-exact` | `x402` (pays the seller's `pay_to`) | `TransferWithAuthorization` | any standard x402 facilitator, as `exact` (section 4) |
| `annon-receive` | `payaion` (pays the splitter) | `ReceiveWithAuthorization` | the splitter's facilitator only |

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

`extensions.annon.schema` is the JSON Schema of that object (`ANNON_SCHEMA` in the SDK).

`accepts` holds one offer, every value from the registration (`get_file`) and the contract's
configuration (`get_config`):

| Field | `annon-exact` | `annon-receive` |
|---|---|---|
| `network` | `eip155:8453` | `eip155:8453` |
| `asset` | `usdc` from `get_config` | same |
| `amount` | the registered price | same |
| `payTo` | the registered `pay_to` | `payaion_splitter` from `get_config` |
| `extra` | `name: "USD Coin"`, `version: "2"` | the same, and `creator`: the registered seller |

No `assetTransferMethod`, no `paymentFlow` other than `authorization`. A stopped or taken-down
file is not offered: `410`.

## 3. Payment

The client sends `PAYMENT-SIGNATURE` (base64 JSON `PaymentPayload`, `x402Version: 2`):

- `accepted`: the offer, unchanged; `resource` and other advertised extensions echoed.
- `payload.signature`: 65 bytes, `0x` hex, low `s`, `v` 27 or 28.
- `payload.authorization`: `from`, `to` (= `payTo`), `value` (= `amount`), `validAfter: "0"`,
  `validBefore`, `nonce`, as strings, as in exact on EVM.
- `extensions.annon.info`: the info received, plus `buyerKey`: the buyer's one-time BLS12-381 G1
  key, `0x` and 48 bytes compressed, not the identity.

The nonce: `annonNonce(contract, fileId, buyerKey)` for `annon-exact`,
`keccak256(creator ‖ annonNonce(...))` for `annon-receive`. Domain: `name`, `version` from
`extra`, chain 8453, `verifyingContract` = `asset`.

The Annon client signs for at most 180 seconds, from the earlier of its own clock and Base's, and
refuses a Base RPC more than 60 seconds off. With that, a payment authorized while the file was on
sale always lands inside the contract's 300 seconds after a stop.

## 4. What the server checks, then how it settles

Before settling (`checkPayment`):

1. The offer is echoed unchanged (compared as data, not as text: key order is free).
2. `extensions.annon.info` holds the advertised info unchanged and a valid `buyerKey`.
3. The nonce is the one in section 3, computed by the server from `buyerKey` and the
   registration; the signature recovers to `from` over that nonce.

Anything else: refuse, settle nothing.

Settlement: `annon-exact` goes to any standard facilitator as `exact`: `forFacilitator` renames the
scheme in both the payload's `accepted` and the requirements (the official facilitator checks
both). The scheme label is not part of the signed message, so this is the same USDC authorization.
`annon-receive` goes through the splitter's receive entry point with
`commitment = annonNonce(contract, fileId, buyerKey)`.

## 5. Settlement response

`PAYMENT-RESPONSE` (base64 JSON `SettlementResponse`). The client does not depend on it: it finds
the payment on Base by its nonce, searching from the Base block that was finalized when it signed.

## 6. What the client trusts

Nothing in the 402. The client:

- takes `extensions.annon.contract` only if it is on its trusted list (the SDK ships
  `v1.annon.defdone.near`; an application may add others explicitly);
- reads `get_file` and `get_config` from that contract through the NEAR RPC it was configured
  with, never one named by the server, and refuses an offer whose price, recipient, token, network
  or scheme differ;
- trusts its NEAR and Base RPCs. A lying NEAR RPC can hide a stop or describe a forged
  registration; NEAR MPC then refuses the key, but the payment has moved. Use RPCs you trust.

## 7. The PAY2 bytes: pay first, then download

The encrypted body is not public. Anyone who collects every encrypted file of a marketplace only
needs one later break (a leaked file key, a compromise of NEAR MPC's master secret, a computer that
breaks BLS12-381 and reads the CKD answers stored on NEAR) to open all of them. Without the bodies,
a recovered key opens nothing.

**Before payment, only the header is public.** `info.header` serves the complete final PAY2 header
(at most 65,536 bytes; no body bytes). The client checks it before signing: `fileId`, the
registered `cipherHash` recomputed from the header, the seller's signature, and a `near-ckd/v1`
stanza for the trusted contract. This proves which bytes the buyer will pay for, not that the host
holds them, and not that the wrapped key is right (a dishonest seller can sign a broken file; the
signature is the evidence).

**After payment the buyer downloads.** Once `unlock` has recorded the buyer on NEAR, `info.download`
serves the file to the paying wallet: the host issues a single-use challenge, the wallet signs it
(EIP-4361, bound to the host's domain, the contract, the `fileId` and a short expiry), and the host
checks the signature and `is_buyer(fileId, wallet)` on the trusted contract before streaming.
Range requests resume a broken download. The client checks every chunk against the hash list of
the header it checked before paying, and marks the file complete only when all checks pass.

**Re-download is the same request, any time later.** A payment signature or a transaction hash is
never an entitlement; `is_buyer` is. A buyer pays once and downloads from any host or mirror that
holds the file.

**What the buyer still trusts the host for:** to keep the file and serve it. The host cannot
substitute bytes (the hash list), and a refusal is provable (the payment on Base, `is_buyer` on
NEAR, the 402 it served).

**A seller may publish the body** (e.g. on IPFS): `info.public: true`. The client then downloads
and checks the whole file before signing.

## 8. Browser clients

As the HTTP transport requires: `Access-Control-Expose-Headers: PAYMENT-REQUIRED, PAYMENT-RESPONSE`,
`Access-Control-Allow-Headers: PAYMENT-SIGNATURE, Content-Type`, preflight answered without
payment, `Vary: Origin` when origins are reflected.
