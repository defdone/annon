# annon CLI

Build with `pnpm build`. The `@defdone/annon` package ships the `annon` bin;
in this checkout run `node packages/annon/dist/node/main.js` in its place.
Run `annon --help` for all flags. All commands return JSON; `--json` uses one compact
JSON line and disables interactive prompts. Success is `{ "ok": true, "result": ... }`;
errors are `{ "ok": false, "error": { "code": ..., "message": ... } }`.

Create a public configuration file and name it with `--config /path/config.json` or
`ANNON_CONFIG`. The default is `~/.config/annon/config.json`:

```json
{
  "contractId": "your-reviewed-contract.near",
  "network": "near:mainnet",
  "nearRpc": "https://rpc.mainnet.fastnear.com",
  "baseRpc": "https://base.example/rpc-with-key",
  "stateDir": "/absolute/private/annon-state",
  "relayer": "https://your-reviewed-relayer.example",
  "maxPrice": "0.2"
}
```

Contract ID and NEAR RPC must be supplied by human configuration or CLI flags for contract operations. Browser login alone uses a public RPC default for ownership verification. Base RPC is required only for Base purchases, Base listing creation and resuming Base unlock. NEAR-only verify/status and purchases need no Base RPC. No deployment is implicitly trusted. The first interactive command asks whether you trust
the configured contract to release file keys. `--trust-contract` records explicit trust
without a prompt. Trust is keyed by network, NEAR RPC and contract; changing any requires
new trust. An offer cannot select a different contract. MCP shares the trust store. For a server, human configuration may set `trustContract: true` or `ANNON_TRUST_CONTRACT=true`; tool calls cannot grant trust.

Flags override environment variables, which override config. Config fields have matching
`ANNON_CONTRACT_ID`, `ANNON_NETWORK`, `ANNON_NEAR_RPC`, `ANNON_BASE_RPC`,
`ANNON_STATE_DIR`, and `ANNON_RELAYER` variables. Endpoints use HTTPS; HTTP is allowed
only on localhost. Endpoint URLs cannot contain credentials or query parameters.
The relayer is optional when a NEAR wallet submits transactions. Direct register/reopen
calls use the caller's prepaid contract storage balance; fund it using the deployment's
storage interface before selling or recovering. The SDK exports `storageDeposit(wallet, contractId, amountYocto)`; choose the amount explicitly. Insufficient storage is reported as `storage_required`.

## Keys and saved purchases

Use `annon login` for per-action browser wallet approval, or `annon init --agent` for key references, remote signing and a persisted daily budget. See [README.md](README.md) for login, `--no-open`, `--signer`, keychain creation and the HTTP signer contract. The legacy explicit local-key sources below remain available. No key discovery occurs.

Select `--wallet evm|solana|near` or `ANNON_WALLET`. Local key values are accepted from environment variables or explicitly named files:

| Wallet | Environment | Named file flag / environment |
| --- | --- | --- |
| EVM | `ANNON_EVM_PRIVATE_KEY`: `0x` and 64 hex digits | `--evm-key-file` / `ANNON_EVM_KEY_FILE`, containing that text |
| Solana | `ANNON_SOLANA_KEYPAIR`: JSON array of 64 bytes | `--solana-key-file` / `ANNON_SOLANA_KEY_FILE`, standard Solana keypair JSON |
| NEAR | `ANNON_NEAR_CREDENTIALS`: credential JSON | `--near-key-file` / `ANNON_NEAR_KEY_FILE`, near-cli-rs credential JSON with `account_id`, `public_key`, `private_key` (ed25519) |

NEAR files may omit `account_id` when `--near-account` / `ANNON_NEAR_ACCOUNT` supplies it.
On macOS, with no NEAR file or credential env value, explicitly select both
`--near-account alice.near --near-public-key ed25519:PUBLIC_KEY` (or `ANNON_NEAR_ACCOUNT`,
`ANNON_NEAR_PUBLIC_KEY`) to read the near-cli-rs native keychain entry:
service `near-mainnet-alice.near`, account `alice.near:ed25519:PUBLIC_KEY`.
Other platforms use the credential JSON file or environment. No keychain enumeration occurs.

Sell, buy, open, recover and stop also require a user-held random 32-byte backup secret,
encoded as 64 lowercase hex characters in `ANNON_BACKUP_SECRET`, or in the file named by
`--backup-secret-file` / `ANNON_BACKUP_SECRET_FILE`. Create it with a cryptographic random
generator and keep it outside the repository. It is never derived from a wallet signature.
`verify` and accepted/read-only `status` need neither a wallet nor this secret. A pending Base `status` with saved state and a backup secret may send `unlock` through the configured relayer or NEAR wallet. Status can update encrypted local state and backups: expired/canceled Base payments are marked with `paymentState`, preserving the purchase, attempts and recovery key. It never deletes the purchase record.

State directories are created with mode 0700 and records/outputs with 0600. Keep existing
state directories private. Purchases and recovery grants are encrypted by the SDK; portable
encrypted backups are under `stateDir/backups`. Public headers and resource URLs are saved
separately for later downloading. Preserve state after timeouts. Losing local state does not
lose recovery rights: the same recovery wallet can create a fresh grant on a new device with
a new backup secret. Keys, signed payment payloads and decrypted file contents are never
returned in CLI/MCP results. Plaintext is written only to the explicitly named output.

## Commands

Identity syntax is `evm:0xADDRESS`, `solana:BASE58_OR_HEX`, or `near:account.near`.
Prices are decimal USDC with at most six decimals. Splits use integer basis points,
totaling 10000. The first split recipient gets the rounding remainder.

```sh
annon sell report.pdf --price 0.2 --split near:alice.near:10000 --wallet near --output report.pay2
annon sell report.pdf --resume 0xFILE_ID --wallet near --output resumed.pay2
annon sell report.pdf --price 0.2 --split evm:0x1111111111111111111111111111111111111111:10000 --wallet evm --base
annon buy https://host.example/report --route near --wallet near
annon buy offer.json --url https://host.example/report --route base --wallet evm --max-price 0.2
annon buy https://host.example/report --route 1click --wallet solana --from-chain solana
annon status 0xPURCHASE_ID --json
annon open 0xPURCHASE_ID --output report.pdf
annon open report.pay2 --purchase /private/purchase-backup.json --output report.pdf
annon recover --recovery near:alice.near --wallet near --json
annon open /private/recovery-backup.json --url https://host.example/report --output recovered.pdf
annon verify report.pay2 --json
annon verify https://host.example/report --json
annon stop 0xFILE_ID --wallet near
```

IDs in these commands are placeholders for full `0x` plus 64 lowercase hex digits.
`sell` creates a PAY2 file; arrange hosting separately. `buy` accepts the HTTPS resource URL
or a named file containing decoded x402 `PAYMENT-REQUIRED` JSON. An offer file requires `--url` with the independently selected resource URL; it must match the offer. It checks the public header
and registered terms before the SDK authorizes payment. Every buy requires `--max-price`, `ANNON_MAX_PRICE` or config `maxPrice` (decimal USDC); the offer never supplies the cap. A configured cap also bounds an explicit flag. The default route is direct NEAR for
a NEAR wallet, 1Click when `--from-chain` is given, otherwise Base for an EVM wallet.
Explicit Base fails if that route or a funded EOA is unavailable; it never silently chooses
another payment route. Each invocation of buy creates a purchase: after an uncertain reply,
retain the saved backup and check status rather than buying again.

1Click accepts `--from-chain solana` or `sol` (ID `sol`), `ethereum` or `eth` (ID `eth`),
`arbitrum`/`arb`, `polygon`/`pol`, `optimism`/`op`, `avalanche`/`avax`, and `berachain`/`bera`.
Other chain IDs pass through unchanged. EVM refund defaults use `eth`, `base`, `arb`, `pol`, `op`,
`avax`, `bsc`, `gnosis`, `bera`, `scroll`, `monad`, `xlayer`, `abs`, and `plasma`.
The optional
`--from-asset` (the exact `nep141:` asset ID). Without an asset it selects the unique USDC
entry for that blockchain in 1Click's token list. Symbols such as `sUSDC` are not USDC matches. For BTC, other tokens, or ambiguous USDC
entries, specify `--from-asset`. `--refund-to` must name a refund address on the source
chain; it defaults to the selected wallet's address only when the chain family matches.
These also have `ANNON_FROM_CHAIN`, `ANNON_FROM_ASSET`, `ANNON_REFUND_TO` equivalents. Only
`--from-chain` or `--origin` selects 1Click automatically: with `ANNON_FROM_CHAIN`, name
`--route 1click` explicitly, or a NEAR wallet pays directly on NEAR.
Human configuration can define named `origins`, for example `{"base-usdc":{"fromChain":"base","fromAsset":"nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near"}}`, or the same JSON in `ANNON_ORIGINS`. Select one with `--origin base-usdc`. Each may specify `refundTo`; otherwise the configured `ANNON_REFUND_TO` or matching wallet address is used.

For a human 1Click purchase, the SDK saves the live EXACT_OUTPUT quote and encrypted purchase record before confirmation. The terms show the source chain, asset, symbol and token contract when known, input amount in human and base units, and deposit cutoff. No funds are sent by quoting or confirming these instructions. Recovery proof follows review. Declining buys nothing and leaves an unpaid encrypted purchase record. The same live quote supplies the returned instructions. After review and recovery proof, at least ten minutes must remain before the deposit cutoff, otherwise the CLI returns `quote_expired`: "The 1Click quote expired. Run buy again." Human terminal mode requires a prompt before requesting a quote. Explicit assets bypass token lookup; human units then use the quote's formatted amount when available.

Successful CLI JSON and agent results also include `source` with `chain`, `asset`, `amount`, `amountFormatted` when known, and `depositBefore`, plus available symbol, decimals and contract metadata. JSON and agent modes do not add an interactive prompt. A 1Click failure before deposit instructions return releases the agent budget reservation; returning instructions keeps it reserved.

The result includes `instructions.address`, `amount` in source token base units, `asset`,
`chain`, optional `memo`, and `qrData`. Fund these externally with the wallet you already use.
Never omit a required memo. `instructions.depositBefore` is the cutoff for a **confirmed** deposit;
`purchaseExpiresAt` is the later contract delivery deadline. The SDK reserves ten minutes between them,
refuses insufficient windows or a swap estimate longer than that buffer, and checks the entire echoed
quote request. Origin-chain confirmation time must fit before `depositBefore`; an estimate is not a
settlement guarantee. Do not deposit after that cutoff even if the service address stays active.
The three recorded quotes return an address-inactivity `quote.deadline` 72 hours after the echoed
request deadline. That extension must not extend the buyer's cutoff or contract purchase expiry.
The [1Click OpenAPI](https://1click.chaindefuser.com/docs/v0/openapi.yaml) describes request `deadline`
as the start of refund handling, response `deadline` as address inactivity, and `timeEstimate` as
execution time after deposit confirmation. Late delivery can be refused by Annon; service SUCCESS
alone does not prove acceptance. `status` resumes a saved paid Base purchase by requesting unlock, then checks final NEAR acceptance. An unsafe payment returns `payment_not_safe` immediately with exit code 4 (pending); 1Click SUCCESS alone
does not grant access.

The signing wallet is also the recovery identity. With a local key named on the command line,
`--recovery kind:id` on buy checks that identity against it. With a configured signer (file,
environment, browser or remote), recovery uses `signer.identity` and `--recovery` is not currently
enforced against it: check the saved public identity before buying. Refunds from Annon itself go to that
wallet's Intents identity; 1Click source-chain refunds use `--refund-to`.
For moderated files, pass `--moderator account.near` on buy only after deciding to trust
that moderator, who can block release. A seller sets it with the same flag on sell.

`open` accepts a saved purchase ID, encrypted purchase/recovery backup, or a local PAY2 file
with `--purchase`. It uses saved resource metadata or `--file`/`--url`, then SDK grant proofs
and authenticated decryption. New-device recovery may require `--url` or a local PAY2 file.
Existing output files are never overwritten. `verify` checks a local file's header and body;
a URL checks only its public header. Verification does not prove future host availability.

Opening a Base purchase requests unlock before the grant-proved download. It also resends its saved signed payload with the download when present;
it does not create a fresh payment authorization after a lost reply.

Key release transport timeout retries are bounded to three attempts with backoff, using the same
unlock/reopen/claim request. In-flight relayer replies (`202` pending, or a legacy duplicate `409`)
are polled every five seconds for at most three minutes. A known transaction hash is retained
across outcome timeouts, so it is looked up without reposting. If still pending, retain state and retry. Registration, transfers and payment authorization are never
blindly retried. Raw upstream errors are intentionally suppressed to avoid leaking secrets.

| Exit | Meaning |
| --- | --- |
| 0 | Command completed; buy may still require a deposit or settlement |
| 1 | Operation failed; inspect final status and retained encrypted state before retrying |
| 2 | Invalid arguments, configuration, wallet source or missing local input |
| 3 | First-use contract trust required or declined |
| 4 | `status` reports pending; acceptance has not been observed (not proof of payment failure) |

## SDK seller resume and CKD configuration

`sell` saves an encrypted sell job and portable backup before registration. Retain the original
plaintext and its file ID; `sdk.resumeSell({ fileId, data, seller, publish })` reconstructs the
same ciphertext, checks the registered commitment, and completes header publication/hosting.
It uses `reopenSeller` if registration landed without a usable CKD response, and retains the
CKD secret in the encrypted job only for publication retries. After publication, the saved job and its current
portable backup contain public terms/metadata and a `published` marker, with `fileKey`,
`sellerSecret` and `ckdSecret` cleared. Seller one-time keys are cleared from their records and
current backups after the CKD response is opened. Recovery of a published listing needs control of the registered seller
wallet and the existing PAY2 ciphertext; request a fresh CKD response with `reopenSeller` to open
that file. Before publication, resume requires the original plaintext and the pending sell job.
Plaintext alone can create a new listing, but cannot reproduce the old ciphertext after cleanup. A published job cannot recreate ciphertext using a retained file key. User-made
backup copies and external backup history cannot be erased by the SDK; remove obsolete pre-publication
copies if this retention policy matters to you. `sdk.reopenSeller({ fileId, seller })`
also works on a fresh device and backs up its new one-time key before the call. These are SDK
methods; the CLI exposes `sell original.pdf --resume 0xFILE_ID`, and MCP exposes
`annon_sell` with `target` and `resume`. A failure after saving the registration job reports `fileId`
in the safe error so it can be resumed without inspecting backups. Base split creation occurs before the
saved registration job, so a failed split deployment still needs separate reconciliation.

The SDK reads `get_config.mpc` and `ckd_domain`, then that account's `public_key` at finality.
An optional human `mpcKey` / `ANNON_MPC_KEY` pins the observed value and fails closed on a
mismatch. The low-level `openAnswer` requires this key explicitly; it has no mainnet default.
Recovery isolates failures per purchase in batch mode and returns safe `errors` in CLI/MCP.
An expired pending reopen without a final grant gets a new backed-up key, nonce and deadline;
the preceding revision remains in an encrypted revision backup.

Agent policy applies when the pinned config has `agent: true`, the launcher sets
`ANNON_AGENT=true`, or the MCP adapter forces it. Agent config must contain a decimal USDC
`maxPrice`, even when the launcher supplies an environment cap. Per-call `--contract-id`,
`--near-rpc`, `--base-rpc`, `--relayer`, `--network`, `--trust-contract`, `--moderator`,
`--max-price`, `--state-dir` and alternate config paths are refused. Init and login are refused
once agent policy is active. Buy targets must be secure URLs; local offer files are refused.
Offer header URLs must share the advertised resource origin in every mode.

In every agent mode, `ANNON_STATE_DIR` is ignored; the config owns `stateDir` and its budget
ledger. Config `maxPrice` is required. If `ANNON_MAX_PRICE` is present, the effective cap is the
smaller of environment and config. Absent `allowedResources` permits any HTTPS URL or HTTP localhost URL within mandatory
`maxPrice` and `dailyBudget`. An explicit empty list denies every URL. Entries may be exact
URLs or path prefixes ending in `/*`, on the same origin and port. Prefixes cannot cross
path boundaries or authorize another origin. `ANNON_ALLOWED_RESOURCES`, when present,
further restricts the effective list, including when config leaves it open.
These environment settings can only tighten policy, regardless of the agent-mode trigger.
Deployment and trust overrides (`ANNON_CONTRACT_ID`, `ANNON_NETWORK`, `ANNON_NEAR_RPC`,
`ANNON_BASE_RPC`, `ANNON_RELAYER`, `ANNON_TRUST_CONTRACT`, `ANNON_MODERATORS`,
`ANNON_MPC_KEY` and `ANNON_ORIGINS`) are ignored in agent mode unless the launcher explicitly
sets `ANNON_AGENT=true`. In that explicit mode, the launcher owns those values.
The resource allowlist applies to `open --url` and to saved download URLs too.
If the home config enables agent mode, an alternate `ANNON_CONFIG` is refused. Use
`ANNON_AGENT=true` or the MCP launcher to keep agent mode enabled independently of config contents.

For a 1Click USDC source, price and daily limits apply to the quoted source amount, including
its quoted fees. Every configured origin must set `usdcDecimals` to declare its source USDC
precision or `maxSourceAmount` to cap its source base units. Token catalog decimals do not set
spending policy.
For other assets, configure `maxSourceAmount` on that origin in source base units; the quoted
amount must fit it. The destination USDC amount still counts toward the daily USDC budget.
Quotes without enough source policy are refused before deposit instructions are released.

A saved live or accepted purchase blocks another buy of that file. Resume its status and open
it using its purchase ID. Use `buy --force` only when you explicitly want another purchase.
A supplied `--recovery` must match the configured signer.
Base purchases check the trusted relayer's eligibility decision and registered split before signing.

Completed-download cooldowns return `download_limited` and `retryAfterSeconds` immediately.
Other host overloads retry within a total automatic wait of 60 seconds. When the next wait would
exceed that budget, the full remaining hint is returned. CLI JSON includes the error and exit code 4;
human output states the wait. MCP stores download and settlement waits locally and refuses repeat
requests until they elapse, including after restart. Wait, then reuse the same purchase and output
path. Buying again to bypass a wait spends money unnecessarily.

Agent mode also requires a human-set `workDir`. Relative `sell.target`/`output` and
`open.file`/`output` paths start there. Local `verify` targets, non-ID `open` targets and
non-ID `open --purchase` backup paths also start there. Verify URLs and purchase IDs retain
their existing meanings. Canonical paths must stay inside it, including symlink
targets and parents of new outputs; parent traversal (`..`) is refused with `path_not_allowed`.
The sell default output is checked too. `ANNON_WORK_DIR` is accepted only when the launcher
explicitly sets `ANNON_AGENT=true`. That flag also pins the config to
`~/.config/annon/config.json`; a different `ANNON_CONFIG` is an error.

MCP is the policy boundary: tools cannot replace the operator config, environment or credentials.
A shell agent running as the same OS user is not contained by these checks; it can edit that
user's files or run another client. Configure process and OS permissions for that threat model.
Browser opener processes receive only executable lookup and desktop routing variables, including
`BROWSER`, desktop session identifiers and `LANG`, excluding signing and backup credentials.

Relayer HTTP 429 and 503 responses with short `Retry-After` delays are retried at most three
times. Delays above 60 seconds return `relayer_rate_limited` or `relayer_unavailable` immediately.
HTTP 425 always keeps `payment_not_safe` guidance: agents, JSON and status return immediately;
human open retries at 10, 20, 30, 40 and 60 seconds, with `Retry-After` as a minimum. A hint above
60 seconds returns immediately for later resumption. Keep the saved purchase and never pay again.
Before a Base payment through a configured relayer, the client checks its advertised contract,
unlock support, disabled state and minimum sponsored price.

A final unlock CKD answer can supply the first open using exactly the same final-grant and MPC
pairing verification as `claim_key`. An optional configured MPC pin remains enforced, but is not
required for this optimization. Missing or invalid answers fall back to verified `claim_key`.

Streaming sell/open accepts regular files only, refusing FIFOs; long output basenames can exceed the filesystem name limit because temporary files append a random suffix. Local verify still buffers the file.
Interrupted processes may leave private `.tmp` plaintext files or `.annon-spool-*` encrypted directories beside the output; remove these leftovers before retrying.
Outputs are published with a hard link, so the output directory must be on a filesystem that supports hard links (not exFAT or FAT32, and not some network or FUSE mounts); otherwise the final step fails with no output written.

## Purchase storage and sponsored splits

Self-funded NEAR sellers can use `annon sell <file> --price <USDC> --split <split>
--storage-budget 0.05`. The budget is NEAR, separate from registration storage and from
the signed terms. Registration is followed by explicit wallet funding before publication.
A definite funding refusal clears the uncertainty state and can be retried on resume.
Saved sell jobs record funding intent before sending and never automatically replenish
a completed or uncertain allocation. After uncertainty, inspect the transaction and explicitly
fund with `annon fund` if needed; resume requires the configured target to be available
before accepting that uncertain allocation as resolved. The human config field `storageBudget` supplies the same decimal-NEAR
target. In agent/MCP mode it is the only source; per-call storage funding overrides are
refused. Sponsored registrations use the relayer allocation instead.

`annon fund <file-id> <NEAR>` allocates nonwithdrawable NEAR using a NEAR wallet.
`annon budget <file-id>` reads available yoctoNEAR and the admission requirement.
After an uncertain funding result, check the file's storage balance with `annon budget <file-id>` before funding again; a new run is a new allocation.
Funding is human-only: agent mode refuses `fund` with `human_only`, and MCP exposes
no funding tool. `--storage-budget` requires a self-registered NEAR sale; other routes
refuse the flag. Self-registered sales without an allocation return a warning.
The SDK exports `fundFileStorage(wallet, contract, fileId, amountYocto, prepaid?)`
and `fileStorageBalance(rpc, contract, fileId)`; zero-attachment prepaid funding can spend
only the caller's own prepaid balance.

NEAR and 1Click buy preflight refuses before payment with `file_storage_low` if the
file cannot cover the 4,096-byte admission allowance. The contract checks again at receipt;
preflight cannot reserve capacity. Base unlock stays caller-funded and needs no file budget.
Existing claims and recovery continue after a file budget is depleted.

Sponsored sell obtains the relayer fee and treasuries from `/v1/capabilities`, adds the
required treasury share and proportionally scales the other shares. Base listings use
one EVM treasury share at the larger route requirement. Rounding goes to an original
non-treasury recipient; the treasury share rounds up by less than one basis point. Interactive CLI asks approval of the resulting split
before registering or creating a Base split. Config `maxProtocolFee` defaults to
`{ "fixed": "30000", "bps": 100 }` (0.03 USDC plus 100 bps); `fixed` is USDC base units.
JSON, agent and MCP sells refuse higher advertised fees with `protocol_fee_above_max`.
Interactive CLI shows the advertised fee and whether it exceeds the ceiling before
approval. Agent URL paths refuse `%2f` and `%5c`, case-insensitively.
JSON/agent modes return the resulting split in `terms`.
Self-funded listings have no compulsory protocol fee. An eight-recipient split needs a
free slot or an existing treasury recipient before sponsorship can add a treasury.

## Shop discovery

Use discovery before configuring a wallet or contract:

```sh
annon shops
annon shop add https://shop.example/demo --id example
annon catalog --shop example --search notes --limit 20 --offset 0
```

`shop add` saves a local alias for the canonical `/.well-known/annon-shop.json` URL. It grants no deployment trust. Configure `shopDirectoryUrl` to read a directory; no directory is selected by default. Local `shops` and optional `defaultShop` belong to the human configuration and cannot be changed by remote documents.

```json
{
  "shopDirectoryUrl": "https://directory.example/shops.json",
  "shops": [
    {
      "id": "example",
      "manifest": "https://shop.example/.well-known/annon-shop.json"
    }
  ],
  "defaultShop": "example"
}
```

Both listing and catalog results contain `items`, `total`, and `nextOffset` (`null` at the end). Search matches name, title and description without case sensitivity. Catalogs sort by newest creation time, then file ID; limits default to 20 and accept 1 through 100. Offsets are nonnegative integers.

Discovery uses HTTPS, omits credentials, rejects redirects and times out after 10 seconds. Limits are 64 KiB per manifest, 256 KiB and 100 shops per directory, and 8 MiB and 10000 entries per catalog. An oversized response fails with `too_large` without partial results.

For a reviewed deployment, a human can add `profile` to a local shop with `network`, `contract`, `nearRpc`, `baseRpc`, `relayer`, and `host`. RPC URLs and service origins come from that local profile. Manifest deployment changes fail with `config_conflict`. Discovery information does not authorize a purchase. Buy a catalog entry using its resource `url` through the normal `annon buy` workflow, which independently verifies the configured deployment, final chain terms, header and price.
