---
'@defdone/annon': patch
'@defdone/annon-mcp': patch
---

Report verified USDC payment amounts, assets, networks and routes in buy, status and open results, including saved 1Click source details. Keep older purchase records readable. Add 30-second retry guidance for pending status and unsafe Base payments, and document the existing localhost HTTP exception.

Keep payment reporting and post-purchase metadata persistence best-effort. Preserve accepted status, recovery opens, purchase IDs, deposit instructions and budget reservations when optional records or backups are unavailable. Validate saved source metadata and omit retry hints when human setup is required. Clarify contract and buyer payment routes.
