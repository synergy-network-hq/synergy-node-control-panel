# Synergy Devnet — Command Reference

All paths are relative to the repo root unless stated otherwise.

---

## 1. Control Panel (Electron App)

These commands are for developing, building, and running the desktop control panel application itself.

### `npm run dev:desktop`
**Run from:** repo root
**What it does:** Starts the Vite renderer and launches the Electron shell against it. The Electron main process starts the local Rust `control-service` on demand.

### `npm run build:control-service`
**Run from:** repo root
**What it does:** Compiles the local Rust `control-service` binary used by Electron.

### `npm run dist:electron`
**Run from:** repo root
**What it does:** Builds the renderer, stages the `control-service` runtime, and packages a production Electron installer for the current platform only (macOS → `.dmg`, Linux → `.deb`, Windows → `.exe`).

### `npm run dev`
**Run from:** repo root
**What it does:** Starts the Vite frontend dev server only. Useful for pure UI work in a browser. Desktop-only Electron bridge calls will not work there.

### `npm run build`
**Run from:** repo root
**What it does:** Compiles the React frontend to `dist/`. Called automatically as part of `dist:electron` and the release preflight. Rarely needed on its own.

### `npm install`
**Run from:** repo root
**What it does:** Installs or updates Node.js dependencies (`node_modules/`). Run this after pulling changes that modify `package.json`.

---

## 2. Agent (Service Worker) Binary

The **devnet agent** (`synergy-devnet-agent`) is the lightweight service worker that runs on each remote devnet machine. It exposes an HTTP control API at port 47990, letting the control panel start/stop/reset nodes without SSH.

### `scripts/build-sidecars.sh`
**Run from:** repo root
**What it does (default — no args):** Compiles the agent for the current native platform and copies the binary to `binaries/synergy-devnet-agent-<platform>`. This is the most common variant and is also used by CI.

```bash
bash scripts/build-sidecars.sh
```

**Flags:**

| Flag | What it does |
|---|---|
| *(none)* | Build for the native platform only (macOS arm64 → `darwin-arm64`, etc.) |
| `--linux` | Cross-compile for `x86_64-unknown-linux-gnu` → `binaries/synergy-devnet-agent-linux-amd64` using `cargo-zigbuild` (no Docker) |
| `--windows` | Cross-compile for `x86_64-pc-windows-gnu` → `binaries/synergy-devnet-agent-windows-amd64.exe` using `cargo-zigbuild` (no Docker) |
| `--all` | Native + linux-amd64 + linux-arm64 + windows-amd64 — builds all remote-deployment targets in one shot |

**One-time setup for `--linux`, `--windows`, or `--all` (macOS):**
```bash
brew install zig
cargo install cargo-zigbuild
rustup target add x86_64-unknown-linux-gnu        # required for --linux / --all
rustup target add aarch64-unknown-linux-gnu       # required for --all (linux-arm64)
rustup target add x86_64-pc-windows-gnu           # required for --windows / --all
```

**CI variant (used in `release.yml`):** The workflow sets `CARGO_BUILD_TARGET=<triple>` and calls `bash scripts/build-sidecars.sh` with no flags. Each GitHub Actions runner builds its own platform natively, so `cargo-zigbuild` is not needed in CI.

**Why these binaries matter:** `binaries/` is bundled into the Electron app as extra resources. When you click **Update Agent** in the control panel, `deploy_agent()` copies the matching binary from this directory to the remote machine over SSH. If `synergy-devnet-agent-linux-amd64` is missing, all agent deployments to Linux machines will fail with "binary not found".

---

## 3. Node Installer Bundles

Node installer bundles are per-node archives deployed to remote machines during initial setup. They contain the `synergy-devnet` binary, config, keys, and a startup script.

### `scripts/devnet15/build-node-installers.sh`
**Run from:** repo root
**What it does:** Assembles per-node installer bundles under `devnet/lean15/installers/<node-slot-id>/`. Each bundle is uploaded to the corresponding remote machine by `remote-node-orchestrator.sh install_node`. The script resolves platform binaries automatically — it prefers freshly compiled binaries in `target/` and falls back to pre-built binaries in `binaries/`.

```bash
bash scripts/devnet15/build-node-installers.sh
```

**Required before running:** The appropriate `synergy-devnet` binary must exist in `target/release/`, `target/x86_64-unknown-linux-gnu/release/`, or `binaries/` (fallback).

---

## 4. Remote Node Operations (Orchestrator)

All remote node actions (both SSH-based and agent-based) go through a single script.

### `scripts/devnet15/remote-node-orchestrator.sh`
**Run from:** repo root
**What it does:** Executes a single operation on a single remote node. The control panel calls this script internally through the local Rust `control-service`. You can also invoke it directly from the terminal.

```bash
bash scripts/devnet15/remote-node-orchestrator.sh <node-slot-id> <operation>
```

**Examples:**
```bash
bash scripts/devnet15/remote-node-orchestrator.sh node-03 status
bash scripts/devnet15/remote-node-orchestrator.sh node-07 start
bash scripts/devnet15/remote-node-orchestrator.sh node-14 logs
bash scripts/devnet15/remote-node-orchestrator.sh node-01 deploy_agent
```

**Node slot IDs:** `node-01` through `node-25` (23 nodes total — `node-19` and `node-21` do not exist)

**Operations:**

| Operation | What it does |
|---|---|
| `start` | Starts the node (`nodectl start`) |
| `stop` | Stops the node (`nodectl stop`) |
| `restart` | Restarts the node (`nodectl restart`) |
| `status` | Returns node running status (`nodectl status`) |
| `logs` | Tails the last 120 lines of node logs |
| `export_logs` | Downloads a full logs archive to `devnet/lean15/reports/remote-exports/` |
| `install_node` | Copies the installer bundle from `devnet/lean15/installers/<id>/` to the remote machine |
| `setup_node` | Copies installer bundle and runs `install_and_start.sh` — full first-time node setup |
| `bootstrap_node` | Same as `setup_node` — alias used during genesis bootstrap |
| `reset_chain` | Stops the node, deletes all chain state on the remote machine, and redeploys config. Does **not** restart — use `start` afterward |
| `sync_node` | Runs the custom sync operation defined in the node's recipe |
| `deploy_agent` | SCPs the matching `binaries/synergy-devnet-agent-<platform>` binary to the remote machine and installs/restarts it as a systemd service. Requires the binary to already exist in `binaries/` |
| `explorer_reset` | Triggers the block explorer to reindex from the remote machine using VPN-safe routing |
| `view_chain_data` | Shows chain data directory size and top files on the remote machine |
| `export_chain_data` | Downloads a chain data archive to `devnet/lean15/reports/remote-exports/` |
| `info` | Prints resolved host/SSH/path config for this node — useful for debugging connectivity |

**Node-type-specific operations** (only valid for the appropriate node role):

| Operation | Role | What it does |
|---|---|---|
| `rotate_vrf_key` | Validator | Rotates the VRF keypair and restarts |
| `verify_archive_integrity` | Archive Validator | Verifies retained chain data integrity |
| `flush_relay_queue` | Relayer | Force-submits pending relay messages |
| `force_feed_update` | Oracle | Triggers an immediate price feed refresh |
| `drain_compute_queue` | Compute | Stops accepting tasks and finishes active ones |
| `reload_models` | AI Inference | Hot-reloads AI model weights |
| `rotate_pqc_keys` | PQC Crypto | Rotates post-quantum keys (Aegis Suite) |
| `run_pqc_benchmark` | PQC Crypto | Benchmarks PQC signing/verification |
| `trigger_da_sample` | Data Availability | Triggers a data availability sampling round |
| `reindex_from_height` | Indexer | Reindexes from genesis |

**How routing works:** The orchestrator tries the agent HTTP API first (`http://<vpn_ip>:47990/v1/control`). If the agent is unreachable it falls back to SSH. The `deploy_agent` operation always uses SSH (by design — the agent can't update itself).

**Environment / config:** The script reads `devnet/lean15/hosts.env` for SSH credentials and VPN IPs. Override specific machines with env vars like `NODE_03_HOST`, `NODE_03_SSH_KEY`, etc.

---

## 5. Local Node Runner (for locally-hosted nodes)

### `scripts/devnet15/run-node.sh`
**Run from:** repo root
**What it does:** Starts, stops, or checks a node that runs locally (on the same machine as the control panel). Used for locally-hosted nodes and by the reset script.

```bash
bash scripts/devnet15/run-node.sh <action> <node-slot-id> [--follow]
```

**Actions:** `start`, `stop`, `restart`, `status`, `logs`

**Flags:**
- `--follow` — Only valid with `logs`. Streams the log file live (`tail -f`) instead of showing the last 100 lines.

**Examples:**
```bash
bash scripts/devnet15/run-node.sh start node-01
bash scripts/devnet15/run-node.sh logs node-01 --follow
bash scripts/devnet15/run-node.sh status node-03
```

---

## 6. Devnet Reset

### `scripts/devnet15/reset-devnet.sh` (via `scripts/reset-devnet.sh`)
**Run from:** repo root
**What it does:** Full closed-devnet reset workflow. Stops all nodes, clears all chain/token/validator state locally and on all remote machines, re-renders configs, regenerates deterministic genesis, then optionally rebuilds installers. Nodes are intentionally **not** restarted — use **Start All** from the control panel dashboard when ready.

```bash
bash scripts/reset-devnet.sh
```

**Flags:**

| Flag | What it does |
|---|---|
| `--rebuild-installers` | Also rebuilds all node installer bundles after the reset (calls `build-node-installers.sh`) |
| `--skip-restart` | Skip the final cluster restart (default is already skip — nodes don't restart after reset) |
| `--hosts-file <path>` | Override the default `devnet/lean15/hosts.env` with a custom hosts file |

---

## 7. Release — Publishing a New Control Panel Version

### `scripts/release.sh <version>`
**Run from:** repo root
**What it does:** The single command to cut and publish a new release. Bumps the version in `package.json` and `src-tauri/Cargo.toml`, runs the release preflight checks, commits the version bump, creates a git tag, and pushes it to origin — which triggers the GitHub Actions release build.

```bash
bash scripts/release.sh 2.11.0
```

**What it does step by step:**
1. Validates the version string is valid semver (`major.minor.patch`)
2. Checks there are no uncommitted changes (exits if there are)
3. Bumps the version in `package.json` and `src-tauri/Cargo.toml`
4. Runs `scripts/release/preflight.sh` (see below)
5. Commits the version bump
6. Creates an annotated git tag (`v2.11.0`)
7. Asks for confirmation, then pushes the branch and tag to `origin`

Pushing the tag triggers `.github/workflows/release.yml`, which builds the app for all platforms and publishes the installers to the releases repo.

---

### `scripts/release/preflight.sh`
**Run from:** repo root (called automatically by `release.sh`)
**What it does:** Validates everything is in order before a release is cut. Can also be run standalone to check readiness without actually publishing.

```bash
bash scripts/release/preflight.sh
```

**Checks it performs:**
- Version strings in `package.json` and `Cargo.toml` match
- Electron packaging metadata exists in `electron-builder.yml`
- Frontend builds cleanly (`npm run build`)
- The local Rust control-service compiles cleanly (`cargo check --bin control-service --no-default-features`)
- The Electron runtime bundle can be staged for packaging

---

## 8. Full Release Workflow Summary

```
1.  Make and commit your changes
2.  bash scripts/build-sidecars.sh --all   # build all agent binaries locally (optional — CI does this too)
3.  bash scripts/release.sh <version>       # bumps versions, runs preflight, tags, pushes
    └─ triggers GitHub Actions release.yml
       └─ build: runs Electron packaging on macOS / Linux / Windows
          └─ uploads installers as GitHub Actions artifacts
```

**Monitor the build:** `https://github.com/synergy-network-hq/devnet-control-panel/actions`
**Installers published to:** `https://github.com/synergy-network-hq/devnet-control-panel-releases/releases`

---

## 9. Quick Reference Table

| Command | Run From | Purpose |
|---|---|---|
| `npm run dev:desktop` | repo root | Dev mode — Vite renderer + Electron shell |
| `npm run build:control-service` | repo root | Build the local Rust control-service |
| `npm run dist:electron` | repo root | Build production installer for current platform |
| `npm install` | repo root | Install/update Node dependencies |
| `bash scripts/build-sidecars.sh` | repo root | Build agent binary for current platform |
| `bash scripts/build-sidecars.sh --linux` | repo root | Cross-compile agent for Linux (zigbuild) |
| `bash scripts/build-sidecars.sh --windows` | repo root | Cross-compile agent for Windows (zigbuild) |
| `bash scripts/build-sidecars.sh --all` | repo root | Build agent for all remote platforms |
| `bash scripts/devnet15/build-node-installers.sh` | repo root | Assemble per-node installer bundles |
| `bash scripts/devnet15/remote-node-orchestrator.sh <id> <op>` | repo root | Run any operation on a remote node (node-01–node-25, excl. node-19/21) |
| `bash scripts/devnet15/run-node.sh <action> <id>` | repo root | Start/stop/status a locally-hosted node |
| `bash scripts/reset-devnet.sh` | repo root | Full devnet reset (stop + wipe + regenerate) |
| `bash scripts/release.sh <version>` | repo root | Cut and publish a new release |
| `bash scripts/release/preflight.sh` | repo root | Validate release readiness without publishing |
