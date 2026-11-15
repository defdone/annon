# Specifications

These documents define the Annon protocol. Byte layouts, texts, hashes and the vectors in
[vectors/](vectors) are normative: the contract (Rust) and the SDK (TypeScript) must produce the same
vectors, and CI fails when they differ.

## Status

All documents are drafts. They describe what the contract `v1.annon.defdone.near` and the
`0.1.0-alpha.N` packages do today.

| Document | Defines | Version |
|---|---|---|
| [near-settlement.md](near-settlement.md) | Identities, terms, the purchase commitment, settlement, refunds, recovery | Draft 3, 11 Nov 2026 |
| [pay2.md](pay2.md) | The encrypted file format | PAY2 version 2 |
| [nonce.md](nonce.md) | The purchase ID and the Base payment nonce | Domains `annon/purchase/v2`, `annon/base-payment/v2` |
| [x402-annon.md](x402-annon.md) | The Annon profile for x402 v2 | Extension version 3 |
| [download.md](download.md) | Downloads proved by a purchase grant | Follows near-settlement.md |

During the alpha the contract can be upgraded ([SECURITY.md](../SECURITY.md)), so an incompatible
change is still possible. Our versioning rule: an incompatible format change gets a new version
number (PAY2 byte 4, `extensions.annon.info.version` or a hash domain string), and an old number
never gets a new meaning. Clients refuse versions they do not know.

The documents become stable when the contract is locked after an independent audit. The formats of
a locked contract do not change; a new protocol version comes with a new contract.

## Proposing changes

Annon is an open protocol. Start a [discussion](https://github.com/defdone/annon/discussions) with a
proposal for a specification or the contract. We review every proposal and either adopt it or work
it out there in the open. Security problems go through private reporting
([SECURITY.md](../SECURITY.md)).

## Reading order

To write your own implementation, read [near-settlement.md](near-settlement.md) first, then
[pay2.md](pay2.md), [nonce.md](nonce.md), [x402-annon.md](x402-annon.md) and
[download.md](download.md). Check your output against [vectors/](vectors).
