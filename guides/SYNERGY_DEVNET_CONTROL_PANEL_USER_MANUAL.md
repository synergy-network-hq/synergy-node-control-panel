# Synergy Devnet Control Panel User Manual

Version: 2026-03-06
Applies to: `tools/devnet-control-panel` (desktop app + `devnet/lean15` closed-devnet profile, 23 active node slots across 13 physical machines)

## Table of Contents

1. Scope and Non-Negotiable Devnet Rules
2. Architecture and Workspace Layout
3. Closed Devnet Configuration Reference
4. Full Node/Port/RPC Inventory
5. Pre-Install WireGuard Foundation (Required Before App Install)
6. Install the Synergy Devnet Control Panel App (macOS, Linux, Windows)
7. Required Steps Immediately After App Install
8. First Operator Runbook (Bootstrap the Private Devnet)
9. Subsequent Operator Runbook (Join and Operate Existing Devnet)
10. Node Types: Setup, Monitoring, and Troubleshooting
11. Node Control Action Reference (Single + Bulk)
12. Operator Configuration Page (RBAC, SSH, SSH Binding, Bulk)
13. WireGuard Operations and OS-Specific Procedures
14. Atlas Explorer Integration
15. Observability Stack
16. Devnet Test Phases and Validation Commands
17. Deterministic Reset Procedure
18. Troubleshooting Playbook
19. Known Gaps and Manual Work Remaining
20. Appendix: Monitor RPC Method Map

---

## 1. Scope and Non-Negotiable Devnet Rules

This manual is the operational reference for the Synergy **closed devnet**. It is not a public testnet runbook.

Closed-devnet requirements enforced in this profile:

- **Isolation**
  - P2P discovery disabled (`enable_discovery = false`)
  - Node bind/listen addresses pinned to private WireGuard identities (`10.50.0.0/24`)
  - RPC CORS disabled in generated configs (`cors_enabled = false`, `cors_origins = []`)
- **Determinism**
  - Deterministic config generation from inventory + keys
  - Deterministic genesis generation (`scripts/devnet15/generate-devnet-genesis.sh`)
  - Determinism check (`scripts/devnet15/check-determinism.sh`)
- **Controlled adversity**
  - Explicit load/chaos scripts (`load-generator.sh`, `chaos-node.sh`, phased runner)

If node ports or RPC endpoints are internet-reachable without explicit hardening, treat that as a deployment defect and correct before proceeding.

---

## 2. Architecture and Workspace Layout

The Synergy Devnet Control Panel app is a Tauri desktop application (Rust backend + React frontend).

### 2.1 Workspace locations by OS

The app writes runtime state under `monitor-workspace`.

- **macOS (current)**: `~/.synergy-devnet-control-panel/monitor-workspace`
- **Linux (current)**: `~/.synergy-devnet-control-panel/monitor-workspace`
- **Windows (current)**: `%USERPROFILE%\.synergy-devnet-control-panel\monitor-workspace`

Legacy paths migrated automatically when the new workspace is empty:

- `~/.synergy-node-monitor/monitor-workspace`
- `~/Library/Application Support/com.synergy.node-monitor/monitor-workspace`

The app now prefers the product-aligned workspace path and migrates legacy workspace data when the new workspace is empty.

### 2.2 Files extracted into workspace

- `devnet/lean15/node-inventory.csv`
- `devnet/lean15/hosts.env.example`
- `devnet/lean15/configs/`
- `devnet/lean15/installers/`
- `devnet/lean15/wireguard/`
- `scripts/devnet15/`
- `scripts/reset-devnet.sh`
- `guides/SYNERGY_DEVNET_CONTROL_PANEL_USER_MANUAL.md`

If `devnet/lean15/hosts.env` does not exist, it is copied from `hosts.env.example`.

### 2.3 Security and audit files

- RBAC/SSH profiles: `config/security.json`
- Control action audit log: `audit/control-actions.jsonl`

Default first operator:

- `operator_id`: `local_admin`
- `role`: `admin`

---

## 3. Closed Devnet Configuration Reference

Source files:

- Inventory: `devnet/lean15/node-inventory.csv`
- Rendered configs: `devnet/lean15/configs/node-*.toml`
- Genesis generator: `scripts/devnet15/generate-devnet-genesis.sh`
- Active genesis: `config/genesis.json`

### 3.1 Global network values

- Chain ID: `338638`
- Network ID/name (config): `338638` / `synergy-devnet-closed`
- Genesis network ID (metadata): `synergy-devnet-closed-001`
- Consensus: `PoSy` / `Proof of Synergy`
- Block time: `2s` (`2000ms`)
- Epoch length: `50`
- Validators: min `5`, max `15`
- Quorum threshold: `0.67`
- Discovery: disabled
- Private subnet: `10.50.0.0/24`

### 3.2 Genesis bootnodes and core private endpoints

From `config/genesis.json`:

- Primary private RPC: `http://10.50.0.13:48650`
- Primary private WS: `ws://10.50.0.13:58650`
- Bootnode 1: `snr://synv1daf1ee2c20ed961ec75d713aea4703389327@10.50.0.1:38638`
- Bootnode 2: `snr://synv1f2d0b0caae7e006426408008ceed4946d5eb@10.50.0.2:38639`

### 3.3 Genesis allocation and cryptographic profile

- Token symbol: `SNRG`
- Decimals: `9`
- Burn address: `synergy00000000000000000000000burn`
- Signature algorithm profile: `FN-DSA-1024`
- KEM profile: `ML-KEM-1024`
- Hash: `SHA3-256`
- Security level: `NIST Level 5`

---

## 4. Full Node/Port/RPC Inventory

### 4.1 Port ranges used by the current active slot map

- P2P: `38638-38662`
- RPC (HTTP): `48638-48662`
- WebSocket: `58638-58662`
- gRPC: `50051-50075`
- Discovery (reserved, disabled): `39638-39662`
- WireGuard listen ports (generated mesh default): `51820-51832`

### 4.2 Public-facing devnet service endpoints (Atlas/clients)

Use these only when ingress is intentionally configured for external access:

- Core RPC: `https://devnet-core-rpc.synergy-network.io`
- Core WS: `wss://devnet-core-ws.synergy-network.io`
- EVM RPC: `https://devnet-evm-rpc.synergy-network.io`
- EVM WS: `wss://devnet-evm-ws.synergy-network.io`
- API: `https://devnet-api.synergy-network.io`
- Explorer: `https://devnet-explorer.synergy-network.io`
- Explorer API: `https://devnet-explorer-api.synergy-network.io`
- Indexer API: `https://devnet-indexer.synergy-network.io`
- Faucet: `https://devnet-faucet.synergy-network.io`

### 4.3 Authoritative active node-slot map

| Node Slot | Alias | Role Group | Role | Node Type | Physical Machine | VPN IP | P2P | RPC | WS | Auto Validator | Pruning | VRF |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| node-01 | consensus-01 | consensus | validator | validator | machine-01 | 10.50.0.1 | 38638 | 48638 | 58638 | true | false | true |
| node-02 | consensus-02 | consensus | validator | validator | machine-02 | 10.50.0.2 | 38639 | 48639 | 58639 | true | false | true |
| node-03 | service-01 | services | observer | observer | machine-02 | 10.50.0.2 | 38640 | 48640 | 58640 | false | false | false |
| node-04 | consensus-03 | consensus | validator | validator | machine-03 | 10.50.0.3 | 38641 | 48641 | 58641 | true | false | true |
| node-05 | interop-01 | interop | cross-chain-verifier | cross-chain-verifier | machine-03 | 10.50.0.3 | 38642 | 48642 | 58642 | false | true | false |
| node-06 | consensus-04 | consensus | validator | validator | machine-04 | 10.50.0.4 | 38643 | 48643 | 58643 | true | false | true |
| node-07 | interop-02 | interop | relayer | relayer | machine-04 | 10.50.0.4 | 38644 | 48644 | 58644 | false | true | false |
| node-08 | consensus-05 | consensus | validator | validator | machine-05 | 10.50.0.5 | 38645 | 48645 | 58645 | true | false | true |
| node-09 | consensus-06 | consensus | committee | committee | machine-05 | 10.50.0.5 | 38646 | 48646 | 58646 | true | false | true |
| node-10 | governance-01 | governance | security-council | security-council | machine-06 | 10.50.0.6 | 38647 | 48647 | 58647 | true | false | true |
| node-11 | interop-03 | interop | oracle | oracle | machine-06 | 10.50.0.6 | 38648 | 48648 | 58648 | false | true | false |
| node-12 | interop-04 | interop | witness | witness | machine-07 | 10.50.0.7 | 38649 | 48649 | 58649 | false | true | false |
| node-13 | service-02 | services | rpc-gateway | rpc-gateway | machine-07 | 10.50.0.7 | 38650 | 48650 | 58650 | false | true | false |
| node-14 | service-03 | services | indexer | indexer | machine-08 | 10.50.0.8 | 38651 | 48651 | 58651 | false | false | false |
| node-15 | compute-01 | pqc | pqc-crypto | pqc-crypto | machine-08 | 10.50.0.8 | 38652 | 48652 | 58652 | false | true | false |
| node-16 | consensus-07 | consensus | archive-validator | archive-validator | machine-09 | 10.50.0.9 | 38653 | 48653 | 58653 | true | false | true |
| node-17 | consensus-08 | consensus | audit-validator | audit-validator | machine-09 | 10.50.0.9 | 38654 | 48654 | 58654 | true | false | true |
| node-18 | compute-02 | compute | data-availability | data-availability | machine-10 | 10.50.0.10 | 38655 | 48655 | 58655 | false | true | false |
| node-20 | compute-03 | compute | ai-inference | ai-inference | machine-11 | 10.50.0.11 | 38657 | 48657 | 58657 | false | true | false |
| node-22 | interop-05 | interop | uma-coordinator | uma-coordinator | machine-12 | 10.50.0.12 | 38659 | 48659 | 58659 | false | true | false |
| node-23 | compute-04 | compute | compute | compute | machine-12 | 10.50.0.12 | 38660 | 48660 | 58660 | false | true | false |
| node-24 | governance-02 | governance | treasury-controller | treasury-controller | machine-13 | 10.50.0.13 | 38661 | 48661 | 58661 | true | false | true |
| node-25 | governance-03 | governance | governance-auditor | governance-auditor | machine-13 | 10.50.0.13 | 38662 | 48662 | 58662 | true | false | true |

### 4.4 WireGuard default listen ports per machine

These are the deployed listen ports for the existing VPN.

| Machine | VPN IP | WG ListenPort |
| --- | --- | --- |
| machine-01 | 10.50.0.1 | 51820 |
| machine-02 | 10.50.0.2 | 51821 |
| machine-03 | 10.50.0.3 | 51822 |
| machine-04 | 10.50.0.4 | 51823 |
| machine-05 | 10.50.0.5 | 51824 |
| machine-06 | 10.50.0.6 | 51825 |
| machine-07 | 10.50.0.7 | 51826 |
| machine-08 | 10.50.0.8 | 51827 |
| machine-09 | 10.50.0.9 | 51828 |
| machine-10 | 10.50.0.10 | 51829 |
| machine-11 | 10.50.0.11 | 51830 |
| machine-12 | 10.50.0.12 | 51831 |
| machine-13 | 10.50.0.13 | 51832 |

---

## 5. Pre-Install WireGuard Foundation (Required Before App Install)

This section is intentionally **before app installation**. It is the minimum network foundation required to avoid broken provisioning flows.

### 5.1 Why this must happen first

Even with correct scripts, provisioning fails when SSH paths, tunnel interfaces, and host reachability are unresolved. Prepare the private network baseline first.

### 5.2 Pre-install checklist

1. Decide machine mapping (`machine-01` to `machine-13`) and assign hosts.
2. Confirm each host has stable SSH access (`public key auth`, no interactive prompt).
3. Install WireGuard packages on all node hosts.
4. Confirm UDP path between hosts for WG listen ports (`51820-51832`).
5. Confirm all hosts reserve the `10.50.0.0/24` tunnel subnet.

### 5.2.1 WireGuard install commands by OS

Run on each node host before Synergy Devnet Control Panel install/provisioning.

Linux (Debian/Ubuntu):

```bash
sudo apt update
sudo apt install -y wireguard wireguard-tools
```

Linux (RHEL/Rocky/Alma):

```bash
sudo dnf install -y epel-release
sudo dnf install -y wireguard-tools
```

Linux (Arch):

```bash
sudo pacman -Sy --noconfirm wireguard-tools
```

macOS:

```bash
brew install wireguard-tools
```

Windows:

1. Install WireGuard for Windows.
2. Ensure service `WireGuardManager` is running.
3. If using native Windows node hosts, plan manual tunnel import or WSL-based orchestration.

### 5.2.2 Required firewall/network rules

For each node host:

1. Allow inbound UDP on that machine's WG listen port (`51820 + machine_offset`).
2. Allow outbound UDP to all other WG peer endpoints.
3. Allow private subnet traffic `10.50.0.0/24`.
4. Keep P2P/RPC ports private to WG/LAN; do not expose to public internet.

### 5.2.3 Canonical workspace paths (do not invent alternate folders)

Use these exact paths inside the monitor workspace:

- `<workspace>/devnet/lean15/hosts.env`
- `<workspace>/devnet/lean15/node-inventory.csv`
- `<workspace>/devnet/lean15/wireguard/configs/`
- `<workspace>/devnet/lean15/wireguard/keys/`
- `<workspace>/scripts/devnet15/remote-node-orchestrator.sh`

Do not move generated WireGuard files into ad-hoc directories like `networking/wireguard/...` unless you also update automation to match. The orchestrator and monitor expect the canonical `devnet/lean15/wireguard/...` paths.

### 5.2.4 Bootstrap addressing model (critical)

`hosts.env` carries two different address concepts:

| Variable | Meaning | Used for |
| --- | --- | --- |
| `MACHINE_XX_HOST` | Real, currently reachable address/hostname | SSH/scp/orchestration bootstrap |
| `MACHINE_XX_VPN_IP` | Overlay address (`10.50.0.x`) | WireGuard and blockchain traffic after tunnel is up |

Rule:

- `HOST` is the underlay/bootstrap address.
- `VPN_IP` is the overlay/tunnel address.

The generator may produce placeholder defaults where `HOST == VPN_IP`. Treat that as incomplete bootstrap data and edit `HOST` values before remote orchestration.

Wrong example:

```dotenv
MACHINE_02_HOST=10.50.0.2
MACHINE_02_VPN_IP=10.50.0.2
```

Right example:

```dotenv
MACHINE_02_HOST=192.168.1.98
MACHINE_02_VPN_IP=10.50.0.2
```

### 5.2.5 Single-machine bootstrap mode (only machine-01 online)

If only machine-01 exists today:

1. Set `MACHINE_01_HOST` to a reachable address for machine-01.
2. Set `MACHINE_01_SSH_USER` to a real account on machine-01.
3. Leave other machines as placeholders for now.
4. Do not run bulk scope `all` yet.
5. Run actions only for `machine-01` until additional machines are online.

### 5.3 Minimal first-node bootstrap when other nodes are offline

You can bring up `machine-01` first even if every other node is offline.

Procedure:

1. Confirm the existing VPN already assigns the expected `10.50.0.x` address to machine-01.
2. Set `MACHINE_01_HOST` to a reachable SSH address in `hosts.env`.
3. Save the SSH profile/binding in the control panel.
4. Start machine-01 node process.

Expected result:

- Interface is up.
- Handshakes may be zero until peers come online.
- Node process can start and serve local status.

### 5.4 First-node commands (manual fallback path)

```bash
# operator machine
WORKSPACE="${HOME}/.synergy-devnet-control-panel/monitor-workspace"
cd "$WORKSPACE"

# 1) generate hosts inventory first
./scripts/devnet15/generate-monitor-hosts-env.sh

# 2) edit hosts.env and set at least machine-01 host/user correctly
#    MACHINE_01_HOST=<reachable-host-for-machine-01>
#    MACHINE_01_SSH_USER=<real-user-on-machine-01>
#    other machines can stay placeholders until they exist

# 3) confirm machine-01 already has the expected VPN IP
ifconfig | rg 10.50

# 4) use the control panel to save host bindings, then deploy node-01
./scripts/devnet15/remote-node-orchestrator.sh node-01 setup_node
./scripts/devnet15/remote-node-orchestrator.sh node-01 status
```
WORKSPACE="${HOME}/.synergy-devnet-control-panel/monitor-workspace"
sudo install -m 600 "$WORKSPACE/devnet/lean15/wireguard/configs/node-01.conf" /etc/wireguard/synergy-devnet.conf
sudo wg-quick down synergy-devnet >/dev/null 2>&1 || true
sudo wg-quick up synergy-devnet
sudo wg show
```

### 5.4.1 Expected first-node output (what is normal)

- Tunnel interface comes up.
- `sudo wg show` lists peers but handshakes are often `never` initially.
- Sent bytes may increase while received bytes stay zero until another machine joins.
- No permanent forks or consensus output are expected yet from a single node bootstrap.

### 5.4.2 macOS-specific behavior and fixes

macOS commonly shows `utun` interfaces instead of a named Linux-style interface. This is normal.

Verification:

```bash
ifconfig | rg utun
ifconfig <utunX> | rg 10.50.0.1
sudo wg show
```

Common macOS cases:

1. `sudo wg show synergy-devnet` -> `No such file or directory`
Use `sudo wg show` (or inspect the active `utunX` interface).

2. `wg-quick up` -> `Address already in use`
A previous WireGuard interface already owns `10.50.0.1`.

```bash
sudo wg-quick down synergy-devnet >/dev/null 2>&1 || true
sudo pkill wireguard-go || true
sudo wg-quick up synergy-devnet
```

3. Warning: config is `world accessible`

```bash
sudo chmod 600 /etc/wireguard/synergy-devnet.conf
```

4. Multiple `utun` devices shown (`utun0`, `utun1`, ...)
This is common on macOS. Identify the one with `inet 10.50.0.1`.

### 5.5 Subsequent machine join sequence

For each additional node host:

1. Confirm the machine already has the expected VPN IP.
2. Confirm the host is bound in `hosts.env`.
3. Verify private reachability and agent health.
4. Start node process.

### 5.6 First-node bootstrap inputs (recommended values)

Use these values during first bootstrap:

| Input | Recommended value | Reason |
| --- | --- | --- |
| SSH user | `ops` | Matches default SSH profile template |
| SSH key | `~/.ssh/id_ed25519` | Stable key path for automation |
| First role brought online | `validator` (`node-01` on `machine-01`) | Establishes first consensus participant |

---

## 6. Install the Synergy Devnet Control Panel App (macOS, Linux, Windows)

### 6.1 macOS install

Current artifact paths:

- App bundle: `tools/devnet-control-panel/src-tauri/target/release/bundle/macos/Synergy Devnet Control Panel.app`
- DMG: `tools/devnet-control-panel/src-tauri/target/release/bundle/dmg/Synergy Devnet Control Panel_<version>_aarch64.dmg`

Install:

1. Open the DMG.
2. Drag app to Applications.
3. Launch app.
4. If Gatekeeper blocks launch:

```bash
xattr -dr com.apple.quarantine "/Applications/Synergy Devnet Control Panel.app"
```

### 6.2 Linux install

```bash
cd tools/devnet-control-panel
npm ci
npm run tauri:build
```

Then install generated package from `src-tauri/target/release/bundle/` (for example `.deb` or `.AppImage`).

### 6.3 Windows install

```powershell
cd tools\devnet-control-panel
npm ci
npm run tauri:build
```

Install generated `.msi` or setup `.exe` from `src-tauri\target\release\bundle\`.

### 6.4 Update channel behavior

`Check Updates` is wired to the published signed release metadata URL configured in `src-tauri/tauri.conf.json`.

Operator expectation:

1. bump the app version before tagging a release
2. publish a signed release so `latest.json` and updater signatures exist
3. installed apps poll the release metadata and show an install prompt when a newer version is available

---

## 7. Required Steps Immediately After App Install

### 7.1 Post-install verification checklist

1. Open app and confirm dashboard loads.
2. Confirm inventory path resolves to `<workspace>/devnet/lean15/node-inventory.csv`.
3. Open `Settings` -> `Operator Configuration` and confirm active operator is `local_admin (admin)`.
4. Confirm all 23 active node-slot rows appear on dashboard.
5. Confirm `<workspace>/devnet/lean15/hosts.env` exists.
6. Run hosts generator once:

```bash
cd "<workspace>"
./scripts/devnet15/generate-monitor-hosts-env.sh
```

7. Edit `hosts.env` and set real `MACHINE_XX_HOST` values for machines that exist now.
8. Set Atlas URL:

```dotenv
ATLAS_BASE_URL=https://devnet-explorer.synergy-network.io
```

9. If only machine-01 exists, run single-machine status first (not `all`).
10. Open one node detail page and confirm runtime metrics + role diagnostics + Atlas links.

If this checklist fails, use Section 18 before any provisioning.

---

## 8. First Operator Runbook (Bootstrap the Private Devnet)

### 8.1 First-operator prerequisites

- Active operator role is `admin`
- SSH key access to all node hosts
- SSH key pair already created manually on operator machine
- `wg` available on operator machine
- Installer bundles present: `devnet/lean15/installers/node-01`..`node-25`

### 8.2 Generate and verify `hosts.env`

```bash
cd "<workspace>"
./scripts/devnet15/generate-monitor-hosts-env.sh
```

Fill per-machine entries:

| Variable | Required | Example | Purpose |
| --- | --- | --- | --- |
| `MACHINE_XX_HOST` | Yes | `192.168.1.51` | Real bootstrap SSH target (not tunnel IP) |
| `MACHINE_XX_VPN_IP` | Yes | `10.50.0.1` | WireGuard overlay IP used after tunnel up |
| `MACHINE_XX_SSH_USER` | Yes | `ops` | SSH username |
| `MACHINE_XX_SSH_PORT` | Optional | `22` | SSH port |
| `MACHINE_XX_SSH_KEY` | Optional | `~/.ssh/id_ed25519` | SSH private key path |
| `ATLAS_BASE_URL` | Recommended | `https://devnet-explorer.synergy-network.io` | Atlas link base |

Critical rules:

1. `MACHINE_XX_HOST` must be reachable before WireGuard exists (LAN/public IP/DNS).
2. `MACHINE_XX_VPN_IP` remains in the `10.50.0.0/24` range.
3. If `generate-monitor-hosts-env.sh` outputs `HOST == VPN_IP`, treat as placeholder and edit it.
4. If only machine-01 exists, edit that host only and avoid `scope=all` bulk operations.

Machine-01 on the operator device:

- Set `MACHINE_01_HOST=127.0.0.1` (or host LAN IP).
- Set `MACHINE_01_SSH_USER` to the local account on that machine.
- Ensure SSH server is enabled if you plan to run orchestrator actions against localhost.

### 8.3 Confirm private-network prerequisites

The control panel assumes WireGuard is already installed and active outside the app.

Confirm:

1. Each machine already has its assigned `10.50.0.x` VPN IP.
2. The hub is reachable at `10.50.0.254`.
3. `hosts.env` contains reachable bootstrap SSH hosts plus the expected VPN IPs.

### 8.4 Configure Operator Configuration page

Open `Settings` -> `Operator Configuration`.

1. Set active operator to an `admin` profile.
2. Save SSH profile(s).
3. Bind machines to profile(s).
4. Execute bulk actions from same page.

### 8.5 Validate the existing VPN across fleet

Recommended checks:

1. Confirm the agent is reachable on each bound machine.
2. Confirm bulk `status` works on the intended scope.
3. Confirm RPC health checks succeed before broad lifecycle actions.

Scope guidance:

- Early bootstrap (only machine-01 online): run per-node-slot (`node-01`) scope.
- Use `all` only after all target machines have real `HOST` values and are reachable.

### 8.6 Provision/start nodes in deterministic order

1. consensus core (`node-01`,`node-02`,`node-04`,`node-06`,`node-08`,`node-09`,`node-16`,`node-17`)
2. governance (`node-10`,`node-24`,`node-25`)
3. interop (`node-05`,`node-07`,`node-11`,`node-12`,`node-22`)
4. services (`node-03`,`node-13`,`node-14`)
5. compute/pqc (`node-15`,`node-18`,`node-20`,`node-23`)

Use either:

- `bootstrap_node` (admin-only, one step)
- `setup` then `start` (two-step)

### 8.7 Validate chain health

- Bulk `status` on `all`
- Validators: `rpc:get_validator_activity`, `rpc:get_determinism_digest`
- Interop: `rpc:get_sxcp_status`, `rpc:get_relayer_set`, `rpc:get_attestations`
- Services: `rpc:get_network_stats`, `rpc:get_latest_block`

CLI verification:

```bash
cd "<workspace>"
./scripts/devnet15/check-determinism.sh
./scripts/devnet15/run-devnet-test-phases.sh --rpc-url http://10.50.0.13:48650
```

### 8.8 Validate Atlas bridge

On node detail page:

- `Atlas Explorer Bridge` should show `connected`
- `Latest Block` should match node page block height

---

## 9. Subsequent Operator Runbook (Join and Operate Existing Devnet)

### 9.1 Monitoring-only operator

1. Install app.
2. Ensure same `node-inventory.csv` and `hosts.env` values as primary operator.
3. Ensure device can reach private RPC endpoints (usually by joining WG mesh).
4. Use dashboard and node details for read-only visibility.

### 9.2 Control-capable operator

1. Complete monitoring-only steps.
2. Set operator role to `admin` or `operator` in local security config.
3. Configure SSH profile + ssh binding in Operator Configuration page.
4. Validate with bulk `status`.

### 9.3 Cross-device consistency rules

All operator devices see consistent state only if:

- They use consistent inventory and host mappings.
- They can reach same private RPC endpoints.
- Nodes are actually running and healthy.

---

## 10. Node Types: Setup, Monitoring, and Troubleshooting

This profile includes multiple role-specific node classes. The detail page diagnostics are grouped by the slot's active role.

### 10.1 Consensus participants (`node-01`, `node-02`, `node-04`, `node-06`, `node-08`, `node-09`, `node-16`, `node-17`)

- Purpose: consensus and block production
- Primary checks: registry presence, stake, block production, sync, peers
- Common fault: missing validator entry in activity RPC

### 10.2 Interop relayer (`node-07`)

- Purpose: SXCP relay/attestations
- Checks: registration, active/slashed flags, heartbeat, attestation flow
- Common fault: not present in relayer set

### 10.3 Interop cross-chain verifier (`node-05`)

- Purpose: cross-chain verification service
- Checks: interop diagnostics, relayer health, attestation visibility

### 10.4 Interop oracle (`node-11`)

- Purpose: oracle input service
- Checks: interop liveness and attestation flow

### 10.5 Interop witness and UMA coordination (`node-12`, `node-22`)

- Purpose: witness/proof support
- Checks: interop liveness, peer connectivity, attestation visibility

### 10.6 Governance participants (`node-10`, `node-24`, `node-25`)

- Purpose: governance participation
- Checks: validator/governance diagnostics, determinism digest

### 10.7 Compute and data services (`node-15`, `node-18`, `node-20`, `node-23`)

- Purpose: post-quantum, data availability, inference, and general compute support
- Checks: sync state, role-specific RPC reachability, and peer connectivity

### 10.8 Services RPC gateway (`node-13`)

- Purpose: private RPC ingress for monitor/explorer/testing
- Checks: service RPC latency, sync, peers, latest block

### 10.9 Services indexer (`node-14`)

- Purpose: indexing for explorer/API
- Checks: service checks + indexer block visibility

### 10.10 Services observer (`node-03`)

- Purpose: passive network observation
- Checks: service latency/sync/peers, lag vs network max block

---

## 11. Node Control Action Reference (Single + Bulk)

### 11.1 Core node actions

| Action | Purpose | Minimum role |
| --- | --- | --- |
| `start` | Start node process | `operator` |
| `stop` | Stop node process | `operator` |
| `restart` | Stop + start | `operator` |
| `status` | Query node status | `viewer` |
| `setup` | Provision node bundle/config | `operator` |
| `export_logs` | Export logs archive | `operator` |
| `view_chain_data` | Inspect chain path/data summary | `viewer` |
| `export_chain_data` | Export chain archive | `operator` |

### 11.2 Custom actions wired by default

| Action | Purpose | Minimum role |
| --- | --- | --- |
| `install_node` | Install node artifacts | `admin` |
| `bootstrap_node` | Deploy bundle and run installer | `admin` |
| `node_logs` | Stream recent logs | `operator` |

### 11.3 Bulk scopes

- `all`
- `role_group:<group>`
- `role:<substring>`
- `<machine-id>`

---

## 12. Operator Configuration Page (RBAC, SSH, SSH Binding, Bulk)

`Operator Access (RBAC)`, `SSH Profiles`, and `Fleet Bulk Actions` are now located in:

- `Settings` -> `Operator Configuration`

### 12.1 Active operator setup

Use this first. Actions execute under the active operator identity.

| Field | Required | Recommended input | Notes |
| --- | --- | --- | --- |
| `operator_id` | Yes | `ops_lead` | Lowercase stable ID (`[a-z0-9_-]`) |
| `display_name` | Yes | `Ops Lead` | Human-readable |
| `role` | Yes | `admin` (first operator), `operator` (daily ops), `viewer` (read-only) | Controls permissions |
| `enabled` | Yes | `true` | Disabled users cannot be activated |

Recommended initial operator set:

- `local_admin` (`admin`)
- `ops_lead` (`admin`)
- `ops_shift` (`operator`)
- `observer` (`viewer`)

Step-by-step:

1. Keep `local_admin` enabled as emergency fallback.
2. Create `ops_lead` with role `admin`.
3. Create `ops_shift` with role `operator`.
4. Create `observer` with role `viewer`.
5. Set active operator to `ops_lead` for initial provisioning.
6. During monitoring-only sessions, switch active operator to `observer`.

### 12.2 SSH profile setup

| Field | Required | Default/preset | Example |
| --- | --- | --- | --- |
| `profile_id` | Yes | `ops` | `ops` |
| `label` | Yes | `Ops SSH Profile` | `Ops SSH Profile` |
| `ssh_user` | Yes | `ops` | `ops` |
| `ssh_port` | No | `22` | `22` |
| `ssh_key_path` | No | `~/.ssh/id_ed25519` | `/Users/you/.ssh/id_ed25519` |
| `remote_root` | No | `/opt/synergy` | `/opt/synergy` |
| `strict_host_key_checking` | Advanced | `accept-new` (or `yes` in hardened environments) | `accept-new` |
| `extra_ssh_args` | Advanced | blank | `-o ConnectTimeout=8` |

Recommended first profile values:

```text
profile_id: ops
label: Ops SSH Profile
ssh_user: ops
ssh_port: 22
ssh_key_path: ~/.ssh/id_ed25519
remote_root: /opt/synergy
```

Notes:

1. UI currently exposes the core fields (`profile_id`, `label`, `ssh_user`, `ssh_port`, `ssh_key_path`, `remote_root`).
2. Advanced fields (`strict_host_key_checking`, `extra_ssh_args`) are available in security config/API flows for hardened environments.
3. Saving an SSH profile does not generate keys; it only stores values used by orchestration commands.

### 12.2.1 SSH key generation and installation (manual, required)

Generate the operator key pair before saving SSH profiles.

macOS/Linux:

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -C "synergy-devnet-ops" -N ""
chmod 600 ~/.ssh/id_ed25519
chmod 644 ~/.ssh/id_ed25519.pub
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.ssh" | Out-Null
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\id_ed25519" -C "synergy-devnet-ops" -N '""'
```

Install the public key on each node host:

Linux/macOS target hosts (from operator machine):

```bash
ssh-copy-id -i ~/.ssh/id_ed25519.pub ops@<node-host>
```

If `ssh-copy-id` is unavailable:

```bash
cat ~/.ssh/id_ed25519.pub | ssh ops@<node-host> "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

Connection verification:

```bash
ssh -i ~/.ssh/id_ed25519 ops@<node-host> "echo ssh-ok"
```

Then set SSH profile fields:

- `ssh_user=ops`
- `ssh_key_path=~/.ssh/id_ed25519` (or absolute path)
- `ssh_port=22`
- `remote_root=/opt/synergy`

### 12.3 Node-slot binding setup

| Field | Required | Recommended input | Notes |
| --- | --- | --- | --- |
| `node_slot_id` | Yes | e.g. `node-06` | This field currently stores the inventory node-slot id |
| `profile_id` | Yes | `ops` | Existing SSH profile |
| `host_override` | Optional | blank unless needed | Overrides hosts.env for this machine |
| `remote_dir_override` | Optional | blank unless needed | Overrides `<remote_root>/<machine-id>` |

Recommended policy:

- Bind every machine to one shared profile first.
- Use overrides only for exceptions.

Step-by-step:

1. Select `node_slot_id` from inventory list (for example `node-01`).
2. Select `profile_id` (`ops` recommended).
3. Leave `host_override` blank unless host differs from `hosts.env`.
4. Leave `remote_dir_override` blank unless host uses a custom directory.
5. Save binding and repeat for all required node slots.

### 12.4 Fleet Bulk Actions setup and presets

Recommended presets:

| Workflow | Action | Scope |
| --- | --- | --- |
| Baseline status | `status` | `all` |
| Core health | `status` | `all` |
| Sync health | `rpc:get_sync_status` | `all` |
| Peer health | `rpc:get_peer_info` | `all` |
| Consensus health | `rpc:get_validator_activity` | `role_group:consensus` |
| Interop health | `rpc:get_sxcp_status` | `role_group:interop` |

Admin-only actions in bulk:

- `install_node`
- `bootstrap_node`

Bulk action field presets:

| Field | Recommended input | Notes |
| --- | --- | --- |
| `action` | `status` for baseline checks | Safe first validation |
| `scope` | `all` for fleet baseline | Use role-group scopes for targeted checks |
| Consensus scope | `role_group:consensus` | Validators and governance validators |
| Interop scope | `role_group:interop` | Relayer/verifier/oracle/witness |
| Services scope | `role_group:services` | RPC/indexer/observer nodes |

### 12.5 RBAC summary

| Role | Control | Bulk | Security config |
| --- | --- | --- | --- |
| `admin` | All | All | Yes |
| `operator` | Core + non-admin custom | Yes | No |
| `viewer` | No control | No | No |

### 12.6 Audit log details

Every control action writes to:

- `<workspace>/audit/control-actions.jsonl`

Each event includes operator id/role, action/scope, command, result, and timestamps.

### 12.7 Operator Configuration completion checklist

1. Active operator is set to an `admin` profile.
2. At least one SSH profile exists (`ops` recommended).
3. Every machine has an SSH profile binding.
4. Bulk `status` succeeds on scope `all`.
5. Audit log updates after a control action.

---

## 13. WireGuard Operations and OS-Specific Procedures

### 13.1 First machine setup responsibility

WireGuard is external infrastructure. The control panel does not generate configs, install clients, or bring tunnels up/down.

### 13.2 Default orchestrator behavior

- The panel reads `MACHINE_XX_VPN_IP` values and uses the existing VPN for agent and private-service access.
- `MACHINE_XX_HOST` remains the bootstrap SSH target when SSH fallback is needed.

Addressing requirement:

- `MACHINE_XX_HOST` must be an underlay/bootstrap-reachable SSH target.
- `MACHINE_XX_VPN_IP` is overlay-only (`10.50.0.x`) and should not be used as the bootstrap host unless that overlay is already established.

### 13.3 OS notes

#### Linux/macOS node hosts

Fully automated by default orchestrator for install/connect/status.

If macOS is used as machine-01:

- `wg-quick` + `wireguard-go` may expose tunnel as `utunX`.
- `sudo wg show` is preferred over querying by interface name.
- Expect multiple unrelated `utun` devices; find the one with `10.50.0.1`.

#### Windows node hosts

Default orchestrator expects Bash + `wg-quick`; native Windows automation is limited.

Use one of:

1. WSL/Linux environment on Windows hosts for orchestration compatibility.
2. Manual WireGuard for Windows import + custom `MACHINE_XX_*_CMD` mappings.

### 13.4 Manual verification commands

Linux:

```bash
sudo wg show
ip addr | rg -n "synergy-devnet|wg"
```

macOS:

```bash
sudo wg show
ifconfig | rg utun
netstat -rn | rg 10.50
```

Windows PowerShell:

```powershell
Get-Service WireGuardManager
```

### 13.5 Failure checklist

- Missing VPN IP: repair the VPN outside the control panel.
- No handshakes: verify endpoints, DNS, and UDP firewall rules.
- `Address already in use`: tear down old tunnel/interface and retry.
- `No such file or directory` on named interface (macOS): use `sudo wg show` and `ifconfig` to identify `utunX`.

---

## 14. Atlas Explorer Integration

Set in `devnet/lean15/hosts.env`:

```dotenv
ATLAS_BASE_URL=https://devnet-explorer.synergy-network.io
```

Node page Atlas links:

- `#/transactions`
- `#/wallet`
- `#/contracts`
- `#/block/<height>`
- `#/tx/<hash>`
- `#/address/<node_address>`

Validation:

1. Open node page.
2. Atlas Bridge should show `connected`.
3. Verify latest block link matches node block height.

---

## 15. Observability Stack

Stack location:

- `devnet/lean15/observability/docker-compose.yml`

Start:

```bash
cd "<workspace>"
./scripts/devnet15/start-observability.sh
```

Stop:

```bash
cd "<workspace>"
./scripts/devnet15/stop-observability.sh
```

Default services:

- Prometheus: `http://127.0.0.1:9090`
- Grafana: `http://127.0.0.1:3000` (`admin/admin`)
- Loki: `http://127.0.0.1:3100`
- RPC exporter: `http://127.0.0.1:9168/metrics`
- Node exporter: `http://127.0.0.1:9100`

---

## 16. Devnet Test Phases and Validation Commands

Full phase runner:

```bash
cd "<workspace>"
./scripts/devnet15/run-devnet-test-phases.sh --rpc-url http://10.50.0.13:48650
```

Direct tests:

```bash
./scripts/devnet15/check-determinism.sh
./scripts/devnet15/load-generator.sh --rpc-url http://10.50.0.13:48650 --rpm 10000 --minutes 1
./scripts/devnet15/chaos-node.sh --rpc-url http://10.50.0.13:48650
```

---

## 17. Deterministic Reset Procedure

```bash
cd "<workspace>"
./scripts/reset-devnet.sh
```

Reset workflow:

1. stop cluster
2. clear local/remote state
3. re-render configs
4. validate closed-devnet constraints
5. regenerate deterministic genesis
6. restart in deterministic order

Optional flags:

- `--hosts-file <path>`
- `--rebuild-installers`
- `--skip-restart`

---

## 18. Troubleshooting Playbook

### 18.1 Dashboard shows nodes offline

- Run bulk `status`
- Check node detail -> `node_logs`
- Validate process with installer scripts (`nodectl.sh` / `nodectl.ps1`)

### 18.2 Bulk action permission denied

- Check active operator role.
- Admin required for install/bootstrap/reset actions.

### 18.3 WireGuard connect fails

This control panel build no longer manages WireGuard.

If the VPN path is unhealthy:

- Confirm the machine already has the expected `10.50.0.x` VPN IP.
- Confirm UDP `51820-51832` path to the hub is open.
- Confirm `MACHINE_XX_HOST` is a real bootstrap-reachable host (not unresolved placeholder).
- Repair the VPN outside the control panel, then retry node actions.

### 18.4 `node-01: command not found` or script actions fail immediately

- Ensure commands are run from `<workspace>` (not from random directories).
- Use the canonical form with script path:

```bash
cd ~/.synergy-devnet-control-panel/monitor-workspace
./scripts/devnet15/remote-node-orchestrator.sh node-01 status
```

- Regenerate hosts inventory if command variables are stale:

```bash
./scripts/devnet15/generate-monitor-hosts-env.sh
```

### 18.5 `Address already in use` during `wg-quick up` (macOS)

Another tunnel already owns the IP:

```bash
sudo wg-quick down synergy-devnet >/dev/null 2>&1 || true
sudo pkill wireguard-go || true
sudo chmod 600 /etc/wireguard/synergy-devnet.conf
sudo wg-quick up synergy-devnet
```

### 18.6 `sudo wg show synergy-devnet` says `No such file or directory` (macOS)

- macOS often exposes tunnel as `utunX` rather than a named Linux interface.
- Use:

```bash
sudo wg show
ifconfig | rg utun
```

- Find the `utunX` device with `10.50.0.1` (or this node's VPN IP).

### 18.7 Node started but not syncing

- Check peer count and bootnode reachability (`10.50.0.1:38638`, `10.50.0.2:38639`).
- Confirm config bind/listen addresses are private.

### 18.8 Atlas link section not configured

- Set `ATLAS_BASE_URL` in `hosts.env`.
- Refresh snapshot or restart app.

### 18.9 Exports missing

- Node snapshots: `devnet/lean15/reports/node-monitor-exports/`
- Remote exports: `devnet/lean15/reports/remote-exports/<machine-id>/`

### 18.10 Multiple `utun` interfaces shown on macOS

- This is usually normal.
- Confirm the active WireGuard interface by matching the tunnel IP:

```bash
ifconfig | rg -n "utun|10\\.50\\."
```

### 18.11 Help button behavior

Help opens second window (`help-articles-window`) and falls back to `/#/help` route in current window if window creation fails.

---

## 19. Known Gaps and Manual Work Remaining

1. App updates depend on a published signed release (`latest.json` plus signatures) being available at the configured updater endpoint.
2. Native Windows remote WG automation remains limited by orchestrator assumptions.
3. RBAC and audit are local per workspace unless externally synchronized.
4. PQC-specific counters remain partially inferred from available RPC payloads.

---

## 20. Appendix: Monitor RPC Method Map

| Action | RPC Method |
| --- | --- |
| `rpc:get_node_status` | `synergy_getNodeStatus` |
| `rpc:get_sync_status` | `synergy_getSyncStatus` |
| `rpc:get_peer_info` | `synergy_getPeerInfo` |
| `rpc:get_latest_block` | `synergy_getLatestBlock` |
| `rpc:get_network_stats` | `synergy_getNetworkStats` |
| `rpc:get_all_wallets` | `synergy_getAllWallets` |
| `rpc:get_validator_activity` | `synergy_getValidatorActivity` |
| `rpc:get_validators` | `synergy_getValidators` |
| `rpc:get_determinism_digest` | `synergy_getDeterminismDigest` |
| `rpc:get_sxcp_status` | `synergy_getSxcpStatus` |
| `rpc:get_relayer_set` | `synergy_getRelayerSet` |
| `rpc:get_relayer_health` | `synergy_getRelayerHealth` |
| `rpc:get_attestations` | `synergy_getAttestations` |

Direct probe example:

```bash
curl -sS -X POST http://10.50.0.13:48650 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"synergy_getDeterminismDigest","params":[],"id":1}'
```
