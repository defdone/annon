---
'@defdone/annon': patch
'@defdone/annon-mcp': patch
---

Name Base RPC rate limits and HTTP failures, expose host-only payment diagnostics, preserve payment_not_safe with bounded human open retries, report host payment HTTP status, and retain split provenance in sell results and backups. Document API-key RPC configuration.

Guard diagnostic hook failures, return unsafe payments immediately for status, agents and JSON mode, refund unsafe relayer IP admission, and expose typed Base and NEAR RPC rate limits as fixed CLI/MCP errors. Preserve compatibility with older sell records.

Accept Solana and Ethereum chain aliases for 1Click token lookup. Review and back up the live quote before human confirmation, display exact source amounts and deadlines, and include source payment details in structured results.

Validate token identifiers before display, use the confirmed 1Click chain IDs, require a ten-minute deposit margin after approval, and surface quote_expired. Refuse missing terminal prompts before quoting, use pending exit status for unsafe status checks, and release 1Click agent reservations when instructions were never returned.
