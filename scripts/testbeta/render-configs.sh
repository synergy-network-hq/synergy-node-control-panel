#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INVENTORY_FILE="$ROOT_DIR/testbeta/runtime/node-inventory.csv"
HOSTS_FILE="${1:-${HOSTS_FILE:-}}"
OUT_DIR="$ROOT_DIR/testbeta/runtime/configs"
NODE_ADDRESSES_FILE="$ROOT_DIR/testbeta/runtime/keys/node-addresses.csv"
MANIFEST_FILE="$ROOT_DIR/../config/operational-manifest.json"
TESTBETA_ENV_DIR_DEFAULT="${TESTBETA_ENV_DIR_DEFAULT:-$ROOT_DIR/testbeta/runtime/env-files}"
ENV_OVERRIDE_HELPER="${ENV_OVERRIDE_HELPER:-$ROOT_DIR/../scripts/testbeta/testbeta-env-overrides.sh}"
USE_HOST_OVERRIDES="false"
TESTBETA_CHAIN_ID="${TESTBETA_CHAIN_ID:-338639}"
TESTBETA_NETWORK_NAME="${TESTBETA_NETWORK_NAME:-synergy-testnet-beta}"
TESTBETA_BLOCK_TIME_SECS="${TESTBETA_BLOCK_TIME_SECS:-2}"
TESTBETA_EPOCH_LENGTH="${TESTBETA_EPOCH_LENGTH:-1000}"
TESTBETA_MIN_VALIDATORS="${TESTBETA_MIN_VALIDATORS:-3}"
TESTBETA_VALIDATOR_CLUSTER_SIZE="${TESTBETA_VALIDATOR_CLUSTER_SIZE:-5}"
TESTBETA_MAX_VALIDATORS="${TESTBETA_MAX_VALIDATORS:-100}"
ALLOW_WILDCARD_LISTEN="${ALLOW_WILDCARD_LISTEN:-false}"

if [[ -f "$ENV_OVERRIDE_HELPER" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_OVERRIDE_HELPER"
fi

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

if [[ ! -f "$MANIFEST_FILE" ]]; then
  echo "Missing operational manifest: $MANIFEST_FILE" >&2
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
find "$OUT_DIR" -maxdepth 1 -type f -name '*.toml' -delete 2>/dev/null || true

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
  local env_port=""
  if declare -F testbeta_validator_env_value >/dev/null 2>&1; then
    env_port="$(testbeta_first_nonempty \
      "$(testbeta_validator_env_value "$validator_address" "P2P_PORT_EXTERNAL" || true)" \
      "$(testbeta_validator_env_value "$validator_address" "P2P_PORT" || true)" \
    )"
  fi

  if [[ -n "$env_port" ]]; then
    echo "$env_port"
    return
  fi

  case "$validator_address" in
    synv114cvu472rkdgpmzvkj70zk9tu8cqqlu4x9ra) echo "5622" ;;
    synv11wrj74dnkc802jfl4e7j7jd2azj2zk2eqvgu) echo "5622" ;;
    synv11v2r4gnp5py3ae5ft6646lxpqphdv58k8tyu) echo "5622" ;;
    synv118u0v2gxn4zew5j886hwz32tkaujsvhykf49) echo "5622" ;;
    synv11mvlgy72uq7kuh200qnxv67zrqjugz267k46) echo "5622" ;;
    *) echo "$default_port" ;;
  esac
}

is_assigned_synergy_host() {
  local host
  host="$(echo "${1:-}" | tr '[:upper:]' '[:lower:]' | xargs)"
  [[ -n "$host" && "$host" == *.synergynode.xyz ]]
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

compute_p2p_listen_address() {
  local role_group="$1"
  local node_type="$2"
  local p2p_host="$3"
  local p2p_port="$4"

  if [[ "$role_group" == "consensus" && "$node_type" == "validator" ]]; then
    echo "0.0.0.0:${p2p_port}"
    return
  fi

  compute_listen_address "$p2p_host" "$p2p_port"
}

compute_discovery_listen_address() {
  local role_group="$1"
  local node_type="$2"
  local p2p_host="$3"
  local discovery_port="$4"

  if [[ "$role_group" == "consensus" && "$node_type" == "validator" ]]; then
    echo "0.0.0.0:${discovery_port}"
    return
  fi

  compute_listen_address "$p2p_host" "$discovery_port"
}

resolve_bind_host() {
  local bind_ip="${1:-}"
  local local_ip="${2:-}"
  local management_host="${3:-}"
  local public_host="${4:-}"
  testbeta_first_nonempty "$bind_ip" "$local_ip" "$management_host" "$public_host"
}

lookup_node_address() {
  local node_slot_id="$1"
  awk -F, -v id="$node_slot_id" 'NR > 1 && $1 == id { print $6; exit }' "$NODE_ADDRESSES_FILE"
}

read_canonical_validators() {
  python3 - "$MANIFEST_FILE" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    manifest = json.load(handle)

for entry in manifest.get("validators", []):
    slot = entry.get("slot")
    address = str(entry.get("address") or "").strip()
    if slot is None or not address:
        continue
    print(f"{slot},{address}")
PY
}

collect_allowed_validator_addresses() {
  local addresses=()
  while IFS=, read -r _ validator_address || [[ -n "${validator_address:-}" ]]; do
    [[ -n "${validator_address:-}" ]] || continue
    addresses+=("\"$validator_address\"")
  done < <(read_canonical_validators)

  if [[ "${#addresses[@]}" -eq 0 ]]; then
    echo "[]"
    return
  fi

  local joined
  joined="$(IFS=,; echo "${addresses[*]}")"
  echo "[$joined]"
}

collect_static_validator_mesh_peers() {
  local current_node_slot_id="${1:-}"
  local current_validator_address="${2:-}"
  local peers=()
  while IFS=, read -r slot peer_id || [[ -n "${peer_id:-}" ]]; do
    [[ -n "${peer_id:-}" ]] || continue
    if [[ -n "$current_validator_address" && "$peer_id" == "$current_validator_address" ]]; then
      continue
    fi

    local validator_env_file resolved_host public_p2p_port
    validator_env_file=""
    if declare -F testbeta_env_file_for_validator_address >/dev/null 2>&1; then
      validator_env_file="$(testbeta_env_file_for_validator_address "$peer_id" || true)"
    fi
    resolved_host="$(testbeta_first_nonempty \
      "$(testbeta_env_value "$validator_env_file" "HOSTNAME" || true)" \
      "genesisval${slot}.synergynode.xyz" \
    )"
    if ! is_assigned_synergy_host "$resolved_host"; then
      continue
    fi
    public_p2p_port="$(testbeta_first_nonempty \
      "$(testbeta_env_value "$validator_env_file" "P2P_PORT_EXTERNAL" || true)" \
      "$(testbeta_env_value "$validator_env_file" "P2P_PORT" || true)" \
      "$(resolve_public_p2p_port "$peer_id" "5622")" \
    )"
    peers+=("\"snr://${peer_id}@${resolved_host}:${public_p2p_port}\"")
  done < <(read_canonical_validators)

  if [[ "${#peers[@]}" -eq 0 ]]; then
    echo "Inventory does not define any assigned consensus validators for static mesh dialing." >&2
    exit 1
  fi

  local joined
  joined="$(IFS=,; echo "${peers[*]}")"
  echo "[$joined]"
}

render_bootnode_list() {
  local joined
  joined="$(IFS=,; echo "$*")"
  echo "[${joined}]"
}
ALLOWED_VALIDATOR_ADDRESSES="$(collect_allowed_validator_addresses)"

generated_count=0

while IFS=, read -r node_slot_id node_alias role_group role node_type _ p2p_port rpc_port ws_port grpc_port discovery_port host management_host physical_machine_id auto_register enable_pruning vrf_enabled operator device operating_system public_ip local_ip || [[ -n "${node_slot_id:-}" ]]; do
  [[ "$node_slot_id" == "node_slot_id" ]] && continue
  if [[ "$(printf '%s' "$node_type" | tr '[:upper:]' '[:lower:]')" == "bootnode" ]]; then
    continue
  fi

  source_env_file="$(testbeta_env_file_for_inventory_node "$node_slot_id" "$node_type" "" "$host" || true)"
  validator_address="$(testbeta_first_nonempty \
    "$(testbeta_env_value "$source_env_file" "NODE_WALLET" || true)" \
    "$(lookup_node_address "$node_slot_id")" \
  )"
  if [[ -z "$validator_address" ]]; then
    echo "Missing validator address mapping for ${node_slot_id} in ${NODE_ADDRESSES_FILE}" >&2
    exit 1
  fi

  host="$(testbeta_inventory_env_value "$node_slot_id" "$node_type" "$validator_address" "$host" "HOSTNAME" "$host")"
  public_ip="$(testbeta_inventory_env_value "$node_slot_id" "$node_type" "$validator_address" "$host" "PUBLIC_IP" "$public_ip")"
  local_ip="$(testbeta_inventory_env_value_allow_empty "$node_slot_id" "$node_type" "$validator_address" "$host" "LOCAL_IP" "$local_ip")"
  bind_ip="$(testbeta_inventory_env_value "$node_slot_id" "$node_type" "$validator_address" "$host" "BIND_IP" "")"
  p2p_port="$(testbeta_inventory_env_value "$node_slot_id" "$node_type" "$validator_address" "$host" "P2P_PORT" "$p2p_port")"
  rpc_port="$(testbeta_inventory_env_value "$node_slot_id" "$node_type" "$validator_address" "$host" "RPC_PORT" "$rpc_port")"
  ws_port="$(testbeta_inventory_env_value "$node_slot_id" "$node_type" "$validator_address" "$host" "WS_PORT" "$ws_port")"
  grpc_port="$(testbeta_inventory_env_value "$node_slot_id" "$node_type" "$validator_address" "$host" "GRPC_PORT" "$grpc_port")"
  discovery_port="$(testbeta_inventory_env_value "$node_slot_id" "$node_type" "$validator_address" "$host" "DISCOVERY_PORT" "$discovery_port")"

  management_host="$(testbeta_first_nonempty \
    "$(testbeta_inventory_env_value "$node_slot_id" "$node_type" "$validator_address" "$host" "MANAGEMENT_HOST" "")" \
    "$local_ip" \
    "$management_host" \
    "$public_ip" \
    "$host" \
  )"
  resolved_public_host="$(resolve_public_host "$node_slot_id" "$host")"
  resolved_p2p_host="$(resolve_p2p_host "$node_slot_id" "$management_host" "$resolved_public_host")"
  bind_host="$(resolve_bind_host "$bind_ip" "$local_ip" "$resolved_p2p_host" "$resolved_public_host")"
  listen_address="$(compute_p2p_listen_address "$role_group" "$node_type" "$bind_host" "$p2p_port")"
  public_p2p_port="$(testbeta_inventory_env_value "$node_slot_id" "$node_type" "$validator_address" "$host" "P2P_PORT_EXTERNAL" "$(resolve_public_p2p_port "$validator_address" "$p2p_port")")"
  public_address="$(compute_public_address "$resolved_public_host" "$public_p2p_port")"
  public_discovery_port="$(testbeta_inventory_env_value "$node_slot_id" "$node_type" "$validator_address" "$host" "DISCOVERY_PORT_EXTERNAL" "$discovery_port")"
  discovery_listen_address="$(compute_discovery_listen_address "$role_group" "$node_type" "$bind_host" "$discovery_port")"
  discovery_public_address="$(compute_public_address "$resolved_public_host" "$public_discovery_port")"
  rpc_bind_address="${bind_host}:${rpc_port}"
  role_id="$(normalize_role_id "$role")"
  compiled_profile="$(compiled_profile_for_role "$role_id")"

  bootnodes="$(render_bootnode_list \
    "\"snr://bootstrap@bootnode1.synergynode.xyz:5620\"" \
    "\"snr://bootstrap@bootnode2.synergynode.xyz:5620\"" \
    "\"snr://bootstrap@bootnode3.synergynode.xyz:5620\"" \
  )"
  additional_dial_targets="$(collect_static_validator_mesh_peers "$node_slot_id" "$validator_address")"

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
seed_servers = []
bootstrap_dns_records = []
additional_dial_targets = ${additional_dial_targets}

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
bind_address = "${rpc_bind_address}"
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
enable_discovery = false
discovery_port = ${discovery_port}
discovery_listen_address = "${discovery_listen_address}"
discovery_public_address = "${discovery_public_address}"
heartbeat_interval = 10

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
strict_validator_allowlist = true
allowed_validator_addresses = ${ALLOWED_VALIDATOR_ADDRESSES}
CONFIG

  echo "Generated ${OUT_DIR}/${node_slot_id}.toml"
  generated_count=$((generated_count + 1))
done < "$INVENTORY_FILE"

echo "Rendered ${generated_count} node configs into: $OUT_DIR"
