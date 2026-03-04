# Release Pipeline Setup Guide

## Overview

The Synergy Devnet Control Center uses a GitHub Actions pipeline to build
cross-platform installers (macOS, Linux, Windows) and publish them to a
**public releases repository** so that:

1. **New machines** can download the installer for their OS from the releases page
2. **Existing installations** can auto-update via the "Check for Updates" button

```
Private source repo                     Public releases repo
(devnet-control-panel)                  (devnet-control-panel-releases)
        │                                        │
        │  push tag v2.0.2                       │
        ├──────────────────►  GitHub Actions      │
        │                     builds for all      │
        │                     platforms           │
        │                            │            │
        │                            ▼            │
        │                     Publishes to  ──────►  Installers + latest.json
        │                                         │  available for download
```

---

## One-Time Setup Steps

### 1. Add secrets to the PRIVATE source repo

Go to **https://github.com/synergy-network-hq/devnet-control-panel/settings/secrets/actions**
and add these two repository secrets:

#### `TAURI_SIGNING_PRIVATE_KEY`

This is the signing key that signs update bundles so the app trusts them.

Recommended: store the **full minisign secret key text** (comment line + payload line),
or store the **base64 of that full text**.
The release workflow normalizes both formats before calling Tauri.

```text
untrusted comment: minisign encrypted secret key
RWQAAE...<base64 minisign secret key payload>...==
```

> **IMPORTANT:** Keep this key secret. Anyone with this key can sign fake
> updates that your app will trust.

#### `RELEASES_REPO_TOKEN`

A GitHub **Personal Access Token** (classic) with `repo` scope, so the
workflow in the private repo can publish releases to the public repo.

To create one:
1. Go to https://github.com/settings/tokens/new
2. Note: "Synergy release publishing"
3. Scopes: check `repo` (full control of private repositories)
4. Generate token
5. Copy and save as `RELEASES_REPO_TOKEN` secret

### 2. Initialize the public releases repo

The releases repo at `synergy-network-hq/devnet-control-panel-releases`
should be **public** and can start empty. The first release build will
create the initial release automatically.

Optionally add a README:

```markdown
# Synergy Devnet Control Center — Releases

Download the latest installer for your platform from the
[Releases page](../../releases).

## Platforms

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `.dmg` |
| macOS (Intel) | `.dmg` |
| Linux (x86_64) | `.deb` or `.AppImage` |
| Windows (x86_64) | `.msi` or `.exe` |

## Auto-Update

If you already have the control panel installed, click **Check for Updates**
in the top-right corner of the app. It will automatically detect and install
new versions.
```

---

## How to Cut a Release

### Option A: Use the release script (recommended)

```bash
./scripts/release.sh 2.0.2
```

This bumps the version everywhere, commits, tags, and pushes.

### Option B: Manual steps

```bash
# 1. Bump version in: package.json, src-tauri/Cargo.toml,
#    src-tauri/tauri.conf.json, src/components/Layout.jsx
# 2. Commit
git add -A && git commit -m "chore: bump version to 2.0.2"
# 3. Tag
git tag -a v2.0.2 -m "Release v2.0.2"
# 4. Push (triggers the build)
git push origin main && git push origin v2.0.2
```

### Option C: Manual workflow trigger

Go to **Actions** → **Release Build** → **Run workflow** and enter
the tag name (e.g., `v2.0.2`).

---

## How Updates Work

1. The app checks `latest.json` from the releases repo on startup and
   every 30 minutes
2. `latest.json` contains the latest version number and download URLs
   for each platform
3. If a newer version exists, the button changes to **Update Available**
4. Clicking it downloads and installs the update, then restarts the app
5. Update bundles are signed with the minisign keypair — the app
   verifies the signature before installing

### Update endpoint

```
https://github.com/synergy-network-hq/devnet-control-panel-releases/releases/latest/download/latest.json
```

This URL always resolves to the `latest.json` from the most recent release.

---

## Signing Key Info

| Key | Value |
|-----|-------|
| Algorithm | Ed25519 (minisign format) |
| Public key | `RWQxnDMVv5SoUaCTmMNFSYlJEbV/1QANtbT06D5QPSWg0sBPNYTDP6U6` |
| Public key location | `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` |
| Private key location | GitHub secret `TAURI_SIGNING_PRIVATE_KEY` |

If the private key is ever compromised, generate a new keypair, update
the pubkey in `tauri.conf.json`, update the GitHub secret, and release
a new version. All machines will need to manually update one last time
(since the old key signed that build).
