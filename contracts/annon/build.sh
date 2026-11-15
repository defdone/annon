#!/bin/sh
# Builds the contract wasm and the MPC and token stand-ins for the sandbox tests, then checks that
# annon.wasm only imports host functions mainnet has, holds no /Users/ or /home/ path, and prints
# its NEAR code hash to compare with the chain.
#
#   build.sh            local build of the working tree; fast, but its hash depends on the machine
#   build.sh --release  release build: cargo near build reproducible-wasm of the committed HEAD in
#                       the digest-pinned NEAR container from contracts/annon/Cargo.toml. Needs
#                       Docker. The same commit gives the same code hash on any machine.
#
# Paths containing spaces are not supported.
set -e
cd "$(dirname "$0")/../.."
OUT=target/wasm32-unknown-unknown/release
WASM=$OUT/annon.wasm
CARGO_DIR="${CARGO_HOME:-$HOME/.cargo}"
unset CARGO_ENCODED_RUSTFLAGS
FLAGS="--cfg near -C target-cpu=mvp -C link-arg=-s --remap-path-prefix=$CARGO_DIR=/cargo --remap-path-prefix=$PWD=/annon"

# The cargo-near release the container recipe expects, fetched once into target/tools with its
# published SHA-256 checked.
cargo_near() {
  version=0.23.0
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) triple=x86_64-unknown-linux-gnu
      sum=94008b827a457750257eced4b571c33736062cc3bd1ffda3e7af70e2bc9a4073 ;;
    Darwin-arm64) triple=aarch64-apple-darwin
      sum=9b428181cae9fe655dfcef56a05c849d0cddd859ecaf73d5ebeb6199827cf0d0 ;;
    *) echo "no pinned cargo-near for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
  esac
  dir=target/tools/cargo-near-$version
  if [ ! -x "$dir/cargo-near" ]; then
    mkdir -p "$dir"
    curl -fsSL -o "$dir/cargo-near.tar.gz" \
      "https://github.com/near/cargo-near/releases/download/cargo-near-v$version/cargo-near-$triple.tar.gz"
    if [ "$(openssl dgst -sha256 -r "$dir/cargo-near.tar.gz" | cut -d' ' -f1)" != "$sum" ]; then
      echo "cargo-near download does not match its published SHA-256" >&2
      rm -rf "$dir"
      exit 1
    fi
    tar -xzf "$dir/cargo-near.tar.gz" -C "$dir" --strip-components 1
    rm "$dir/cargo-near.tar.gz"
  fi
  echo "$PWD/$dir"
}

if [ "${1:-}" = "--release" ]; then
  RUSTFLAGS="$FLAGS" cargo build --locked -p mock-mpc -p mock-token --lib --target wasm32-unknown-unknown --release
  rm -rf target/near-release
  PATH="$(cargo_near):$PATH" cargo near build reproducible-wasm \
    --manifest-path contracts/annon/Cargo.toml --out-dir target/near-release
  cp target/near-release/annon.wasm "$WASM"
else
  RUSTFLAGS="$FLAGS" \
    cargo build --locked -p annon -p mock-mpc -p mock-token --lib --target wasm32-unknown-unknown --release
  # About 20% smaller, so 20% less NEAR locked for storage. Keeps the features rustc already emits
  # (bulk memory, sign-ext), which mainnet accepts.
  if [ -n "${WASM_OPT:-}" ]; then
    "$WASM_OPT" --detect-features --enable-bulk-memory --enable-sign-ext -Oz --strip-debug "$WASM" -o "$WASM"
  else
    npx -y -p binaryen@123.0.0 wasm-opt --detect-features --enable-bulk-memory --enable-sign-ext \
      -Oz --strip-debug "$WASM" -o "$WASM"
  fi
fi
node contracts/annon/check-imports.mjs "$WASM"
# /home/near is the fixed path inside the NEAR build container, recorded in the build metadata.
if LC_ALL=C grep -a -o -E '/(Users|home)/[A-Za-z0-9._-]*' "$WASM" | grep -q -v -x '/home/near'; then
  echo "annon.wasm contains a local path" >&2
  exit 1
fi
ls -l "$WASM" | awk '{ printf "annon.wasm: %d bytes, %.2f NEAR of storage\n", $5, $5 / 100000 }'
node contracts/annon/code-hash.mjs "$WASM"
