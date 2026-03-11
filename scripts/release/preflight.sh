#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

REPO_SLUG="synergy-network-hq/devnet-control-panel"
DEFAULT_KEY_PATH="$HOME/.synergy-devnet-control-panel/updater.key"
KEY_INPUT="${TAURI_SIGNING_PRIVATE_KEY:-$DEFAULT_KEY_PATH}"
REQUIRE_LOCAL_SIGNING="${RELEASE_PREFLIGHT_REQUIRE_LOCAL_SIGNING:-0}"

echo "== Release preflight =="
echo "Repo: $REPO_SLUG"

if [[ ! -f package.json || ! -f src-tauri/Cargo.toml || ! -f src-tauri/tauri.conf.json ]]; then
  echo "Release metadata files are missing." >&2
  exit 1
fi

PACKAGE_VERSION="$(node -e 'const fs=require("fs"); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); process.stdout.write(pkg.version);')"
CARGO_VERSION="$(python3 - <<'PY'
import pathlib
import re

text = pathlib.Path("src-tauri/Cargo.toml").read_text(encoding="utf-8")
match = re.search(r'^version\s*=\s*"([^"]+)"', text, re.MULTILINE)
if not match:
    raise SystemExit(1)
print(match.group(1), end="")
PY
)"
TAURI_VERSION="$(jq -r '.version' src-tauri/tauri.conf.json)"

if [[ "$PACKAGE_VERSION" != "$CARGO_VERSION" || "$PACKAGE_VERSION" != "$TAURI_VERSION" ]]; then
  echo "Version mismatch detected:" >&2
  echo "  package.json: $PACKAGE_VERSION" >&2
  echo "  Cargo.toml:   $CARGO_VERSION" >&2
  echo "  tauri.conf:   $TAURI_VERSION" >&2
  exit 1
fi

echo "Version consistency: $PACKAGE_VERSION"

PRODUCT_NAME="$(jq -r '.productName' src-tauri/tauri.conf.json)"
if [[ "$PRODUCT_NAME" != "Synergy Devnet Control Panel" ]]; then
  echo "Unexpected productName: $PRODUCT_NAME" >&2
  exit 1
fi

UPDATER_ENDPOINT_COUNT="$(jq '.plugins.updater.endpoints | length' src-tauri/tauri.conf.json)"
UPDATER_PUBKEY="$(jq -r '.plugins.updater.pubkey' src-tauri/tauri.conf.json)"
CREATE_UPDATER_ARTIFACTS="$(jq -r '.bundle.createUpdaterArtifacts' src-tauri/tauri.conf.json)"

if [[ "$UPDATER_ENDPOINT_COUNT" -lt 1 ]]; then
  echo "Updater endpoints are not configured." >&2
  exit 1
fi

if [[ -z "$UPDATER_PUBKEY" || "$UPDATER_PUBKEY" == "null" ]]; then
  echo "Updater public key is not configured." >&2
  exit 1
fi

if [[ "$CREATE_UPDATER_ARTIFACTS" != "true" ]]; then
  echo "bundle.createUpdaterArtifacts must be true." >&2
  exit 1
fi

echo "Updater config: OK"

SECRET_NAMES="$(gh secret list --repo "$REPO_SLUG" | awk '{print $1}')"
for secret_name in RELEASES_REPO_TOKEN TAURI_SIGNING_PRIVATE_KEY TAURI_SIGNING_PRIVATE_KEY_PASSWORD; do
  if ! printf '%s\n' "$SECRET_NAMES" | grep -qx "$secret_name"; then
    echo "Missing required GitHub Actions secret: $secret_name" >&2
    exit 1
  fi
done

echo "GitHub secrets: OK"

HAS_LOCAL_SIGNING_KEY="false"
if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" || -f "$KEY_INPUT" ]]; then
  HAS_LOCAL_SIGNING_KEY="true"
fi

echo "Frontend build..."
npm run build

echo "Rust compile check..."
cargo check --manifest-path src-tauri/Cargo.toml

if [[ "$HAS_LOCAL_SIGNING_KEY" == "true" ]]; then
  TAURI_SIGNING_PRIVATE_KEY="$KEY_INPUT" ./scripts/verify-signing-key.sh

  HOST_TARGET="$(rustc -vV | sed -n 's/^host: //p')"
  BUILD_ARGS=()
  ARTIFACT_ROOT="src-tauri/target/release/bundle"
  KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-${TAURI_PRIVATE_KEY_PASSWORD:-}}"

  if [[ "$HOST_TARGET" == "aarch64-apple-darwin" ]]; then
    BUILD_ARGS=(--target "$HOST_TARGET")
    ARTIFACT_ROOT="src-tauri/target/${HOST_TARGET}/release/bundle"
  fi

  echo "Local signed bundle build (${HOST_TARGET})..."
  ALLOW_DIRTY_BUNDLE_PREP=1 \
  TAURI_SIGNING_PRIVATE_KEY="$KEY_INPUT" \
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$KEY_PASSWORD" \
  npx tauri build "${BUILD_ARGS[@]}"

  MAC_UPDATER_BUNDLE="$(find "$ARTIFACT_ROOT/macos" -maxdepth 1 -type f -name '*.app.tar.gz' | head -n 1 || true)"
  MAC_UPDATER_SIG="$(find "$ARTIFACT_ROOT/macos" -maxdepth 1 -type f -name '*.app.tar.gz.sig' | head -n 1 || true)"

  if [[ -z "$MAC_UPDATER_BUNDLE" || -z "$MAC_UPDATER_SIG" ]]; then
    echo "Local macOS updater artifacts were not produced." >&2
    echo "Expected files under $ARTIFACT_ROOT/macos" >&2
    exit 1
  fi

  echo "Local updater bundle: $MAC_UPDATER_BUNDLE"
  echo "Local updater signature: $MAC_UPDATER_SIG"
elif [[ "$REQUIRE_LOCAL_SIGNING" == "1" ]]; then
  echo "No local updater signing key found at $DEFAULT_KEY_PATH and TAURI_SIGNING_PRIVATE_KEY is unset." >&2
  exit 1
else
  echo "No local updater signing key found at $DEFAULT_KEY_PATH; skipping local signed bundle build."
  echo "GitHub Actions signing will use repo secrets."
fi

echo "Preflight passed."
