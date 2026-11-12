#!/bin/sh
# Builds the contract wasm (and the MPC and token stand-ins for sandbox tests), shrinks it with wasm-opt and
# checks it only imports host functions mainnet has.
# Note: plain cargo build for dev deploys; the final deploy uses cargo near reproducible-wasm
set -e
cd "$(dirname "$0")/../.."
RUSTFLAGS="--cfg near -C target-cpu=mvp -C link-arg=-s" \
  cargo build -p annon -p mock-mpc -p mock-token --lib --target wasm32-unknown-unknown --release
WASM=target/wasm32-unknown-unknown/release/annon.wasm
# About 20% smaller, so 20% less NEAR locked for storage. Keeps the features rustc already emits
# (bulk memory, sign-ext), which mainnet accepts.
if [ -n "${WASM_OPT:-}" ]; then
  "$WASM_OPT" --detect-features --enable-bulk-memory --enable-sign-ext -Oz --strip-debug "$WASM" -o "$WASM"
else
  npx -y -p binaryen@123.0.0 wasm-opt --detect-features --enable-bulk-memory --enable-sign-ext \
    -Oz --strip-debug "$WASM" -o "$WASM"
fi
node contracts/annon/check-imports.mjs "$WASM"
ls -l "$WASM" | awk '{ printf "annon.wasm: %d bytes, %.2f NEAR of storage\n", $5, $5 / 100000 }'
