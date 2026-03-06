# Synergy Devnet Control Panel

This app is the desktop operator console for the Synergy closed devnet.

It ships the 25-slot inventory in `devnet/lean15/node-inventory.csv`, the rendered node configs, installer bundles, WireGuard assets, and the in-app operator manual used by the Help view.

Core responsibilities:

- monitor node-slot health and sync state
- bootstrap and operate the closed devnet from one control surface
- manage SSH/RBAC/operator bindings for the 13 physical machines
- check for signed app updates and install new releases

## Run (Desktop Dev)

From this directory:

```bash
npm install
npm run tauri:dev
```

## Build App Bundle

```bash
npm run tauri:build
```

## Inventory Resolution

The monitor resolves the inventory file in this order:

1. `SYNERGY_MONITOR_INVENTORY` environment variable (absolute path recommended)
2. relative project paths (for repo-local development)
3. bundled/local fallback path under `devnet/lean15/node-inventory.csv`

### Recommended explicit override

```bash
export SYNERGY_MONITOR_INVENTORY="/absolute/path/to/synergy-devnet/devnet/lean15/node-inventory.csv"
```

On PowerShell:

```powershell
$env:SYNERGY_MONITOR_INVENTORY="C:\absolute\path\to\synergy-devnet\devnet\lean15\node-inventory.csv"
```

## Host Overrides

If your monitor machine cannot resolve the default DNS names (for example `machine01.synergy-devnet.local`), add a `hosts.env` file in the same directory as `node-inventory.csv`.

For WireGuard deployments:

- keep `node-inventory.csv` `host` as monitor/public host identity
- keep `node-inventory.csv` `vpn_ip` for internal P2P identity
- use `hosts.env` only when this monitor machine needs local override behavior

Example:

```dotenv
machine-01=10.0.0.21
machine-02=10.0.0.22
machine-03=10.0.0.23
machine-04=10.0.0.24
machine-05=10.0.0.25
machine-06=10.0.0.26
machine-07=10.0.0.27
machine-08=10.0.0.28
machine-09=10.0.0.29
machine-10=10.0.0.30
machine-11=10.0.0.31
machine-12=10.0.0.32
machine-13=10.0.0.33
```
