# Synergy Lean 15-Node Closed Devnet Bundle

This directory defines a WireGuard-only, deterministic devnet profile.

## Closed-Devnet Guarantees

- P2P discovery is disabled (`enable_discovery = false`).
- P2P and RPC bind to VPN identities (`10.50.0.0/24`).
- Validator registration is strict-allowlist gated.
- Config rendering is deterministic from inventory + key material.

## Files

- `node-inventory.csv`: authoritative machine map, ports, VPN identities, validator auto-register policy.
- `hosts.env.example`: host/VPN mapping plus optional remote lifecycle hooks.
- `configs/`: per-machine rendered node configuration files (generated).
- `keys/`: per-machine key material and address metadata (generated).
- `observability/`: Prometheus/Grafana/Loki stack and RPC exporter.

## Core Generation Workflow

```bash
cp devnet/lean15/hosts.env.example devnet/lean15/hosts.env
scripts/devnet15/generate-node-keys.sh
scripts/devnet15/render-configs.sh
scripts/devnet15/generate-devnet-genesis.sh
```

## One-Command Cluster Reset

```bash
./reset-devnet.sh
```

This executes:

1. Stop nodes.
2. Clear chain/token/validator state.
3. Re-render configs.
4. Regenerate deterministic genesis.
5. Restart cluster in deterministic order.

## WireGuard Mesh Generation

```bash
scripts/devnet15/generate-wireguard-mesh.sh
```

## Test Harness

```bash
scripts/devnet15/run-devnet-test-phases.sh --rpc-url http://10.50.0.7:48650
scripts/devnet15/check-determinism.sh
scripts/devnet15/load-generator.sh --rpc-url http://10.50.0.7:48650 --rpm 10000 --minutes 1
scripts/devnet15/chaos-node.sh --rpc-url http://10.50.0.7:48650
```

## Observability

```bash
scripts/devnet15/start-observability.sh
```

For full deployment and operations details, use:

- `guides/LEAN_15_NODE_DEVNET_RUNBOOK.md`
- `guides/CLOSED_DEVNET_IMPLEMENTATION_UPDATE_2026-02-26.md`
