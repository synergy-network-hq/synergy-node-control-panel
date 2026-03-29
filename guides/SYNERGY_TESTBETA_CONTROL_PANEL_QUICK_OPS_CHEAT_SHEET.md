# Synergy Node Control Panel Quick Ops Cheat Sheet

Version: 2026-03-28
Scope: Synergy Testnet-Beta genesis ceremony and first-start operations

## 1. Core Facts

- Chain ID: `338639`
- Network ID: `synergy-testnet-beta`
- Token: `SNRG`
- Core RPC: `https://testbeta-core-rpc.synergy-network.io`
- Core WS: `wss://testbeta-core-ws.synergy-network.io`
- API: `https://testbeta-api.synergy-network.io`
- Explorer: `https://testbeta-explorer.synergy-network.io`
- Atlas API: `https://testbeta-atlas-api.synergy-network.io`
- Bootnodes: `bootnode1.synergynode.xyz:5620`, `bootnode2.synergynode.xyz:5620`, `bootnode3.synergynode.xyz:5620`
- Seeds: `http://seed1.synergynode.xyz:5621`, `http://seed2.synergynode.xyz:5621`, `http://seed3.synergynode.xyz:5621`

## 2. Genesis Setup Command

Open Jarvis and send:

```text
genesis setup
```

Jarvis switches into ceremony mode and asks for the node role to install.

## 3. Package To Select

- `bootnode`: download the matching `bootnode*.tar.gz` bundle from the Genesis Dashboard.
- `seed_server`: download the matching `seed*.tar.gz` bundle from the Genesis Dashboard.
- `validator`: download the assigned `validator-*-setup-package.json` file from the Genesis Dashboard.
- `rpc_gateway`: download `rpc-gateway-setup-package.json`.
- `indexer`: download `indexer-explorer-setup-package.json`.

## 4. Expected Local Ports

- Bootnode: `5620`
- Seed service: `5621`
- Role P2P: `5630 + slot`
- Role RPC: `5730 + slot`
- Role WebSocket: `5830 + slot`
- Role discovery: `5930 + slot`
- Role metrics: `6030 + slot`

## 5. Minimum Role Checks

- Bootnode: bootstrap-only workspace imported, `config/node.toml` present, port `5620` reachable.
- Seed server: `seed-service.json` present, `/peer-list.json` reachable on `5621`.
- Genesis validator: `config/genesis.json`, `config/operational-manifest.json`, and validator identity all staged before first start.
- RPC gateway: package imported with the canonical beta manifests and public host set for `testbeta-core-rpc` and `testbeta-core-ws`.
- Indexer and explorer: package imported with the canonical beta manifests and public host set for `testbeta-explorer` and `testbeta-atlas-api`.

## 6. Bring-Up Order

1. Bootnodes
2. Seed services
3. Genesis validators
4. Public RPC and API
5. Atlas and explorer
6. Wallet, faucet, and public service checks
7. SXCP runtime

## 7. Immediate Health Checks

- `status`
- `rpc:get_sync_status`
- `rpc:get_peer_info`
- `rpc:get_latest_block`
- `rpc:get_validator_activity`
- `rpc:get_sxcp_status`

## 8. Workspace Locations

- macOS: `~/.synergy-node-control-panel/monitor-workspace`
- Linux: `~/.synergy-node-control-panel/monitor-workspace`
- Windows: `%USERPROFILE%\.synergy-node-control-panel\monitor-workspace`

## 9. Fast Failure Checks

- Import rejected: re-download the package from the Genesis Dashboard and import the exact assigned role package.
- Bootstrap missing: confirm all three bootnodes and at least one seed service respond before starting validators.
- Wrong public host: re-run `genesis setup` and enter the canonical hostname for the role being installed.
- Stale manifests: delete the failed workspace and import the ceremony package again.
