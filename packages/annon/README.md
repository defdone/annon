# @defdone/annon

The Annon SDK and the `annon` command line tool. A seller encrypts a file into PAY2 and registers
its terms on the Annon contract on NEAR. A buyer pays in USDC on NEAR, on Base through x402, or from
another chain through NEAR Intents, and the contract releases the file key to the buyer alone. The
SDK runs in Node.js and in browsers; the CLI is built on it for developers and agents. People buying
files in a browser should use the browser purchase flow.

Protocol overview: the [repository README](https://github.com/defdone/annon/blob/master/README.md).
Walkthroughs: [buying](https://github.com/defdone/annon/blob/master/docs/quickstart.md),
[selling](https://github.com/defdone/annon/blob/master/docs/selling.md) and
[agents](https://github.com/defdone/annon/blob/master/docs/agents.md). Command reference:
[CLI.md](CLI.md). Security model and known limits:
[SECURITY.md](https://github.com/defdone/annon/blob/master/SECURITY.md).

The SDK and CLI have no usage fees or daily upload or sales quotas. Shops set their own hosting and
sponsorship limits ([shops and limits](https://github.com/defdone/annon/blob/master/docs/shops-and-limits.md)).

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Browser purchases](#browser-purchases)
- [Hosted selling](#hosted-selling)
- [CLI browser wallet login](#cli-browser-wallet-login)
- [Agent initialization and spending policy](#agent-initialization-and-spending-policy)
- [Remote signer, HTTP JSON v1](#remote-signer-http-json-v1)
- [Durable keeper](#durable-keeper)
- [RPC configuration](#rpc-configuration)
- [Base splits](#base-splits)
- [Previews](#previews)
- [Security notes](#security-notes)

## Install

Node.js 22 or newer. The package is on the npm `alpha` tag.

```sh
npm i @defdone/annon@alpha        # the SDK
npm i -g @defdone/annon@alpha     # the annon CLI
```

| Entry point | Use |
| --- | --- |
| `@defdone/annon` | SDK core: `Annon`, wallets, identities, terms, 1Click, encrypted stores and backups, storage funding, sponsorship checks and types, size/retry limits, error classes |
| `@defdone/annon/browser` | Browser purchase controller, downloads, wallet adapters, sponsorship checks and types, size/retry limits, error classes |
| `@defdone/annon/browser/purchase-bundle.js` | The same browser entry as one standalone ESM bundle |
| `@defdone/annon/node` | Node only: `createAdapter` (the engine behind the CLI and the MCP server), `publicError`, `AdapterError`, `BudgetError` |
| `@defdone/annon/relay` | Relayer admission, durable sponsorship and settlement: `relay`, `RelayLedger`, `keep` and their types |
| `@defdone/annon/pay/store-node` | `fileStore`, a durable file-backed record store for Node |
| `@defdone/annon/node/signer-mock` | `signerMock`, the reference signing handler for tests |
| `@defdone/annon/pay/seller`, `pay/settle`, `pay/store`, `pay/split`, `download/host`, `download/http`, `envelope/pay2`, `near/rpc` | Building blocks for a server that sells files: x402 offers and payment checks, settlement, record stores, revenue splits, grant downloads, the PAY2 format and NEAR RPC reads |
| `@defdone/annon/node/adapter`, `node/cli`, `node/errors` | Deprecated: use `@defdone/annon/node` |

### From source

Build with `pnpm build`. In a checkout, run `node packages/annon/dist/node/main.js` in place of
`annon`. Running the source with a TypeScript runner reads the generated
`dist/browser/login-bundle.js`, so run `pnpm --filter @defdone/annon build` first; without the bundle,
`annon login` prints that build instruction.

## Quick start

The shortest path is the CLI: [docs/quickstart.md](https://github.com/defdone/annon/blob/master/docs/quickstart.md)
buys, opens and recovers a demo file in a few commands, and [CLI.md](CLI.md) covers configuration,
encrypted purchase backups and every command.

In code, an `Annon` instance needs a deployment, a durable record store, a persisted backup secret, a
place to write encrypted backups, and a transport for contract calls. In Node, with a NEAR account
that signs its own calls:

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Annon, nearKeyPairWallet, storageDeposit } from '@defdone/annon';
import { fileStore } from '@defdone/annon/pay/store-node';

const contractId = 'v1.annon.defdone.near';
const stateDir = '/absolute/private/annon-state';
const backups = join(stateDir, 'backups');
for (const dir of [join(stateDir, 'records'), backups])
  await mkdir(dir, { recursive: true, mode: 0o700 });

// 64 hex characters (32 random bytes), created once with a cryptographic generator and kept
// outside the repository. Records and backups are unreadable without it.
const backupSecret = Buffer.from(
  (await readFile('/absolute/private/annon-backup-secret', 'utf8')).trim(),
  'hex',
);

// `account` is a near-api-js Account for your NEAR account.
const near = nearKeyPairWallet(account);

const annon = new Annon({
  contractId,
  network: 'near:mainnet',
  nearRpc: 'https://rpc.mainnet.fastnear.com',
  baseRpc: process.env.BASE_RPC!, // an endpoint with an API key, see RPC configuration
  rawStore: fileStore(join(stateDir, 'records')),
  backupSecret,
  writeBackup: (name, encrypted) =>
    writeFile(join(backups, encodeURIComponent(name)), encrypted, { mode: 0o600 }),
  // Contract calls (register, claim_key, reopen and others) are signed by the call's NEAR owner,
  // or by your account when the caller is not a NEAR wallet.
  send: (method, args, owner) => (owner ?? near).call({ receiverId: contractId, method, args }),
});

// Direct calls use your prepaid storage balance on the contract. Fund it once, with an amount you
// choose (yoctoNEAR); insufficient storage is reported as `storage_required`.
await storageDeposit(near, contractId, 100_000_000_000_000_000_000_000n);
```

`annon.sell`, `annon.buy`, `annon.open`, `annon.openTo` and `annon.recover` then drive listings and
purchases with the wallet you pass in (`evmWallet`, `solanaWallet`, `nearKeyPairWallet`,
`nearSelectorWallet`). Without `send`, a call whose signer is not a NEAR wallet fails with
"configure a transaction transport for relayed calls".

For sponsored calls through a relayer instead of your own NEAR account, `send` posts to the
relayer's `/v1/relay` endpoint and waits for its result. The CLI implements that transport in
[`packages/annon/src/node/relay-transport.ts`](https://github.com/defdone/annon/blob/master/packages/annon/src/node/relay-transport.ts).
Its adapter,
[`packages/annon/src/node/core-adapter.ts`](https://github.com/defdone/annon/blob/master/packages/annon/src/node/core-adapter.ts),
and the command modules it calls are the complete reference integration, including trust, prompts
and backups.

## Browser purchases

Import the headless purchase controller from `@defdone/annon/browser`. A seller or marketplace
supplies its own screen, a verified offer and wallet adapters. There is no hosted checkout.
`dist/browser/purchase-bundle.js` is built with the same CSP checks as the CLI approval bridge.

```ts
import {
  browserAnnon,
  browserEvmWallet,
  browserPurchaseStorage,
  BrowserPurchaseController,
} from '@defdone/annon/browser';

const storage = await browserPurchaseStorage();
const sdk = browserAnnon(storage, trustedSdkOptions);
const controller = await BrowserPurchaseController.create({ storage, sdk }, {
  id: stableCheckoutId,
  fileId,
  header: checkedHeader,
  resourceUrl,
  route: '1click',
  maxPrice: approvedUsdcCap,
});
controller.subscribe(renderProgress);
await controller.start({ recovery: recoveryWallet, refund: refundIdentity, origin });
const instructions = await controller.instructions();

// Later, once the purchase is accepted:
const { meta, data } = await controller.open({ onProgress: renderDownload });
```

### Checkouts, reloads and tabs

- Use a stable, caller-owned checkout ID for each terms review. Creation refuses an existing ID.
- `route` is `'near'`, `'base'` or `'1click'`, the same names as in CLI and MCP results. Offer
  `'base'` only when the file's final on-chain terms include a Base payee; otherwise the SDK refuses
  it with `route_unavailable` before any wallet step. For a file without Base terms, a buyer holding
  USDC on Base uses `'1click'` with Base as the source chain.
- After a reload, construct `new BrowserPurchaseController({ storage, sdk, id })` and call
  `resume()`. Never call `buy()` or create another checkout to resume an uncertain payment.
- `storage.list()` supplies the purchases list.
- A renewable two-minute lease protects an active checkout across tabs. `poll`, `recover` and `open`
  refuse a live lease held by another tab with `PurchaseLeaseBusy` (code `lease_busy`, with
  `waitUntil`); `resume` returns without writing. `snapshot()` and progress events carry
  `leaseWaitUntil` (Unix seconds) so the page can say why it is waiting, for example after a crashed
  tab.
- After an expired lease, an unsigned preparation that never reached the payment boundary becomes
  `abandoned`; the UI may then explicitly create a fresh checkout ID. Signed Base payloads and
  purchases that crossed the payment boundary remain resumable and must never be replaced.
- Base starts require `submitBase`. Signed payloads become uncertain before the SDK dry run.
- `snapshot()` and progress events contain public metadata only; persistence records contain private
  recovery material.
- `instructions()` releases only a saved, proved 1Click quote with the required time margin.

### Paying from another chain (1Click)

- Use `OneClick.tokens()` and `originFromToken(tokens, assetId, blockchain, refundTo)` for exact
  source selection. Supported sources are the explicitly listed EVM chains, Solana and NEAR.
- Catalog selection refuses unsupported families and slow chains. Legacy caller-specified origins in
  the other family keep the existing nonempty, whitespace-free refund validation.
- NEAR catalog selections explicitly request `ORIGIN_CHAIN` refunds. Legacy direct `quote()` callers
  keep their existing NEAR `INTENTS` default.
- A 1Click source refund and an Annon rejection refund are different obligations. The latter stays
  in NEAR Intents.
- `OneClick.preview()` returns amounts and timing without a deposit address.
- `poll()` awaits progress callbacks, saves memo-aware checkpoints and retries transport errors and
  rate limits with backoff. The controller persists checkpoints automatically.
- Polling remains available after expiry to track late deposits and refunds. Expiry never extends
  the purchase or permits a new deposit. `SUCCESS` still requires contract acceptance.

### Storage and receipts

- Each checkout is stored in its own encrypted IndexedDB record, with a small metadata index
  committed atomically alongside it. Index contention retries without weakening purchase revision
  checks.
- Latest purchase and recovery snapshots are kept alongside every recovery revision archive created
  before an expired key is replaced. Portable receipts carry those archives too.
- The local random backup secret is persisted in IndexedDB for reload recovery. It protects
  encrypted storage from accidental disclosure and shares the embedding page's trust boundary.
- Export with `controller.exportReceipt(portableSecret)`, using a separate random 32-byte
  `newBackupSecret()` that you keep separately. Import with
  `storage.importReceipt(file, portableSecret)`. Import restores the header, resource URL and
  recovery records, and requires a fresh recovery proof before releasing deposit instructions.
- IndexedDB failures and stale writes reject before any payment effect.

### Downloading and opening

- `recover(wallet)` resumes recovery of an accepted purchase on a new device.
- `open()` downloads the PAY2 file from the saved resource URL with the buyer's grant proof. It
  checks the header against the one pinned before payment and each chunk against that header while
  downloading; the SDK then checks the on-chain listing and grant before it decrypts in memory.
  `open(bytes)` opens a PAY2 file the page already has.
- The result is `{ meta, data }`. Plaintext and file keys are never written to storage; the record
  only moves to `file_ready`.
- Every path caps a file at 50 MB of plaintext (`MAX_PLAINTEXT_BYTES`, 50,000,000 bytes). The
  download cap `BROWSER_DOWNLOAD_LIMIT` equals `MAX_PAY2_BYTES`: those 50 MB plus the largest PAY2
  header, metadata and tags. A known larger size is refused before downloading, and a stream that
  passes the cap is aborted. Both raise `DownloadError` with code `too_large`.
- Pass `signal` to cancel and `onProgress` to follow the `downloading`, `decrypting` and `ready`
  phases. A failed or cancelled download leaves the purchase accepted, so `open` can be retried
  without paying again.
- `browserDownload` is the same bounded, proof-authorized download without the controller.

### Wallet adapters

The adapters wrap the provider object a page already has. The SDK imports no wallet library.

| Adapter | Provider | Used for |
| --- | --- | --- |
| `browserEvmWallet(provider, address)` | EIP-1193 `request` (MetaMask, Coinbase Wallet and others) | Recovery signatures with `personal_sign` on any chain; Base x402 payments with `eth_signTypedData_v4`, after checking or requesting a switch to Base |
| `browserSolanaWallet(provider, address)` | Injected `publicKey` and `signMessage` | Recovery signatures |
| `browserNearWallet(provider, accountId)` | NEAR Wallet Selector style: required `getAccounts`, `signMessage` (NEP-413) and `signAndSendTransaction` | Recovery signatures and USDC payments on the NEAR route |

Each adapter checks what the wallet returns: the signature is verified against the expected
identity, the account is still the selected one, and Base payments are signed for chain 8453.
Failures raise `BrowserWalletError` with a code a page can show: `rejected`, `wrong_chain`,
`wrong_identity`, `invalid_signature`, `missing_method`, `invalid_response` or `wallet_error`.

## Hosted selling

`annon.share(options)` sells a file through a shop's host: it quotes the final terms without writing
anything, calls `onSplit` with the split and fee for approval, saves the pending encrypted backup
(`confirmBackup` must resolve only after you stored it and its separate secret), then uploads,
creates the shop's Base split for an EVM seller, registers, funds a NEAR seller's storage and
publishes. It returns `{ fileId, url, header, expiresAt }`. `expiresAt` is the hosting expiry the
shop states, in Unix seconds, or `null` when the shop plans no expiry; the SDK sets no maximum of its
own and refuses a time that has already passed with `file_expired`. A saved completed sale stays
readable after that time. `hosting.origin` is the host of a shop you approved; there is no default host. Each step is checkpointed in the encrypted sell record, and
`annon.resumeShare({ fileId, data, seller, hosting })` continues a stopped sale with the original
file and terms, reconciling any uncertain transaction before it sends another.

- Without `near.recipients` the split pays the seller; sponsored EVM and Solana sellers get the
  relayer's fee share added, as with `sell`.
- Only EVM sellers get Base terms. NEAR and Solana sellers list with `base: null`.
- A NEAR seller signs the upload with NEP-413 (`hosting.signUpload`; `signNearUpload` in the browser
  entry), sends its own transactions, and pays `listingStorage` and `storageBudget` in yoctoNEAR.
- `UploadClient` and `uploadText` are exported for shops that drive the upload protocol themselves.

In a page, `createBrowserSeller(options)` from `@defdone/annon/browser` returns a `SellerFacade`:

```ts
const seller = createBrowserSeller({ ...trustedSdkOptions, host, indexStore, wallet });
const quote = await seller.quote(connection, { file, title, description, priceUsdc: '1.00' });
const sale = await seller.begin(quote.quoteId);   // after the person approved the quote
const backup = await sale.exportBackup();         // let the person save it, then:
await sale.confirmBackup();
let view = await sale.view();
while (view.next) view = await sale.next();       // the only method that signs or writes
```

- `quote` signs and writes nothing. It shows the shares, fee, NEAR funding, routes and steps.
- `next()` runs one step. Each step is persisted before its effect, and a lease keeps two tabs from
  running the same sale.
- After a reload, `active()` returns the open sale. `attachWallet`, `attachFile` and `unlock` supply
  what `view().needs` lists; `discard()` drops a sale.
- `view().result` holds `{ fileId, url, expiresAt }` once the file is published; `expiresAt` may be
  `null` (no planned expiry). `quote.hostedDays` shows the optional `fileLifetimeDays` option, which
  a page fills from the selected shop's rules; it is absent when the page does not pass it.

### Shop discovery

`listShops(config, query)` and `catalog(config, query)`, from both entries, read shop manifests and
catalogs with client-side search and paging and return `{ items, total, nextOffset }`. `config` is the
public discovery configuration (`shops`, `defaultShop`, `shopDirectoryUrl`); there is no built-in
shop or directory. A manifest's optional `rules` (`ShopRules`) is validated strictly and returned as
shop-provided data: on each shop's `info` from `listShops`, and as `rules` with `shop` (`manifest`,
`name`) from `catalog`. Show it as text from that shop; it grants no trust. Limits and fields:
[CLI.md](CLI.md#shop-discovery).

## CLI browser wallet login

```sh
annon login --wallet evm
annon login --wallet near --network near:testnet
annon login --wallet near --no-open
```

Login proves control of a browser wallet you already use. It installs no wallet key and grants no
ongoing signing authority. Every later signing action opens a new local session and needs approval
in the wallet.

| Wallet | How | Signing supported |
| --- | --- | --- |
| EVM | Injected EIP-1193 wallet on Base | `personal_sign` for the SDK's authorization texts, `eth_signTypedData_v4` for the exact EIP-3009/x402 payload |
| NEAR | MyNearWallet through Wallet Selector, account-only sign-in (no `contractId`, no function-call key) | NEP-413 and `signAndSendTransaction`, including the required deposit `"1"` on `ft_transfer_call` |

Browser and remote EVM split-deployment transactions and browser and remote Solana signing are not
included; the local-key adapters remain available for those workflows.

**The local page.** The listener binds `127.0.0.1` on an OS-assigned port before opening the browser.
Match the short pairing code with the terminal, and review the action, amount, recipients, file and
chain on the page before approving in the wallet.

- Host (including port), Origin and an unpredictable RAM-only capability are checked on action and
  result API calls.
- In open mode, a same-origin POST bootstraps the capability once into the opened page, then the
  bootstrap route closes. With `--no-open`, bootstrap is disabled and the capability exists only in
  the printed URL fragment. It is never passed to the browser launcher in argv.
- Bundled scripts, a restrictive CSP, no framing, `no-store` and `no-referrer` are enforced.
- Actions expire after two minutes and are verified once. Identical popup and opener result
  submissions return the same outcome.
- Sessions close after the command or after five idle minutes. Active approvals keep their own
  expiry, and each completed approval restarts the idle timer.
- A rejected or uncertain action must be reviewed at the terminal before another session starts.
- No wallet result is accepted without a local signature check or an independent finalized RPC
  outcome check.

**Remote machines.** `--no-open` prints the full URL and pairing code to stderr. Over SSH, forward
the printed port with `ssh -L PORT:127.0.0.1:PORT host` and open that exact URL locally. Keep the
capability URL private.

**NEAR redirects.** The page removes capabilities and NEAR redirect fragments from browser history
immediately. MyNearWallet receives only a random per-action nonce as `state`. The callback posts the
nonce and proof to its same-origin opener, where the capability stays in RAM; nonce matching and
local signature verification are required. No capability is sent to the wallet. The callback URL is
included in the signed NEP-413 hash, as [NEP-413](https://github.com/near/NEPs/blob/master/neps/nep-0413.md)
specifies.

**What is saved.** Only public identity, network and configuration go into the config file. Login
works before you choose a contract; NEAR ownership checks use a public mainnet or testnet RPC by
default, for login only. Configure and trust your reviewed deployment before other commands. Wallet
and browser internals have their own storage behaviour. Browser approval is still required with
`--json`; terminal prompts are disabled in that mode.

## Agent initialization and spending policy

Choose one signer source. Secrets are referenced, never copied into configuration:

```sh
annon init --agent --wallet evm --recovery evm:0x1111111111111111111111111111111111111111 --key-env BOT_EVM_KEY --daily-budget 2
annon init --agent --wallet near --near-account bot.near --near-key-file /absolute/credentials.json --daily-budget 2
annon init --agent --wallet near --near-account bot.near --keychain-entry 'near-mainnet-bot.near/bot.near:ed25519:PUBLIC_KEY' --daily-budget 2
annon init --agent --wallet near --near-account bot.near --new-key --keychain-entry annon-bot --daily-budget 2
annon init --agent --signer https://signer.example --recovery evm:0x1111111111111111111111111111111111111111 --credential-env SIGNER_TOKEN --daily-budget 2
```

### Signer sources

- Saved file and environment signers require a public identity (`--recovery` or `--near-account`),
  which is checked against the loaded key.
- When a signer is configured, per-call `--evm-key-file`, `--near-key-file` and `--solana-key-file`
  overrides are refused.
- `--key-env` stores only an environment variable's name. EVM variables and files contain hex
  private keys; NEAR variables and files contain credential JSON, as in CLI.md.
- `--new-key` generates directly into an injectable OS keychain interface and returns only public
  identity and key metadata. The shipped OS adapter supports macOS; other platforms can inject an
  adapter or use file, environment or remote references. Tests always inject a fake keychain and
  process.
- A new NEAR key is **not installed on-chain** by this command: the owner must authorize its public
  key separately. A function-call key cannot attach the one yoctoNEAR required for an FT purchase.
  Agent payment keys must have the authority the action requires.

**macOS Keychain.** New entries use `security`'s `-T ""` ACL, which removes automatic access for the
creator executable, so every agent key read prompts for macOS user approval. **Never click Always
Allow for agent keys**: doing so restores automatic access. A generic `security` executable cannot
isolate trusted callers. Review the ACL of existing entries in Keychain Access. For unattended use,
choose a policy-enforcing remote signer rather than granting `security` automatic access.

### Spending policy

Agent configuration includes `agent: true`, `dailyBudget` (decimal USDC), `signer` and `workDir`, a
directory the owner creates and every agent file path must stay inside (`work_dir_required` without
it). Keep the deployment settings, `maxPrice`, `allowedResources`, named `origins` and trusted
`moderators` in that same public config.

Order matters, because agent mode refuses `init`, `login` and per-call trust or deployment flags:

1. Create the working directory.
2. Write the deployment, `maxPrice`, `workDir` and, after reviewing the contract,
   `trustContract: true` (or trust it once with a human command and `--trust-contract`). Do not set
   `agent: true` yourself.
3. Run one `annon init --agent ...` from the examples above. It saves the signer, the daily budget
   and `agent: true`.

- Agents never prompt. Missing trust, price cap or daily budget causes a refusal.
- `allowedResources` is optional. Without it, any secure resource URL is allowed within the
  spending limits; an empty list denies every purchase.
- The full price is reserved atomically before any payment or deposit instructions are prepared.
- UTC daily usage lives in `stateDir/budgets`, survives restarts, and is shared across chains and
  identities that use that state directory. Concurrent writers use the file store's CAS and locking.
- Over-budget requests return `budget_exceeded`; missing policy returns `budget_required`.
- NEAR and Base reservations stay charged after failures and ambiguous outcomes. A 1Click failure
  before deposit instructions are returned releases its reservation; returned instructions keep it
  reserved. There is no other automatic refund.

### Pinning the configuration

Protect the config and state directory from changes by untrusted tools. The trusted launcher pins
`ANNON_CONFIG` (or the default config path) and `ANNON_STATE_DIR` (or the configured or default state
directory).

- Once that config has `agent: true`, per-call `--config` changes, `--state-dir`, `init` and `login`
  are refused, and TTY prompts stay disabled.
- Launch with `ANNON_AGENT=true` to force the policy even if the config lacks `agent: true`. In this
  mode the pinned config is `~/.config/annon/config.json`, and its saved `stateDir` (or
  `~/.local/share/annon`) pins the ledger. A differing `ANNON_CONFIG` is an error
  (`config_conflict`); `ANNON_STATE_DIR` is ignored, and the saved configuration or the default
  owns the ledger location.
- Custom agent config paths must be set through `ANNON_CONFIG` before initialization; alternate
  `init --config` paths are rejected. Human initialization must happen before handing off this
  launcher environment.

**Limit.** An agent with shell access as the same OS user can edit config and ledgers, change
environment variables, call the SDK directly or use accessible signing credentials. It is outside
this protection, and CLI budgets are not a security boundary against it. Use OS isolation and a
remote signer with its own spending policy for that boundary.

### Human payments

Before a human payment the CLI confirms the current price, split recipients and remainder, resource
and file, token and network. Browser mode shows these exact terms with each signing request for
approval in the page and the wallet. Local and remote human signing require an explicit terminal
confirmation. Purchase and recovery secrets still need the independent backup secret described in
CLI.md; login does not derive one from a signature.

## Remote signer, HTTP JSON v1

`init --agent --signer` persists an HTTPS origin and either `--credential-env NAME` or
`--credential-keychain SERVICE/ACCOUNT`.

- Signer origins and credential references can only be set during `init`. Every per-command
  override is rejected before credential lookup.
- URL credentials, query or fragment tokens, plaintext credential fields and HTTP are rejected.
  Redirects are refused.
- The bearer value is read at use time and never saved or printed.

A provider adapter implements:

| Request | Response |
| --- | --- |
| `GET /v1/capabilities` | `{version:1, chain, account, operations:[...]}` |
| `POST /v1/requests` | `{version:1, id, status:"pending"\|"approved"\|"rejected", result?}` |
| `GET /v1/requests/{id}` | Same status response; idempotent polling, no new signing |

Every request uses `Authorization: Bearer <credential>` over HTTPS. JSON request fields are
`version:1`, a unique `id`, `operation`, `chain`, `account`, `expiresAt` (Unix milliseconds),
`payload`, and optional `terms` (display and policy context). Integers too large for JSON numbers are
decimal strings; nonces are byte arrays.

- An ID is never reused for a different exact request. Repeated POSTs must return the same job,
  including during approval.
- Expired, rejected and mismatched responses are refused locally. A transport failure does not
  authorize a new signing request.
- The client discovers capabilities before posting, retries a lost create response with the same
  immutable ID and payload (up to three attempts), and polls that ID every second until its
  deadline. HTTP refusals are not retried.

| Operation | Exact payload | Approved result |
| --- | --- | --- |
| `evm.personalSign` | `{message}`: literal SDK authorization text | `{signature}`: 65-byte hex EIP-191 signature |
| `evm.signTypedData` | EIP-712 `{domain,types,primaryType,message}` | `{signature}`: checked against the domain, chain and selected account |
| `near.nep413` | `{message,recipient,nonce,callbackUrl?}` | `{accountId,publicKey,signature}`: base64 Ed25519 signature, checked with final full-access membership |
| `near.signTransaction` | `{receiverId,method,args,gas,deposit,transaction}`; `transaction` is the exact unsigned Borsh bytes in base64 | `{signedTransaction}`: signed Borsh bytes in base64; exact bytes, fields, signature and final full-access key membership are checked before submission |

Chains are `eip155:8453` for the supported EVM payment route and `near:mainnet` or `near:testnet` for
NEAR. Remote NEAR transaction configuration also needs `signer.publicKey` (`--near-public-key`
during init), so the CLI builds the exact nonce, block and actions before approval. Providers must
apply their own independent policy to these semantic operations; discovery is not permission to
sign arbitrary bytes.

**Transaction outcomes.** The browser bridge returns `{txHash}` for wallet-submitted NEAR calls, and
the CLI independently checks the final signer, receiver, single action, args, gas and deposit through
RPC. A returned transaction hash alone never proves success.

- Definite mismatches and failed finalized transactions are rejected without saving the hash as
  `nearSubmission` evidence. Only RPC unavailability or a non-final status keeps the outcome
  uncertain.
- If submission or finalized verification is ambiguous, the CLI returns `state: "uncertain"`,
  `purchaseId` and `txHash`, and keeps `nearSubmission: {state:"uncertain",txHash}` in the encrypted
  purchase backup. Check status for that saved purchase before buying again.
- Signing errors with a known hash also expose safe hash and purchase evidence, with exit code 4.

**Reference handler.** `node/signer-mock` exports `signerMock`, an authenticated HTTP
`Request -> Response` handler with injected approval and signing, duplicate-ID claims, immutable
request checks, and `decide(id, result)` for pending approvals. Use it in tests or wrap it in your
provider's HTTPS server. It keeps jobs in RAM and is not a durable production signer: production
adapters must persist idempotency state and provide an approval and status UI as appropriate. See
[`node/signing.test.ts`](https://github.com/defdone/annon/blob/master/packages/annon/src/node/signing.test.ts) for fake-key examples; tests need no provider credentials or real signing
service.

## Durable keeper

`keep` is exported from `@defdone/annon/relay`. Supply a stable `network` (`near:mainnet`,
`near:testnet` or `near:sandbox`), a dedicated account and key, durable `store` and `budgetStore`,
hourly and daily yoctoNEAR budgets, and a maximum gas price. In Node, create private directories and
use `fileStore<KeeperRecord>` and `fileStore<BudgetRecord>`. Environment configuration is in the
[relayer README](https://github.com/defdone/annon/blob/master/apps/relayer/README.md).

### Discovery and settlement

- Discovery reads `open_delivery_count` and `list_open_deliveries` against one finalized block. The
  block, count and cursor are persisted across bounded passes (default 20 pages of 50).
- A new finalized snapshot begins after each complete sweep. This covers swap-removals and later
  materializations without a historical-ID eligibility cap.
- Current finalized state is re-read before sending. `settle` uses 600 Tgas while unfunded and 450
  Tgas when funded.
- InFlight funding and slots are never reset or newly submitted. Calls for other pending slots can
  proceed; the contract guards InFlight slots.

### Running the keeper

Run the keeper with a dedicated funded account and durable state. Configure its hourly and daily
spending limits, retain its state after a timeout, and check the saved transaction before retrying.
The relayer README lists the service settings. A `RefundSource` integration supplies refund leaves
and current proofs for `materializeRefund`. Run one keeper process per signing key.

## RPC configuration

| Who | Needs | Setting |
| --- | --- | --- |
| A file host, the CLI for Base purchases, the relayer | A Base RPC endpoint with an API key | `baseRpc` in SDK and host options or CLI config; `ANNON_BASE_RPC` for the CLI; `BASE_RPC` for the relayer |
| A keeper polling every few seconds | A NEAR RPC endpoint with an API key | `nearRpc` in SDK and CLI config; `ANNON_NEAR_RPC` for the CLI; `NEAR_RPC` for the relayer |

The public `https://mainnet.base.org` rate-limits the burst of reads made during settlement and
unlocking. Keep API keys out of public files.

## Base splits

When a file has Base terms, `sell` results include `baseSplit: { address, kind, salt }` beside
`terms`. Public results omit `baseSplit` for a file without Base terms; its encrypted sell record
stores `null`. This metadata stays with the sell record through resume and publication and is
outside the on-chain terms and their hash.

To call `readSplit` later, pass `address` and `{ salt }`, and rebuild the split from
`terms.near.recipients` in their saved order:

| Split field | Value |
| --- | --- |
| `recipients` | The recipient identity IDs |
| `allocations` | Each recipient's `bps` |
| `totalAllocation` | `10000n` |
| `distributionIncentive` | `0` |

## Previews

A seller can build a PAY2 file with a preview by passing `previewLen` to `sell` (format:
[specs/pay2.md](https://github.com/defdone/annon/blob/master/specs/pay2.md) section 7). The SDK does
not verify preview packages for buyers in this release, so a page must not present a preview as
checked.

## Security notes

- The browser build fails if a post-build scan of the emitted JavaScript finds `eval`, `Function`
  construction or calls, or string-argument timers.
- CSP compatibility is also checked statically against the actual built, minified bundle and the HTTP
  page and CSP header: no dynamic `eval` or `Function` calls, string timers, inline scripts or HTML
  event handlers.
- The browser build removes legacy dynamic-code fallbacks from the pinned Wallet Selector and
  js-sha256 copies, with guards that require review when their source changes.
- VM tests disable string and Wasm code generation and exercise fake wallet flows.
- **Real-browser execution is not covered by the test suite.** Tests never launch browsers or GUI
  applications and always stub the login opener; no real wallet, RPC, transaction or Keychain is
  used.

The trust model, the upgrade key during the alpha and the known protocol limits are in
[SECURITY.md](https://github.com/defdone/annon/blob/master/SECURITY.md).
