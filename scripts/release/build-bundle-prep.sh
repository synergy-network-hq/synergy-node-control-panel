#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "== Bundle prep =="

ensure_version_alignment() {
  local package_version cargo_version

  package_version="$(node -e 'const fs=require("fs"); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); process.stdout.write(pkg.version);')"
  cargo_version="$(python3 - <<'PY'
import pathlib
import re

content = pathlib.Path("control-service/Cargo.toml").read_text(encoding="utf-8")
match = re.search(r'^version\s*=\s*"([^"]+)"', content, re.MULTILINE)
if not match:
    raise SystemExit("Missing version in control-service/Cargo.toml")
print(match.group(1), end="")
PY
)"

  if [[ "$package_version" != "$cargo_version" ]]; then
    cat >&2 <<EOF
Version mismatch detected:
  package.json:            $package_version
  control-service/Cargo.toml:    $cargo_version
Keep the desktop package version and control-service version aligned before tagging a release.
EOF
    exit 1
  fi
}

ensure_tracked_testbeta_keys() {
  local inventory_file="$ROOT_DIR/testbeta/lean15/node-inventory.csv"
  local missing_or_untracked=0

  if [[ ! -f "$inventory_file" ]]; then
    echo "Missing inventory file: $inventory_file" >&2
    exit 1
  fi

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Bundle prep requires a git checkout so deterministic testbeta assets can be verified." >&2
    exit 1
  fi

  while IFS=, read -r node_slot_id _rest || [[ -n "${node_slot_id:-}" ]]; do
    [[ "$node_slot_id" == "node_slot_id" ]] && continue
    [[ -z "${node_slot_id:-}" ]] && continue

    for required_file in \
      "testbeta/lean15/keys/${node_slot_id}/private.key" \
      "testbeta/lean15/keys/${node_slot_id}/public.key" \
      "testbeta/lean15/keys/${node_slot_id}/address.txt"
    do
      if [[ ! -f "$required_file" ]]; then
        echo "Missing deterministic testbeta key asset: $required_file" >&2
        missing_or_untracked=1
        continue
      fi

      if ! git ls-files --error-unmatch "$required_file" >/dev/null 2>&1; then
        echo "Untracked deterministic testbeta key asset: $required_file" >&2
        missing_or_untracked=1
      fi
    done
  done < "$inventory_file"

  if [[ ! -f "testbeta/lean15/keys/node-addresses.csv" ]]; then
    echo "Missing deterministic testbeta key asset: testbeta/lean15/keys/node-addresses.csv" >&2
    missing_or_untracked=1
  elif ! git ls-files --error-unmatch "testbeta/lean15/keys/node-addresses.csv" >/dev/null 2>&1; then
    echo "Untracked deterministic testbeta key asset: testbeta/lean15/keys/node-addresses.csv" >&2
    missing_or_untracked=1
  fi

  if [[ "$missing_or_untracked" -ne 0 ]]; then
    cat >&2 <<'EOF'
Release bundle prep requires the committed testbeta key bundle under testbeta/lean15/keys.
If those files are missing or untracked, bundle prep will regenerate validator addresses,
which changes installers and workspace-manifest and makes tagged releases fail.
Commit the deterministic key bundle before cutting the release tag.
EOF
    exit 1
  fi
}

sync_role_bound_binaries() {
  local source_dir="$ROOT_DIR/../../../synergy-testnet-beta/binaries"
  local target_dir="$ROOT_DIR/binaries"

  mkdir -p "$target_dir"

  if [[ ! -d "$source_dir" ]]; then
    echo "Role binary source directory not found at $source_dir; keeping existing control-panel binaries."
    return
  fi

  shopt -s nullglob
  for binary_path in "$source_dir"/synergy-*-node-* "$source_dir"/synergy-testbeta-*; do
    cp "$binary_path" "$target_dir/$(basename "$binary_path")"
    chmod +x "$target_dir/$(basename "$binary_path")" 2>/dev/null || true
  done
  shopt -u nullglob
}

for binary_path in \
  "$ROOT_DIR/binaries/synergy-testbeta-darwin-arm64" \
  "$ROOT_DIR/binaries/synergy-testbeta-linux-amd64" \
  "$ROOT_DIR/binaries/synergy-testbeta-agent-darwin-arm64" \
  "$ROOT_DIR/binaries/synergy-testbeta-agent-linux-amd64"
do
  if [[ -f "$binary_path" ]]; then
    chmod +x "$binary_path"
  fi
done

ensure_version_alignment
ensure_tracked_testbeta_keys
sync_role_bound_binaries

if [[ ! -f "$ROOT_DIR/binaries/synergy-testbeta-agent-darwin-arm64" || \
      ! -f "$ROOT_DIR/binaries/synergy-testbeta-agent-linux-amd64" || \
      ! -f "$ROOT_DIR/binaries/synergy-testbeta-agent-windows-amd64.exe" ]]; then
  ./scripts/build-sidecars.sh
else
  echo "Using prebuilt agent binaries from binaries/"
fi

./scripts/testbeta/generate-node-keys.sh
./scripts/testbeta/generate-testbeta-genesis.sh
./scripts/testbeta/render-configs.sh
./scripts/testbeta/build-node-installers.sh
./scripts/release/generate-workspace-manifest.sh
./scripts/release/validate-bundled-assets.sh

npm run build
