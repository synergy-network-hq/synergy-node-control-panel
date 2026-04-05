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
  package.json:                $package_version
  control-service/Cargo.toml: $cargo_version
Keep the desktop package version and control-service version aligned before tagging a release.
EOF
    exit 1
  fi
}

sync_platform_binaries() {
  local target_dir="$ROOT_DIR/binaries"
  local source_dir=""
  local candidates=()

  if [[ -n "${SYNERGY_TESTBETA_BINARY_SOURCE_DIR:-}" ]]; then
    candidates+=("${SYNERGY_TESTBETA_BINARY_SOURCE_DIR}")
  fi

  if [[ -n "${SYNERGY_TESTBETA_SOURCE_REPO_ROOT:-}" ]]; then
    candidates+=("${SYNERGY_TESTBETA_SOURCE_REPO_ROOT}/binaries")
  fi

  candidates+=(
    "$ROOT_DIR/../binaries"
    "$ROOT_DIR/../../synergy-testnet-beta/binaries"
    "$ROOT_DIR/../../../synergy-testnet-beta/binaries"
  )

  mkdir -p "$target_dir"

  for candidate in "${candidates[@]}"; do
    if [[ -d "$candidate" ]]; then
      source_dir="$(cd "$candidate" && pwd)"
      break
    fi
  done

  if [[ ! -d "$source_dir" ]]; then
    echo "Platform binary source not found; keeping existing binaries in binaries/."
    echo "Checked: ${candidates[*]}"
    return
  fi

  if [[ "$source_dir" == "$target_dir" ]]; then
    echo "Platform binary source resolves to binaries/; skipping sync."
    return
  fi

  echo "Syncing platform binaries from $source_dir"

  for binary_name in \
    synergy-testbeta-darwin-arm64 \
    synergy-testbeta-linux-amd64 \
    "synergy-testbeta-windows-amd64.exe"
  do
    if [[ -f "$source_dir/$binary_name" ]]; then
      cp "$source_dir/$binary_name" "$target_dir/$binary_name"
      echo "  Synced: $binary_name"
    fi
  done
}

# Ensure Unix platform binaries are executable
for binary_path in \
  "$ROOT_DIR/binaries/synergy-testbeta-darwin-arm64" \
  "$ROOT_DIR/binaries/synergy-testbeta-linux-amd64"
do
  if [[ -f "$binary_path" ]]; then
    chmod +x "$binary_path"
  fi
done

ensure_version_alignment
sync_platform_binaries
./scripts/release/generate-workspace-manifest.sh
./scripts/release/validate-bundled-assets.sh

npm run build
