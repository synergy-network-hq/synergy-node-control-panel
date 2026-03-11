# Synergy Devnet Control Panel

This app is the desktop operator console for the Synergy closed devnet.

It ships the active node-slot inventory in `devnet/lean15/node-inventory.csv`, rendered node configs, installer bundles, WireGuard assets, and the in-app operator manual used by the Help window.

## Core Responsibilities

- monitor node-slot health and sync state
- bootstrap and operate the closed devnet from one control surface
- manage SSH/RBAC/operator bindings for the fleet
- check for signed app updates and install published releases

## WireGuard Control Agent

The control panel now ships a small local machine agent for the core fleet-control actions:

- `start`
- `stop`
- `restart`
- `status`
- `setup_node`
- `install_node`
- `bootstrap_node`
- `reset_chain`
- `logs`

Behavior:

- On app launch, the control panel extracts the bundled agent into the monitor workspace and starts it locally.
- The dashboard/node-control path now prefers the agent over the WireGuard VPN and falls back to SSH only if the agent is unavailable.
- `scripts/devnet15/reset-devnet.sh` also prefers the agent for `stop`, `reset_chain`, and `start`.

Operational requirement:

- Each machine must run the updated control panel once so its local agent is installed and started.
- Older installs without the agent will continue to fall back to SSH until updated.

## Project Layout

- `src/`: React frontend
- `electron/`: Electron main-process and preload bridge
- `src-tauri/`: Rust/Tauri backend
- `src-tauri/src/bin/control-service.rs`: local Rust control-service used by Electron
- `devnet/lean15/`: inventory, rendered configs, installers, reports, WireGuard assets
- `guides/`: bundled operator manuals used by the app Help window
- `docs/`: current project/reference docs not bundled into the app
- `archive/`: superseded or generated material moved out of the root

## Run (Desktop Dev)

```bash
npm install
npm run build:control-service
npm run dev:desktop
```

## Build App Bundle

```bash
npm run dist:electron
```

Tauri sources remain in `src-tauri/` as reference during the migration, but the active desktop runtime is now Electron plus the local Rust `control-service`.

## Inventory Resolution

The monitor resolves the inventory file in this order:

1. `SYNERGY_MONITOR_INVENTORY` environment variable
2. repo-local relative paths
3. bundled fallback under `devnet/lean15/node-inventory.csv`

Recommended override:

```bash
export SYNERGY_MONITOR_INVENTORY="/absolute/path/to/synergy-devnet/tools/devnet-control-panel/devnet/lean15/node-inventory.csv"
```

PowerShell:

```powershell
$env:SYNERGY_MONITOR_INVENTORY="C:\absolute\path\to\synergy-devnet\tools\devnet-control-panel\devnet\lean15\node-inventory.csv"
```

## Docs

- Project docs index: `docs/README.md`
- Bundled operator manual: `guides/SYNERGY_DEVNET_CONTROL_PANEL_USER_MANUAL.md`
- Bundled quick ops sheet: `guides/SYNERGY_DEVNET_CONTROL_PANEL_QUICK_OPS_CHEAT_SHEET.md`
