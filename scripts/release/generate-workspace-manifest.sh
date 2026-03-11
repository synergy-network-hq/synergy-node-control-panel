#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

MANIFEST_PATH="$ROOT_DIR/devnet/lean15/workspace-manifest.json"
APP_VERSION="$(node -e 'const fs=require("fs");const pkg=JSON.parse(fs.readFileSync("package.json","utf8"));process.stdout.write(pkg.version);')"
python3 - <<'PY' "$ROOT_DIR" "$MANIFEST_PATH" "$APP_VERSION"
import hashlib
import json
import pathlib
import subprocess
import sys

root = pathlib.Path(sys.argv[1])
manifest_path = pathlib.Path(sys.argv[2])
app_version = sys.argv[3]

required_paths = [
    "devnet/lean15/node-inventory.csv",
    "devnet/lean15/hosts.env.example",
    "devnet/lean15/configs",
    "devnet/lean15/installers",
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

ignored_names = {
    ".DS_Store",
    "Thumbs.db",
}

tracked_files = None
tracked_file_modes = None

def sha256_file(path: pathlib.Path, normalize_eol: bool = False) -> str:
    """Hash a file, optionally collapsing CRLF to LF for tracked text files."""
    with path.open("rb") as fh:
        content = fh.read()
    if normalize_eol:
        content = content.replace(b"\r\n", b"\n")
    return hashlib.sha256(content).hexdigest()

def should_hash(path: pathlib.Path) -> bool:
    return not any(part.startswith(".") or part in ignored_names for part in path.parts)

def load_tracked_files():
    try:
        output = subprocess.run(
            ["git", "-C", str(root), "ls-files"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    except Exception:
        return None
    return {line.strip() for line in output.splitlines() if line.strip()}

def load_tracked_file_modes():
    try:
        output = subprocess.run(
            ["git", "-C", str(root), "ls-files", "--eol"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    except Exception:
        return None

    modes = {}
    for line in output.splitlines():
        if not line.strip():
            continue
        parts = line.split(None, 3)
        if len(parts) != 4:
            continue
        index_mode, worktree_mode, _attr_mode, rel_path = parts
        modes[rel_path] = {
            "is_binary": index_mode == "i/-text" or worktree_mode == "w/-text",
        }
    return modes

def should_normalize_eol(rel_str: str) -> bool:
    if tracked_file_modes is None:
        return False
    mode = tracked_file_modes.get(rel_str)
    return bool(mode) and not mode["is_binary"]

tracked_files = load_tracked_files()
tracked_file_modes = load_tracked_file_modes()

checksums = {}
for rel in checksum_targets:
    path = root / rel
    if path.is_file():
        checksums[rel] = sha256_file(path, normalize_eol=False)

bundle_hasher = hashlib.sha256()
for rel in required_paths:
    path = root / rel
    bundle_hasher.update(rel.encode("utf-8"))
    if path.is_file():
        rel_path = path.relative_to(root)
        rel_str = str(rel_path)
        if not should_hash(rel_path):
            continue
        if tracked_files is not None and rel_str not in tracked_files:
            continue
        bundle_hasher.update(
            sha256_file(path, normalize_eol=should_normalize_eol(rel_str)).encode("utf-8")
        )
        continue
    if path.is_dir():
        for child in sorted(p for p in path.rglob("*") if p.is_file()):
            rel_path = child.relative_to(root)
            rel_str = str(rel_path)
            if not should_hash(rel_path):
                continue
            if tracked_files is not None and rel_str not in tracked_files:
                continue
            bundle_hasher.update(rel_str.encode("utf-8"))
            bundle_hasher.update(
                sha256_file(child, normalize_eol=should_normalize_eol(rel_str)).encode("utf-8")
            )

bundle_digest = bundle_hasher.hexdigest()

manifest = {
    "workspace_resource_version": f"{app_version}+{bundle_digest[:12]}",
    "app_version": app_version,
    "bundle_digest": bundle_digest,
    "required_paths": required_paths,
    "checksums": checksums,
}

with open(str(manifest_path), "w", encoding="utf-8", newline="\n") as _fh:
    _fh.write(json.dumps(manifest, indent=2) + "\n")
PY

echo "Workspace manifest ready: $MANIFEST_PATH"
