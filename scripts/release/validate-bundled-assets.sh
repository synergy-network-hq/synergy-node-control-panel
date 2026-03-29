#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

required_paths=(
  "testbeta/lean15/node-inventory.csv"
  "testbeta/lean15/hosts.env.example"
  "testbeta/lean15/configs"
  "testbeta/lean15/installers"
  "testbeta/lean15/keys"
  "testbeta/lean15/workspace-manifest.json"
  "binaries"
)

for required_path in "${required_paths[@]}"; do
  if [[ ! -e "$required_path" ]]; then
    echo "Missing required bundled asset: $required_path" >&2
    exit 1
  fi
done

for node_dir in testbeta/lean15/installers/node-*; do
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

  if ! grep -q '^min_validators = 4$' "$node_dir/config/node.toml"; then
    echo "Installer config is missing the enforced minimum validator count in $node_dir/config/node.toml" >&2
    exit 1
  fi
done

unix_binary_paths=(
  "binaries/synergy-testbeta-darwin-arm64"
  "binaries/synergy-testbeta-linux-amd64"
  "binaries/synergy-testbeta-agent-darwin-arm64"
  "binaries/synergy-testbeta-agent-linux-amd64"
)

windows_binary_paths=(
  "binaries/synergy-testbeta-windows-amd64.exe"
  "binaries/synergy-testbeta-agent-windows-amd64.exe"
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
  BUNDLE_PATHS=(testbeta/lean15/keys testbeta/lean15/configs testbeta/lean15/installers testbeta/lean15/workspace-manifest.json)

  # Detect untracked files (new files not yet in index)
  untracked="$(git status --short --untracked-files=all -- "${BUNDLE_PATHS[@]}" | grep '^??' || true)"

  # Detect content changes, ignoring pure CRLF-vs-LF differences so that Windows
  # CI runners (where some tools write CRLF) don't cause false-positive failures.
  # If a file differs only in line endings the regenerated content is still correct
  # and the CRLF will be normalised to LF by .gitattributes on the next commit.
  content_diff="$(git diff --ignore-cr-at-eol -- "${BUNDLE_PATHS[@]}" 2>/dev/null || true)"

  if [[ -n "$untracked" || -n "$content_diff" ]]; then
    echo "Deterministic bundle assets are stale or untracked. Re-run bundle prep and commit testbeta/lean15/keys, configs, installers, and workspace-manifest outputs." >&2
    git status --short --untracked-files=all -- "${BUNDLE_PATHS[@]}" >&2 || true
    git diff --ignore-cr-at-eol -- "${BUNDLE_PATHS[@]}" >&2 || true
    exit 1
  fi
fi

echo "Bundled assets validated."
