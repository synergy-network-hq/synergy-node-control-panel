#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

MANIFEST_PATH="$ROOT_DIR/devnet/lean15/workspace-manifest.json"
APP_VERSION="$(node -e 'const fs=require("fs");const pkg=JSON.parse(fs.readFileSync("package.json","utf8"));process.stdout.write(pkg.version);')"
SOURCE_REVISION="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
GENERATED_AT_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

python3 - <<'PY' "$ROOT_DIR" "$MANIFEST_PATH" "$APP_VERSION" "$SOURCE_REVISION" "$GENERATED_AT_UTC"
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
manifest_path = pathlib.Path(sys.argv[2])
app_version = sys.argv[3]
source_revision = sys.argv[4]
generated_at_utc = sys.argv[5]

required_paths = [
    "devnet/lean15/node-inventory.csv",
    "devnet/lean15/hosts.env.example",
    "devnet/lean15/configs",
    "devnet/lean15/installers",
    "devnet/lean15/wireguard",
    "devnet/lean15/wireguard/configs",
    "devnet/lean15/wireguard/keys",
    "binaries",
    "guides/SYNERGY_DEVNET_CONTROL_PANEL_USER_MANUAL.md",
]

checksum_targets = [
    "binaries/synergy-devnet-agent-darwin-arm64",
    "binaries/synergy-devnet-agent-linux-amd64",
    "binaries/synergy-devnet-agent-windows-amd64.exe",
    "binaries/synergy-devnet-darwin-arm64",
    "binaries/synergy-devnet-linux-amd64",
    "binaries/synergy-devnet-windows-amd64.exe",
]

def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

checksums = {}
for rel in checksum_targets:
    path = root / rel
    if path.is_file():
        checksums[rel] = sha256_file(path)

manifest = {
    "workspace_resource_version": f"{app_version}+{source_revision[:12]}",
    "app_version": app_version,
    "source_revision": source_revision,
    "generated_at_utc": generated_at_utc,
    "required_paths": required_paths,
    "checksums": checksums,
}

manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
PY

echo "Workspace manifest ready: $MANIFEST_PATH"

