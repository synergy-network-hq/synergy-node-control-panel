#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "== Bundle prep =="

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
