---
"@defdone/annon": patch
"@defdone/annon-mcp": patch
---

Honor recorded 1Click quote timing with an earlier deposit cutoff and delivery buffer. Restrict
MCP origins/refunds and offer-file resources to human configuration. Add CLI/MCP sell resume and
safe failure file IDs, clear published sell and completed seller-key secrets from current encrypted
state/backups, retain terminal purchase records, and allow NEAR-only use without Base RPC.
Return and handle retryable in-flight relayer operations, remove the keeper retry capacity ceiling
and accumulating delays, and gate production-container installs behind an explicit test flag.
