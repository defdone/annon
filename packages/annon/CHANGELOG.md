# @defdone/annon

## 0.1.0-beta.0

First public beta.

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
