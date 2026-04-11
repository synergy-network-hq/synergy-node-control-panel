# Testnet-Beta Validator Update Workflow

This file is the maintainer guide for validator config changes in the Testnet-Beta control panel.

The short version:

- Edit the control-panel generators and workspace builders first.
- Regenerate `testbeta/runtime/` artifacts from those generators.
- Treat `genesis-nodes/...` copies as exports or legacy mirrors, not the primary source of truth.

## Source Of Truth

The control panel is what creates and repairs validator workspaces. The primary edit surface is inside `node-control-panel/`, not inside `genesis-nodes/`.

| File | Role |
| --- | --- |
| `control-service/src/testnet_beta.rs` | Builds the live validator workspace used by the app during `setup_node`, installer import, ceremony import, and workspace repair. If a validator started by the control panel should see a config value, this file usually needs to emit it. |
| `scripts/testbeta/build-node-installers.sh` | Generates the bundled per-node installers under `testbeta/runtime/installers/`, including `config/node.toml`, `config/peers.toml`, startup scripts, and `keys/setup-package.json`. |
| `scripts/testbeta/render-configs.sh` | Generates the canonical rendered configs under `testbeta/runtime/configs/`. Keep this aligned with the installer/runtime config shape so the bundled reference configs match what the control panel deploys. |
| `src/lib/testnetBetaBootstrap.js` | Renderer-side helper that writes bootstrap peer config. Update this when the `peers.toml` structure changes. |
| `scripts/release/build-bundle-prep.sh` | Release prep entry point. Rebuilds deterministic runtime artifacts before packaging the app. |

## Generated Files

Do not hand-edit these unless you are debugging a one-off local issue and plan to throw the changes away:

- `testbeta/runtime/configs/*.toml`
- `testbeta/runtime/installers/*`
- `testbeta/runtime/installers/*/config/peers.toml`
- `testbeta/runtime/installers/*/keys/setup-package.json`

The control panel consumes the generated installer/runtime artifacts above. Editing the generated output without updating the generator guarantees drift on the next rebuild.

## What `genesis-nodes/` Is

`genesis-nodes/` is not the primary control-panel input for validator setup.

Today, the control panel deploys validators from the generated bundles under:

- `testbeta/runtime/installers/`

If `genesis-nodes/.../setup-packages/` or related folders are still kept around, treat them as downstream export copies only. The safe rule is:

1. Update the generator inside `node-control-panel/`.
2. Regenerate installer assets.
3. Sync any legacy `genesis-nodes/` copies from the regenerated control-panel output.

Do not make the same config change independently in both places.

## When A Validator Setting Changes

### Case 1: Existing config key, value change only

Example: changing timeout values, quorum thresholds, peer lists, bootstrap behavior, or startup env.

Update the relevant generators:

1. `control-service/src/testnet_beta.rs`
2. `scripts/testbeta/build-node-installers.sh`
3. `scripts/testbeta/render-configs.sh`
4. `src/lib/testnetBetaBootstrap.js` if `peers.toml` changed

### Case 2: New config key or renamed config key

If the node binary does not already understand the key, first add support in the core node runtime outside the control panel.

Typical examples from the main repo root:

- `../src/config/mod.rs`
- `../src/p2p/networking.rs`
- `../src/consensus/consensus_algorithm.rs`
- `../src/consensus/dual_quorum.rs`

After the runtime supports the key, wire the same key into the control-panel generators listed above.

If the runtime parser and the control-panel generator are not updated together, the app will ship config that the node either ignores or fails to parse.

## Required Update Checklist

Use this checklist every time validator setup behavior changes.

1. Update `control-service/src/testnet_beta.rs` so live app-created validator workspaces use the new values.
2. Update `scripts/testbeta/build-node-installers.sh` so bundled installers and `setup-package.json` carry the same values.
3. Update `scripts/testbeta/render-configs.sh` so bundled reference configs stay aligned.
4. Update `src/lib/testnetBetaBootstrap.js` if `peers.toml` generation changed.
5. If the key is new, update the core runtime parser/consumer in `../src/...`.
6. Regenerate runtime artifacts.
7. Verify generated `node.toml`, `peers.toml`, and `setup-package.json`.
8. Rebuild the app bundle if this is a release or installer handoff.
9. Only after regeneration, sync any legacy `genesis-nodes/` package copies that still need to exist.

## Regenerate Artifacts

Run from `node-control-panel/`:

```bash
bash scripts/testbeta/render-configs.sh
bash scripts/testbeta/build-node-installers.sh
SKIP_BUNDLED_ASSET_GIT_CLEAN_CHECK=1 npm run build:bundle-prep
```

For a release build:

```bash
SKIP_BUNDLED_ASSET_GIT_CLEAN_CHECK=1 npm run build:bundle-prep
npm run dist:electron
```

## Release Order Across Repos

The Testnet-Beta release is coordinated across two repos:

1. `testnet-beta/` contains the node runtime source and the canonical `config/` inputs.
2. `node-control-panel/` contains the desktop app, the bundled `binaries/`, and the shipped `testbeta/runtime/` installer assets.

The control-panel release workflow expects the same tag to exist in both repos.

If you push `node-control-panel` tag `vX.Y.Z` without first pushing `testnet-beta` tag `vX.Y.Z`, GitHub Actions will fail when it tries to check out the runtime repo at that same ref.

Release in this order:

1. Finish and verify the runtime changes in `testnet-beta/`.
2. Refresh the shipped runtime binaries for every supported platform.
3. Sync those binaries into `node-control-panel/binaries/`.
4. Regenerate `node-control-panel/testbeta/runtime/` from those fresh binaries.
5. Commit and push `testnet-beta/`.
6. Create and push the runtime tag.
7. Commit and push `node-control-panel/`.
8. Create and push the matching control-panel tag.
9. Let the control-panel release workflow build and publish the desktop installers.

## Exact Release Sequence

### 1. Runtime repo: `testnet-beta/`

Run from the runtime repo root:

```bash
cargo fmt --manifest-path Cargo.toml --all
```

Run the focused runtime tests that cover the mesh/bootstrap/consensus changes you touched.

Then refresh the shipped runtime binaries so the control panel can package the same code that you just verified:

```bash
# Expected release artifacts used by node-control-panel/binaries:
# binaries/synergy-testbeta-darwin-arm64
# binaries/synergy-testbeta-macos-arm64
# binaries/synergy-testbeta-linux-amd64
# binaries/synergy-testbeta-windows-amd64.exe
```

Commit the runtime repo on `main`, push it, then create and push the matching tag:

```bash
git push origin main
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

### 2. Control-panel repo: `node-control-panel/`

After the runtime repo is pushed and tagged, sync the refreshed node binaries into `node-control-panel/binaries/`.

Then regenerate the bundled runtime assets:

```bash
SKIP_BUNDLED_ASSET_GIT_CLEAN_CHECK=1 npm run build:bundle-prep
```

That step must happen after the runtime binaries are refreshed because it now performs the release prep in this order:

1. Refreshes `binaries/*.sha256` for the shipped node binaries.
2. Syncs canonical genesis into `testbeta/runtime/configs/genesis/genesis.json`.
3. Re-renders `testbeta/runtime/configs/*.toml`.
4. Rebuilds `testbeta/runtime/installers/*`.
5. Rewrites `testbeta/runtime/workspace-manifest.json`.
6. Validates the bundled validator mesh settings.
7. Rebuilds the renderer bundle.

The release workflow passes these env vars into `npm run build:bundle-prep` and the scripts in `scripts/testbeta/` must continue to honor them:

- `SYNERGY_TESTBETA_BINARY_SOURCE_DIR`
- `SYNERGY_TESTBETA_SOURCE_REPO_ROOT`
- `SYNERGY_TESTBETA_CANONICAL_GENESIS_FILE`
- `SYNERGY_TESTBETA_CANONICAL_MANIFEST_FILE`
- `SKIP_BUNDLED_ASSET_GIT_CLEAN_CHECK`

Before tagging, inspect the actual shipped outputs:

- `binaries/synergy-testbeta-*.sha256`
- `testbeta/runtime/installers/GenVal-01/config/node.toml`
- `testbeta/runtime/installers/GenVal-01/config/peers.toml`
- `testbeta/runtime/installers/GenVal-01/keys/setup-package.json`
- `testbeta/runtime/workspace-manifest.json`

If you want a local installer build before pushing the release tag:

```bash
SKIP_BUNDLED_ASSET_GIT_CLEAN_CHECK=1 npm run build:bundle-prep
npm run dist:electron
```

Then commit the control-panel repo on `main`, push it, create the matching tag, and push the tag:

```bash
git push origin main
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

## GitHub Actions Release Behavior

The control-panel release workflow is the final packaging step. It should not be treated as the primary place where validator installer state is authored.

The intended CI order is:

1. Check out `node-control-panel` at `vX.Y.Z`.
2. Check out `testnet-beta` at the same `vX.Y.Z`.
3. Build fresh Testnet-Beta node binaries for macOS, Linux, and Windows.
4. Download those fresh binaries into `node-control-panel/binaries/`.
5. Run bundle prep so `testbeta/runtime/installers/` is regenerated from the fresh binaries and canonical config inputs.
6. Build the desktop app for each supported OS.
7. Publish the generated installers to the releases repo.

If CI rebuilds only the top-level node binaries but does not regenerate `testbeta/runtime/installers/`, the desktop app can still ship stale validator setup bundles.

If CI fails with `Missing operational manifest`, verify that:

1. `scripts/testbeta/render-configs.sh` and `scripts/testbeta/build-node-installers.sh` both honor `SYNERGY_TESTBETA_CANONICAL_MANIFEST_FILE`.
2. The release workflow passes `SYNERGY_TESTBETA_CANONICAL_MANIFEST_FILE` pointing at `testnet-beta-source/config/operational-manifest.json`.
3. The release workflow passes `SYNERGY_TESTBETA_BINARY_SOURCE_DIR=${{ github.workspace }}/binaries` so bundle prep uses the just-downloaded release binaries instead of whatever was committed in the repo checkout.

## Verification

Minimum verification after a validator config change:

```bash
bash -n scripts/testbeta/render-configs.sh
bash -n scripts/testbeta/build-node-installers.sh
cargo test --manifest-path control-service/Cargo.toml setup_node_writes_role_metadata_and_bootstrap_inputs -- --exact
```

Then inspect the generated outputs:

- `testbeta/runtime/installers/GenVal-01/config/node.toml`
- `testbeta/runtime/installers/GenVal-01/config/peers.toml`
- `testbeta/runtime/installers/GenVal-01/keys/setup-package.json`

If the change affects ceremony import or workspace repair, also run the targeted tests that cover those flows.

## Single-Source Rule

If a validator setting is supposed to affect nodes created by the control panel, the control-panel code must be treated as authoritative.

Generated runtime assets are outputs.
`genesis-nodes/` copies are mirrors.
The edit surface is the generator code.
