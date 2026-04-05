#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

host_os="$(uname -s)"

# --- Platform binaries ---------------------------------------------------------
# The three testbeta platform binaries are the only bundled assets that must
# exist. Configs, installers, and keys are not included in the Electron app
# and must not be validated here.

unix_binaries=(
  "binaries/synergy-testbeta-darwin-arm64"
  "binaries/synergy-testbeta-linux-amd64"
)

windows_binaries=(
  "binaries/synergy-testbeta-windows-amd64.exe"
)

for binary_path in "${unix_binaries[@]}"; do
  if [[ ! -f "$binary_path" ]]; then
    echo "Missing platform binary: $binary_path" >&2
    exit 1
  fi
  if [[ ! "$host_os" =~ ^(MINGW|MSYS|CYGWIN) ]] && [[ ! -x "$binary_path" ]]; then
    echo "Platform binary is not executable: $binary_path" >&2
    exit 1
  fi
done

for binary_path in "${windows_binaries[@]}"; do
  if [[ ! -f "$binary_path" ]]; then
    echo "Missing platform binary: $binary_path" >&2
    exit 1
  fi
done

# --- Workspace manifest --------------------------------------------------------
if [[ ! -f "testbeta/runtime/workspace-manifest.json" ]]; then
  echo "Missing workspace manifest: testbeta/runtime/workspace-manifest.json" >&2
  exit 1
fi

# Detect stale manifest (manifest content differs from what the binaries produce).
# This is expected on the very first run after binaries change — commit the
# updated manifest and re-run to clear this check.
if [[ "${ALLOW_DIRTY_BUNDLE_PREP:-0}" != "1" ]]; then
  BUNDLE_PATHS=(testbeta/runtime/workspace-manifest.json)

  untracked="$(git status --short --untracked-files=all -- "${BUNDLE_PATHS[@]}" | grep '^??' || true)"
  content_diff="$(git diff --ignore-cr-at-eol -- "${BUNDLE_PATHS[@]}" 2>/dev/null || true)"

  if [[ -n "$untracked" || -n "$content_diff" ]]; then
    echo "workspace-manifest.json is stale. Commit it and re-run bundle prep." >&2
    git status --short --untracked-files=all -- "${BUNDLE_PATHS[@]}" >&2 || true
    git diff --ignore-cr-at-eol -- "${BUNDLE_PATHS[@]}" >&2 || true
    exit 1
  fi
fi

echo "Bundled assets validated."
