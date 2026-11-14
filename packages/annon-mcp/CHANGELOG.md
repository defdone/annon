# @defdone/annon-mcp

## 0.1.0-alpha.2

### Patch Changes

- Bare `annon init` creates the CLI backup secret at `~/.config/annon/backup-secret`: 32 random bytes as hex, mode 0600 from the first write, published with a hard link so it never appears half-written and never replaces an existing file. Running it again only validates the file. It refuses to create a new secret while saved records or backups exist, never prints the secret, and sends its one-time notice to stderr. `--backup-secret-file`, `ANNON_BACKUP_SECRET_FILE` and `ANNON_BACKUP_SECRET` keep their precedence; the default file is read only when none is set, and a selected source that fails never falls back. Other commands, agent mode and MCP read the default but never create it. Reading the default checks that `~/.config/annon` is a private directory you own, refuses symlinks, FIFOs and other non-regular files without blocking, and never repairs anything. Bare `init` reports an unreadable config as a setup error (exit 2). A pending `status` now uses the default file too. `annon --version` (or `-v`) prints the installed version. The quickstart replaces the manual secret recipe with `annon init` and explains backup and restore.
- Uses `@defdone/annon` 0.1.0-alpha.2.

## 0.1.0-alpha.1

### Patch Changes

- Uses `@defdone/annon` 0.1.0-alpha.1.

## 0.1.0-alpha.0

First public alpha, published on the npm `alpha` tag.

- Local stdio MCP server with `annon_share`, `annon_sell`, `annon_buy`, `annon_open`,
  `annon_verify`, `annon_recover`, `annon_budget`, `annon_status`, `annon_shops` and
  `annon_catalog`.
- Owner-set policy that tool calls cannot change: trusted contract, price cap, daily budget, allowed
  resources and a working directory for every file path.

### Minor Changes

- Add bounded shop discovery and client-side catalog search and paging to the SDK, CLI and read-only MCP tools. Keep aliases and deployment profiles in human configuration. Refuse unavailable direct Base routes before wallet setup and restore authenticated, validated seller-key backup import.
- Add hosted sharing through approved shops, durable seller checkpoints and pending backups, browser seller controls, upload signing helpers, and CLI and MCP share commands. Keep NEAR and Solana listings on NEAR and 1Click routes. Preserve retry hints for hosted sharing budget refusals and isolate unavailable third-party shops during discovery.

### Patch Changes

- Expose relayer services and browser sponsorship checks through the supported package entries. Send seller-signed storage requests, share retry handling, and preserve download and registration recovery evidence. Use the Node entrypoint in the MCP server and validate packed package boundaries.

  Report wrong_identity when a funding wallet is not the file's seller. Keep shared CORS defaults empty and scan recent recovery grants first.
- Use one public payment route vocabulary and validated portable receipts. Standardize public errors and preserve relayer recovery accounting.

  Remove the unused sell preview callback and text preview helper.

  Preserve command-specific error guidance and alert on held relayer reconciliation. Remove unused preview verification and seller-key import helpers.
- Check Base sponsorship and split eligibility before signing. Preserve pending Base purchases after expiry and allow an explicit NEAR unlock wallet when resuming with a fresh SDK instance.

  Enforce configured source spending caps, prevent accidental repeat purchases, and retain download and settlement waits across restarts. Automatic download retries and pending-payment polling now stop after at most 60 seconds of total waiting and return the remaining retry hint. Use the same saved purchase when retrying.

  Require a configured origin for agent 1Click purchases. Recover the purchase guard queue after a failed renewal and preserve completed buy results when reservation cleanup fails.
- Hosting lifetime is now the shop's policy. Hosted selling accepts any future publication expiry from the selected shop, or `null` for no planned expiry, instead of refusing expiries more than seven days away. An expiry at or before the current time is still refused with `file_expired`, and malformed values are refused. `Shared.expiresAt` and the browser seller's `view().result.expiresAt` are now `number | null`. Saved completed sales stay readable after their expiry. The browser seller's `quote.hostedDays` comes from the new optional `fileLifetimeDays` option instead of a fixed 7, and is absent when the page does not pass it.
- Validate optional shop rules and expose descriptive text with shop provenance in discovery, catalog and hosted share output.
- Uses `@defdone/annon` 0.1.0-alpha.0.
