#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INVENTORY_FILE="$ROOT_DIR/testbeta/runtime/node-inventory.csv"
NODE_ADDRESSES_FILE="$ROOT_DIR/testbeta/runtime/keys/node-addresses.csv"
OUTPUT_FILE="${1:-$ROOT_DIR/testbeta/runtime/configs/genesis/genesis.json}"

if [[ ! -f "$INVENTORY_FILE" ]]; then
  echo "Missing inventory file: $INVENTORY_FILE" >&2
  exit 1
fi

if [[ ! -f "$NODE_ADDRESSES_FILE" ]]; then
  echo "Missing node address file: $NODE_ADDRESSES_FILE" >&2
  echo "Run scripts/testbeta/generate-node-keys.sh first." >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT_FILE")"

python3 - "$INVENTORY_FILE" "$NODE_ADDRESSES_FILE" "$OUTPUT_FILE" <<'PY'
import csv
import json
import os
import sys

inventory_file, addresses_file, output_file = sys.argv[1:4]

chain_id = int(os.environ.get("TESTBETA_CHAIN_ID", "338639"))
genesis_time = os.environ.get("TESTBETA_GENESIS_TIME", "2026-01-01T00:00:00Z")
node_stake = int(os.environ.get("TESTBETA_NODE_STAKE", os.environ.get("TESTBETA_VALIDATOR_STAKE", "50000000000000")))
min_validators = int(os.environ.get("TESTBETA_MIN_VALIDATORS", "4"))
max_validators = int(os.environ.get("TESTBETA_MAX_VALIDATORS", "100"))

faucet_address = os.environ.get("TESTBETA_FAUCET_ADDRESS", "synw1prdr55ggjhupx0d7jycftrl2hzs3k8zuw5ad")
treasury_address = os.environ.get("TESTBETA_TREASURY_ADDRESS", "synu1nd0fvzfhhj4s0te3ks06csfsnpg2hed8vsmh")
team_address = os.environ.get("TESTBETA_TEAM_ADDRESS", "synw1pckkuqdeep4qz47ww9hnnm6uru2f9r6qtumv")
ecosystem_address = os.environ.get("TESTBETA_ECOSYSTEM_ADDRESS", "synw1vkn2dq8mftcn7nkdhyv5t0jrv83thf0cakkj")
public_sale_address = os.environ.get("TESTBETA_PUBLIC_SALE_ADDRESS", "synw1f2kpjt9flxl6y4e3uez0zp3hjanamrlew5ja")

faucet_balance = int(os.environ.get("TESTBETA_FAUCET_BALANCE", "100000000000000"))
treasury_balance = int(os.environ.get("TESTBETA_TREASURY_BALANCE", "400000000000000"))
team_balance = int(os.environ.get("TESTBETA_TEAM_BALANCE", "150000000000000"))
ecosystem_balance = int(os.environ.get("TESTBETA_ECOSYSTEM_BALANCE", "200000000000000"))
public_sale_balance = int(os.environ.get("TESTBETA_PUBLIC_SALE_BALANCE", "100000000000000"))

def parse_bool(raw: str) -> bool:
    value = (raw or "").strip().lower()
    return value in {"1", "true", "yes", "on"}

addresses = {}
with open(addresses_file, newline="", encoding="utf-8") as handle:
    reader = csv.DictReader(handle)
    for row in reader:
        node_slot_id = row.get("node_slot_id", "").strip()
        address = row.get("address", "").strip()
        if node_slot_id and address:
            addresses[node_slot_id] = address

inventory_rows = []
with open(inventory_file, newline="", encoding="utf-8") as handle:
    reader = csv.DictReader(handle)
    for row in reader:
        inventory_rows.append(row)

machine_by_id = {row["node_slot_id"]: row for row in inventory_rows}

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
bootnodes = []
for row in validator_rows:
    node_slot_id = row["node_slot_id"]
    endpoint_ip = row.get("management_host") or row.get("host")
    p2p_port = row.get("p2p_port")
    address = addresses.get(node_slot_id)
    if endpoint_ip and p2p_port and address:
        bootnodes.append(f"snr://{address}@{endpoint_ip}:{p2p_port}")

validators = []
genesis_allocations = [
    {
        "type": "treasury",
        "address": treasury_address,
        "balance": str(treasury_balance),
        "description": "Foundation/Treasury",
    },
    {
        "type": "team_wallet",
        "address": team_address,
        "balance": str(team_balance),
        "description": "Team",
    },
    {
        "type": "ecosystem_wallet",
        "address": ecosystem_address,
        "balance": str(ecosystem_balance),
        "description": "Ecosystem Development",
    },
    {
        "type": "faucet_wallet",
        "address": faucet_address,
        "balance": str(faucet_balance),
        "description": "Testnet Faucet Reserve",
    },
    {
        "type": "public_sale_wallet",
        "address": public_sale_address,
        "balance": str(public_sale_balance),
        "description": "Future Public Sale",
    },
]
for index, row in enumerate(validator_rows, start=1):
    node_slot_id = row["node_slot_id"]
    address = addresses.get(node_slot_id)
    if not address:
        continue
    node_alias = row.get("node_alias", node_slot_id)
    validators.append(
        {
            "address": address,
            "public_key_file": f"testbeta/runtime/keys/{node_slot_id}/identity.json",
            "stake": str(node_stake),
            "commission_rate": 0.05,
            "min_self_delegation": "1",
            "max_delegations": 1000,
            "details": {
                "name": f"{node_alias} validator",
                "identity": node_alias,
                "website": "https://synergy-network.io",
                "security_contact": "security@synergy-network.io",
                "class": int(row.get("address_class") or 1),
            },
        }
    )
    genesis_allocations.append(
        {
            "type": "validator_wallet",
            "address": address,
            "balance": str(node_stake),
            "stake": str(node_stake),
            "description": f"Genesis allocation for {node_alias}",
            "node_alias": node_alias,
            "node_slot_id": node_slot_id,
            "role_group": row.get("role_group", ""),
            "role": row.get("role", ""),
            "node_type": row.get("node_type", ""),
            "physical_machine_id": row.get("physical_machine_id", ""),
        }
    )

total_allocated = 0
for allocation in genesis_allocations:
    try:
        total_allocated += int(allocation.get("balance", "0"))
    except ValueError:
        pass

genesis = {
    "metadata": {
        "network_name": "Synergy Testnet-Beta",
        "network_id": "synergy-testnet-beta",
        "genesis_time": genesis_time,
        "chain_id": str(chain_id),
        "version": "2.1.0-testbeta",
        "description": "Canonical Synergy Testnet-Beta genesis",
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
            "min_stake_amount": str(node_stake),
            "allow_zero_stake_validators": False,
            "dynamic_validator_registration": False,
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
        "rpc_endpoint": "https://testbeta-core-rpc.synergy-network.io",
        "websocket_endpoint": "wss://testbeta-core-ws.synergy-network.io",
        "api_endpoint": "https://testbeta-api.synergy-network.io",
        "explorer_endpoint": "https://testbeta-explorer.synergy-network.io",
        "rpc_port": 5640,
        "p2p_port": 5622,
        "websocket_port": 5660,
        "metrics_port": 6030,
        "bootnodes": [
            "snr://bootstrap@bootnode1.synergynode.xyz:5620",
            "snr://bootstrap@bootnode2.synergynode.xyz:5620",
            "snr://bootstrap@bootnode3.synergynode.xyz:5620",
        ],
    },
    "supply": {
        "total_supply": str(total_allocated),
        "token_symbol": "SNRG",
        "token_name": "Synergy Token",
        "decimals": 9,
        "burn_address": "synergy000000000000000000000000000000burn",
    },
    "genesis_allocations": genesis_allocations,
    "validators": validators,
    "governance": {
        "dao_address": "syndao1lf6q9zmfh4w4t30d04j05nmsku03te4685t5vn",
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

with open(output_file, "w", encoding="utf-8", newline="\n") as handle:
    json.dump(genesis, handle, indent=2)
    handle.write("\n")

print(f"Wrote genesis to {output_file}")
print(f"validators={len(validators)} bootnodes={len(bootnodes)}")
PY

echo "Genesis generation complete: $OUTPUT_FILE"
