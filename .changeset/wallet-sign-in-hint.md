---
"@defdone/annon": patch
---

In a terminal, a command that stops with `credentials_required` now also says how a person gets past it: sign in with `annon login --wallet near` (or `evm`) to approve payments in the browser, or configure a key as in the docs. Inside the interactive session, that hint and the catalog's "Buy a row with" line name the command without the `annon` prefix. `annon --help` lists the key-file options `init --agent` already accepts. The package now declares Node.js 22.22.2 or newer, which its NEAR dependency already required. Piped, `--json` and agent output are unchanged.
