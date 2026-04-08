#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INVENTORY_FILE="$ROOT_DIR/testbeta/runtime/node-inventory.csv"
HOSTS_FILE="${1:-${HOSTS_FILE:-}}"
OUT_DIR="$ROOT_DIR/testbeta/runtime/configs"
NODE_ADDRESSES_FILE="$ROOT_DIR/testbeta/runtime/keys/node-addresses.csv"
USE_HOST_OVERRIDES="false"
TESTBETA_CHAIN_ID="${TESTBETA_CHAIN_ID:-338639}"
TESTBETA_NETWORK_NAME="${TESTBETA_NETWORK_NAME:-synergy-testnet-beta}"
TESTBETA_BLOCK_TIME_SECS="${TESTBETA_BLOCK_TIME_SECS:-2}"
TESTBETA_EPOCH_LENGTH="${TESTBETA_EPOCH_LENGTH:-1000}"
TESTBETA_MIN_VALIDATORS="${TESTBETA_MIN_VALIDATORS:-4}"
TESTBETA_VALIDATOR_CLUSTER_SIZE="${TESTBETA_VALIDATOR_CLUSTER_SIZE:-4}"
TESTBETA_MAX_VALIDATORS="${TESTBETA_MAX_VALIDATORS:-100}"
ALLOW_WILDCARD_LISTEN="${ALLOW_WILDCARD_LISTEN:-false}"

normalize_bool() {
  local raw="${1:-}"
  raw="$(echo "$raw" | tr '[:upper:]' '[:lower:]' | xargs)"
  case "$raw" in
    1|true|yes|on)
      echo "true"
      ;;
    0|false|no|off|"")
      echo "false"
      ;;
    *)
      echo "false"
      ;;
  esac
}

if [[ ! -f "$INVENTORY_FILE" ]]; then
  echo "Missing inventory file: $INVENTORY_FILE" >&2
  exit 1
fi

if [[ ! -f "$NODE_ADDRESSES_FILE" ]]; then
  echo "Missing node address file: $NODE_ADDRESSES_FILE" >&2
  exit 1
fi

if [[ -n "${HOSTS_FILE:-}" && -s "$HOSTS_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$HOSTS_FILE"
  USE_HOST_OVERRIDES="true"
else
  if [[ -n "${HOSTS_FILE:-}" ]]; then
    echo "Hosts override file not found or empty at $HOSTS_FILE; using values from inventory." >&2
  else
    echo "No hosts override file provided; using values from inventory." >&2
  fi
fi

mkdir -p "$OUT_DIR"

resolve_public_host() {
  local node_slot_id="$1"
  local default_host="$2"
  local node_slot_key
  if [[ "$USE_HOST_OVERRIDES" != "true" ]]; then
    echo "$default_host"
    return
  fi

  node_slot_key="$(echo "$node_slot_id" | tr '[:lower:]-' '[:upper:]_')"
  local var_name="${node_slot_key}_HOST"
  local value="${!var_name:-}"
  if [[ -n "$value" ]]; then
    echo "$value"
  else
    echo "$default_host"
  fi
}

resolve_public_p2p_port() {
  local validator_address="$1"
  local default_port="$2"
  case "$validator_address" in
    synv114cvu472rkdgpmzvkj70zk9tu8cqqlu4x9ra) echo "5622" ;;
    synv11wrj74dnkc802jfl4e7j7jd2azj2zk2eqvgu) echo "5622" ;;
    synv11v2r4gnp5py3ae5ft6646lxpqphdv58k8tyu) echo "5623" ;;
    synv118u0v2gxn4zew5j886hwz32tkaujsvhykf49) echo "5624" ;;
    synv11mvlgy72uq7kuh200qnxv67zrqjugz267k46) echo "5622" ;;
    *) echo "$default_port" ;;
  esac
}

normalize_role_id() {
  local raw="${1:-}"
  raw="$(echo "$raw" | tr '[:upper:]-' '[:lower:]_' | xargs)"
  case "$raw" in
    validator) echo "validator" ;;
    committee) echo "committee" ;;
    archive_validator) echo "archive_validator" ;;
    audit_validator) echo "audit_validator" ;;
    relayer) echo "relayer" ;;
    witness) echo "witness" ;;
    oracle) echo "oracle" ;;
    uma_coordinator) echo "uma_coordinator" ;;
    cross_chain_verifier) echo "cross_chain_verifier" ;;
    compute|synq_execution) echo "synq_execution" ;;
    ai_inference|analytics_simulation) echo "analytics_simulation" ;;
    pqc_crypto|aegis_cryptography) echo "aegis_cryptography" ;;
    data_availability) echo "data_availability" ;;
    governance_auditor) echo "governance_auditor" ;;
    treasury_controller) echo "treasury_controller" ;;
    security_council) echo "security_council" ;;
    rpc_gateway) echo "rpc_gateway" ;;
    indexer|indexer_explorer) echo "indexer_explorer" ;;
    observer|observer_light) echo "observer_light" ;;
    *)
      echo "$raw"
      ;;
  esac
}

compiled_profile_for_role() {
  local role_id="$1"
  case "$role_id" in
    validator) echo "validator_node" ;;
    committee) echo "committee_node" ;;
    archive_validator) echo "archive_validator_node" ;;
    audit_validator) echo "audit_validator_node" ;;
    relayer) echo "relayer_node" ;;
    witness) echo "witness_node" ;;
    oracle) echo "oracle_node" ;;
    uma_coordinator) echo "uma_coordinator_node" ;;
    cross_chain_verifier) echo "cross_chain_verifier_node" ;;
    synq_execution) echo "synq_execution_node" ;;
    analytics_simulation) echo "analytics_and_simulation_node" ;;
    aegis_cryptography) echo "aegis_cryptography_node" ;;
    data_availability) echo "data_availability_node" ;;
    governance_auditor) echo "governance_auditor_node" ;;
    treasury_controller) echo "treasury_controller_node" ;;
    security_council) echo "security_council_node" ;;
    rpc_gateway) echo "rpc_gateway_node" ;;
    indexer_explorer) echo "indexer_and_explorer_node" ;;
    observer_light) echo "observer_light_node" ;;
    *)
      echo "${role_id}_node"
      ;;
  esac
}

resolve_p2p_host() {
  local node_slot_id="$1"
  local default_management_host="$2"
  local fallback_public_host="$3"
  local node_slot_key
  if [[ "$USE_HOST_OVERRIDES" != "true" ]]; then
    if [[ -n "${default_management_host}" ]]; then
      echo "${default_management_host}"
    else
      echo "${fallback_public_host}"
    fi
    return
  fi

  node_slot_key="$(echo "$node_slot_id" | tr '[:lower:]-' '[:upper:]_')"

  local management_host_var="${node_slot_key}_MANAGEMENT_HOST"
  local p2p_var="${node_slot_key}_P2P_HOST"
  local internal_var="${node_slot_key}_INTERNAL_HOST"

  if [[ -n "${!management_host_var:-}" ]]; then
    echo "${!management_host_var}"
    return
  fi

  if [[ -n "${!p2p_var:-}" ]]; then
    echo "${!p2p_var}"
    return
  fi

  if [[ -n "${!internal_var:-}" ]]; then
    echo "${!internal_var}"
    return
  fi

  if [[ -n "${default_management_host}" ]]; then
    echo "${default_management_host}"
    return
  fi

  echo "${fallback_public_host}"
}

compute_listen_address() {
  local p2p_host="$1"
  local p2p_port="$2"

  if [[ "$p2p_host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    if [[ "$p2p_host" =~ ^10\. ]] || [[ "$p2p_host" =~ ^192\.168\. ]] || [[ "$p2p_host" =~ ^172\.([1][6-9]|2[0-9]|3[0-1])\. ]] || [[ "$p2p_host" =~ ^127\. ]]; then
      echo "${p2p_host}:${p2p_port}"
      return
    fi
    echo "0.0.0.0:${p2p_port}"
    return
  fi

  if [[ "$p2p_host" == "localhost" ]]; then
    echo "127.0.0.1:${p2p_port}"
    return
  fi

  echo "0.0.0.0:${p2p_port}"
}

compute_public_address() {
  local p2p_host="$1"
  local p2p_port="$2"

  if [[ "$p2p_host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "${p2p_host}:${p2p_port}"
    return
  fi

  if [[ "$p2p_host" == "localhost" ]]; then
    echo "127.0.0.1:${p2p_port}"
    return
  fi

  echo "${p2p_host}:${p2p_port}"
}

lookup_node_address() {
  local node_slot_id="$1"
  awk -F, -v id="$node_slot_id" 'NR > 1 && $1 == id { print $6; exit }' "$NODE_ADDRESSES_FILE"
}

collect_allowed_validator_addresses() {
  local addresses=()
  while IFS=, read -r node_slot_id node_alias role_group role node_type address_class p2p_port rpc_port ws_port grpc_port discovery_port host management_host physical_machine_id auto_register enable_pruning vrf_enabled operator device operating_system public_ip local_ip || [[ -n "${node_slot_id:-}" ]]; do
    [[ "$node_slot_id" == "node_slot_id" ]] && continue
    local normalized_group normalized_role normalized_type
    normalized_group="$(echo "${role_group:-}" | tr '[:upper:]' '[:lower:]' | xargs)"
    normalized_role="$(echo "${role:-}" | tr '[:upper:]' '[:lower:]' | xargs)"
    normalized_type="$(echo "${node_type:-}" | tr '[:upper:]' '[:lower:]' | xargs)"
    if [[ "$(normalize_bool "$auto_register")" != "true" ]]; then
      continue
    fi
    if [[ "$normalized_group" != "consensus" ]]; then
      continue
    fi
    if [[ "$normalized_type" != "validator" && "$normalized_role" != "validator" ]]; then
      continue
    fi
    local validator_address
    validator_address="$(lookup_node_address "$node_slot_id")"
    if [[ -n "$validator_address" ]]; then
      addresses+=("\"$validator_address\"")
    fi
  done < "$INVENTORY_FILE"

  if [[ "${#addresses[@]}" -eq 0 ]]; then
    echo "[]"
    return
  fi

  local joined
  joined="$(IFS=,; echo "${addresses[*]}")"
  echo "[$joined]"
}

collect_bootnodes() {
  local bootnodes=()
  while IFS=, read -r node_slot_id _ role_group role node_type _ p2p_port _ _ _ _ host management_host _ auto_register _ _ || [[ -n "${node_slot_id:-}" ]]; do
    [[ "$node_slot_id" == "node_slot_id" ]] && continue
    local normalized_group normalized_role normalized_type
    normalized_group="$(echo "${role_group:-}" | tr '[:upper:]' '[:lower:]' | xargs)"
    normalized_role="$(echo "${role:-}" | tr '[:upper:]' '[:lower:]' | xargs)"
    normalized_type="$(echo "${node_type:-}" | tr '[:upper:]' '[:lower:]' | xargs)"
    if [[ "$(normalize_bool "$auto_register")" != "true" ]]; then
      continue
    fi
    if [[ "$normalized_group" != "consensus" ]]; then
      continue
    fi
    if [[ "$normalized_type" != "validator" && "$normalized_role" != "validator" ]]; then
      continue
    fi

    local resolved_host resolved_p2p_host peer_id public_p2p_port
    resolved_host="$(resolve_public_host "$node_slot_id" "$host")"
    resolved_p2p_host="$(resolve_p2p_host "$node_slot_id" "$management_host" "$resolved_host")"
    peer_id="$(lookup_node_address "$node_slot_id")"
    if [[ -z "$peer_id" ]]; then
      echo "Could not resolve peer ID for ${node_slot_id} from node-addresses.csv." >&2
      exit 1
    fi
    public_p2p_port="$(resolve_public_p2p_port "$peer_id" "$p2p_port")"

    bootnodes+=("\"snr://${peer_id}@${resolved_host}:${public_p2p_port}\"")
  done < "$INVENTORY_FILE"

  if [[ "${#bootnodes[@]}" -eq 0 ]]; then
    echo "Inventory does not define any auto-register consensus validators for bootstrap dialing." >&2
    exit 1
  fi

  local joined
  joined="$(IFS=,; echo "${bootnodes[*]}")"
  echo "[$joined]"
}

BOOTNODES="$(collect_bootnodes)"
ALLOWED_VALIDATOR_ADDRESSES="$(collect_allowed_validator_addresses)"

generated_count=0

while IFS=, read -r node_slot_id node_alias role_group role node_type _ p2p_port rpc_port ws_port grpc_port discovery_port host management_host physical_machine_id auto_register enable_pruning vrf_enabled operator device operating_system public_ip local_ip || [[ -n "${node_slot_id:-}" ]]; do
  [[ "$node_slot_id" == "node_slot_id" ]] && continue

  resolved_public_host="$(resolve_public_host "$node_slot_id" "$host")"
  resolved_p2p_host="$(resolve_p2p_host "$node_slot_id" "$management_host" "$resolved_public_host")"
  listen_address="$(compute_listen_address "$resolved_p2p_host" "$p2p_port")"
  validator_address="$(lookup_node_address "$node_slot_id")"
  if [[ -z "$validator_address" ]]; then
    echo "Missing validator address mapping for ${node_slot_id} in ${NODE_ADDRESSES_FILE}" >&2
    exit 1
  fi
  public_p2p_port="$(resolve_public_p2p_port "$validator_address" "$p2p_port")"
  public_address="$(compute_public_address "$resolved_public_host" "$public_p2p_port")"
  role_id="$(normalize_role_id "$role")"
  compiled_profile="$(compiled_profile_for_role "$role_id")"

  bootnodes="$BOOTNODES"

  auto_register="$(normalize_bool "$auto_register")"
  enable_pruning="$(normalize_bool "$enable_pruning")"
  vrf_enabled="$(normalize_bool "$vrf_enabled")"

  cat > "$OUT_DIR/${node_slot_id}.toml" <<CONFIG
# Auto-generated by scripts/testbeta/render-configs.sh
# Node Slot: ${node_slot_id}
# Role Group: ${role_group}
# Role: ${role}
# Node Type: ${node_type}

[identity]
node_id = "${node_slot_id}"
role = "${role_id}"
role_display = "${role}"
address = "${validator_address}"
label = "${node_alias}"

[role]
compiled_profile = "${compiled_profile}"
services = []

[network]
id = ${TESTBETA_CHAIN_ID}
name = "${TESTBETA_NETWORK_NAME}"
p2p_port = ${p2p_port}
rpc_port = ${rpc_port}
ws_port = ${ws_port}
max_peers = 100
bootnodes = ${bootnodes}

[blockchain]
block_time = ${TESTBETA_BLOCK_TIME_SECS}
max_gas_limit = "0x2fefd8"
chain_id = ${TESTBETA_CHAIN_ID}

[consensus]
algorithm = "Proof of Synergy"
block_time_secs = ${TESTBETA_BLOCK_TIME_SECS}
epoch_length = ${TESTBETA_EPOCH_LENGTH}
min_validators = ${TESTBETA_MIN_VALIDATORS}
validator_cluster_size = ${TESTBETA_VALIDATOR_CLUSTER_SIZE}
max_validators = ${TESTBETA_MAX_VALIDATORS}
synergy_score_decay_rate = 0.05
vrf_enabled = ${vrf_enabled}
vrf_seed_epoch_interval = 1000
max_synergy_points_per_epoch = 100
max_tasks_per_validator = 10

[consensus.reward_weighting]
task_accuracy = 0.5
uptime = 0.3
collaboration = 0.2

[logging]
log_level = "debug"
log_file = "data/logs/${node_alias}.log"
enable_console = true
max_file_size = 10485760
max_files = 5

[rpc]
bind_address = "${resolved_p2p_host}:${rpc_port}"
enable_http = true
http_port = ${rpc_port}
enable_ws = true
ws_port = ${ws_port}
enable_grpc = true
grpc_port = ${grpc_port}
cors_enabled = false
cors_origins = []

[p2p]
listen_address = "${listen_address}"
public_address = "${public_address}"
node_name = "${node_alias}"
enable_discovery = true
discovery_port = ${discovery_port}
heartbeat_interval = 30

[storage]
database = "rocksdb"
path = "data/chain"
enable_pruning = ${enable_pruning}
pruning_interval = 86400

[snapshots]
enabled = true
interval_blocks = 10000

[node]
auto_register_validator = ${auto_register}
validator_address = "${validator_address}"
strict_validator_allowlist = false
allowed_validator_addresses = ${ALLOWED_VALIDATOR_ADDRESSES}
CONFIG

  echo "Generated ${OUT_DIR}/${node_slot_id}.toml"
  generated_count=$((generated_count + 1))
done < "$INVENTORY_FILE"

echo "Rendered ${generated_count} node configs into: $OUT_DIR"
