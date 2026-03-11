#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "== Bundle prep =="

./scripts/build-sidecars.sh
./scripts/devnet15/render-configs.sh
./scripts/devnet15/build-node-installers.sh
./scripts/release/generate-workspace-manifest.sh
./scripts/release/validate-bundled-assets.sh

vite build

