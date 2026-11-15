#!/bin/sh
# Builds the contract wasm (and the MPC and token stand-ins for sandbox tests), shrinks it with wasm-opt and
# checks it only imports host functions mainnet has.
# Remaps workspace and Cargo source paths, rejects a wasm containing /Users/ or /home/, and prints
# the NEAR code hash to compare with the chain. Paths containing spaces are not supported.
set -e
cd "$(dirname "$0")/../.."
CARGO_DIR="${CARGO_HOME:-$HOME/.cargo}"
unset CARGO_ENCODED_RUSTFLAGS
RUSTFLAGS="--cfg near -C target-cpu=mvp -C link-arg=-s --remap-path-prefix=$CARGO_DIR=/cargo --remap-path-prefix=$PWD=/annon" \
  cargo build --locked -p annon -p mock-mpc -p mock-token --lib --target wasm32-unknown-unknown --release
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
if LC_ALL=C grep -a -q -E '/(Users|home)/' "$WASM"; then
  echo "annon.wasm contains a local path" >&2
  exit 1
fi
ls -l "$WASM" | awk '{ printf "annon.wasm: %d bytes, %.2f NEAR of storage\n", $5, $5 / 100000 }'
node contracts/annon/code-hash.mjs "$WASM"
