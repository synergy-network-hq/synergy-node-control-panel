#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CARGO_MANIFEST="$ROOT_DIR/src-tauri/Cargo.toml"
SIDECAR_TARGET_DIR="$ROOT_DIR/src-tauri/target-sidecars"
TARGET_TRIPLE="${TAURI_ENV_TARGET_TRIPLE:-${CARGO_BUILD_TARGET:-$(rustc -vV | awk '/^host: / { print $2 }')}}"

if [[ -z "${TARGET_TRIPLE:-}" ]]; then
  echo "Unable to determine target triple for sidecar build." >&2
  exit 1
fi

target_arg=()
target_dir_segment=""
if [[ -n "$TARGET_TRIPLE" ]]; then
  target_arg=(--target "$TARGET_TRIPLE")
  target_dir_segment="$TARGET_TRIPLE/"
fi

platform_suffix=""
binary_ext=""
case "$TARGET_TRIPLE" in
  *apple-darwin)
    if [[ "$TARGET_TRIPLE" == aarch64-* ]]; then
      platform_suffix="darwin-arm64"
    else
      platform_suffix="darwin-amd64"
    fi
    ;;
  *unknown-linux-gnu|*unknown-linux-musl)
    if [[ "$TARGET_TRIPLE" == aarch64-* ]]; then
      platform_suffix="linux-arm64"
    else
      platform_suffix="linux-amd64"
    fi
    ;;
  *pc-windows-msvc|*pc-windows-gnu)
    binary_ext=".exe"
    if [[ "$TARGET_TRIPLE" == aarch64-* ]]; then
      platform_suffix="windows-arm64"
    else
      platform_suffix="windows-amd64"
    fi
    ;;
  *)
    echo "Unsupported target triple for agent sidecar build: $TARGET_TRIPLE" >&2
    exit 1
    ;;
esac

echo "Building Synergy Devnet Agent sidecar for $TARGET_TRIPLE..."
cargo build \
  --manifest-path "$CARGO_MANIFEST" \
  --bin synergy-devnet-agent \
  --features devnet-agent-bin \
  --release \
  --target-dir "$SIDECAR_TARGET_DIR" \
  "${target_arg[@]}"

compiled_binary="$SIDECAR_TARGET_DIR/${target_dir_segment}release/synergy-devnet-agent${binary_ext}"
if [[ ! -f "$compiled_binary" ]]; then
  echo "Compiled agent binary not found at $compiled_binary" >&2
  exit 1
fi

rm -f \
  "$ROOT_DIR/src-tauri/target/${target_dir_segment}release/synergy-devnet-agent${binary_ext}" \
  "$ROOT_DIR/src-tauri/target/${target_dir_segment}release/synergy-devnet-agent.d"

mkdir -p "$ROOT_DIR/binaries"
output_binary="$ROOT_DIR/binaries/synergy-devnet-agent-${platform_suffix}${binary_ext}"
cp "$compiled_binary" "$output_binary"

if [[ "$binary_ext" != ".exe" ]]; then
  chmod +x "$output_binary"
fi

echo "Agent sidecar ready: $output_binary"
