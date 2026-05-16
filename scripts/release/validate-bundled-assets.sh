#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

host_os="$(uname -s)"

# --- Platform binaries ---------------------------------------------------------
# The three testnet platform binaries are the only bundled assets that must
# exist. Configs, installers, and keys are not included in the Electron app
# and must not be validated here.

unix_binaries=(
  "binaries/synergy-testnet-darwin-arm64"
  "binaries/synergy-testnet-linux-amd64"
)

windows_binaries=(
  "binaries/synergy-testnet-windows-amd64.exe"
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

for binary_path in "${unix_binaries[@]}" "${windows_binaries[@]}"; do
  checksum_path="${binary_path}.sha256"
  if [[ ! -f "$checksum_path" ]]; then
    echo "Missing platform binary checksum: $checksum_path" >&2
    exit 1
  fi
  expected="$(awk '{print $1}' "$checksum_path")"
  if command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$binary_path" | awk '{print $1}')"
  else
    actual="$(sha256sum "$binary_path" | awk '{print $1}')"
  fi
  if [[ "$expected" != "$actual" ]]; then
    echo "Checksum mismatch for $binary_path: expected $expected got $actual" >&2
    exit 1
  fi
done

# --- Workspace manifest --------------------------------------------------------
if [[ ! -f "testnet/runtime/workspace-manifest.json" ]]; then
  echo "Missing workspace manifest: testnet/runtime/workspace-manifest.json" >&2
  exit 1
fi

# Detect stale manifest (manifest content differs from what the binaries produce).
# This is expected on the very first run after binaries change. CI and release
# prep can skip this git-clean guard because they intentionally regenerate the
# manifest before committing the result.
skip_git_clean_guard="${SKIP_BUNDLED_ASSET_GIT_CLEAN_CHECK:-${ALLOW_DIRTY_BUNDLE_PREP:-0}}"
if [[ "$skip_git_clean_guard" != "1" ]]; then
  BUNDLE_PATHS=(testnet/runtime/workspace-manifest.json)

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
runtime_genesis_path="testnet/runtime/configs/genesis/genesis.json"
installer_genesis_path="testnet/runtime/installers/GenVal-01/config/genesis.json"
installer_peers_path="testnet/runtime/installers/GenVal-01/config/peers.toml"

for required_path in \
  "$canonical_genesis_path" \
  "$runtime_genesis_path" \
  "$installer_genesis_path" \
  "$installer_peers_path"
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
data = json.loads(path.read_text(encoding="utf-8"))
value = data.get("integrity", {}).get("genesis_hash", "")
print(value, end="")
PY
}

canonical_genesis_hash="$(read_json_hash "$canonical_genesis_path" plain)"
runtime_genesis_hash="$(read_json_hash "$runtime_genesis_path" plain)"
installer_genesis_hash="$(read_json_hash "$installer_genesis_path" plain)"

if [[ -z "$canonical_genesis_hash" ]]; then
  echo "Canonical genesis hash missing from $canonical_genesis_path" >&2
  exit 1
fi

for candidate in \
  "$runtime_genesis_hash" \
  "$installer_genesis_hash"
do
  if [[ "$candidate" != "$canonical_genesis_hash" ]]; then
    cat >&2 <<EOF
Bundled genesis drift detected.
  canonical:      $canonical_genesis_hash
  runtime:        $runtime_genesis_hash
  installer:      $installer_genesis_hash
EOF
    exit 1
  fi
done

if ! rg -q '^[[:space:]]*persistent_peers[[:space:]]*=' "$installer_peers_path"; then
  echo "Bundled peers.toml is missing global.persistent_peers" >&2
  exit 1
fi

if ! rg -q '^[[:space:]]*persistent_peers[[:space:]]*=' "testnet/runtime/installers/GenVal-01/config/node.toml"; then
  echo "Bundled validator node.toml is missing network.persistent_peers" >&2
  exit 1
fi

if ! rg -q '^[[:space:]]*strict_validator_allowlist[[:space:]]*=[[:space:]]*true' "testnet/runtime/installers/GenVal-01/config/node.toml"; then
  echo "Bundled validator node.toml is missing strict_validator_allowlist = true" >&2
  exit 1
fi

if ! rg -q '^[[:space:]]*allowed_validator_addresses[[:space:]]*=' "testnet/runtime/installers/GenVal-01/config/node.toml"; then
  echo "Bundled validator node.toml is missing allowed_validator_addresses" >&2
  exit 1
fi

if ! rg -q '^[[:space:]]*status_ready_gate_enabled[[:space:]]*=[[:space:]]*true' "testnet/runtime/installers/GenVal-01/config/node.toml"; then
  echo "Bundled validator node.toml is missing status_ready_gate_enabled = true" >&2
  exit 1
fi

if ! rg -q '^[[:space:]]*leader_timeout_secs[[:space:]]*=[[:space:]]*4' "testnet/runtime/installers/GenVal-01/config/node.toml"; then
  echo "Bundled validator node.toml is missing leader_timeout_secs = 4" >&2
  exit 1
fi

if ! rg -q '^[[:space:]]*vote_timeout_secs[[:space:]]*=[[:space:]]*2' "testnet/runtime/installers/GenVal-01/config/node.toml"; then
  echo "Bundled validator node.toml is missing vote_timeout_secs = 2" >&2
  exit 1
fi

if ! rg -q '^[[:space:]]*bootstrap_refresh_secs[[:space:]]*=[[:space:]]*3600' "testnet/runtime/installers/GenVal-01/config/node.toml"; then
  echo "Bundled validator node.toml is missing bootstrap_refresh_secs = 3600" >&2
  exit 1
fi

if ! rg -q '^[[:space:]]*state_sync_before_join[[:space:]]*=[[:space:]]*true' "testnet/runtime/installers/GenVal-01/config/node.toml"; then
  echo "Bundled validator node.toml is missing state_sync_before_join = true" >&2
  exit 1
fi

if ! rg -q '^[[:space:]]*bootnodes[[:space:]]*=[[:space:]]*\[\]' "testnet/runtime/installers/GenVal-01/config/node.toml"; then
  echo "Bundled validator node.toml must not include bootnodes" >&2
  exit 1
fi

required_atlas_paths=(
  "testnet/runtime/installers/Node-RPC/nginx.conf"
  "testnet/runtime/installers/Node-EXP/nginx.conf"
  "testnet/runtime/installers/Node-EXP/explorer-app/dist/index.html"
  "testnet/runtime/installers/Node-EXP/explorer-app/dist/assets"
  "testnet/runtime/installers/Node-EXP/explorer-app/backend/dist"
  "testnet/runtime/installers/Node-EXP/explorer-app/backend/scripts/migrate.js"
  "testnet/runtime/installers/Node-EXP/explorer-app/backend/migrations"
  "testnet/runtime/installers/Node-EXP/explorer-app/backend/node_modules/fastify/package.json"
  "testnet/runtime/installers/Node-EXP/explorer-app/indexer/dist"
  "testnet/runtime/installers/Node-EXP/explorer-app/indexer/scripts/migrate.js"
  "testnet/runtime/installers/Node-EXP/explorer-app/indexer/migrations"
  "testnet/runtime/installers/Node-EXP/explorer-app/indexer/node_modules/pg/package.json"
)

for required_path in "${required_atlas_paths[@]}"; do
  if [[ ! -e "$required_path" ]]; then
    echo "Missing bundled Atlas/runtime asset: $required_path" >&2
    exit 1
  fi
done

# Public release artifacts must never carry validator/wallet private material.
# Print file names only; never print matching lines or values.
secret_name_hits="$(find testnet/runtime -type f \( \
    -iname 'private.key' -o \
    -iname 'identity.json' -o \
    -iname 'identity.toml' -o \
    -iname '*mnemonic*' -o \
    -iname '*secret*' \
  \) -print 2>/dev/null || true)"
if [[ -n "$secret_name_hits" ]]; then
  echo "Secret-shaped files are present in bundled Testnet runtime artifacts:" >&2
  printf '%s\n' "$secret_name_hits" >&2
  exit 1
fi

secret_field_hits="$(rg -l --pcre2 -i '(^|["[:space:]_])(private[_-]?key|secret[_-]?key|mnemonic|seed[_-]?phrase|recovery[_-]?phrase|\\bsk\\b|\\bpriv\\b)["[:space:]]*[:=]' \
  testnet/runtime/configs \
  testnet/runtime/installers/*/config \
  testnet/runtime/installers/*/keys \
  testnet/runtime/installers/*/node.env \
  testnet/runtime/node-inventory.csv \
  testnet/runtime/hosts.env.example \
  testnet/runtime/workspace-manifest.json 2>/dev/null || true)"
if [[ -n "$secret_field_hits" ]]; then
  echo "Secret-shaped fields are present in bundled Testnet public artifacts:" >&2
  printf '%s\n' "$secret_field_hits" >&2
  exit 1
fi

if ! rg -q '^DATABASE_URL=postgres://synergy:synergy@127\.0\.0\.1:5432/synergy_explorer\?sslmode=disable$' "testnet/runtime/installers/Node-EXP/node.env"; then
  echo "Bundled Node-EXP node.env is missing the canonical DATABASE_URL" >&2
  exit 1
fi

if ! rg -q '^INDEXER_WS_HOSTNAME=testnet-indexer\.synergy-network\.io$' "testnet/runtime/installers/Node-EXP/node.env"; then
  echo "Bundled Node-EXP node.env is missing the canonical INDEXER_WS_HOSTNAME" >&2
  exit 1
fi

if ! rg -q 'server_name testnet-core-rpc\.synergy-network\.io' "testnet/runtime/installers/Node-RPC/nginx.conf"; then
  echo "Bundled Node-RPC nginx.conf is missing the canonical RPC hostname" >&2
  exit 1
fi

if ! rg -q 'server_name testnet-core-ws\.synergy-network\.io' "testnet/runtime/installers/Node-RPC/nginx.conf"; then
  echo "Bundled Node-RPC nginx.conf is missing the canonical WS hostname" >&2
  exit 1
fi

for expected_host in \
  'testnet-explorer.synergy-network.io' \
  'testnet-atlas-api.synergy-network.io' \
  'testnet-indexer.synergy-network.io'
do
  if ! rg -q "server_name ${expected_host}" "testnet/runtime/installers/Node-EXP/nginx.conf"; then
    echo "Bundled Node-EXP nginx.conf is missing ${expected_host}" >&2
    exit 1
  fi
done

echo "Bundled assets validated."
