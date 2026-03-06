#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INVENTORY_FILE="$ROOT_DIR/devnet/lean15/node-inventory.csv"
NODE_ADDRESSES_FILE="$ROOT_DIR/devnet/lean15/keys/node-addresses.csv"
OUTPUT_FILE="${1:-$ROOT_DIR/devnet/lean15/configs/genesis/genesis.json}"

if [[ ! -f "$INVENTORY_FILE" ]]; then
  echo "Missing inventory file: $INVENTORY_FILE" >&2
  exit 1
fi

if [[ ! -f "$NODE_ADDRESSES_FILE" ]]; then
  echo "Missing node address file: $NODE_ADDRESSES_FILE" >&2
  echo "Run scripts/devnet15/generate-node-keys.sh first." >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"

python3 - "$INVENTORY_FILE" "$NODE_ADDRESSES_FILE" "$OUTPUT_FILE" <<'PY'
import csv
import json
import os
import sys

inventory_file, addresses_file, output_file = sys.argv[1:4]

chain_id = int(os.environ.get("DEVNET_CHAIN_ID", "338638"))
genesis_time = os.environ.get("DEVNET_GENESIS_TIME", "2026-01-01T00:00:00Z")
validator_stake = int(os.environ.get("DEVNET_VALIDATOR_STAKE", "5000000000000"))
min_validators = int(os.environ.get("DEVNET_MIN_VALIDATORS", "2"))
max_validators = int(os.environ.get("DEVNET_MAX_VALIDATORS", "15"))

faucet_address = os.environ.get("DEVNET_FAUCET_ADDRESS", "synw1lfgerdqglc6p74p9u6k8ghfssl59q8jzhuwm07")
rewards_pool_address = os.environ.get("DEVNET_REWARDS_POOL_ADDRESS", "synw1zwy4m4mpdxyvz4nf8f7s0hk8nesc2cv09ex8pg")
treasury_address = os.environ.get("DEVNET_TREASURY_ADDRESS", "synw14lswrh8z7kremft633xym9wtr5l9vkm3rd6lvd")
foundation_address = os.environ.get("DEVNET_FOUNDATION_ADDRESS", "synw1v6fhr0x7v6e2hxf9d9l72z2fcmn2c4k4m6m7d8")
test_pool_address = os.environ.get("DEVNET_TEST_POOL_ADDRESS", "synw1q0a8jzk24y8ra9qy0wqp6lx8kclha04r6w3lmf")

faucet_balance = int(os.environ.get("DEVNET_FAUCET_BALANCE", "1500000000000000000"))
rewards_pool_balance = int(os.environ.get("DEVNET_REWARDS_POOL_BALANCE", "1500000000000000000"))
treasury_balance = int(os.environ.get("DEVNET_TREASURY_BALANCE", "8800000000000000000"))
foundation_balance = int(os.environ.get("DEVNET_FOUNDATION_BALANCE", "50000000000000000"))
test_pool_balance = int(os.environ.get("DEVNET_TEST_POOL_BALANCE", "100000000000000000"))

def parse_bool(raw: str) -> bool:
    value = (raw or "").strip().lower()
    return value in {"1", "true", "yes", "on"}

addresses = {}
with open(addresses_file, newline="", encoding="utf-8") as handle:
    reader = csv.DictReader(handle)
    for row in reader:
        machine_id = row.get("machine_id", "").strip()
        address = row.get("address", "").strip()
        if machine_id and address:
            addresses[machine_id] = address

inventory_rows = []
with open(inventory_file, newline="", encoding="utf-8") as handle:
    reader = csv.DictReader(handle)
    for row in reader:
        inventory_rows.append(row)

machine_by_id = {row["machine_id"]: row for row in inventory_rows}

bootnodes = []
for bootnode_id in ("node-01", "node-02"):
    row = machine_by_id.get(bootnode_id)
    if not row:
        continue
    endpoint_ip = row.get("vpn_ip") or row.get("host")
    p2p_port = row.get("p2p_port")
    address = addresses.get(bootnode_id)
    if endpoint_ip and p2p_port and address:
        bootnodes.append(f"snr://{address}@{endpoint_ip}:{p2p_port}")

def is_consensus_validator(row: dict) -> bool:
    role_group = (row.get("role_group") or "").strip().lower()
    role = (row.get("role") or "").strip().lower()
    node_type = (row.get("node_type") or "").strip().lower()
    return role_group == "consensus" and (node_type == "validator" or role == "validator")


validator_rows = [
    row
    for row in inventory_rows
    if parse_bool(row.get("auto_register_validator", "")) and is_consensus_validator(row)
]
validators = []
validator_allocations = []
for index, row in enumerate(validator_rows, start=1):
    machine_id = row["machine_id"]
    address = addresses.get(machine_id)
    if not address:
        continue
    node_id = row.get("node_id", machine_id)
    validators.append(
        {
            "address": address,
            "public_key_file": f"devnet/lean15/keys/{machine_id}/identity.json",
            "stake": str(validator_stake),
            "commission_rate": 0.05,
            "min_self_delegation": "1",
            "max_delegations": 1000,
            "details": {
                "name": f"{node_id} validator",
                "identity": node_id,
                "website": "https://synergy.local",
                "security_contact": "security@synergy.local",
                "class": int(row.get("address_class") or 1),
            },
        }
    )
    validator_allocations.append(
        {
            "type": "validator_wallet",
            "address": address,
            "balance": str(validator_stake),
            "stake": str(validator_stake),
            "description": f"Devnet validator allocation for {node_id}",
        }
    )

genesis_allocations = [
    {
        "type": "faucet_wallet",
        "address": faucet_address,
        "balance": str(faucet_balance),
        "description": "Closed-devnet faucet wallet",
    },
    {
        "type": "rewards_pool",
        "address": rewards_pool_address,
        "balance": str(rewards_pool_balance),
        "description": "Validator rewards pool",
    },
    {
        "type": "treasury",
        "address": treasury_address,
        "balance": str(treasury_balance),
        "description": "Protocol treasury",
    },
    {
        "type": "foundation_wallet",
        "address": foundation_address,
        "balance": str(foundation_balance),
        "description": "Foundation/devops wallet",
    },
    {
        "type": "test_wallet_pool",
        "address": test_pool_address,
        "balance": str(test_pool_balance),
        "description": "Load and integration testing wallet pool",
    },
]
genesis_allocations.extend(validator_allocations)

total_allocated = 0
for allocation in genesis_allocations:
    try:
        total_allocated += int(allocation.get("balance", "0"))
    except ValueError:
        pass

genesis = {
    "metadata": {
        "network_name": "Synergy Closed Devnet",
        "network_id": "synergy-devnet-closed-001",
        "genesis_time": genesis_time,
        "chain_id": str(chain_id),
        "version": "2.1.0-devnet",
        "description": "Closed, WireGuard-only deterministic devnet genesis",
    },
    "consensus": {
        "algorithm": "PoSy",
        "version": "2.1",
        "parameters": {
            "block_time_ms": 2000,
            "epoch_length": 50,
            "min_validators": min_validators,
            "max_validators": max_validators,
            "quorum_threshold": 0.67,
            "min_stake_amount": str(validator_stake),
            "allow_zero_stake_validators": False,
            "dynamic_validator_registration": True,
            "slashing_conditions": {
                "double_sign_penalty": 1000000,
                "downtime_penalty": 100000,
                "max_missed_blocks": 10,
                "slashing_penalty": 100000,
            },
        },
    },
    "network": {
        "chain_id": chain_id,
        "rpc_endpoint": "http://10.50.0.13:48650",
        "websocket_endpoint": "ws://10.50.0.13:58650",
        "api_endpoint": "http://10.50.0.13:48650",
        "explorer_endpoint": "http://10.50.0.11:3000",
        "rpc_port": 48650,
        "p2p_port": 38638,
        "websocket_port": 58650,
        "metrics_port": 9090,
        "bootnodes": bootnodes,
    },
    "supply": {
        "total_supply": str(total_allocated),
        "token_symbol": "SNRG",
        "token_name": "Synergy Token",
        "decimals": 9,
        "burn_address": "synergy00000000000000000000000burn",
    },
    "genesis_allocations": genesis_allocations,
    "validators": validators,
    "governance": {
        "dao_address": "syndao17qw77teuxfejlupqpadzzj9exavmtmhysac2uq",
        "treasury_address": treasury_address,
        "proposal_deposit": "10000",
        "voting_period": 100,
        "execution_delay": 10,
        "quorum_percentage": 33.4,
        "pass_threshold": 51.0,
    },
    "cryptography": {
        "signature_algorithm": "FN-DSA-1024",
        "key_encapsulation": "ML-KEM-1024",
        "hash_algorithm": "SHA3-256",
        "address_encoding": "Bech32m",
        "security_level": "NIST Level 5",
    },
    "smart_contracts": {
        "aivm_enabled": True,
        "wasm_enabled": True,
        "max_gas_per_block": 100000000,
        "min_gas_price": 1,
    },
}

with open(output_file, "w", encoding="utf-8") as handle:
    json.dump(genesis, handle, indent=2)
    handle.write("\n")

print(f"Wrote genesis to {output_file}")
print(f"validators={len(validators)} bootnodes={len(bootnodes)}")
PY

echo "Genesis generation complete: $OUTPUT_FILE"
