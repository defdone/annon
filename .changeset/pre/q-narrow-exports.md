---
"@defdone/annon": patch
---

Publish an explicit list of entry points instead of every module under `dist/`: `.`, `./browser`, `./browser/purchase-bundle.js`, `./node`, `./relay`, `./pay/store-node`, `./node/signer-mock` and the server building blocks `./pay/seller`, `./pay/settle`, `./pay/store`, `./pay/split`, `./download/host`, `./download/http`, `./envelope/pay2` and `./near/rpc`. `./node/adapter`, `./node/cli` and `./node/errors` remain for now and are deprecated in favour of `./node`. The main entry lists its exports by name, adds the error classes, and no longer exports the low-level `openTo`, the relayer fee math or the purchase, refund and text encoders. The build starts from an empty `dist/` and ships no source maps.
