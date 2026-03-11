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
tracked_eol_info = None

# Text extensions whose line endings should be normalised (CRLF→LF) before
# hashing so that Windows and Unix checkouts produce the same bundle digest.
_TEXT_EXTENSIONS = {
    ".json", ".toml", ".sh", ".ps1", ".env", ".txt",
    ".csv", ".md", ".html", ".js", ".ts", ".yaml", ".yml", ".rs",
}
_TEXT_NAME_SUFFIXES = {
    ".env.example",
}

def sha256_file(path: pathlib.Path, normalize_eol: bool = True) -> str:
    """Hash a file.  For known text extensions, CRLF is collapsed to LF
    before hashing when normalize_eol=True so that Windows CI runners and
    Unix developers produce the same digest for the same committed content.
    Binary files (executables, etc.) are hashed from their raw bytes."""
    with path.open("rb") as fh:
        content = fh.read()
    if normalize_eol and should_normalize_eol(path):
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

def load_tracked_eol_info():
    try:
        output = subprocess.run(
            ["git", "-C", str(root), "ls-files", "--eol"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    except Exception:
        return None

    info = {}
    for line in output.splitlines():
        if "\t" not in line:
            continue
        meta, rel_path = line.split("\t", 1)
        parts = meta.split()
        if len(parts) < 2:
            continue
        index_token = parts[0][2:] if parts[0].startswith("i/") else ""
        worktree_token = parts[1][2:] if parts[1].startswith("w/") else ""
        info[rel_path] = (index_token, worktree_token)
    return info

def should_normalize_eol(path: pathlib.Path) -> bool:
    rel_path = str(path.relative_to(root))

    if tracked_eol_info is not None:
        eol_info = tracked_eol_info.get(rel_path)
        if eol_info is not None:
            index_eol, worktree_eol = eol_info
            return any(token and token != "-text" for token in (index_eol, worktree_eol))

    if path.suffix.lower() in _TEXT_EXTENSIONS:
        return True

    return any(path.name.endswith(suffix) for suffix in _TEXT_NAME_SUFFIXES)

tracked_files = load_tracked_files()
tracked_eol_info = load_tracked_eol_info()

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
        bundle_hasher.update(sha256_file(path).encode("utf-8"))
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
            bundle_hasher.update(sha256_file(child).encode("utf-8"))

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
