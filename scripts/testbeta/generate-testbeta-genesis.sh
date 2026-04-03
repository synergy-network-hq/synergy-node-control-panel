#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CANONICAL_GENESIS_FILE="$ROOT_DIR/../config/genesis.json"
OUTPUT_FILE="${1:-$ROOT_DIR/testbeta/runtime/configs/genesis/genesis.json}"

if [[ ! -f "$CANONICAL_GENESIS_FILE" ]]; then
  echo "Missing canonical genesis file: $CANONICAL_GENESIS_FILE" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"
cp "$CANONICAL_GENESIS_FILE" "$OUTPUT_FILE"

echo "Canonical genesis synced to: $OUTPUT_FILE"
