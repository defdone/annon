---
name: annon
description: Sell, buy, open, recover and verify Annon encrypted files through the annon CLI, using an existing EVM, Solana or NEAR wallet.
---

Use `annon --help` for flags. Configure `ANNON_CONFIG` with the reviewed contract ID, NEAR/Base
RPCs, state directory and optional relayer. In a source checkout, replace `annon` with
`node packages/annon/dist/node/main.js` after `pnpm build`.

Select `ANNON_WALLET=evm|solana|near`. Supply keys through `ANNON_EVM_PRIVATE_KEY`,
`ANNON_SOLANA_KEYPAIR` (64-byte JSON), `ANNON_NEAR_CREDENTIALS` (near-cli-rs JSON), or named
files using `--evm-key-file`, `--solana-key-file`, `--near-key-file`. On macOS, NEAR can use
the near-cli-rs keychain with explicitly selected `--near-account` and `--near-public-key`.
Supply `ANNON_BACKUP_SECRET_FILE` containing a user-held random 32-byte secret as 64 hex
characters. Never put keys in command arguments, skill text, output or source control.

First use requires contract trust. Review the contract, then use `--trust-contract` once;
interactive CLI users can answer its prompt. `--json` is noninteractive. Do not trust a
contract merely because an offer names it. Use a moderator on sell, or accept one on buy,
only with the user's authorization: that moderator can prevent key release.

Commands below assume those env settings. Replace `0xFILE_ID` / `0xPURCHASE_ID` with full
64-hex IDs from JSON results, and the sample identity with the intended public recipient.

```sh
annon sell report.pdf --price 0.2 --split near:alice.near:10000 --output report.pay2 --json
```

`sell` writes ciphertext; arrange hosting separately. Add `--base` only with an EVM wallet
and exclusively EVM split recipients. Splits are `kind:id:bps` entries separated by commas,
totaling 10000; the first recipient receives rounding remainder.

Buy directly with NEAR USDC, via Base x402 with an EVM wallet, or through 1Click:

```sh
annon buy https://host.example/report --route near --wallet near --json
annon buy https://host.example/report --route base --wallet evm --json
annon buy https://host.example/report --route 1click --wallet solana --from-chain solana --json
```

URLs accept HTTPS, and plain HTTP only for `localhost`, `127.0.0.1` or `[::1]`,
for example `http://localhost:8790/file`. This also applies to verify.

Human CLI use may accept decoded x402 PAYMENT-REQUIRED JSON as `offer.json`; agent purchases
refuse offer files. With no `allowedResources`, any HTTPS or HTTP localhost URL is allowed
within mandatory human-configured `maxPrice` and `dailyBudget`. An explicit list restricts
buys to exact URLs or same-origin path prefixes ending in `/*`; an empty list denies all. Every buy requires a human-approved `--max-price 0.2`, `ANNON_MAX_PRICE`, or config
`maxPrice` in decimal USDC. Never derive the cap from the offer or choose it on the user's behalf. An offer file also requires `--url` with the independently selected resource URL. A moderated offer requires an explicitly accepted `--moderator account.near`.
The selected signing wallet is the recovery identity; `--recovery kind:id` checks it.
1Click selects the unique source-chain USDC by default. For other tokens or ambiguous
entries, add `--from-asset nep141:EXACT_ASSET_ID`. If the source chain differs from the wallet
family, add `--refund-to SOURCE_CHAIN_ADDRESS`. Return deposit instructions to the user or
their existing wallet: address, source base-unit amount, asset and any memo are all required.
Annon does not automatically fund that deposit.

```sh
annon status 0xPURCHASE_ID --json
annon open 0xPURCHASE_ID --output report.pdf --json
annon open report.pay2 --purchase purchase-backup.json --output report.pdf --json
```

Waiting: after `submitted`, poll `annon_status` (or `annon status`) about every 30 seconds
until `accepted`, then open. `payment_not_safe` and `pending` mean wait, not failure;
never pay again. For 1Click, fund the deposit first. Base safety usually takes one to three
minutes; a 1Click SUCCESS is only delivery. Preserve encrypted state after a timeout.
Status/open resume a saved paid Base purchase with unlock before its grant-proved download.
Key-release retries reuse saved requests, with bounded backoff. Configure MCP deployment,
trust, wallet sources, moderator trust and price caps in the server environment/config; tools
cannot set or override these.
Never infer payment failure from a lost reply. Outputs name files; plaintext is not printed.
Use the public `payment` result to report the price in decimal USDC (`amountUsdc`) and
base units (`amountBaseUnits`), asset, network and route. For 1Click, `payment.source`
includes the reviewed source amount and asset. Status/open include payment details when saved.
Payment reporting is best-effort: unreadable purchase records omit `payment`; recovery open still needs the secret for its recovery grant.
Top-level `route` is the contract route (`near-usdc`/`base-usdc`); `payment.route` is how the buyer paid (`near`/`base`/`1click`).

Recover on a fresh device using the same recovery wallet and a new local backup secret:

```sh
annon recover --recovery near:alice.near --wallet near --json
annon open recovery-backup.json --url https://host.example/report --output recovered.pdf --json
annon verify report.pay2 --json
annon verify https://host.example/report --json
annon stop 0xFILE_ID --json
```

`recover` returns encrypted backup paths and fresh grant numbers. Local verification checks
header and body; URL verification checks only the public header against the trusted contract.
`stop` permanently ends new sales; use it only when requested.

Read JSON `ok` and `error.code`. Exit 0 means command completion, including deposit-required
results; 1 is operation failure, 2 arguments/config/keys, 3 contract trust required, 4 pending status.
Encrypted records and portable backups live under the configured state directory. Keep both
the state and backup secret private; keep the secret separately from exported backups.


For MCP or CLI agent mode, the operator config must include `maxPrice` and `workDir`.
`ANNON_STATE_DIR` never replaces the configured state directory. Environment price caps can
only lower the config cap; environment resource URLs intersect the config allowlist. Do not
change these settings to get a refused purchase through. MCP tools cannot set deployment,
trust, budget, working directory or credential policy.

Keep `annon_sell.target`/`output` and `annon_open.file`/`output` inside `workDir`. Local
`annon_verify.target`, non-ID `annon_open.target`, and non-ID `annon_open.purchase` backups are
confined too. Verify URLs stay remote and purchase IDs stay identifiers. Relative paths
start there, including the default sell output. The adapter checks real paths and output parents;
`..`, symlink escapes, dangling symlinks and outside paths return `path_not_allowed`. Ask the
operator to place intended inputs inside the directory; do not bypass the refusal. Only a
launcher with `ANNON_AGENT=true` can use `ANNON_WORK_DIR`; it also pins the home config.
MCP is the policy boundary. A shell agent with the same OS user is not contained by this policy,
since it can edit configuration or invoke another client.

For `payment_not_safe`, retain the purchase and return its wait guidance immediately in agent,
JSON and status flows. Human open retries honor `Retry-After` as a minimum within the bounded
wait policy. The client checks the relayer's sponsorship floor before a Base payment.

For self-funded NEAR sales, a human may choose `--storage-budget <NEAR>` or configure
`storageBudget`. Agents and MCP must take that value only from human configuration.
Sponsored sell uses the relayer allocation and required treasury split; report the resulting
`terms` to the seller. Rounding goes to an original non-treasury recipient. Do not
silently remove treasury recipients to fit the eight-recipient limit.

Read `annon budget 0xFILE_ID --json` before advertising NEAR or 1Click sales. A human can
allocate nonwithdrawable NEAR with `annon fund 0xFILE_ID 0.05 --wallet near --json`.
MCP offers read-only `annon_budget`. Funding is human-only, refused in agent mode,
and is not exposed as an MCP tool. Do not work around `human_only`.
`maxProtocolFee` defaults to 0.03 USDC plus 100 bps; agent/MCP sells refuse higher
advertised fees with `protocol_fee_above_max`. Only human configuration can change it.
Encoded URL path separators `%2f` and `%5c` are refused in agent mode.
A buy returning `file_storage_low` has not paid. Ask the sponsor to fund the file or report
the refusal; do not bypass preflight. Base unlock and existing recovery do not depend on
the file budget.

Sell funding is allocated once. After a lost funding response, inspect the transaction and
use explicit funding if needed before resume; do not automatically replenish a spent budget.
