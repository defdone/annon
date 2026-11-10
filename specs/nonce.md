# Purchase and Base payment nonces

The commitment in [near-settlement.md §5](near-settlement.md) is the only payment model.
`Purchase.nonce` is 32 cryptographically random bytes generated locally. It is part of the
Borsh purchase commitment, along with the file, terms, buyer key, refund and recovery identities,
route, asset, price, expiry, contract and network.

```
purchase_id = SHA256("annon/purchase/v2" ‖ 0x00 ‖ Borsh(Purchase))
base_nonce = keccak256("annon/base-payment/v2" ‖ 0x00 ‖ purchase_id)
```

`purchase_id` is decoded to 32 bytes before hashing. On Base the commitment network is exactly
`eip155:8453` and asset is `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` (lowercase Base USDC).
NEAR network names are refused on Base. The buyer signs EIP-3009 TransferWithAuthorization with
`nonce = base_nonce`, `to = terms.base.pay_to`, and `value = terms.base.price`. The purchase
commitment travels in the x402 extension and in `unlock(purchase, logs, header)`.

The old concatenation of contract/file/key is not produced or accepted. A random EIP-3009 nonce
cannot release a key; the seller verifies the commitment before giving a payload to a facilitator.
Vectors: `vectors/nonce.json` and `vectors/near-settlement.json`.
