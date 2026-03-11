#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

required_paths=(
  "devnet/lean15/node-inventory.csv"
  "devnet/lean15/hosts.env.example"
  "devnet/lean15/configs"
  "devnet/lean15/installers"
  "devnet/lean15/wireguard"
  "devnet/lean15/workspace-manifest.json"
  "binaries"
)

for required_path in "${required_paths[@]}"; do
  if [[ ! -e "$required_path" ]]; then
    echo "Missing required bundled asset: $required_path" >&2
    exit 1
  fi
done

for node_dir in devnet/lean15/installers/node-*; do
  [[ -d "$node_dir" ]] || continue
  for required_file in install_and_start.sh nodectl.sh install_and_start.ps1 nodectl.ps1 node.env config/node.toml; do
    if [[ ! -f "$node_dir/$required_file" ]]; then
      echo "Installer bundle is incomplete: $node_dir/$required_file" >&2
      exit 1
    fi
  done

  if ! grep -q 'start_node()' "$node_dir/nodectl.sh"; then
    echo "Linux/macOS nodectl.sh is missing start_node in $node_dir" >&2
    exit 1
  fi

  for action in install_node setup bootstrap_node reset_chain export_logs view_chain_data export_chain_data; do
    if ! grep -q "\"$action\"" "$node_dir/nodectl.ps1"; then
      echo "Windows nodectl.ps1 is missing action '$action' in $node_dir" >&2
      exit 1
    fi
  done

  if ! grep -q '^min_validators = 5$' "$node_dir/config/node.toml"; then
    echo "Installer config is missing the enforced minimum validator count in $node_dir/config/node.toml" >&2
    exit 1
  fi
done

unix_binary_paths=(
  "binaries/synergy-devnet-darwin-arm64"
  "binaries/synergy-devnet-linux-amd64"
  "binaries/synergy-devnet-agent-darwin-arm64"
  "binaries/synergy-devnet-agent-linux-amd64"
)

windows_binary_paths=(
  "binaries/synergy-devnet-windows-amd64.exe"
  "binaries/synergy-devnet-agent-windows-amd64.exe"
)

host_os="$(uname -s)"

for binary_path in "${unix_binary_paths[@]}"; do
  if [[ ! -f "$binary_path" ]]; then
    echo "Missing binary: $binary_path" >&2
    exit 1
  fi
  if [[ ! "$host_os" =~ ^(MINGW|MSYS|CYGWIN) ]] && [[ ! -x "$binary_path" ]]; then
    echo "Unix binary is not executable: $binary_path" >&2
    exit 1
  fi
done

for binary_path in "${windows_binary_paths[@]}"; do
  if [[ ! -f "$binary_path" ]]; then
    echo "Missing binary: $binary_path" >&2
    exit 1
  fi
done

if [[ "${ALLOW_DIRTY_BUNDLE_PREP:-0}" != "1" ]]; then
  if ! git diff --quiet -- devnet/lean15/configs devnet/lean15/installers devnet/lean15/workspace-manifest.json; then
    echo "Generated configs/installers/manifest are stale. Re-run bundle prep and commit the outputs." >&2
    git diff -- devnet/lean15/configs devnet/lean15/installers devnet/lean15/workspace-manifest.json >&2 || true
    exit 1
  fi
fi

echo "Bundled assets validated."
