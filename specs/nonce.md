# Payment nonce

The EIP-3009 nonce a buyer signs ties the payment to one Annon contract, one file and one one-time
key. Vectors: `vectors/nonce.json`, written by `vectors/nonce.mjs`; the contract's unit tests and the
SDK's tests check the same values.

```
annonNonce = keccak256("annon/v1" ‖ contractId ‖ fileId ‖ buyerKey)
```

- `contractId`: the Annon contract's NEAR account, ASCII.
- `fileId`: 32 bytes. `buyerKey`: the buyer's one-time BLS12-381 G1 key, 48 bytes compressed.

The buyer signs a `TransferWithAuthorization` with this nonce. Its recipient (`to`) is the file's
registered `pay_to`, and the contract checks that the `Transfer` went there. A payment signed with
any other nonce (for example a random one, as a plain x402 client makes) moves the money but can
never release the key; the SDK's seller check refuses it before settlement.

The contract id is the contract's own account, so the concatenation is unambiguous.
