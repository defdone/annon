# @defdone/annon-demo-host

## 0.1.0-alpha.2

### Patch Changes

- The browser page for a file URL uses the annon.dev print style. Its command line section lists one `annon buy` command per route the file offers (NEAR, Base only when the file has Base terms, and another chain through `--from-chain`), and the commands wrap instead of scrolling sideways. Below them the page says that every purchase needs a spending cap (`--max-price`, `ANNON_MAX_PRICE` or `maxPrice`) and that `--from-chain` returns a deposit address to fund on that chain. A new "Already bought it?" line points to My purchases in the demo shop and to `annon recover`. Status, headers and every non-browser response stay the same.

## 0.1.0-alpha.1

### Patch Changes

- A file URL opened in a browser shows the file's title, price, seller, routes and how to buy it, instead of an empty 402. The status and headers stay the same, and requests that do not ask for HTML get exactly the same response as before.

## 0.1.0-alpha.0

First public alpha. This service is not published to npm.

### Patch Changes

- Include all service runtime modules in production images and include the relayer cutover tool.
