#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# release.sh — Cut a new release of the Synergy Node Control Panel
# ─────────────────────────────────────────────────────────────────────────────
# Usage:
#   ./scripts/release.sh <version>
#
# Example:
#   ./scripts/release.sh 2.0.2
#
# This script will:
#   1. Validate the version string
#   2. Bump the version in package.json and control-service/Cargo.toml
#   3. Run local release preflight checks, including an Electron runtime build
#   4. Commit the version bump
#   5. Create a git tag (v2.0.2)
#   6. Push the tag to origin, which triggers the GitHub Actions release build
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

echo "Bumping version in control-service/Cargo.toml..."
sed -i.bak "s/^version = \"[^\"]*\"/version = \"$VERSION\"/" control-service/Cargo.toml
rm -f control-service/Cargo.toml.bak

# Update Cargo.lock if it exists
if [[ -f control-service/Cargo.lock ]]; then
  echo "Updating Cargo.lock..."
  (cd control-service && cargo generate-lockfile 2>/dev/null || true)
fi

echo ""
echo "Version bumped to $VERSION in all files."
echo ""

echo "Regenerating bundled release assets for $VERSION..."
ALLOW_DIRTY_BUNDLE_PREP=1 npm run build:bundle-prep
echo ""
echo "Bundled release assets refreshed."
echo ""

echo "Running release preflight..."
chmod +x scripts/release/preflight.sh scripts/release/generate-latest-json.sh
./scripts/release/preflight.sh
echo ""
echo "Preflight passed."
echo ""

# ── Commit and tag ──
git add package.json control-service/Cargo.toml
git add control-service/Cargo.lock 2>/dev/null || true
git add testbeta/runtime/configs testbeta/runtime/installers testbeta/runtime/workspace-manifest.json
git add scripts/release/preflight.sh scripts/release/generate-latest-json.sh .github/workflows/release.yml 2>/dev/null || true
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
  echo "Monitor progress at: https://github.com/synergy-network-hq/testbeta-control-panel/actions"
  echo ""
  echo "Once complete, download the generated installers from the workflow artifacts"
  echo "or publish them to the releases repo for distribution."
else
  echo ""
  echo "Tag created locally but not pushed. Push manually with:"
  echo "  git push origin HEAD && git push origin $TAG"
fi
