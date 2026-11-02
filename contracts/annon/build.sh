#!/bin/sh
# Builds the contract wasm (and the MPC stand-in for sandbox tests) and checks it only imports host functions mainnet has.
# ponytail: plain cargo build for dev deploys; the final deploy uses cargo near reproducible-wasm
set -e
cd "$(dirname "$0")/../.."
RUSTFLAGS="--cfg near -C target-cpu=mvp -C link-arg=-s" \
  cargo build -p annon -p mock-mpc --lib --target wasm32-unknown-unknown --release
node contracts/annon/check-imports.mjs target/wasm32-unknown-unknown/release/annon.wasm
