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
annon buy offer.json --route 1click --wallet solana --from-chain solana --json
```

`offer.json` is decoded x402 PAYMENT-REQUIRED JSON. Optional `--max-price 0.2` is a decimal
USDC quote bound. A moderated offer requires an explicitly accepted `--moderator account.near`.
The selected signing wallet is the recovery identity; `--recovery kind:id` checks it.
1Click selects the unique source-chain USDC by default. For other tokens or ambiguous
entries, add `--from-asset nep141:EXACT_ASSET_ID`. If the source chain differs from the wallet
family, add `--refund-to SOURCE_CHAIN_ADDRESS`. Return deposit instructions to the user or
their existing wallet: address, source base-unit amount, asset and any memo are all required.
Annon does not automatically fund that deposit.

```sh
annon status 0xPURCHASE_ID --json
annon open 0xPURCHASE_ID --output report.pdf --json
annon open report.pay2 --purchase /private/purchase-backup.json --output report.pdf --json
```

Wait for final acceptance. A 1Click SUCCESS is only delivery, and a submitted Base payment
is not acceptance. After a timeout, preserve encrypted state and check status; another buy
creates another purchase. Key-release retries reuse saved requests, with bounded backoff.
Never infer payment failure from a lost reply. Outputs name files; plaintext is not printed.

Recover on a fresh device using the same recovery wallet and a new local backup secret:

```sh
annon recover --recovery near:alice.near --wallet near --json
annon open /private/recovery-backup.json --url https://host.example/report --output recovered.pdf --json
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
