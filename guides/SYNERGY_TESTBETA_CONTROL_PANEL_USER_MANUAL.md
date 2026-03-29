# Synergy Node Control Panel User Manual

Version: 2026-03-28  
Applies to: Synergy Node Control Panel `5.6.0` for Synergy Testnet-Beta

## 1. Network Baseline

- Chain ID: `338639`
- Network ID: `synergy-testnet-beta`
- Token: `SNRG`
- Core RPC: `https://testbeta-core-rpc.synergy-network.io`
- Core WS: `wss://testbeta-core-ws.synergy-network.io`
- API: `https://testbeta-api.synergy-network.io`
- Explorer: `https://testbeta-explorer.synergy-network.io`
- Atlas API: `https://testbeta-atlas-api.synergy-network.io`
- Bootnodes:
  - `bootnode1.synergynode.xyz:5620`
  - `bootnode2.synergynode.xyz:5620`
  - `bootnode3.synergynode.xyz:5620`
- Seed services:
  - `http://seed1.synergynode.xyz:5621`
  - `http://seed2.synergynode.xyz:5621`
  - `http://seed3.synergynode.xyz:5621`

## 2. Supported Genesis Roles

- `bootnode`
- `seed_server`
- `validator`
- `rpc_gateway`
- `indexer`

Each role is installed from an approved ceremony package or bootstrap bundle downloaded from the Genesis Dashboard.

## 3. Install The Control Panel

Install the current `Synergy.Node.Control.Panel-5.6.0` build for your platform.

First launch creates the local workspace:

- macOS: `~/.synergy-node-control-panel/monitor-workspace`
- Linux: `~/.synergy-node-control-panel/monitor-workspace`
- Windows: `%USERPROFILE%\.synergy-node-control-panel\monitor-workspace`

## 4. Start Genesis Setup

Open Jarvis and send:

```text
genesis setup
```

Jarvis switches into Testnet-Beta ceremony mode and prompts for the role to install on the current machine.

## 5. Select The Correct Ceremony File

- `bootnode`: import the assigned `bootnode*.tar.gz` bundle.
- `seed_server`: import the assigned `seed*.tar.gz` bundle.
- `validator`: import the assigned `validator-*-setup-package.json`.
- `rpc_gateway`: import `rpc-gateway-setup-package.json`.
- `indexer`: import `indexer-explorer-setup-package.json`.

Only use the exact file assigned to the machine being provisioned.

## 6. What Jarvis Stages

After a successful import, the workspace contains the approved Testnet-Beta launch data for that role:

- `config/genesis.json`
- `config/operational-manifest.json`
- role-specific config files
- bootstrap endpoints
- the assigned validator identity when the imported role is `validator`

Bootnode and seed imports stage the files from the approved bootstrap bundles.

## 7. Role-Specific Requirements

### Bootnode

- Keep `5620/tcp` open.
- Use the imported `config/node.toml` without changing bootnode addresses or ports.
- Do not expose public RPC or WebSocket from a bootstrap-only host.

### Seed Server

- Keep `5621/tcp` open.
- Confirm `config/seed-service.json` is present.
- Confirm `/peer-list.json` and `/peers/register` are reachable after start.

### Genesis Validator

- Confirm the imported validator address matches the assignment from the Genesis Dashboard.
- Confirm the workspace carries both `genesis.json` and `operational-manifest.json` before first start.
- Start only after bootnodes and seeds are already healthy.

### RPC Gateway

- Provide the canonical public host for:
  - `testbeta-core-rpc.synergy-network.io`
  - `testbeta-core-ws.synergy-network.io`
- Confirm the imported workspace serves the canonical genesis and manifest.

### Indexer And Explorer

- Provide the canonical public host for:
  - `testbeta-explorer.synergy-network.io`
  - `testbeta-atlas-api.synergy-network.io`
- Keep Atlas, the indexer, and the explorer frontend aligned to the imported beta manifest.

## 8. Port Model

- Bootnode: `5620`
- Seed service: `5621`
- Reserved: `5622`
- Role P2P: `5630 + slot`
- Role RPC: `5730 + slot`
- Role WebSocket: `5830 + slot`
- Role discovery: `5930 + slot`
- Role metrics: `6030 + slot`

Do not reintroduce `38638`, `48638`, `58638`, or `18080`.

## 9. Bring-Up Order

1. Bootnodes
2. Seed services
3. Genesis validators
4. Public RPC and API
5. Atlas and explorer
6. Wallet, faucet, and public service validation
7. SXCP runtime

## 10. Required Health Checks

Run these actions after each role comes online:

- `status`
- `rpc:get_sync_status`
- `rpc:get_peer_info`
- `rpc:get_latest_block`
- `rpc:get_validator_activity`
- `rpc:get_sxcp_status`

Target outcomes:

- bootnodes reachable
- at least one seed service responding
- validator set present
- block height increasing
- explorer loading live data
- Atlas health endpoints green

## 11. Failure Recovery

### Package import fails

- Re-download the package from the Genesis Dashboard.
- Select the same role again in Jarvis.
- Import the untouched package.

### Wrong host or role chosen

- Remove the failed workspace.
- Start `genesis setup` again.
- Re-import the correct role package.

### Validator will not join

- Confirm all three bootnodes resolve.
- Confirm at least one seed service answers.
- Confirm the imported validator address is part of the approved genesis validator set.

### Public endpoints do not match

- Re-run the role import with the canonical hostname.
- Confirm reverse proxy and TLS are serving:
  - `testbeta-core-rpc.synergy-network.io`
  - `testbeta-core-ws.synergy-network.io`
  - `testbeta-api.synergy-network.io`
  - `testbeta-explorer.synergy-network.io`
  - `testbeta-atlas-api.synergy-network.io`

## 12. Launch Acceptance

Treat Testnet-Beta as live only after all of the following are true:

- all bootnodes are reachable
- seed services are registering peers
- all four genesis validators are running
- public RPC and WS are serving the canonical chain
- Atlas and explorer show live chain data
- wallet, faucet, and public services are pointed at the canonical beta endpoints
- SXCP status is either live and healthy or explicitly held behind a launch gate
