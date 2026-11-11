---
'@defdone/annon': minor
'@defdone/annon-relayer': patch
---

Add ephemeral browser wallet login, agent key references and injectable keychain creation,
verified HTTP JSON remote signing, payment terms approval and durable agent spending limits.
Include callback URLs in NEP-413 hashing and use account-only MyNearWallet sign-in.

Replace historical keeper scans with durable finalized open-index sweeps, settle calls,
per-phase/slot backoff, dependency breakers, unresolved transaction monitoring and NEAR budgets.
Support prepaid refund materialization from a pluggable proof source and reserve alerts.
Require separate optional keeper credentials and persistent storage in the relayer.

Restrict signer configuration to initialization, pin agent config/budget paths and reject
interactive agent commands. Keep browser capabilities out of launch arguments and wallet
state, isolate expired verifiers, and use idle session expiry. Apply an explicit macOS
Keychain ACL and retain uncertain NEAR purchase/hash evidence. Retry remote signer creation
idempotently, scope keeper work/budgets by network, and reclaim finalized-invalid unknown
transactions with trusted failure classification and current finalized gas-price checks.

Persist keeper reference block heights for expiry checks after RPC garbage collection. Preserve
known transaction evidence across the browser verifier boundary. Build a minified CSP-compatible
browser bundle without dynamic-code fallbacks, test its static CSP contract, and support loading
that generated bundle from source execution. Browser tests use VM/fakes only; no GUI is launched.

Close bootstrap after use and disable it for manual pairing. Deduplicate verified browser results,
reject definite transaction mismatches without uncertain backup evidence, and add a two-block
keeper expiry margin. Scan emitted browser code for CSP violations, require file/env signer
identities, refuse key-file overrides, and ignore agent path environment redirection in forced mode.
