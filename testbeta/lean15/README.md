# Synergy Lean 15-Node Closed Testnet-Beta Bundle

This directory defines the deterministic testbeta profile.

## Closed-Testnet-Beta Guarantees

- P2P discovery is disabled (`enable_discovery = false`).
- P2P and RPC bind to the rendered inventory addresses for each assigned node.
- Validator registration is strict-allowlist gated.
- Config rendering is deterministic from inventory + key material.

## Files

- `node-inventory.csv`: authoritative machine map, ports, inventory bind addresses, validator auto-register policy.
- `hosts.env.example`: host/address mapping plus optional remote lifecycle hooks.
- `configs/`: per-machine rendered node configuration files (generated).
- `keys/`: per-machine key material and address metadata (generated).
- `observability/`: Prometheus/Grafana/Loki stack and RPC exporter.

## Core Generation Workflow

```bash
cp testbeta/lean15/hosts.env.example testbeta/lean15/hosts.env
scripts/testbeta/generate-node-keys.sh
scripts/testbeta/render-configs.sh
scripts/testbeta/generate-testbeta-genesis.sh
```

## One-Command Cluster Reset

```bash
./reset-testbeta.sh
```

This executes:

1. Stop nodes.
2. Clear chain/token/validator state.
3. Re-render configs.
4. Regenerate deterministic genesis.
5. Restart cluster in deterministic order.

## Test Harness

```bash
scripts/testbeta/run-testbeta-test-phases.sh --rpc-url http://127.0.0.1:5652
scripts/testbeta/check-determinism.sh
scripts/testbeta/load-generator.sh --rpc-url http://127.0.0.1:5652 --rpm 10000 --minutes 1
scripts/testbeta/chaos-node.sh --rpc-url http://127.0.0.1:5652
```

## Observability

```bash
scripts/testbeta/start-observability.sh
```

For full deployment and operations details, use:

- `guides/LEAN_15_NODE_TESTBETA_RUNBOOK.md`
- `guides/CLOSED_TESTBETA_IMPLEMENTATION_UPDATE_2026-02-26.md`
