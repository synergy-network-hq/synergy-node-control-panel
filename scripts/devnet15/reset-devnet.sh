#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INVENTORY_FILE="$ROOT_DIR/devnet/lean15/node-inventory.csv"
HOSTS_FILE="${HOSTS_FILE:-$ROOT_DIR/devnet/lean15/hosts.env}"
RUN_NODE_SCRIPT="$ROOT_DIR/scripts/devnet15/run-node.sh"
RENDER_CONFIGS_SCRIPT="$ROOT_DIR/scripts/devnet15/render-configs.sh"
GENESIS_SCRIPT="$ROOT_DIR/scripts/devnet15/generate-devnet-genesis.sh"
VALIDATE_CLOSED_SCRIPT="$ROOT_DIR/scripts/devnet15/validate-closed-devnet.sh"

REBUILD_INSTALLERS="false"
SKIP_RESTART="false"

START_ORDER=(
  node-01
  node-02
  node-03
  node-04
  node-05
  node-10
  node-11
  node-06
  node-07
  node-08
  node-09
  node-12
  node-13
  node-14
  node-15
)

usage() {
  cat <<USAGE
Usage: $0 [--hosts-file <path>] [--rebuild-installers] [--skip-restart]

Performs a full closed-devnet reset workflow:
1) stop nodes
2) clear chain/token/validator state
3) re-render configs
4) regenerate genesis
5) restart cluster in deterministic order

Optional remote control:
- If hosts.env defines NODE_XX_STOP_CMD / START_CMD / RESET_CMD, those are used.
- Otherwise the script falls back to local scripts/devnet15/run-node.sh commands.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hosts-file)
      if [[ $# -lt 2 ]]; then
        echo "--hosts-file requires a path" >&2
        exit 1
      fi
      HOSTS_FILE="$2"
      shift 2
      ;;
    --rebuild-installers)
      REBUILD_INSTALLERS="true"
      shift
      ;;
    --skip-restart)
      SKIP_RESTART="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ ! -f "$INVENTORY_FILE" ]]; then
  echo "Missing inventory file: $INVENTORY_FILE" >&2
  exit 1
fi

if [[ ! -x "$RUN_NODE_SCRIPT" ]]; then
  echo "Missing run-node script: $RUN_NODE_SCRIPT" >&2
  exit 1
fi

if [[ -s "$HOSTS_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$HOSTS_FILE"
fi

machine_var_prefix() {
  local node_slot_id="$1"
  echo "$node_slot_id" | tr '[:lower:]-' '[:upper:]_'
}

machine_hook_cmd() {
  local node_slot_id="$1"
  local hook="$2"
  local prefix
  prefix="$(machine_var_prefix "$node_slot_id")"
  local var_name="${prefix}_${hook}"
  echo "${!var_name:-}"
}

run_hook_or_local() {
  local node_slot_id="$1"
  local hook="$2"
  local local_action="$3"
  local cmd
  cmd="$(machine_hook_cmd "$node_slot_id" "$hook")"

  if [[ -n "$cmd" ]]; then
    echo "[$node_slot_id] running remote hook: ${hook}"
    eval "$cmd"
    return
  fi

  echo "[$node_slot_id] running local action: $local_action"
  "$RUN_NODE_SCRIPT" "$local_action" "$node_slot_id" || true
}

inventory_node_slot_ids() {
  awk -F, 'NR > 1 {print $1}' "$INVENTORY_FILE"
}

stop_cluster() {
  echo "Stopping devnet nodes..."
  while IFS= read -r node_slot_id; do
    [[ -z "$node_slot_id" ]] && continue
    run_hook_or_local "$node_slot_id" "STOP_CMD" "stop"
  done < <(inventory_node_slot_ids)
}

reset_local_state() {
  echo "Clearing local chain data..."
  rm -f "$ROOT_DIR/data/chain.json"
  rm -f "$ROOT_DIR/data/token_state.json"
  rm -f "$ROOT_DIR/data/validator_registry.json"
  rm -f "$ROOT_DIR/data/synergy-devnet.pid"
  rm -f "$ROOT_DIR/data/.reset_flag"

  while IFS= read -r node_slot_id; do
    [[ -z "$node_slot_id" ]] && continue
    local_data_dir="$ROOT_DIR/data/devnet15/$node_slot_id"
    rm -rf "$local_data_dir/chain" "$local_data_dir/logs"
    mkdir -p "$local_data_dir/chain" "$local_data_dir/logs"
  done < <(inventory_node_slot_ids)
}

reset_remote_nodes() {
  while IFS= read -r node_slot_id; do
    [[ -z "$node_slot_id" ]] && continue
    reset_cmd="$(machine_hook_cmd "$node_slot_id" "RESET_CMD")"
    if [[ -n "$reset_cmd" ]]; then
      echo "[$node_slot_id] running remote hook: RESET_CMD"
      eval "$reset_cmd"
    fi
  done < <(inventory_node_slot_ids)
}

render_and_regenerate() {
  echo "Re-rendering configs..."
  "$RENDER_CONFIGS_SCRIPT" "$HOSTS_FILE"

  echo "Validating closed-devnet constraints..."
  "$VALIDATE_CLOSED_SCRIPT"

  echo "Regenerating deterministic genesis..."
  "$GENESIS_SCRIPT"
}

rebuild_installers_if_requested() {
  if [[ "$REBUILD_INSTALLERS" != "true" ]]; then
    return
  fi
  echo "Rebuilding installers..."
  "$ROOT_DIR/scripts/devnet15/build-node-installers.sh"
}

start_machine() {
  local node_slot_id="$1"
  run_hook_or_local "$node_slot_id" "START_CMD" "start"
}

restart_cluster() {
  if [[ "$SKIP_RESTART" == "true" ]]; then
    echo "Skipping restart (--skip-restart)."
    return
  fi

  echo "Starting devnet nodes in deterministic order..."
  for node_slot_id in "${START_ORDER[@]}"; do
    start_machine "$node_slot_id"
    sleep 1
  done
}

post_check() {
  local rpc_url="${DEVNET_RPC_URL:-http://127.0.0.1:48650}"
  echo "Post-reset check via $rpc_url ..."
  curl -sS -X POST "$rpc_url" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"synergy_blockNumber","params":[],"id":1}' || true
  echo
}

echo "=== Synergy Closed Devnet Reset ==="
echo "inventory: $INVENTORY_FILE"
echo "hosts:     $HOSTS_FILE"

stop_cluster
reset_local_state
reset_remote_nodes
render_and_regenerate
rebuild_installers_if_requested
restart_cluster
post_check

echo "Reset workflow complete."
