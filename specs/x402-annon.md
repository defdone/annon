# Annon profile for x402 v2, extension version 3

This is the single model of [near-settlement.md](near-settlement.md). The x402 envelope stays
`x402Version: 2`; `extensions.annon.info.version` is exactly 3. Earlier extension and PAY2 versions
are refused. `resource.url` is the HTTPS PAY2 file; `info.header` is its public complete header.
The client independently trusts the NEAR contract and checks the header before authorizing money.

## 1. Schemes

A standard x402 client must not sign a random nonce for Annon. `annon-exact` identifies Base
USDC EIP-3009 TransferWithAuthorization; `annon-near-usdc` identifies native NEAR USDC settlement.
1Click pays the NEAR offer and is not another scheme.

## 2. PAYMENT-REQUIRED

A 402 carries base64 JSON. `extensions.annon.info` contains `version: 3`, `network: near:mainnet`,
`contract`, `fileId`, `header`, and optional `public: true`. The contract is explicitly trusted by
the client; no deployment is implicitly pinned by this draft. `accepts` is derived from final
`get_file(file_id)` (including `terms` and `terms_hash`), with the NEAR offer first:

| Field | NEAR | Optional Base |
|---|---|---|
| scheme | annon-near-usdc | annon-exact |
| network | terms.network | eip155:8453 |
| asset | terms.near.token | terms.base.usdc |
| amount | terms.near.price | terms.base.price |
| payTo | contract | terms.base.pay_to |
| extra | contract, file_id, terms_hash | name: USD Coin, version: 2, paymentFlow: upfront, nonceVersion: 2 |

A host MUST omit the Base offer when the file's final terms have `terms.base: null`. Hosts and
clients MUST refuse direct Base payments for that file. A buyer holding USDC on Base uses the NEAR
offer through 1Click. The reference host answers such a payment with `400 route_unavailable`, and
the reference clients refuse the `base` route for that file before any wallet step.

`maxTimeoutSeconds` is positive; Base authorizations are capped at 180 seconds, with 60 seconds
clock tolerance. `assetTransferMethod` is absent or `eip3009`; nonempty payment `splits` are refused.
There are no offers after stop. Takedown answers 410. Previous buyers retain grants after stop.

## 3. PAYMENT-SIGNATURE

The Base payload echoes the selected offer and advertised extensions, carries the EIP-3009
signature and authorization, and adds `purchase` (the canonical §5.1 MESSAGE string, including the refund prefix and embedded
`purchase_id`, byte-for-byte identical to the message used by the NEAR route) and `purchase_id` to `extensions.annon.info`. It never contains a buyer secret.
The seller recomputes the ID, requires route/network/asset/file/contract/terms_hash/price to match,
then checks `authorization.nonce = base_nonce(purchase_id)`, recipient and amount exactly,
`validAfter = 0`, deadline within purchase expiry, EOA signer and a short authorization window.

## 4. Facilitator

Only a checked Base payment is renamed `exact` in both payload.accepted and paymentRequirements
for the standard facilitator. It is the same signed EIP-3009 authorization. Bazaar metadata is
removed before sending. NEAR settlement uses direct ft_transfer_call or 1Click instead.

## 5. Local payment record

Before displaying instructions or requesting an authorization, the SDK generates a random nonce
and BLS buyer key, proves control of the recovery identity, validates the compact purchase message
and checked header, and saves the record. Before an RPC or facilitator sees a signed payment, its
payload is saved with compare-and-set. Retries resend identical payloads. A lost reply is not
proof that payment failed. Purchase records are keyed by purchase_id, not paying wallet.

## 6. Key release

Base logs are verified at Safe finality through MPC by
`unlock({args:{purchase: message, logs, header}})`. `purchase` is the canonical message string.
The SDK signs EIP-3009 `validBefore <= expires_at`; the seller enforces this bound. The Base
contract does not check `expires_at`. A delayed unlock remains valid. The header may be null
while sales are open; after stop it must prove the payment block's hash, number and time.
Payment block time `<= sales_stopped_at + 300` seconds is allowed, inclusive
(`STOP_SETTLEMENT_SECONDS = 300`), regardless of unlock time. Takedown blocks release.
NEAR acceptance is observed through `get_purchase`; 1Click SUCCESS alone is not acceptance.
`claim_key(purchase_id, grant)` is repeatable. Recovery calls `purchases_of` and authorized `reopen`
with a fresh key, nonce and deadline. Earlier grants remain. No wallet address view grants access.

## 7. Bytes before payment

The client checks PAY2 version 2, registered file ID and cipher hash, registered seller kind and
header authorization, and a usable stanza for the trusted contract. A public body is checked too.
The saved checked header hash is SHA256 of the complete header including trailer.
Downloads prove a final purchase grant as specified by [download.md](download.md).

## 8. Refunds

NEAR messages always start with the valid bounded refund prefix (§5.1). Delivery overpayment and
invalid-body refunds are obligations credited to that Identity's Intents balance. Refusing a
1Click delivery strands its NEP-141 refund in the quote's Intents account. The SDK validates the
whole message locally before paying.

## 9. HTTP

HTTPS, no redirects, no cookies, no-store. CORS allowlists page origins; allow PAYMENT-SIGNATURE,
Annon-Buyer-Proof, Range, Content-Type. Expose PAYMENT-REQUIRED, PAYMENT-RESPONSE, Retry-After,
Content-Range, Content-Length. GET and OPTIONS only. A body is served only after final purchase
and grant validation, including after Base facilitator settlement.

## 10. Settlement idempotency

The optional standard payment-identifier extension binds an ID to the first payload fingerprint;
reuse with a different payload answers 409. Seller CAS records are keyed by network/asset/from/nonce.
An in-flight facilitator lease prevents overlapping calls. Before retrying, the server searches
Base by nonce; settled means the payment block hash is canonical at or below Base safe. Expiry or
cancellation is final only at finalized state. Pending answers carry Retry-After. Payment state
and grant entitlement are separate: settlement alone never authorizes a download.

## 11. Discovery and attribution

Offers are NEAR plus optional Base as in §2. Standard payment-identifier, builder-code and Bazaar
metadata may be declared. The SDK echoes declared app/service codes, adds its service code, and
checks the echo before settlement. Bazaar is omitted from facilitator requests so discovery does
not accidentally advertise a plain exact offer that cannot release a key.
