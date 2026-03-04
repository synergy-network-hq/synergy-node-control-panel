#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# release.sh — Cut a new release of the Synergy Devnet Control Center
# ─────────────────────────────────────────────────────────────────────────────
# Usage:
#   ./scripts/release.sh <version>
#
# Example:
#   ./scripts/release.sh 2.0.2
#
# This script will:
#   1. Validate the version string
#   2. Bump the version in all config files (package.json, Cargo.toml,
#      tauri.conf.json, Layout.jsx)
#   3. Commit the version bump
#   4. Create a git tag (v2.0.2)
#   5. Push the tag to origin, which triggers the GitHub Actions release build
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <version>"
  echo "Example: $0 2.0.2"
  exit 1
fi

VERSION="$1"
TAG="v${VERSION}"

# Validate version format (semver: major.minor.patch)
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: Version must be in semver format (e.g., 2.0.2)" >&2
  exit 1
fi

# Check for uncommitted changes
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: You have uncommitted changes. Commit or stash them first." >&2
  git status --short
  exit 1
fi

# Check if tag already exists
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: Tag $TAG already exists." >&2
  exit 1
fi

echo "Releasing version $VERSION (tag: $TAG)"
echo ""

# ── Bump version in all files ──
echo "Bumping version in package.json..."
sed -i.bak "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" package.json
rm -f package.json.bak

echo "Bumping version in src-tauri/Cargo.toml..."
sed -i.bak "s/^version = \"[^\"]*\"/version = \"$VERSION\"/" src-tauri/Cargo.toml
rm -f src-tauri/Cargo.toml.bak

echo "Bumping version in src-tauri/tauri.conf.json..."
sed -i.bak "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" src-tauri/tauri.conf.json
rm -f src-tauri/tauri.conf.json.bak

echo "Bumping version in src/components/Layout.jsx..."
sed -i.bak "s/const APP_VERSION = '[^']*'/const APP_VERSION = '$VERSION'/" src/components/Layout.jsx
rm -f src/components/Layout.jsx.bak

# Update Cargo.lock if it exists
if [[ -f src-tauri/Cargo.lock ]]; then
  echo "Updating Cargo.lock..."
  (cd src-tauri && cargo generate-lockfile 2>/dev/null || true)
fi

echo ""
echo "Version bumped to $VERSION in all files."
echo ""

# ── Commit and tag ──
git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json src/components/Layout.jsx
git add src-tauri/Cargo.lock 2>/dev/null || true
git commit -m "chore: bump version to $VERSION"
git tag -a "$TAG" -m "Release $TAG"

echo ""
echo "Created commit and tag $TAG."
echo ""

# ── Push ──
read -p "Push tag $TAG to origin? This will trigger the release build. [y/N] " confirm
if [[ "$confirm" =~ ^[Yy]$ ]]; then
  git push origin HEAD
  git push origin "$TAG"
  echo ""
  echo "Pushed! The GitHub Actions release build is now running."
  echo "Monitor progress at: https://github.com/synergy-network-hq/devnet-control-panel/actions"
  echo ""
  echo "Once complete, installers will be available at:"
  echo "  https://github.com/synergy-network-hq/devnet-control-panel-releases/releases/tag/$TAG"
else
  echo ""
  echo "Tag created locally but not pushed. Push manually with:"
  echo "  git push origin HEAD && git push origin $TAG"
fi
