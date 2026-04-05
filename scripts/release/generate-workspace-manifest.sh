#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

MANIFEST_PATH="$ROOT_DIR/testbeta/runtime/workspace-manifest.json"
APP_VERSION="$(node -e 'const fs=require("fs");const pkg=JSON.parse(fs.readFileSync("package.json","utf8"));process.stdout.write(pkg.version);')"
python3 - <<'PY' "$ROOT_DIR" "$MANIFEST_PATH" "$APP_VERSION"
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
manifest_path = pathlib.Path(sys.argv[2])
app_version = sys.argv[3]

# Only the three platform binaries that are bundled into the Electron app.
# Configs, installers, and keys are not bundled and must not drive the digest.
platform_binaries = [
    "binaries/synergy-testbeta-darwin-arm64",
    "binaries/synergy-testbeta-linux-amd64",
    "binaries/synergy-testbeta-windows-amd64.exe",
]

def sha256_file(path: pathlib.Path) -> str:
    with path.open("rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()

checksums = {}
bundle_hasher = hashlib.sha256()

for rel in platform_binaries:
    path = root / rel
    if not path.is_file():
        raise SystemExit(f"Missing platform binary: {rel}")
    digest = sha256_file(path)
    checksums[rel] = digest
    bundle_hasher.update(rel.encode("utf-8"))
    bundle_hasher.update(digest.encode("utf-8"))

bundle_digest = bundle_hasher.hexdigest()

manifest = {
    "workspace_resource_version": f"{app_version}+{bundle_digest[:12]}",
    "app_version": app_version,
    "bundle_digest": bundle_digest,
    "platform_binaries": platform_binaries,
    "checksums": checksums,
}

manifest_path.parent.mkdir(parents=True, exist_ok=True)
with open(str(manifest_path), "w", encoding="utf-8", newline="\n") as fh:
    fh.write(json.dumps(manifest, indent=2) + "\n")
PY

echo "Workspace manifest ready: $MANIFEST_PATH"
