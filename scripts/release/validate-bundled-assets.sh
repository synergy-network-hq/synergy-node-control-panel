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

if ! rg -q '^[[:space:]]*strict_validator_allowlist[[:space:]]*=[[:space:]]*true' "testbeta/runtime/installers/GenVal-01/config/node.toml"; then
  echo "Bundled validator node.toml is missing strict_validator_allowlist = true" >&2
  exit 1
fi

if ! rg -q '^[[:space:]]*allowed_validator_addresses[[:space:]]*=' "testbeta/runtime/installers/GenVal-01/config/node.toml"; then
  echo "Bundled validator node.toml is missing allowed_validator_addresses" >&2
  exit 1
fi

if ! rg -q '^[[:space:]]*status_ready_gate_enabled[[:space:]]*=[[:space:]]*false' "testbeta/runtime/installers/GenVal-01/config/node.toml"; then
  echo "Bundled validator node.toml is missing status_ready_gate_enabled = false" >&2
  exit 1
fi

if ! rg -q '^[[:space:]]*leader_timeout_secs[[:space:]]*=[[:space:]]*15' "testbeta/runtime/installers/GenVal-01/config/node.toml"; then
  echo "Bundled validator node.toml is missing leader_timeout_secs = 15" >&2
  exit 1
fi

if ! rg -q '^[[:space:]]*vote_timeout_secs[[:space:]]*=[[:space:]]*30' "testbeta/runtime/installers/GenVal-01/config/node.toml"; then
  echo "Bundled validator node.toml is missing vote_timeout_secs = 30" >&2
  exit 1
fi

if ! rg -q '^[[:space:]]*bootstrap_refresh_secs[[:space:]]*=[[:space:]]*3600' "testbeta/runtime/installers/GenVal-01/config/node.toml"; then
  echo "Bundled validator node.toml is missing bootstrap_refresh_secs = 3600" >&2
  exit 1
fi

if ! rg -q '^[[:space:]]*state_sync_before_join[[:space:]]*=[[:space:]]*false' "testbeta/runtime/installers/GenVal-01/config/node.toml"; then
  echo "Bundled validator node.toml is missing state_sync_before_join = false" >&2
  exit 1
fi

if ! rg -q '^[[:space:]]*bootnodes[[:space:]]*=[[:space:]]*\[\]' "testbeta/runtime/installers/GenVal-01/config/node.toml"; then
  echo "Bundled validator node.toml must not include bootnodes" >&2
  exit 1
fi

python3 - <<'PY' "$setup_package_path"
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
package = json.loads(path.read_text(encoding="utf-8"))
runtime = package.get("runtime_config") or {}
network = runtime.get("network") or {}
consensus = runtime.get("consensus") or {}
p2p = runtime.get("p2p") or {}
node = runtime.get("node") or {}

expected_allowlist = [
    "synv114cvu472rkdgpmzvkj70zk9tu8cqqlu4x9ra",
    "synv11wrj74dnkc802jfl4e7j7jd2azj2zk2eqvgu",
    "synv11v2r4gnp5py3ae5ft6646lxpqphdv58k8tyu",
    "synv118u0v2gxn4zew5j886hwz32tkaujsvhykf49",
    "synv11mvlgy72uq7kuh200qnxv67zrqjugz267k46",
]

errors = []

if len(network.get("additional_dial_targets") or []) != 4:
    errors.append("runtime_config.network.additional_dial_targets must include the four remote validator peers")

if network.get("persistent_peers") != network.get("additional_dial_targets"):
    errors.append("runtime_config.network.persistent_peers must match additional_dial_targets")

if network.get("bootnodes") != []:
    errors.append("runtime_config.network.bootnodes must be empty for bundled validator packages")

if network.get("seed_servers") != []:
    errors.append("runtime_config.network.seed_servers must be empty for bundled validator packages")

if network.get("bootstrap_dns_records") != []:
    errors.append("runtime_config.network.bootstrap_dns_records must be empty for bundled validator packages")

expected_consensus = {
    "min_validators": 2,
    "validator_vote_threshold": 2,
    "validator_cluster_size": 5,
    "status_ready_gate_enabled": False,
    "status_ready_min_validators": 2,
    "status_ready_genesis_grace_secs": 0,
    "allow_genesis_status_bypass": True,
    "mesh_settle_secs": 15,
    "leader_timeout_secs": 15,
    "vote_timeout_secs": 30,
    "block_timeout_secs": 30,
    "penalization_enabled": False,
}
for key, expected in expected_consensus.items():
    if consensus.get(key) != expected:
        errors.append(f"runtime_config.consensus.{key} must be {expected!r}")

expected_p2p = {
    "enable_discovery": False,
    "heartbeat_interval": 10,
    "bootstrap_refresh_secs": 3600,
}
for key, expected in expected_p2p.items():
    if p2p.get(key) != expected:
        errors.append(f"runtime_config.p2p.{key} must be {expected!r}")

if node.get("strict_validator_allowlist") is not True:
    errors.append("runtime_config.node.strict_validator_allowlist must be true")

if node.get("allowed_validator_addresses") != expected_allowlist:
    errors.append("runtime_config.node.allowed_validator_addresses must match the canonical five-validator allowlist")

if node.get("validator_address") not in expected_allowlist:
    errors.append("runtime_config.node.validator_address must be one of the canonical validator addresses")

if node.get("auto_register_validator") is not False:
    errors.append("runtime_config.node.auto_register_validator must be false for bundled validator packages")

validator = runtime.get("validator") or {}
expected_validator = {
    "participation": "active",
    "verify_quorum_certificates": True,
    "state_sync_before_join": False,
}
for key, expected in expected_validator.items():
    if validator.get(key) != expected:
        errors.append(f"runtime_config.validator.{key} must be {expected!r}")

if errors:
    for error in errors:
        print(error, file=sys.stderr)
    raise SystemExit(1)
PY

echo "Bundled assets validated."
