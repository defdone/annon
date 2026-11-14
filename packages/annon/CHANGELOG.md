# @defdone/annon

## 0.1.0-alpha.4

### Patch Changes

- b533bd1: `annon init --deployment defdone` writes the configuration for the deployment run by defdone (contract, network, NEAR RPC, relayer, price cap and the demo shop with its approved profile) when no configuration file exists, then sets up the backup secret as before. In a terminal, plain `annon init` asks once whether to use that deployment; without a terminal and without the flag it writes no configuration and says how to add one. Init writes the configuration only when nothing exists at that path; it never changes, replaces or writes through anything already there, such as a file or a symlink, and reports it as kept. The file is written owner-only and atomically. The init result adds a `config` field with the path and whether it was created, kept or not written. `--deployment` accepts only `defdone`. `init --agent` and agent mode are unchanged. The quickstart now starts with this command.
- 76c0b97: In a terminal, `share` and sponsored `sell` show their terms as readable lines instead of raw JSON, with prices in USDC, storage in NEAR and the number of sales the purchase storage covers. Each browser approval is named before it opens, the hosting expiry reads as a local date and time, and when `stop`, `fund` or `share --resume` runs with the wrong account, the error says who you are signed in as, who the seller is and how to sign in as the seller. An interactive NEAR share now proposes 0.2 NEAR of purchase storage instead of 0.05. Piped, `--json` and agent output are unchanged.

## 0.1.0-alpha.3

### Patch Changes

- edb0ec2: Bound approval session shutdown and resume polling after accepted approvals. Keep completed review snapshots read only and clarify that the tab should stay open.
- 5d871b7: Keep accepted browser approvals successful after session shutdown and show completed approvals as read-only collapsible steps.
- f607080: The CLI is easier to use by hand. `annon` with no arguments in a terminal (or `annon shell`) starts
  an interactive session that runs the usual commands without the prefix until `exit`. In a terminal
  the commands print short text in place of JSON: a login line, a numbered catalog table, the buy
  terms and next step, one or two lines for status and open. `--json`, piped output and agent mode
  keep the JSON envelope unchanged.
  
  `annon buy` takes a catalog row number (`buy 2 --shop demo`) and `--open <file>`, which waits for
  acceptance and writes the file. `annon status` and `annon open` without an ID use the latest
  purchase saved for the configured contract and network, and accept an ID prefix of 8 or more hex
  digits for purchases saved for it. The `next` text of a NEAR or Base buy no
  longer talks about a deposit.

## 0.1.0-alpha.2

### Patch Changes

- Add `BrowserPurchaseController.reconcile()` so a purchase that 1Click reported as failed can be checked again. Under the purchase lease it keeps the same purchase, deposit and recovery identity, checks NEAR acceptance and reads the existing deposit's 1Click status once. Accepted moves to `accepted`, `SUCCESS` to `accepting` and `REFUNDED` to `refunded`; anything else stays `failed` with the new status saved. If the saved deposit address or memo, the restored purchase's deposit and the saved polling checkpoint disagree, it refuses before any read or write. It never creates, starts or pays for a purchase.
- Bare `annon init` creates the CLI backup secret at `~/.config/annon/backup-secret`: 32 random bytes as hex, mode 0600 from the first write, published with a hard link so it never appears half-written and never replaces an existing file. Running it again only validates the file. It refuses to create a new secret while saved records or backups exist, never prints the secret, and sends its one-time notice to stderr. `--backup-secret-file`, `ANNON_BACKUP_SECRET_FILE` and `ANNON_BACKUP_SECRET` keep their precedence; the default file is read only when none is set, and a selected source that fails never falls back. Other commands, agent mode and MCP read the default but never create it. Reading the default checks that `~/.config/annon` is a private directory you own, refuses symlinks, FIFOs and other non-regular files without blocking, and never repairs anything. Bare `init` reports an unreadable config as a setup error (exit 2). A pending `status` now uses the default file too. `annon --version` (or `-v`) prints the installed version. The quickstart replaces the manual secret recipe with `annon init` and explains backup and restore.
- The CLI wallet approval page shows a readable summary of exactly what the wallet signs: a title per action, the pairing code to compare, amounts in USDC or NEAR, receiver, account, expiry and what signing does, with the CLI's terms shown apart and the raw request under Technical details (the NEP-413 nonce as hex). Each click opens at most one wallet window, so Meteor's web popup is no longer blocked: NEP-413 messages are signed without a sign-in, and transactions connect first and then send. After a closed, blocked or declined wallet window the page explains it and allows another try until the request expires. The terminal prints a waiting line with the expiry, the reported wallet failure and a specific final error (`cancelled`, `rejected` or `wallet_error`) instead of `operation_failed`. Once the page has called the wallet's send for a transaction, the request is never attempted again: the CLI records the send start before the wallet is called, the request ends as `transaction_uncertain` with a warning not to pay again, the saved purchase keeps that state without inventing a transaction hash, and it blocks a plain rerun of `annon buy` until it is accepted or `--force` is used. A result the CLI cannot verify after the send start also ends as uncertain, keeping a valid transaction hash when there is one. An uncertain `annon buy` exits 4, and `annon status` reports `submission: "uncertain"` with a warning not to pay again. The NEAR wallet is chosen in a styled, keyboard-accessible list instead of the browser's native menu.

## 0.1.0-alpha.1

### Patch Changes

- Search Base for a payment in eth_getLogs chunks of at most 10,000 blocks, so a purchase whose search window outgrows the common RPC range limit still reaches unlock instead of failing with a transport error on every retry.
- Browser login offers Meteor Wallet and HOT Wallet for NEAR instead of the retired MyNearWallet, which no longer connects to apps. HOT is offered for near:mainnet only, and unknown NEAR chains are refused. The login page CSP connects only to the page, the selector's NEAR RPC and HOT's relay, and frames only the HOT widget. Browser NEP-413 requests no longer include a callback URL, since both wallets return signatures to the page. The bundled Meteor SDK no longer logs its generated key pair, and Meteor sign-out removes that key.

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
