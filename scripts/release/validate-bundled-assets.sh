#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

host_os="$(uname -s)"

# --- Platform binaries ---------------------------------------------------------
# The three testbeta platform binaries are the only bundled assets that must
# exist. Configs, installers, and keys are not included in the Electron app
# and must not be validated here.

unix_binaries=(
  "binaries/synergy-testbeta-darwin-arm64"
  "binaries/synergy-testbeta-linux-amd64"
)

windows_binaries=(
  "binaries/synergy-testbeta-windows-amd64.exe"
)

for binary_path in "${unix_binaries[@]}"; do
  if [[ ! -f "$binary_path" ]]; then
    echo "Missing platform binary: $binary_path" >&2
    exit 1
  fi
  if [[ ! "$host_os" =~ ^(MINGW|MSYS|CYGWIN) ]] && [[ ! -x "$binary_path" ]]; then
    echo "Platform binary is not executable: $binary_path" >&2
    exit 1
  fi
done

for binary_path in "${windows_binaries[@]}"; do
  if [[ ! -f "$binary_path" ]]; then
    echo "Missing platform binary: $binary_path" >&2
    exit 1
  fi
done

# --- Workspace manifest --------------------------------------------------------
if [[ ! -f "testbeta/runtime/workspace-manifest.json" ]]; then
  echo "Missing workspace manifest: testbeta/runtime/workspace-manifest.json" >&2
  exit 1
fi

# Detect stale manifest (manifest content differs from what the binaries produce).
# This is expected on the very first run after binaries change. CI and release
# prep can skip this git-clean guard because they intentionally regenerate the
# manifest before committing the result.
skip_git_clean_guard="${SKIP_BUNDLED_ASSET_GIT_CLEAN_CHECK:-${ALLOW_DIRTY_BUNDLE_PREP:-0}}"
if [[ "$skip_git_clean_guard" != "1" ]]; then
  BUNDLE_PATHS=(testbeta/runtime/workspace-manifest.json)

  untracked="$(git status --short --untracked-files=all -- "${BUNDLE_PATHS[@]}" | grep '^??' || true)"
  content_diff="$(git diff --ignore-cr-at-eol -- "${BUNDLE_PATHS[@]}" 2>/dev/null || true)"

  if [[ -n "$untracked" || -n "$content_diff" ]]; then
    echo "workspace-manifest.json is stale. Commit it and re-run bundle prep." >&2
    git status --short --untracked-files=all -- "${BUNDLE_PATHS[@]}" >&2 || true
    git diff --ignore-cr-at-eol -- "${BUNDLE_PATHS[@]}" >&2 || true
    exit 1
  fi
fi

# --- Canonical genesis consistency ---------------------------------------------
canonical_genesis_path="../config/genesis.json"
runtime_genesis_path="testbeta/runtime/configs/genesis/genesis.json"
installer_genesis_path="testbeta/runtime/installers/GenVal-01/config/genesis.json"
installer_peers_path="testbeta/runtime/installers/GenVal-01/config/peers.toml"
setup_package_path="testbeta/runtime/installers/GenVal-01/keys/setup-package.json"

for required_path in \
  "$canonical_genesis_path" \
  "$runtime_genesis_path" \
  "$installer_genesis_path" \
  "$installer_peers_path" \
  "$setup_package_path"
do
  if [[ ! -f "$required_path" ]]; then
    echo "Missing genesis consistency input: $required_path" >&2
    exit 1
  fi
done

read_json_hash() {
  python3 - <<'PY' "$1" "$2"
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
mode = sys.argv[2]
data = json.loads(path.read_text(encoding="utf-8"))
if mode == "package":
    data = data["artifacts"]["genesis"]
value = data.get("integrity", {}).get("genesis_hash", "")
print(value, end="")
PY
}

canonical_genesis_hash="$(read_json_hash "$canonical_genesis_path" plain)"
runtime_genesis_hash="$(read_json_hash "$runtime_genesis_path" plain)"
installer_genesis_hash="$(read_json_hash "$installer_genesis_path" plain)"
setup_package_genesis_hash="$(read_json_hash "$setup_package_path" package)"

if [[ -z "$canonical_genesis_hash" ]]; then
  echo "Canonical genesis hash missing from $canonical_genesis_path" >&2
  exit 1
fi

for candidate in \
  "$runtime_genesis_hash" \
  "$installer_genesis_hash" \
  "$setup_package_genesis_hash"
do
  if [[ "$candidate" != "$canonical_genesis_hash" ]]; then
    cat >&2 <<EOF
Bundled genesis drift detected.
  canonical:      $canonical_genesis_hash
  runtime:        $runtime_genesis_hash
  installer:      $installer_genesis_hash
  setup-package:  $setup_package_genesis_hash
EOF
    exit 1
  fi
done

if ! rg -q '^[[:space:]]*persistent_peers[[:space:]]*=' "$installer_peers_path"; then
  echo "Bundled peers.toml is missing global.persistent_peers" >&2
  exit 1
fi

if ! rg -q '^[[:space:]]*persistent_peers[[:space:]]*=' "testbeta/runtime/installers/GenVal-01/config/node.toml"; then
  echo "Bundled validator node.toml is missing network.persistent_peers" >&2
  exit 1
fi

if ! rg -q '^[[:space:]]*status_ready_gate_enabled[[:space:]]*=[[:space:]]*true' "testbeta/runtime/installers/GenVal-01/config/node.toml"; then
  echo "Bundled validator node.toml is missing status_ready_gate_enabled" >&2
  exit 1
fi

if ! rg -q '^[[:space:]]*leader_timeout_secs[[:space:]]*=[[:space:]]*120' "testbeta/runtime/installers/GenVal-01/config/node.toml"; then
  echo "Bundled validator node.toml is missing leader_timeout_secs = 120" >&2
  exit 1
fi

echo "Bundled assets validated."
