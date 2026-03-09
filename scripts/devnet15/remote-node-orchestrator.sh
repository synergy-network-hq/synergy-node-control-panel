#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INVENTORY_FILE="$ROOT_DIR/devnet/lean15/node-inventory.csv"
HOSTS_ENV_FILE="${SYNERGY_MONITOR_HOSTS_ENV:-$ROOT_DIR/devnet/lean15/hosts.env}"
INSTALLERS_DIR="$ROOT_DIR/devnet/lean15/installers"
REMOTE_ROOT_DEFAULT="${SYNERGY_REMOTE_ROOT:-/opt/synergy}"
REMOTE_EXPORTS_DIR="$ROOT_DIR/devnet/lean15/reports/remote-exports"

usage() {
  cat <<USAGE
Usage: $0 <machine-id> <operation>

Core Operations:
  install_node          Copy installer bundle to remote machine
  setup_node            Deploy installer bundle and run install_and_start.sh
  bootstrap_node        Deploy installer bundle and run install_and_start.sh
  reset_chain           Stop node, delete ALL chain state, redeploy config (does NOT restart)
  start                 nodectl start
  stop                  nodectl stop
  restart               nodectl restart
  status                nodectl status
  logs                  tail nodectl logs (last 120 lines)
  export_logs           Download logs archive from remote machine to local reports dir
  view_chain_data       Show chain data size and top files on remote machine
  export_chain_data     Download chain data archive from remote machine to local reports dir
  explorer_reset        Trigger explorer reindex from the remote machine using localhost/VPN-safe routing
  deploy_agent          Push updated devnet-agent binary to remote machine and (re)start as a service
                        Prerequisite: run scripts/build-sidecars.sh first to compile the binary.
                        This is the one-time bootstrap for machines that don't yet have the agent.

Node-Type-Specific Operations:
  rotate_vrf_key            [Validator]       Rotate VRF keypair and restart
  verify_archive_integrity  [Archive Val.]    Verify retained chain data integrity
  flush_relay_queue         [Relayer]         Force-submit pending relay messages
  force_feed_update         [Oracle]          Trigger immediate price feed refresh
  drain_compute_queue       [Compute]         Stop accepting tasks, finish active ones
  reload_models             [AI Inference]    Hot-reload AI model weights
  rotate_pqc_keys           [PQC Crypto]      Rotate post-quantum keys (Aegis Suite)
  run_pqc_benchmark         [PQC Crypto]      Benchmark PQC signing/verification
  trigger_da_sample         [Data Avail.]     Trigger data availability sampling round
  reindex_from_height       [Indexer]         Reindex from genesis

  info                  Print resolved host/ssh/paths for this machine

Required local files:
  - devnet/lean15/node-inventory.csv
  - devnet/lean15/hosts.env
  - devnet/lean15/installers/<machine-id>/
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" || $# -lt 2 ]]; then
  usage
  exit $(( $# < 2 ? 1 : 0 ))
fi

NODE_SLOT_ID="$1"
OPERATION="$2"
MACHINE_KEY_UPPER="$(printf '%s' "$NODE_SLOT_ID" | tr '[:lower:]-' '[:upper:]_')"

if [[ ! -f "$INVENTORY_FILE" ]]; then
  echo "Inventory file missing: $INVENTORY_FILE" >&2
  exit 1
fi

if [[ -f "$HOSTS_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$HOSTS_ENV_FILE"
else
  echo "Warning: hosts.env not found at $HOSTS_ENV_FILE. Falling back to inventory/default SSH settings." >&2
fi

inventory_host() {
  awk -F, -v machine="$NODE_SLOT_ID" 'NR>1 && tolower($1)==tolower(machine){print $12; exit}' "$INVENTORY_FILE"
}

inventory_vpn_ip() {
  awk -F, -v machine="$NODE_SLOT_ID" 'NR>1 && tolower($1)==tolower(machine){print $13; exit}' "$INVENTORY_FILE"
}

resolve_var() {
  local name="$1"
  printf '%s' "${!name:-}"
}

shell_escape() {
  printf '%q' "$1"
}

is_truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

HOST_VAR="${MACHINE_KEY_UPPER}_HOST"
VPN_VAR="${MACHINE_KEY_UPPER}_VPN_IP"
SSH_USER_VAR="${MACHINE_KEY_UPPER}_SSH_USER"
SSH_PORT_VAR="${MACHINE_KEY_UPPER}_SSH_PORT"
SSH_KEY_VAR="${MACHINE_KEY_UPPER}_SSH_KEY"
REMOTE_DIR_VAR="${MACHINE_KEY_UPPER}_REMOTE_DIR"

HOST="$(resolve_var "$HOST_VAR")"
if [[ -z "$HOST" ]]; then
  HOST="$(inventory_host)"
fi
VPN_IP="$(resolve_var "$VPN_VAR")"
if [[ -z "$VPN_IP" ]]; then
  VPN_IP="$(inventory_vpn_ip)"
fi

SSH_USER="$(resolve_var "$SSH_USER_VAR")"
if [[ -z "$SSH_USER" ]]; then
  SSH_USER="${SYNERGY_DEVNET_SSH_USER:-ops}"
fi

SSH_PORT="$(resolve_var "$SSH_PORT_VAR")"
if [[ -z "$SSH_PORT" ]]; then
  SSH_PORT="${SYNERGY_DEVNET_SSH_PORT:-22}"
fi

SSH_KEY="$(resolve_var "$SSH_KEY_VAR")"
if [[ -z "$SSH_KEY" ]]; then
  SSH_KEY="${SYNERGY_DEVNET_SSH_KEY:-}"
fi
REMOTE_NODE_DIR="$(resolve_var "$REMOTE_DIR_VAR")"
if [[ -z "$REMOTE_NODE_DIR" ]]; then
  REMOTE_NODE_DIR="$REMOTE_ROOT_DEFAULT/$NODE_SLOT_ID"
fi

if [[ -z "$HOST" ]]; then
  echo "Unable to resolve host for $NODE_SLOT_ID from hosts.env or inventory." >&2
  exit 1
fi

local_ipv4_list() {
  if command -v ip >/dev/null 2>&1; then
    ip -o -4 addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1 || true
  fi
  if command -v ifconfig >/dev/null 2>&1; then
    ifconfig 2>/dev/null | awk '/inet /{print $2}' || true
  fi
  if command -v hostname >/dev/null 2>&1; then
    hostname -I 2>/dev/null | tr ' ' '\n' || true
  fi
}

is_local_ip() {
  local candidate="$1"
  [[ -z "$candidate" ]] && return 1
  [[ "$candidate" == "127.0.0.1" || "$candidate" == "::1" ]] && return 0
  local_ipv4_list | grep -Fxq "$candidate"
}

is_local_host_token() {
  local candidate
  candidate="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"
  [[ -z "$candidate" ]] && return 1
  [[ "$candidate" == "localhost" || "$candidate" == "127.0.0.1" || "$candidate" == "::1" ]] && return 0
  if is_local_ip "$candidate"; then
    return 0
  fi
  local host_short host_full
  host_short="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)"
  host_full="$(hostname -f 2>/dev/null | tr '[:upper:]' '[:lower:]' || true)"
  [[ -n "$host_short" && "$candidate" == "$host_short" ]] && return 0
  [[ -n "$host_full" && "$candidate" == "$host_full" ]] && return 0
  return 1
}

IS_LOCAL_TARGET=0
if is_local_host_token "$HOST" || { [[ -n "$VPN_IP" ]] && is_local_host_token "$VPN_IP"; }; then
  IS_LOCAL_TARGET=1
fi

if [[ "$IS_LOCAL_TARGET" -eq 1 ]]; then
  LOCAL_INSTALLER_DIR="$INSTALLERS_DIR/$NODE_SLOT_ID"
  if [[ ! -d "$REMOTE_NODE_DIR" && -d "$LOCAL_INSTALLER_DIR" ]]; then
    REMOTE_NODE_DIR="$LOCAL_INSTALLER_DIR"
  fi
fi

SSH_ARGS=(
  -o BatchMode=yes
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=8
  -o ConnectionAttempts=1
  -o ServerAliveInterval=5
  -o ServerAliveCountMax=2
  -p "$SSH_PORT"
)
SCP_ARGS=(
  -o BatchMode=yes
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=8
  -o ConnectionAttempts=1
  -P "$SSH_PORT"
)

if [[ -n "$SSH_KEY" ]]; then
  SSH_ARGS+=( -i "$SSH_KEY" )
  SCP_ARGS+=( -i "$SSH_KEY" )
fi

REMOTE_TARGET="${SSH_USER}@${HOST}"
INSTALLER_DIR="$INSTALLERS_DIR/$NODE_SLOT_ID"

remote_run_script() {
  local script="$1"
  if [[ "$IS_LOCAL_TARGET" -eq 1 ]]; then
    bash -s <<<"$script"
  else
    ssh "${SSH_ARGS[@]}" "$REMOTE_TARGET" "bash -s" <<<"$script"
  fi
}

copy_to_remote() {
  local local_path="$1"
  local remote_path="$2"
  if [[ "$IS_LOCAL_TARGET" -eq 1 ]]; then
    mkdir -p "$(dirname "$remote_path")"
    cp "$local_path" "$remote_path"
  else
    scp "${SCP_ARGS[@]}" "$local_path" "${REMOTE_TARGET}:$remote_path"
  fi
}

copy_from_remote() {
  local remote_path="$1"
  local local_path="$2"
  if [[ "$IS_LOCAL_TARGET" -eq 1 ]]; then
    mkdir -p "$(dirname "$local_path")"
    cp "$remote_path" "$local_path"
  else
    scp "${SCP_ARGS[@]}" "${REMOTE_TARGET}:$remote_path" "$local_path"
  fi
}

deploy_installer_bundle() {
  if [[ ! -d "$INSTALLER_DIR" ]]; then
    echo "Installer directory missing: $INSTALLER_DIR" >&2
    exit 1
  fi

  local archive
  archive="$(mktemp "/tmp/${NODE_SLOT_ID}-installer.XXXXXX.tgz")"
  tar -C "$INSTALLER_DIR" -czf "$archive" .

  local remote_archive
  remote_archive="/tmp/${NODE_SLOT_ID}-installer.tgz"
  copy_to_remote "$archive" "$remote_archive"
  rm -f "$archive"

  remote_run_script "
set -euo pipefail
mkdir -p '$REMOTE_NODE_DIR'
tar -xzf '$remote_archive' -C '$REMOTE_NODE_DIR'
rm -f '$remote_archive'
chmod +x '$REMOTE_NODE_DIR/install_and_start.sh' '$REMOTE_NODE_DIR/nodectl.sh' || true
echo 'Installer deployed to $REMOTE_NODE_DIR'
"
}

run_nodectl() {
  local command="$1"
  remote_run_script "
set -euo pipefail
if [[ ! -x '$REMOTE_NODE_DIR/nodectl.sh' ]]; then
  echo 'nodectl.sh not found in $REMOTE_NODE_DIR. Run install_node or setup_node first.' >&2
  exit 1
fi
cd '$REMOTE_NODE_DIR'
./nodectl.sh $command
"
}

kill_machine_processes() {
  local reason="${1:-cleanup}"
  remote_run_script "
set -euo pipefail
config_path='$REMOTE_NODE_DIR/config/node.toml'
if [[ ! -f \"\$config_path\" ]]; then
  exit 0
fi

pids=\"\$(pgrep -f \"\$config_path\" || true)\"
if [[ -z \"\$pids\" ]]; then
  exit 0
fi

echo \"Killing stale $NODE_SLOT_ID processes (\$(printf '%s' \"\$pids\" | tr '\n' ' ')) for $reason...\"
for pid in \$pids; do
  kill \"\$pid\" 2>/dev/null || true
done
sleep 1
for pid in \$pids; do
  if kill -0 \"\$pid\" 2>/dev/null; then
    kill -9 \"\$pid\" 2>/dev/null || true
  fi
done
"
}

# ── Readiness & Connectivity Helpers ──────────────────────────────────────────

wait_for_bootnode_ready() {
  # Polls a bootnode's RPC endpoint until it returns a valid block height.
  # Usage: wait_for_bootnode_ready <rpc_url> [max_attempts]
  local rpc_url="$1"
  local max_attempts="${2:-60}"
  local attempt=0
  echo "Waiting for bootnode RPC at $rpc_url to become ready..."
  while [[ $attempt -lt $max_attempts ]]; do
    attempt=$((attempt + 1))
    local response
    response=$(curl -sS --max-time 3 -X POST "$rpc_url" \
      -H "Content-Type: application/json" \
      -d '{"jsonrpc":"2.0","method":"synergy_blockNumber","params":[],"id":1}' 2>/dev/null) || true
    if [[ -n "$response" ]] && echo "$response" | grep -q '"result"'; then
      echo "Bootnode RPC at $rpc_url is ready (attempt $attempt/$max_attempts)."
      return 0
    fi
    sleep 3
  done
  echo "WARNING: Bootnode RPC at $rpc_url did not become ready after $max_attempts attempts." >&2
  return 1
}

check_node_alive() {
  # Uses pgrep to check if a node process is running, independent of PID files.
  # Returns 0 if running, 1 if not.
  remote_run_script "
set -euo pipefail
config_path='$REMOTE_NODE_DIR/config/node.toml'
if pgrep -f \"\$config_path\" >/dev/null 2>&1; then
  echo 'PROCESS_ALIVE: true'
  exit 0
else
  echo 'PROCESS_ALIVE: false'
  exit 1
fi
" || return 1
}

# ── Chain Reset ──────────────────────────────────────────────────────────────

reset_chain() {
  # Stop first, but do not fail if the process is already down.
  run_nodectl "stop" || true
  kill_machine_processes "reset_chain"

  remote_run_script "
set -euo pipefail
cd '$REMOTE_NODE_DIR'

# Remove all chain state, logs, and runtime artifacts so the node
# reinitializes from genesis on next start.
rm -rf data/chain data/devnet15/'$NODE_SLOT_ID'/chain
rm -rf data/devnet15/'$NODE_SLOT_ID'/logs
rm -f  data/chain.json data/token_state.json data/validator_registry.json
rm -f  data/synergy-devnet.pid data/.reset_flag
rm -f  data/node.pid

# Flush filesystem to ensure deletions are persisted before verification.
sync

# Verify chain data was actually deleted — fail hard if not.
if [ -d data/chain ] && [ \"\$(ls -A data/chain 2>/dev/null)\" ]; then
  echo 'ERROR: data/chain directory still contains files after deletion for $NODE_SLOT_ID' >&2
  exit 1
fi
if [ -f data/chain.json ]; then
  echo 'ERROR: data/chain.json still exists after deletion for $NODE_SLOT_ID' >&2
  exit 1
fi
if [ -f data/token_state.json ]; then
  echo 'ERROR: data/token_state.json still exists after deletion for $NODE_SLOT_ID' >&2
  exit 1
fi
if [ -f data/validator_registry.json ]; then
  echo 'ERROR: data/validator_registry.json still exists after deletion for $NODE_SLOT_ID' >&2
  exit 1
fi

# Recreate the directory skeleton the node binary expects.
mkdir -p data/chain data/devnet15/'$NODE_SLOT_ID'/chain data/devnet15/'$NODE_SLOT_ID'/logs data/logs
echo 'Cleared all chain state for $NODE_SLOT_ID in $REMOTE_NODE_DIR — node is stopped and ready for manual start.'
"

  # Re-deploy the installer bundle so the node picks up the latest
  # configs and genesis parameters when it is started next.
  if [[ -d "$INSTALLER_DIR" ]]; then
    deploy_installer_bundle
  fi

  # Node is intentionally NOT restarted after reset. Use "Start All" from
  # the control panel dashboard when all nodes are confirmed reset.
  echo "[$NODE_SLOT_ID] Chain reset complete. Node stopped and ready."
}

explorer_reset() {
  local endpoint="${SYNERGY_EXPLORER_RESET_ENDPOINT:-}"
  if [[ -z "$endpoint" ]]; then
    echo "SYNERGY_EXPLORER_RESET_ENDPOINT is not configured." >&2
    exit 1
  fi

  local reason="${SYNERGY_EXPLORER_RESET_REASON:-chain_reset}"
  local scheme="https"
  local endpoint_without_scheme="$endpoint"
  if [[ "$endpoint" == https://* ]]; then
    endpoint_without_scheme="${endpoint#https://}"
  elif [[ "$endpoint" == http://* ]]; then
    scheme="http"
    endpoint_without_scheme="${endpoint#http://}"
  fi

  local host_port="${endpoint_without_scheme%%/*}"
  local host="$host_port"
  local port
  if [[ "$host_port" == *:* ]]; then
    host="${host_port%%:*}"
    port="${host_port##*:}"
  elif [[ "$scheme" == "http" ]]; then
    port="80"
  else
    port="443"
  fi

  local endpoint_q reason_q host_q port_q vpn_ip_q
  endpoint_q="$(shell_escape "$endpoint")"
  reason_q="$(shell_escape "$reason")"
  host_q="$(shell_escape "$host")"
  port_q="$(shell_escape "$port")"
  vpn_ip_q="$(shell_escape "${VPN_IP:-}")"

  remote_run_script "
set -euo pipefail
endpoint=$endpoint_q
reason=$reason_q
host=$host_q
port=$port_q
vpn_ip=$vpn_ip_q

if ! command -v curl >/dev/null 2>&1; then
  echo 'curl is required for explorer_reset.' >&2
  exit 1
fi

timestamp_utc=\$(date -u +%Y-%m-%dT%H:%M:%SZ)
body=\$(printf '{\"action\":\"reindex_from_genesis\",\"reason\":\"%s\",\"timestamp_utc\":\"%s\"}' \"\$reason\" \"\$timestamp_utc\")

attempt_reset() {
  local label=\"\$1\"
  local resolve_ip=\"\$2\"
  local response curl_exit status payload

  if [[ -n \"\$resolve_ip\" ]]; then
    response=\$(curl --silent --show-error --connect-timeout 5 --max-time 20 --write-out '\nHTTP_STATUS:%{http_code}' --resolve \"\$host:\$port:\$resolve_ip\" -X POST \"\$endpoint\" -H 'Content-Type: application/json' --data \"\$body\" 2>&1) || curl_exit=\$?
  else
    response=\$(curl --silent --show-error --connect-timeout 5 --max-time 20 --write-out '\nHTTP_STATUS:%{http_code}' -X POST \"\$endpoint\" -H 'Content-Type: application/json' --data \"\$body\" 2>&1) || curl_exit=\$?
  fi
  curl_exit=\${curl_exit:-0}
  status=\$(printf '%s\n' \"\$response\" | sed -n 's/^HTTP_STATUS://p' | tail -n1)
  payload=\$(printf '%s\n' \"\$response\" | sed '/^HTTP_STATUS:/d')

  if [[ \"\$curl_exit\" -eq 0 && \"\$status\" == 2* ]]; then
    printf '%s\n' \"\$payload\"
    echo \"Explorer reset accepted via \$label.\"
    return 0
  fi

  echo \"Explorer reset attempt via \$label failed.\" >&2
  if [[ -n \"\$payload\" ]]; then
    printf '%s\n' \"\$payload\" >&2
  fi
  return 1
}

attempt_reset 'localhost' '127.0.0.1' \
  || attempt_reset 'vpn' \"\$vpn_ip\" \
  || attempt_reset 'endpoint' ''
"
}

export_logs() {
  local ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  local remote_archive
  remote_archive="/tmp/${NODE_SLOT_ID}-logs-${ts}.tgz"

  remote_run_script "
set -euo pipefail
if [[ ! -d '$REMOTE_NODE_DIR/data/logs' ]]; then
  echo 'Remote logs directory not found: $REMOTE_NODE_DIR/data/logs' >&2
  exit 1
fi
tar -C '$REMOTE_NODE_DIR' -czf '$remote_archive' data/logs
echo '$remote_archive'
"

  local local_dir
  local_dir="$REMOTE_EXPORTS_DIR/$NODE_SLOT_ID"
  mkdir -p "$local_dir"
  local local_archive
  local_archive="$local_dir/${NODE_SLOT_ID}-logs-${ts}.tgz"

  copy_from_remote "$remote_archive" "$local_archive"
  remote_run_script "rm -f '$remote_archive'"

  echo "Exported logs to $local_archive"
}

view_chain_data() {
  remote_run_script "
set -euo pipefail
if [[ ! -d '$REMOTE_NODE_DIR/data/chain' ]]; then
  echo 'Remote chain directory not found: $REMOTE_NODE_DIR/data/chain' >&2
  exit 1
fi
du -sh '$REMOTE_NODE_DIR/data/chain'
ls -lah '$REMOTE_NODE_DIR/data/chain' | head -40
"
}

export_chain_data() {
  local ts
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  local remote_archive
  remote_archive="/tmp/${NODE_SLOT_ID}-chain-${ts}.tgz"

  remote_run_script "
set -euo pipefail
if [[ ! -d '$REMOTE_NODE_DIR/data/chain' ]]; then
  echo 'Remote chain directory not found: $REMOTE_NODE_DIR/data/chain' >&2
  exit 1
fi
tar -C '$REMOTE_NODE_DIR' -czf '$remote_archive' data/chain
echo '$remote_archive'
"

  local local_dir
  local_dir="$REMOTE_EXPORTS_DIR/$NODE_SLOT_ID"
  mkdir -p "$local_dir"
  local local_archive
  local_archive="$local_dir/${NODE_SLOT_ID}-chain-${ts}.tgz"

  copy_from_remote "$remote_archive" "$local_archive"
  remote_run_script "rm -f '$remote_archive'"

  echo "Exported chain data to $local_archive"
}

# ── Node-type-specific shell operations ──────────────────────────────────

# Class I — Validator: rotate VRF keypair
rotate_vrf_key() {
  remote_run_script "
set -euo pipefail
cd '$REMOTE_NODE_DIR'
source node.env
echo 'Rotating VRF key for $NODE_SLOT_ID...'
if [[ -f keys/vrf_private.key ]]; then
  cp keys/vrf_private.key keys/vrf_private.key.bak.\$(date +%s)
fi
./bin/synergy-devnet-\$(uname -s | tr A-Z a-z)-\$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/') keygen --type vrf --output keys/ 2>/dev/null || {
  echo 'VRF key generation tool not available in binary. Generate manually.' >&2
  exit 1
}
echo 'VRF key rotated. Restart the node to apply the new key.'
"
  run_nodectl "restart"
  run_nodectl "status" || true
}

# Class I — Archive Validator: verify integrity of retained chain data
verify_archive_integrity() {
  remote_run_script "
set -euo pipefail
cd '$REMOTE_NODE_DIR'
source node.env
echo 'Verifying archive integrity for $NODE_SLOT_ID...'
CHAIN_DIR=data/devnet15/$NODE_SLOT_ID/chain
if [[ ! -d \"\$CHAIN_DIR\" ]]; then
  echo 'Chain directory not found: \$CHAIN_DIR' >&2
  exit 1
fi
BLOCK_COUNT=\$(find \"\$CHAIN_DIR\" -name '*.db' -o -name '*.sst' -o -name '*.ldb' 2>/dev/null | wc -l)
TOTAL_SIZE=\$(du -sh \"\$CHAIN_DIR\" | cut -f1)
echo \"Archive data directory: \$CHAIN_DIR\"
echo \"Total size: \$TOTAL_SIZE\"
echo \"Database files: \$BLOCK_COUNT\"
# Check for corruption markers
if ls \"\$CHAIN_DIR\"/*.corrupt 2>/dev/null | head -1 >/dev/null 2>&1; then
  echo 'WARNING: Corruption markers found!'
  ls -la \"\$CHAIN_DIR\"/*.corrupt
else
  echo 'No corruption markers detected.'
fi
echo 'Archive integrity check complete.'
"
}

# Class II — Relayer: flush pending relay queue
flush_relay_queue() {
  remote_run_script "
set -euo pipefail
cd '$REMOTE_NODE_DIR'
source node.env
echo 'Flushing relay queue for $NODE_SLOT_ID...'
curl -sS -X POST \"http://\${VPN_IP:-127.0.0.1}:\$RPC_PORT\" \
  -H 'Content-Type: application/json' \
  -d '{\"jsonrpc\":\"2.0\",\"method\":\"synergy_flushRelayQueue\",\"params\":[],\"id\":1}'
echo ''
echo 'Relay queue flush requested.'
"
}

# Class II — Oracle: force an immediate price feed update
force_feed_update() {
  remote_run_script "
set -euo pipefail
cd '$REMOTE_NODE_DIR'
source node.env
echo 'Forcing oracle feed update for $NODE_SLOT_ID...'
curl -sS -X POST \"http://\${VPN_IP:-127.0.0.1}:\$RPC_PORT\" \
  -H 'Content-Type: application/json' \
  -d '{\"jsonrpc\":\"2.0\",\"method\":\"synergy_forceOracleFeedUpdate\",\"params\":[],\"id\":1}'
echo ''
echo 'Feed update triggered.'
"
}

# Class III — Compute: drain task queue gracefully
drain_compute_queue() {
  remote_run_script "
set -euo pipefail
cd '$REMOTE_NODE_DIR'
source node.env
echo 'Draining compute queue for $NODE_SLOT_ID...'
curl -sS -X POST \"http://\${VPN_IP:-127.0.0.1}:\$RPC_PORT\" \
  -H 'Content-Type: application/json' \
  -d '{\"jsonrpc\":\"2.0\",\"method\":\"synergy_drainComputeQueue\",\"params\":[],\"id\":1}'
echo ''
echo 'Compute queue drain initiated. Node will finish active tasks and reject new ones.'
"
}

# Class III — AI Inference: hot-reload models without restart
reload_models() {
  remote_run_script "
set -euo pipefail
cd '$REMOTE_NODE_DIR'
source node.env
echo 'Reloading AI models for $NODE_SLOT_ID...'
curl -sS -X POST \"http://\${VPN_IP:-127.0.0.1}:\$RPC_PORT\" \
  -H 'Content-Type: application/json' \
  -d '{\"jsonrpc\":\"2.0\",\"method\":\"synergy_reloadModels\",\"params\":[],\"id\":1}'
echo ''
echo 'Model reload requested.'
"
}

# Class III — PQC Crypto: rotate post-quantum keys
rotate_pqc_keys() {
  remote_run_script "
set -euo pipefail
cd '$REMOTE_NODE_DIR'
source node.env
echo 'Rotating PQC keys for $NODE_SLOT_ID (Aegis Suite: ML-KEM-512, Dilithium-3, SLH-DSA, FN-DSA)...'
if [[ -d keys/pqc ]]; then
  cp -r keys/pqc keys/pqc.bak.\$(date +%s)
fi
curl -sS -X POST \"http://\${VPN_IP:-127.0.0.1}:\$RPC_PORT\" \
  -H 'Content-Type: application/json' \
  -d '{\"jsonrpc\":\"2.0\",\"method\":\"synergy_rotatePqcKeys\",\"params\":[],\"id\":1}'
echo ''
echo 'PQC key rotation requested.'
"
}

# Class III — PQC Crypto: benchmark signing/verification performance
run_pqc_benchmark() {
  remote_run_script "
set -euo pipefail
cd '$REMOTE_NODE_DIR'
source node.env
echo 'Running PQC benchmark on $NODE_SLOT_ID...'
curl -sS -X POST \"http://\${VPN_IP:-127.0.0.1}:\$RPC_PORT\" \
  -H 'Content-Type: application/json' \
  -d '{\"jsonrpc\":\"2.0\",\"method\":\"synergy_runPqcBenchmark\",\"params\":[],\"id\":1}'
echo ''
echo 'PQC benchmark complete.'
"
}

# Class III — Data Availability: trigger a DA sampling round
trigger_da_sample() {
  remote_run_script "
set -euo pipefail
cd '$REMOTE_NODE_DIR'
source node.env
echo 'Triggering DA sampling round on $NODE_SLOT_ID...'
curl -sS -X POST \"http://\${VPN_IP:-127.0.0.1}:\$RPC_PORT\" \
  -H 'Content-Type: application/json' \
  -d '{\"jsonrpc\":\"2.0\",\"method\":\"synergy_triggerDaSample\",\"params\":[],\"id\":1}'
echo ''
echo 'DA sampling round triggered.'
"
}

# Class V — Indexer: reindex from a specific block height
reindex_from_height() {
  remote_run_script "
set -euo pipefail
cd '$REMOTE_NODE_DIR'
source node.env
echo 'Triggering reindex from genesis for $NODE_SLOT_ID...'
curl -sS -X POST \"http://\${VPN_IP:-127.0.0.1}:\$RPC_PORT\" \
  -H 'Content-Type: application/json' \
  -d '{\"jsonrpc\":\"2.0\",\"method\":\"synergy_reindexFromHeight\",\"params\":[0],\"id\":1}'
echo ''
echo 'Reindex initiated from block 0.'
"
}

deploy_agent() {
  if [[ "$IS_LOCAL_TARGET" -eq 1 ]]; then
    echo "Node $NODE_SLOT_ID is on the local machine — the devnet agent runs as a Tauri app sidecar here."
    echo "Rebuild and relaunch the control panel app to update the local agent."
    exit 0
  fi

  # Detect remote OS and architecture so we pick the right pre-built binary.
  echo "Detecting remote platform for $REMOTE_TARGET ..."
  local remote_os remote_arch
  remote_os="$(ssh "${SSH_ARGS[@]}" "$REMOTE_TARGET" 'uname -s' 2>/dev/null | tr '[:upper:]' '[:lower:]')" || {
    echo "Failed to connect to $REMOTE_TARGET via SSH. Check connectivity and SSH key." >&2
    exit 1
  }
  remote_arch="$(ssh "${SSH_ARGS[@]}" "$REMOTE_TARGET" 'uname -m' 2>/dev/null)"

  local platform_suffix
  case "$remote_os" in
    linux)
      case "$remote_arch" in
        x86_64|amd64)    platform_suffix="linux-amd64" ;;
        aarch64|arm64)   platform_suffix="linux-arm64" ;;
        *) echo "Unsupported remote arch: $remote_arch" >&2; exit 1 ;;
      esac ;;
    darwin)
      case "$remote_arch" in
        x86_64)          platform_suffix="darwin-amd64" ;;
        arm64|aarch64)   platform_suffix="darwin-arm64" ;;
        *) echo "Unsupported remote arch: $remote_arch" >&2; exit 1 ;;
      esac ;;
    *)
      echo "Unsupported remote OS: $remote_os" >&2
      exit 1 ;;
  esac
  echo "Remote platform: $remote_os/$remote_arch → binary suffix: $platform_suffix"

  # Locate the compiled agent binary.
  local binary_ext=""
  [[ "$remote_os" == "windows"* ]] && binary_ext=".exe"
  local binary_src="$ROOT_DIR/binaries/synergy-devnet-agent-${platform_suffix}${binary_ext}"
  if [[ ! -f "$binary_src" ]]; then
    echo "Agent binary not found: $binary_src" >&2
    echo "Run  scripts/build-sidecars.sh  first to compile the binary for $platform_suffix." >&2
    exit 1
  fi

  # Paths on the remote machine.
  local agent_dir="/opt/synergy/devnet-agent"
  local agent_bin="$agent_dir/synergy-devnet-agent${binary_ext}"
  local workspace_dir="$agent_dir/workspace"

  echo "Creating remote directories ..."
  ssh "${SSH_ARGS[@]}" "$REMOTE_TARGET" "mkdir -p '$agent_dir' '$workspace_dir/devnet/lean15'"

  # Push workspace metadata so the agent can resolve node installs.
  echo "Pushing inventory and hosts config ..."
  scp "${SCP_ARGS[@]}" \
    "$ROOT_DIR/devnet/lean15/node-inventory.csv" \
    "${REMOTE_TARGET}:${workspace_dir}/devnet/lean15/node-inventory.csv"
  scp "${SCP_ARGS[@]}" \
    "$ROOT_DIR/devnet/lean15/hosts.env" \
    "${REMOTE_TARGET}:${workspace_dir}/devnet/lean15/hosts.env"

  # Push the agent binary.
  echo "Pushing agent binary ($binary_src) ..."
  scp "${SCP_ARGS[@]}" "$binary_src" "${REMOTE_TARGET}:${agent_bin}"
  ssh "${SSH_ARGS[@]}" "$REMOTE_TARGET" "chmod +x '$agent_bin'"

  # Install as a systemd service (Linux) or run in background (macOS/other).
  remote_run_script "
set -euo pipefail

AGENT_BIN='$agent_bin'
WORKSPACE='$workspace_dir'

if command -v systemctl >/dev/null 2>&1 && [[ -d /etc/systemd/system ]]; then
  # Write the unit file (requires root; sudo is attempted if not root).
  SERVICE_FILE=/etc/systemd/system/synergy-devnet-agent.service
  UNIT_CONTENT=\"[Unit]
Description=Synergy Devnet Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=\${AGENT_BIN} --workspace \${WORKSPACE}
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=synergy-devnet-agent

[Install]
WantedBy=multi-user.target\"

  if [[ \$(id -u) -eq 0 ]]; then
    printf '%s\n' \"\$UNIT_CONTENT\" > \"\$SERVICE_FILE\"
    systemctl daemon-reload
    systemctl enable synergy-devnet-agent
    systemctl restart synergy-devnet-agent
    sleep 2
    systemctl status synergy-devnet-agent --no-pager || true
  else
    echo \"\$UNIT_CONTENT\" | sudo tee \"\$SERVICE_FILE\" >/dev/null
    sudo systemctl daemon-reload
    sudo systemctl enable synergy-devnet-agent
    sudo systemctl restart synergy-devnet-agent
    sleep 2
    sudo systemctl status synergy-devnet-agent --no-pager || true
  fi
  echo 'Agent installed as systemd service and started.'

else
  # Non-systemd fallback: kill old agent, start fresh in background.
  pkill -f 'synergy-devnet-agent' 2>/dev/null || true
  sleep 1
  LOG_FILE='/var/log/synergy-devnet-agent.log'
  touch \"\$LOG_FILE\" 2>/dev/null || LOG_FILE=\"\$HOME/synergy-devnet-agent.log\"
  nohup \"\$AGENT_BIN\" --workspace \"\$WORKSPACE\" > \"\$LOG_FILE\" 2>&1 &
  echo \"Agent started in background (PID \$!). Logs: \$LOG_FILE\"
fi
"

  echo ""
  echo "Agent deployed successfully on $REMOTE_TARGET."
  echo "It is listening on port 47990 and will restart automatically on failure."
}

show_info() {
  cat <<INFO
Machine:            $NODE_SLOT_ID
Host:               $HOST
VPN IP:             ${VPN_IP:-unknown}
Execution mode:     $([[ "$IS_LOCAL_TARGET" -eq 1 ]] && echo "local" || echo "ssh")
SSH user:           $SSH_USER
SSH port:           $SSH_PORT
SSH key:            ${SSH_KEY:-default-agent}
Remote node dir:    $REMOTE_NODE_DIR
Installer source:   $INSTALLER_DIR
INFO
}

case "$OPERATION" in
  # ── Core lifecycle ─────────────────────────────────────────────────────
  install_node)       deploy_installer_bundle ;;
  setup_node)         deploy_installer_bundle
                      remote_run_script "set -euo pipefail; cd '$REMOTE_NODE_DIR'; ./install_and_start.sh" ;;
  bootstrap_node)     deploy_installer_bundle
                      remote_run_script "set -euo pipefail; cd '$REMOTE_NODE_DIR'; ./install_and_start.sh" ;;
  reset_chain)        reset_chain ;;
  explorer_reset)     explorer_reset ;;
  deploy_agent)       deploy_agent ;;
  start)              run_nodectl "start" ;;
  stop)               run_nodectl "stop" || true; kill_machine_processes "stop" ;;
  restart)            run_nodectl "stop" || true; kill_machine_processes "restart"; run_nodectl "start" ;;
  status)             run_nodectl "status" ;;
  sync_node)          run_nodectl "sync" ;;
  logs)               run_nodectl "logs" ;;
  export_logs)        export_logs ;;
  view_chain_data)    view_chain_data ;;
  export_chain_data)  export_chain_data ;;

  # ── Class I — Consensus ────────────────────────────────────────────────
  rotate_vrf_key)             rotate_vrf_key ;;
  verify_archive_integrity)   verify_archive_integrity ;;

  # ── Class II — Interoperability ────────────────────────────────────────
  flush_relay_queue)    flush_relay_queue ;;
  force_feed_update)    force_feed_update ;;

  # ── Class III — Intelligence & Computation ─────────────────────────────
  drain_compute_queue)  drain_compute_queue ;;
  reload_models)        reload_models ;;
  rotate_pqc_keys)      rotate_pqc_keys ;;
  run_pqc_benchmark)    run_pqc_benchmark ;;
  trigger_da_sample)    trigger_da_sample ;;

  # ── Class V — Service & Support ────────────────────────────────────────
  reindex_from_height)  reindex_from_height ;;

  info)                 show_info ;;
  *)
    echo "Unsupported operation: $OPERATION" >&2
    usage
    exit 1
    ;;
esac
