#!/usr/bin/env bash
# build-sidecars.sh — Build the synergy-devnet-agent sidecar binary.
#
# USAGE
#   scripts/build-sidecars.sh               # native platform only (default)
#   scripts/build-sidecars.sh --all          # native + all remote-deployment targets
#   scripts/build-sidecars.sh --linux        # linux-amd64 only (cross-compiled via cargo-zigbuild)
#   scripts/build-sidecars.sh --windows      # windows-amd64 only (cross-compiled via cargo-zigbuild)
#   CARGO_BUILD_TARGET=x86_64-unknown-linux-gnu scripts/build-sidecars.sh
#
# OUTPUT
#   binaries/synergy-devnet-agent-<platform>   e.g. synergy-devnet-agent-linux-amd64
#
# WHY --all / --linux?
#   The devnet remote machines run Linux (x86_64).  When you run the control
#   panel on a Mac and click "Update All Agents", deploy_agent() copies
#   binaries/synergy-devnet-agent-linux-amd64 to each remote host.  If that
#   file is missing the deployment fails with "binary not found".
#
#   --all / --linux / --windows cross-compile via cargo-zigbuild (no Docker required).
#   One-time setup on macOS:
#     brew install zig
#     cargo install cargo-zigbuild
#     rustup target add x86_64-unknown-linux-gnu
#     rustup target add aarch64-unknown-linux-gnu   # only needed for --all
#     rustup target add x86_64-pc-windows-gnu       # only needed for --all / --windows
#
# GITHUB ACTIONS
#   CI builds agent binaries natively on each platform using the CARGO_BUILD_TARGET
#   environment variable — see .github/workflows/release.yml build-agents job.
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CARGO_MANIFEST="$ROOT_DIR/src-tauri/devnet-agent/Cargo.toml"
SIDECAR_TARGET_DIR="$ROOT_DIR/src-tauri/devnet-agent/target"

# ─── Helpers ──────────────────────────────────────────────────────────────────

require_cargo_zigbuild() {
  if command -v cargo-zigbuild >/dev/null 2>&1; then
    return 0
  fi

  echo "cargo-zigbuild is required for cross-compilation." >&2
  echo "Install it with:" >&2
  echo "  brew install zig" >&2
  echo "  cargo install cargo-zigbuild" >&2
  echo "  rustup target add $1" >&2
  echo "" >&2
  echo "Alternatively, push to GitHub and let the release workflow build the target binary." >&2
  exit 1
}

build_native() {
  local TARGET_TRIPLE
  TARGET_TRIPLE="${TAURI_ENV_TARGET_TRIPLE:-${CARGO_BUILD_TARGET:-$(rustc -vV | awk '/^host: / { print $2 }')}}"

  if [[ -z "${TARGET_TRIPLE:-}" ]]; then
    echo "Unable to determine target triple for sidecar build." >&2
    exit 1
  fi

  local target_arg=()
  local target_dir_segment=""
  if [[ -n "$TARGET_TRIPLE" ]]; then
    target_arg=(--target "$TARGET_TRIPLE")
    target_dir_segment="$TARGET_TRIPLE/"
  fi

  local platform_suffix=""
  local binary_ext=""
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
    --release \
    --target-dir "$SIDECAR_TARGET_DIR" \
    "${target_arg[@]}"

  local compiled_binary="$SIDECAR_TARGET_DIR/${target_dir_segment}release/synergy-devnet-agent${binary_ext}"
  if [[ ! -f "$compiled_binary" ]]; then
    echo "Compiled agent binary not found at $compiled_binary" >&2
    exit 1
  fi

  rm -f \
    "$ROOT_DIR/src-tauri/target/${target_dir_segment}release/synergy-devnet-agent${binary_ext}" \
    "$ROOT_DIR/src-tauri/target/${target_dir_segment}release/synergy-devnet-agent.d"

  mkdir -p "$ROOT_DIR/binaries"
  local output_binary="$ROOT_DIR/binaries/synergy-devnet-agent-${platform_suffix}${binary_ext}"
  cp "$compiled_binary" "$output_binary"

  if [[ "$binary_ext" != ".exe" ]]; then
    chmod +x "$output_binary"
  fi

  echo "Agent sidecar ready: $output_binary"
}

# Cross-compile a Linux binary using cargo-zigbuild (no Docker required).
# cargo-zigbuild uses Zig as a drop-in cross-linker, producing a glibc-linked
# binary that runs on all Ubuntu/Debian remote hosts.
#
# One-time setup (macOS):
#   brew install zig
#   cargo install cargo-zigbuild
#   rustup target add x86_64-unknown-linux-gnu
#   rustup target add aarch64-unknown-linux-gnu   # only if building linux-arm64
build_linux_via_zigbuild() {
  local target="${1:-x86_64-unknown-linux-gnu}"
  local suffix="${2:-linux-amd64}"

  require_cargo_zigbuild "${target}"

  # Verify the Rust target is installed
  if ! rustup target list --installed 2>/dev/null | grep -q "^${target}$"; then
    echo "Rust target '${target}' is not installed." >&2
    echo "Install it with: rustup target add ${target}" >&2
    exit 1
  fi

  echo "Cross-compiling agent for ${target} using cargo-zigbuild..."
  cargo zigbuild \
    --manifest-path "$CARGO_MANIFEST" \
    --release \
    --target-dir "$SIDECAR_TARGET_DIR" \
    --target "${target}"

  local compiled="$SIDECAR_TARGET_DIR/${target}/release/synergy-devnet-agent"
  if [[ ! -f "$compiled" ]]; then
    echo "Cross-compiled binary not found at $compiled" >&2
    exit 1
  fi

  mkdir -p "$ROOT_DIR/binaries"
  local output="$ROOT_DIR/binaries/synergy-devnet-agent-${suffix}"
  cp "$compiled" "$output"
  chmod +x "$output"
  echo "Agent sidecar ready: $output"
}

# Cross-compile a Windows binary using cargo-zigbuild (no Docker required).
# Uses the x86_64-pc-windows-gnu target (MinGW ABI) which zigbuild supports
# from macOS — produces a valid .exe that runs on any x86_64 Windows host.
#
# One-time setup (macOS):
#   rustup target add x86_64-pc-windows-gnu   # (brew install zig + cargo install cargo-zigbuild already done)
build_windows_via_zigbuild() {
  local target="${1:-x86_64-pc-windows-gnu}"
  local suffix="${2:-windows-amd64}"

  require_cargo_zigbuild "${target}"

  # Verify the Rust target is installed
  if ! rustup target list --installed 2>/dev/null | grep -q "^${target}$"; then
    echo "Rust target '${target}' is not installed." >&2
    echo "Install it with: rustup target add ${target}" >&2
    exit 1
  fi

  echo "Cross-compiling agent for ${target} using cargo-zigbuild..."
  cargo zigbuild \
    --manifest-path "$CARGO_MANIFEST" \
    --release \
    --target-dir "$SIDECAR_TARGET_DIR" \
    --target "${target}"

  local compiled="$SIDECAR_TARGET_DIR/${target}/release/synergy-devnet-agent.exe"
  if [[ ! -f "$compiled" ]]; then
    echo "Cross-compiled binary not found at $compiled" >&2
    exit 1
  fi

  mkdir -p "$ROOT_DIR/binaries"
  local output="$ROOT_DIR/binaries/synergy-devnet-agent-${suffix}.exe"
  cp "$compiled" "$output"
  echo "Agent sidecar ready: $output"
}

# ─── Entry point ──────────────────────────────────────────────────────────────

MODE="${1:-native}"

case "$MODE" in
  --all)
    echo "=== Building all remote-deployment targets ==="
    build_native
    build_linux_via_zigbuild   "x86_64-unknown-linux-gnu"   "linux-amd64"
    build_linux_via_zigbuild   "aarch64-unknown-linux-gnu"  "linux-arm64"
    build_windows_via_zigbuild "x86_64-pc-windows-gnu"      "windows-amd64"
    echo ""
    echo "All agent binaries built:"
    ls -la "$ROOT_DIR/binaries/synergy-devnet-agent-"* 2>/dev/null || true
    ;;
  --linux)
    build_linux_via_zigbuild "x86_64-unknown-linux-gnu" "linux-amd64"
    ;;
  --windows)
    build_windows_via_zigbuild "x86_64-pc-windows-gnu" "windows-amd64"
    ;;
  native|"")
    # Default: native platform only (also used by CI with CARGO_BUILD_TARGET set)
    build_native
    ;;
  *)
    echo "Unknown option: $MODE" >&2
    echo "Usage: $0 [--all | --linux | --windows | native]" >&2
    exit 1
    ;;
esac
