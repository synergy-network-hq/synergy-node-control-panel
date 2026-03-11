#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "== Bundle prep =="

ensure_tracked_devnet_keys() {
  local inventory_file="$ROOT_DIR/devnet/lean15/node-inventory.csv"
  local missing_or_untracked=0

  if [[ ! -f "$inventory_file" ]]; then
    echo "Missing inventory file: $inventory_file" >&2
    exit 1
  fi

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Bundle prep requires a git checkout so deterministic devnet assets can be verified." >&2
    exit 1
  fi

  while IFS=, read -r node_slot_id _rest || [[ -n "${node_slot_id:-}" ]]; do
    [[ "$node_slot_id" == "node_slot_id" ]] && continue
    [[ -z "${node_slot_id:-}" ]] && continue

    for required_file in \
      "devnet/lean15/keys/${node_slot_id}/private.key" \
      "devnet/lean15/keys/${node_slot_id}/public.key" \
      "devnet/lean15/keys/${node_slot_id}/address.txt"
    do
      if [[ ! -f "$required_file" ]]; then
        echo "Missing deterministic devnet key asset: $required_file" >&2
        missing_or_untracked=1
        continue
      fi

      if ! git ls-files --error-unmatch "$required_file" >/dev/null 2>&1; then
        echo "Untracked deterministic devnet key asset: $required_file" >&2
        missing_or_untracked=1
      fi
    done
  done < "$inventory_file"

  if [[ ! -f "devnet/lean15/keys/node-addresses.csv" ]]; then
    echo "Missing deterministic devnet key asset: devnet/lean15/keys/node-addresses.csv" >&2
    missing_or_untracked=1
  elif ! git ls-files --error-unmatch "devnet/lean15/keys/node-addresses.csv" >/dev/null 2>&1; then
    echo "Untracked deterministic devnet key asset: devnet/lean15/keys/node-addresses.csv" >&2
    missing_or_untracked=1
  fi

  if [[ "$missing_or_untracked" -ne 0 ]]; then
    cat >&2 <<'EOF'
Release bundle prep requires the committed devnet key bundle under devnet/lean15/keys.
If those files are missing or untracked, bundle prep will regenerate validator addresses,
which changes installers and workspace-manifest and makes tagged releases fail.
Commit the deterministic key bundle before cutting the release tag.
EOF
    exit 1
  fi
}

for binary_path in \
  "$ROOT_DIR/binaries/synergy-devnet-darwin-arm64" \
  "$ROOT_DIR/binaries/synergy-devnet-linux-amd64" \
  "$ROOT_DIR/binaries/synergy-devnet-agent-darwin-arm64" \
  "$ROOT_DIR/binaries/synergy-devnet-agent-linux-amd64"
do
  if [[ -f "$binary_path" ]]; then
    chmod +x "$binary_path"
  fi
done

ensure_tracked_devnet_keys

if [[ ! -f "$ROOT_DIR/binaries/synergy-devnet-agent-darwin-arm64" || \
      ! -f "$ROOT_DIR/binaries/synergy-devnet-agent-linux-amd64" || \
      ! -f "$ROOT_DIR/binaries/synergy-devnet-agent-windows-amd64.exe" ]]; then
  ./scripts/build-sidecars.sh
else
  echo "Using prebuilt agent binaries from binaries/"
fi

./scripts/devnet15/generate-node-keys.sh
./scripts/devnet15/generate-devnet-genesis.sh
./scripts/devnet15/render-configs.sh
./scripts/devnet15/build-node-installers.sh
./scripts/release/generate-workspace-manifest.sh
./scripts/release/validate-bundled-assets.sh

vite build
