---
'@defdone/annon-demo-host': patch
---

The browser page for a file URL uses the annon.dev print style. Its command line section lists one `annon buy` command per route the file offers (NEAR, Base only when the file has Base terms, and another chain through `--from-chain`), and the commands wrap instead of scrolling sideways. Below them the page says that every purchase needs a spending cap (`--max-price`, `ANNON_MAX_PRICE` or `maxPrice`) and that `--from-chain` returns a deposit address to fund on that chain. A new "Already bought it?" line points to My purchases in the demo shop and to `annon recover`. Status, headers and every non-browser response stay the same.
