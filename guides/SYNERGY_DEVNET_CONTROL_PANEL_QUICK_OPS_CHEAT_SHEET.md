# Synergy Devnet Control Panel Quick Ops Cheat Sheet

Version: 2026-02-28
Scope: Daily operations for Synergy closed devnet (`lean15`)

## 1. Core Facts

- Chain ID: `338638`
- Private subnet: `10.50.0.0/24`
- Primary private RPC: `http://10.50.0.13:48650`
- Primary private WS: `ws://10.50.0.13:58650`
- Explorer: `https://devnet-explorer.synergy-network.io`
- Bootnode peers:
  - `10.50.0.1:38638`
  - `10.50.0.2:38639`

## 2. Where Things Live

- App workspace (macOS): `~/.synergy-devnet-control-panel/monitor-workspace`
- App workspace (Linux): `~/.synergy-devnet-control-panel/monitor-workspace`
- App workspace (Windows): `%USERPROFILE%\.synergy-devnet-control-panel\monitor-workspace`

Critical files:

- Inventory: `devnet/lean15/node-inventory.csv`
- Host overrides + Atlas URL: `devnet/lean15/hosts.env`
- WireGuard configs: `devnet/lean15/wireguard/configs/`
- Security/RBAC: `config/security.json`
- Audit log: `audit/control-actions.jsonl`

Hard rules:

- Run `generate-monitor-hosts-env.sh` before `generate-wireguard-mesh.sh`.
- `MACHINE_XX_HOST` must be bootstrap-reachable (LAN/public/DNS), not a placeholder.
- `MACHINE_XX_VPN_IP` stays in `10.50.0.0/24` for overlay traffic.
- Do not move WG artifacts out of `devnet/lean15/wireguard/`.

## 3. First Operator Fast Path

From workspace root:

```bash
./scripts/devnet15/generate-monitor-hosts-env.sh
./scripts/devnet15/generate-wireguard-mesh.sh
```

Important:

- Saving an SSH profile does not generate SSH keys.
- Generate your operator key first: `ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -C "synergy-devnet-ops" -N ""`
- If only machine-01 exists, set machine-01 host/user first and avoid `scope=all`.
- For machine-01 on operator machine: set `MACHINE_01_HOST=127.0.0.1` (or LAN IP) and local SSH user.

In app (Settings -> Operator Configuration):

1. Set active operator to `admin`.
2. Configure SSH profile + SSH bindings.
3. Single-machine bootstrap (machine-01 scope):
   - `wireguard_install`
   - `wireguard_connect`
   - `wireguard_status`
4. Fleet bootstrap (only after hosts are populated):
   - `wireguard_install`
   - `wireguard_connect`
   - `wireguard_status`
5. Start nodes by groups:
   - consensus core (`node-01`,`node-02`,`node-04`,`node-06`,`node-08`,`node-09`,`node-16`,`node-17`)
   - governance (`node-10`,`node-24`,`node-25`)
   - interop (`node-05`,`node-07`,`node-11`,`node-12`,`node-22`)
   - services (`node-03`,`node-13`,`node-14`)
   - compute/pqc (`node-15`,`node-18`,`node-20`,`node-23`)

## 4. Daily Health Checks (App)

Run these bulk actions:

1. `status` on `all`
2. `rpc:get_sync_status` on `all`
3. `rpc:get_peer_info` on `all`
4. `rpc:get_latest_block` on `all`
5. `rpc:get_validator_activity` on `role_group:consensus`
6. `rpc:get_sxcp_status` and `rpc:get_relayer_set` on `role_group:interop`

Node page checks:

- `Role Execution Status` should be `healthy` or `degraded` (investigate `critical` immediately).
- `Atlas Explorer Bridge` should show `connected`.

## 5. WireGuard Quick Commands

Linux/macOS:

```bash
sudo wg show
```

macOS interface check:

```bash
ifconfig | rg utun
ifconfig <utunX> | rg 10.50
```

Windows PowerShell:

```powershell
Get-Service WireGuardManager
```

If `wireguard_connect` fails:

1. Regenerate mesh: `./scripts/devnet15/generate-wireguard-mesh.sh`
2. Confirm machine config exists: `devnet/lean15/wireguard/configs/<machine-id>.conf`
3. Confirm UDP WG ports `51820-51834` are open between node hosts.
4. Confirm `MACHINE_XX_HOST` is not an unresolved placeholder.

If `wg-quick up` says `Address already in use` (macOS):

```bash
sudo wg-quick down synergy-devnet >/dev/null 2>&1 || true
sudo pkill wireguard-go || true
sudo chmod 600 /etc/wireguard/synergy-devnet.conf
sudo wg-quick up synergy-devnet
sudo wg show
```

If `sudo wg show synergy-devnet` says `No such file or directory` on macOS:

- Run `sudo wg show` and inspect the active `utunX` interface instead.

## 6. Determinism + Test Shortcuts

```bash
./scripts/devnet15/check-determinism.sh
./scripts/devnet15/run-devnet-test-phases.sh --rpc-url http://10.50.0.13:48650
./scripts/devnet15/load-generator.sh --rpc-url http://10.50.0.13:48650 --rpm 10000 --minutes 1
```

## 7. Reset Devnet (Deterministic)

```bash
./scripts/reset-devnet.sh
```

Does: stop -> clear state -> re-render configs -> regenerate genesis -> restart.

## 8. Most Used Node Actions

Single node page:

- `start`
- `stop`
- `restart`
- `status`
- `setup`
- `export_logs`
- `view_chain_data`
- `export_chain_data`

Custom operations (admin):

- `install_node`
- `bootstrap_node`
- `wireguard_install`
- `wireguard_connect`
- `wireguard_disconnect`
- `wireguard_status`
- `wireguard_restart`

## 9. RBAC Reminder

- `admin`: all actions
- `operator`: no admin-only install/bootstrap/WireGuard connect-disconnect-restart
- `viewer`: read-only

## 10. Troubleshooting 60-Second Triage

1. Node offline:
   - bulk `status` -> node page `node_logs`
2. Sync stuck:
   - check peer count + bootnode reachability
3. Atlas links missing:
   - set `ATLAS_BASE_URL` in `hosts.env`
4. Exports missing:
   - check `devnet/lean15/reports/node-monitor-exports/`
   - check `devnet/lean15/reports/remote-exports/<machine-id>/`

## 11. macOS Installer Output

- App: `tools/devnet-control-panel/src-tauri/target/release/bundle/macos/Synergy Devnet Control Panel.app`
- DMG: `tools/devnet-control-panel/src-tauri/target/release/bundle/dmg/Synergy Devnet Control Panel_<version>_aarch64.dmg`
