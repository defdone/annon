---
"@defdone/annon-mcp": patch
---

The server returns short instructions in its initialize result: start with `annon_catalog` or `annon_verify`, buy with `annon_buy`, call `annon_status` until the purchase is accepted, then `annon_open`; buying needs a wallet and limits the owner configures. The README's configuration example now includes the demo shop and matches docs/agents.md. The package now declares Node.js 22.22.2 or newer, as `@defdone/annon` does.
