# @defdone/annon

## 0.1.0-alpha.0

First public alpha, published on the npm `alpha` tag.

- PAY2 encryption with streaming `sell` and `open` in constant memory.
- Purchases verified by the Annon contract on NEAR: USDC on NEAR, Base through x402, and other chains
  through NEAR Intents (1Click), with explicit route selection.
- Key release through NEAR MPC to a one-time buyer key, grant-proved downloads, and recovery on a new
  device with the buyer's wallet.
- Per-file storage budgets, sponsored listings through a relayer, and protocol fees shown before
  registration.
- Browser entry `@defdone/annon/browser`: a purchase controller that survives reloads and works
  across tabs, encrypted IndexedDB receipts with export and import, downloads with in-browser
  decryption up to 50 MiB, and adapters for injected EVM, Solana and NEAR wallets.
- `annon` CLI with browser wallet login (`annon login`) and agent mode (`annon init --agent`) with a
  price cap and a daily budget.

### Minor Changes

- Add bounded shop discovery and client-side catalog search and paging to the SDK, CLI and read-only MCP tools. Keep aliases and deployment profiles in human configuration. Refuse unavailable direct Base routes before wallet setup and restore authenticated, validated seller-key backup import.
- Add hosted sharing through approved shops, durable seller checkpoints and pending backups, browser seller controls, upload signing helpers, and CLI and MCP share commands. Keep NEAR and Solana listings on NEAR and 1Click routes. Preserve retry hints for hosted sharing budget refusals and isolate unavailable third-party shops during discovery.

### Patch Changes

- Prepare immutable encrypted bodies for hosted upload reservations.
- Add a canonical hosted split salt, reject direct Base settlement when final terms omit Base, preserve pending upload retry hints, tighten split response validation, and protect sponsored seller admissions with a liquid balance floor while keeping buyer recovery available.
- Expose relayer services and browser sponsorship checks through the supported package entries. Send seller-signed storage requests, share retry handling, and preserve download and registration recovery evidence. Use the Node entrypoint in the MCP server and validate packed package boundaries.

  Report wrong_identity when a funding wallet is not the file's seller. Keep shared CORS defaults empty and scan recent recovery grants first.
- Check NEAR wallet return hashes against the pending call's exact deposit and the time the attempt started. Old, mismatched or unreadable hashes are refused with transaction_uncertain and leave the pending operation in place, so no second deposit is sent. Saved transaction hashes are also checked for the exact deposit. Passing txHash when no NEAR wallet call is pending now fails with invalid_arguments.
- Use one public payment route vocabulary and validated portable receipts. Standardize public errors and preserve relayer recovery accounting.

  Remove the unused sell preview callback and text preview helper.

  Preserve command-specific error guidance and alert on held relayer reconciliation. Remove unused preview verification and seller-key import helpers.
- Publish an explicit list of entry points instead of every module under `dist/`: `.`, `./browser`, `./browser/purchase-bundle.js`, `./node`, `./relay`, `./pay/store-node`, `./node/signer-mock` and the server building blocks `./pay/seller`, `./pay/settle`, `./pay/store`, `./pay/split`, `./download/host`, `./download/http`, `./envelope/pay2` and `./near/rpc`. `./node/adapter`, `./node/cli` and `./node/errors` remain for now and are deprecated in favour of `./node`. The main entry lists its exports by name, adds the error classes, and no longer exports the low-level `openTo`, the relayer fee math or the purchase, refund and text encoders. The build starts from an empty `dist/` and ships no source maps.
- Restore relay dependency and declaration initialization order while retaining the split function bodies.
- Split relay request validation, transaction handling and reconciliation into focused modules while preserving behavior and existing import paths.
- Remove unused internal keeper wrappers and exports, and keep the refund tree oracle in test support.
- Check Base sponsorship and split eligibility before signing. Preserve pending Base purchases after expiry and allow an explicit NEAR unlock wallet when resuming with a fresh SDK instance.

  Enforce configured source spending caps, prevent accidental repeat purchases, and retain download and settlement waits across restarts. Automatic download retries and pending-payment polling now stop after at most 60 seconds of total waiting and return the remaining retry hint. Use the same saved purchase when retrying.

  Require a configured origin for agent 1Click purchases. Recover the purchase guard queue after a failed renewal and preserve completed buy results when reservation cleanup fails.
- Check Base authorization validity, balances and nonce state before recording new payments. Add exact-origin CORS validation and hooks for durable completed-download accounting.

  The SDK HTTP helper now applies an exact-origin CORS allow-list policy with no origins allowed by default. Integrators configure `allowedOrigins` and, optionally, verified exact `previewOrigins` on `handle()` for their browser clients.
- Require durable admission for sponsored relay sends and seller authorization for sponsored file storage funding. Preserve checked sponsorship and admission limits across relayer restarts, and bound sponsored unlocks by file and seller.
- Omit ambient cookies and HTTP authentication from SDK RPC and 1Click requests.
- Sponsored `share` registrations from the CLI, the MCP server and the browser seller check the NEAR outcome against the contract call only, without the relayer-only hosting reservation, so a successful registration no longer ends as `transaction_uncertain`.
- Share equivalent byte, record validation and directory sync helpers while preserving public exports and error behavior.
- Hosting lifetime is now the shop's policy. Hosted selling accepts any future publication expiry from the selected shop, or `null` for no planned expiry, instead of refusing expiries more than seven days away. An expiry at or before the current time is still refused with `file_expired`, and malformed values are refused. `Shared.expiresAt` and the browser seller's `view().result.expiresAt` are now `number | null`. Saved completed sales stay readable after their expiry. The browser seller's `quote.hostedDays` comes from the new optional `fileLifetimeDays` option instead of a fixed 7, and is absent when the page does not pass it.
- Validate optional shop rules and expose descriptive text with shop provenance in discovery, catalog and hosted share output.
- Raise the default sponsored registration allowance to two per seller and IP bucket per UTC day.
