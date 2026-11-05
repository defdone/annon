# Payment nonces

The EIP-3009 nonce a buyer signs ties the payment to one file, one contract and one one-time key.
For Partner files it also ties it to the seller, so nobody can settle the payment to anyone else.
Vectors: `vectors/nonce.json`, written by `vectors/nonce.mjs`; the contract's unit tests and the
splitter's tests check the same values.

## Annon nonce

```
annonNonce = keccak256("annon/v1" ‖ contractId ‖ fileId ‖ buyerKey)
```

- `contractId`: the Annon contract's NEAR account, ASCII.
- `fileId`: 32 bytes. `buyerKey`: the buyer's one-time BLS12-381 G1 key, 48 bytes compressed.

A direct x402 payment (`Source::X402`) signs `annonNonce`. Its recipient is already in the signed
authorization (`to`), and the contract checks that the `Transfer` went to the registered `pay_to`.

## Partner nonce

```
partnerNonce = keccak256(creator ‖ annonNonce)      // abi.encodePacked(address, bytes32)
```

- `creator`: the 20-byte seller address registered on the contract for the file.

A Partner payment (`Source::Partner`) signs `partnerNonce` as a `ReceiveWithAuthorization`. The
splitter's Annon entry point takes `creator` and `annonNonce` (as the commitment) and refuses to
settle unless they hash to the signed nonce, so a relayer can't pick another creator and a changed
payout address can't receive the money. The contract recomputes `partnerNonce` from the
registration and refuses any other value.

Before signing, the client must check that the `creator` in the payment requirements equals the
registered seller and build the nonce from the registered seller. The splitter only checks that the
nonce matches the creator it settles to: a nonce bound to the wrong creator would settle, and the
contract would then refuse the key.
