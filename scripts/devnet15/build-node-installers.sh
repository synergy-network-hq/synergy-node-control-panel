#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INVENTORY_FILE="$ROOT_DIR/devnet/lean15/node-inventory.csv"
CONFIG_DIR="$ROOT_DIR/devnet/lean15/configs"
GENESIS_FILE="$ROOT_DIR/devnet/lean15/configs/genesis/genesis.json"
KEYS_DIR="$ROOT_DIR/devnet/lean15/keys"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/devnet/lean15/installers}"
DEVNET_CHAIN_ID="${DEVNET_CHAIN_ID:-338638}"
DEVNET_NETWORK_ID="${DEVNET_NETWORK_ID:-338638}"

FRESH_HOST_BINARY="$ROOT_DIR/target/release/synergy-devnet"
FRESH_DARWIN_BINARY="$ROOT_DIR/target/aarch64-apple-darwin/release/synergy-devnet"
FRESH_LINUX_BINARY="$ROOT_DIR/target/x86_64-unknown-linux-gnu/release/synergy-devnet"
FRESH_WINDOWS_BINARY_MSVC="$ROOT_DIR/target/x86_64-pc-windows-msvc/release/synergy-devnet.exe"
FRESH_WINDOWS_BINARY_GNU="$ROOT_DIR/target/x86_64-pc-windows-gnu/release/synergy-devnet.exe"

FALLBACK_DARWIN_BINARY="$ROOT_DIR/binaries/synergy-devnet-darwin-arm64"
FALLBACK_LINUX_BINARY="$ROOT_DIR/binaries/synergy-devnet-linux-amd64"
FALLBACK_WINDOWS_BINARY="$ROOT_DIR/binaries/synergy-devnet-windows-amd64.exe"

DARWIN_BINARY=""
LINUX_BINARY=""
WINDOWS_BINARY=""
DARWIN_BINARY_SOURCE=""
LINUX_BINARY_SOURCE=""
WINDOWS_BINARY_SOURCE=""

sha256_file() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    echo "sha256-unavailable"
  fi
}

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

collect_allowlisted_validators_csv() {
  local addresses=()
  while IFS=, read -r node_slot_id node_alias role_group role node_type address_class p2p_port rpc_port ws_port grpc_port discovery_port host vpn_ip physical_machine_id auto_register enable_pruning vrf_enabled operator device operating_system public_ip local_ip || [[ -n "${node_slot_id:-}" ]]; do
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
    local address_file="$KEYS_DIR/${node_slot_id}/address.txt"
    if [[ -f "$address_file" ]]; then
      local address
      address="$(cat "$address_file")"
      if [[ -n "$address" ]]; then
        addresses+=("$address")
      fi
    fi
  done < "$INVENTORY_FILE"

  if [[ "${#addresses[@]}" -eq 0 ]]; then
    echo ""
    return
  fi

  local joined
  joined="$(IFS=,; echo "${addresses[*]}")"
  echo "$joined"
}

print_binary_requirements() {
  cat <<REQ
Required binary locations:
  macOS arm64:
    - preferred: $FRESH_DARWIN_BINARY
    - fallback:  $FALLBACK_DARWIN_BINARY
  Linux x86_64:
    - preferred: $FRESH_LINUX_BINARY
    - fallback:  $FALLBACK_LINUX_BINARY
  Windows x86_64:
    - preferred (MSVC): $FRESH_WINDOWS_BINARY_MSVC
    - preferred (GNU):  $FRESH_WINDOWS_BINARY_GNU
    - fallback:         $FALLBACK_WINDOWS_BINARY
REQ
}

resolve_binaries() {
  local host_os host_arch
  host_os="$(uname -s)"
  host_arch="$(uname -m)"

  if [[ "$host_os" == "Darwin" && "$host_arch" == "arm64" && -f "$FRESH_HOST_BINARY" ]]; then
    DARWIN_BINARY="$FRESH_HOST_BINARY"
    DARWIN_BINARY_SOURCE="fresh-local-build(target/release/synergy-devnet)"
  elif [[ -f "$FRESH_DARWIN_BINARY" ]]; then
    DARWIN_BINARY="$FRESH_DARWIN_BINARY"
    DARWIN_BINARY_SOURCE="fresh-target-build(target/aarch64-apple-darwin/release/synergy-devnet)"
  elif [[ -f "$FALLBACK_DARWIN_BINARY" ]]; then
    DARWIN_BINARY="$FALLBACK_DARWIN_BINARY"
    DARWIN_BINARY_SOURCE="fallback-prebuilt(binaries/synergy-devnet-darwin-arm64)"
  fi

  if [[ -f "$FRESH_LINUX_BINARY" ]]; then
    LINUX_BINARY="$FRESH_LINUX_BINARY"
    LINUX_BINARY_SOURCE="fresh-cross-build(target/x86_64-unknown-linux-gnu/release/synergy-devnet)"
  elif [[ -f "$FALLBACK_LINUX_BINARY" ]]; then
    LINUX_BINARY="$FALLBACK_LINUX_BINARY"
    LINUX_BINARY_SOURCE="fallback-prebuilt(binaries/synergy-devnet-linux-amd64)"
  fi

  if [[ -f "$FRESH_WINDOWS_BINARY_MSVC" ]]; then
    WINDOWS_BINARY="$FRESH_WINDOWS_BINARY_MSVC"
    WINDOWS_BINARY_SOURCE="fresh-cross-build(target/x86_64-pc-windows-msvc/release/synergy-devnet.exe)"
  elif [[ -f "$FRESH_WINDOWS_BINARY_GNU" ]]; then
    WINDOWS_BINARY="$FRESH_WINDOWS_BINARY_GNU"
    WINDOWS_BINARY_SOURCE="fresh-cross-build(target/x86_64-pc-windows-gnu/release/synergy-devnet.exe)"
  elif [[ -f "$FALLBACK_WINDOWS_BINARY" ]]; then
    WINDOWS_BINARY="$FALLBACK_WINDOWS_BINARY"
    WINDOWS_BINARY_SOURCE="fallback-prebuilt(binaries/synergy-devnet-windows-amd64.exe)"
  fi
}

if [[ ! -f "$INVENTORY_FILE" ]]; then
  echo "Missing inventory file: $INVENTORY_FILE" >&2
  exit 1
fi

if [[ ! -f "$GENESIS_FILE" ]]; then
  echo "Missing genesis file: $GENESIS_FILE" >&2
  echo "Run scripts/devnet15/generate-devnet-genesis.sh first." >&2
  exit 1
fi

resolve_binaries

if [[ -z "$DARWIN_BINARY" || -z "$LINUX_BINARY" || -z "$WINDOWS_BINARY" ]]; then
  echo "Required binaries are unavailable." >&2
  echo "Darwin source:  ${DARWIN_BINARY_SOURCE:-missing}" >&2
  echo "Linux source:   ${LINUX_BINARY_SOURCE:-missing}" >&2
  echo "Windows source: ${WINDOWS_BINARY_SOURCE:-missing}" >&2
  echo "" >&2
  print_binary_requirements >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

write_install_script() {
  local node_dir="$1"
  cat > "$node_dir/install_and_start.sh" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$BASE_DIR/node.env"

BIN_LINUX="$BASE_DIR/bin/synergy-devnet-linux-amd64"
BIN_DARWIN="$BASE_DIR/bin/synergy-devnet-darwin-arm64"
BIN_SELECTED=""
DATA_DIR="$BASE_DIR/data"
CHAIN_DIR="$DATA_DIR/chain"
LOG_DIR="$DATA_DIR/logs"
PID_FILE="$DATA_DIR/node.pid"
OUT_FILE="$LOG_DIR/node.out"
ERR_FILE="$LOG_DIR/node.err"
NETWORK_TRANSPORT="${NETWORK_TRANSPORT:-wireguard}"
WIREGUARD_INTERFACE="${WIREGUARD_INTERFACE:-wg0}"
VPN_CIDR="${VPN_CIDR:-10.50.0.0/24}"
PRIVILEGED_HELPER=""
SUDO_KEEPALIVE_PID=""

select_binary() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  if [[ "$os" == "Linux" && "$arch" == "x86_64" ]]; then
    BIN_SELECTED="$BIN_LINUX"
  elif [[ "$os" == "Darwin" && "$arch" == "arm64" ]]; then
    BIN_SELECTED="$BIN_DARWIN"
  else
    echo "Unsupported platform for this script: ${os}/${arch}" >&2
    echo "For Windows, use install_and_start.ps1" >&2
    exit 1
  fi

  chmod +x "$BIN_SELECTED"
}

apply_staged_binaries() {
  local candidate staged
  for candidate in "$BIN_LINUX" "$BIN_DARWIN"; do
    staged="${candidate}.pending"
    if [[ -f "$staged" ]]; then
      mv -f "$staged" "$candidate"
      chmod +x "$candidate" || true
      echo "Applied staged binary update: $candidate"
    fi
  done
}

cleanup_privileged_helper() {
  if [[ -n "$SUDO_KEEPALIVE_PID" ]]; then
    kill "$SUDO_KEEPALIVE_PID" >/dev/null 2>&1 || true
  fi
}

prepare_privileged_helper() {
  if [[ "$(id -u)" -eq 0 ]]; then
    PRIVILEGED_HELPER="root"
    return 0
  fi

  if command -v sudo >/dev/null 2>&1; then
    if sudo -n true >/dev/null 2>&1; then
      PRIVILEGED_HELPER="sudo"
      return 0
    fi

    if [[ -t 0 || -t 1 ]]; then
      echo "Requesting sudo authentication once for firewall configuration..."
      if sudo -v; then
        PRIVILEGED_HELPER="sudo"
        (
          while true; do
            sudo -n true >/dev/null 2>&1 || exit
            sleep 45
          done
        ) &
        SUDO_KEEPALIVE_PID="$!"
        return 0
      fi
    fi
  fi

  PRIVILEGED_HELPER="none"
  echo "Warning: No cached sudo privilege available. Firewall rules will be skipped. Run 'sudo -v' once before setup to enable firewall automation." >&2
  return 0
}

run_privileged() {
  case "$PRIVILEGED_HELPER" in
    root)
      "$@"
      ;;
    sudo)
      sudo -n "$@"
      ;;
    *)
      return 1
      ;;
  esac
}

open_ports_ufw() {
  if [[ "$NETWORK_TRANSPORT" == "wireguard" ]]; then
    for port in "$P2P_PORT" "$RPC_PORT" "$WS_PORT" "$GRPC_PORT" "$DISCOVERY_PORT"; do
      run_privileged ufw allow in on "$WIREGUARD_INTERFACE" from "$VPN_CIDR" to any port "$port" proto tcp >/dev/null || true
    done
    return
  fi

  for port in "$P2P_PORT" "$RPC_PORT" "$WS_PORT" "$GRPC_PORT" "$DISCOVERY_PORT"; do
    run_privileged ufw allow "${port}/tcp" >/dev/null || true
  done
}

open_ports_firewalld() {
  if [[ "$NETWORK_TRANSPORT" == "wireguard" ]]; then
    for port in "$P2P_PORT" "$RPC_PORT" "$WS_PORT" "$GRPC_PORT" "$DISCOVERY_PORT"; do
      run_privileged firewall-cmd --permanent --add-rich-rule="rule family='ipv4' source address='${VPN_CIDR}' port protocol='tcp' port='${port}' accept" >/dev/null || true
    done
    run_privileged firewall-cmd --reload >/dev/null || true
    return
  fi

  for port in "$P2P_PORT" "$RPC_PORT" "$WS_PORT" "$GRPC_PORT" "$DISCOVERY_PORT"; do
    run_privileged firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null || true
  done
  run_privileged firewall-cmd --reload >/dev/null || true
}

open_ports_iptables() {
  if [[ "$NETWORK_TRANSPORT" == "wireguard" ]]; then
    for port in "$P2P_PORT" "$RPC_PORT" "$WS_PORT" "$GRPC_PORT" "$DISCOVERY_PORT"; do
      if ! run_privileged iptables -C INPUT -i "$WIREGUARD_INTERFACE" -s "$VPN_CIDR" -p tcp --dport "$port" -j ACCEPT >/dev/null 2>&1; then
        run_privileged iptables -I INPUT -i "$WIREGUARD_INTERFACE" -s "$VPN_CIDR" -p tcp --dport "$port" -j ACCEPT >/dev/null || true
      fi
    done
    return
  fi

  for port in "$P2P_PORT" "$RPC_PORT" "$WS_PORT" "$GRPC_PORT" "$DISCOVERY_PORT"; do
    if ! run_privileged iptables -C INPUT -p tcp --dport "$port" -j ACCEPT >/dev/null 2>&1; then
      run_privileged iptables -I INPUT -p tcp --dport "$port" -j ACCEPT >/dev/null || true
    fi
  done
}

open_ports() {
  if [[ "$(uname -s)" != "Linux" ]]; then
    echo "Non-Linux host detected; skipping firewall automation."
    return
  fi

  local firewall_backend=""
  if command -v ufw >/dev/null 2>&1; then
    firewall_backend="ufw"
  elif command -v firewall-cmd >/dev/null 2>&1; then
    firewall_backend="firewalld"
  elif command -v iptables >/dev/null 2>&1; then
    firewall_backend="iptables"
  else
    echo "No supported firewall tool detected. Open these TCP ports manually:"
    echo "$P2P_PORT, $RPC_PORT, $WS_PORT, $GRPC_PORT, $DISCOVERY_PORT"
    return
  fi

  trap cleanup_privileged_helper EXIT
  prepare_privileged_helper

  if [[ "$NETWORK_TRANSPORT" == "wireguard" ]]; then
    echo "WireGuard mode: allowing node ports only from $VPN_CIDR on interface $WIREGUARD_INTERFACE..."
  fi

  if [[ "$firewall_backend" == "ufw" ]]; then
    echo "Opening ports via ufw..."
    open_ports_ufw
  elif [[ "$firewall_backend" == "firewalld" ]]; then
    echo "Opening ports via firewalld..."
    open_ports_firewalld
  elif [[ "$firewall_backend" == "iptables" ]]; then
    echo "Opening ports via iptables..."
    open_ports_iptables
  fi
}

is_running() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

is_bootnode_slot() {
  [[ "$NODE_SLOT_ID" == "node-01" || "$NODE_SLOT_ID" == "node-02" ]]
}

sync_required_before_start() {
  if is_bootnode_slot; then
    return 1
  fi
  [[ "${ROLE_GROUP:-}" == "consensus" && "${NODE_TYPE:-}" == "validator" ]]
}

run_prestart_sync() {
  if is_bootnode_slot; then
    return 0
  fi

  local validator_address
  validator_address="${SYNERGY_VALIDATOR_ADDRESS:-${NODE_ADDRESS:-}}"
  local auto_register_validator
  auto_register_validator="${SYNERGY_AUTO_REGISTER_VALIDATOR:-${AUTO_REGISTER_VALIDATOR:-false}}"
  local strict_allowlist
  strict_allowlist="${SYNERGY_STRICT_VALIDATOR_ALLOWLIST:-${STRICT_VALIDATOR_ALLOWLIST:-true}}"
  local allowed_validators
  allowed_validators="${SYNERGY_ALLOWED_VALIDATOR_ADDRESSES:-${ALLOWED_VALIDATOR_ADDRESSES:-}}"
  local rpc_bind_address
  rpc_bind_address="${SYNERGY_RPC_BIND_ADDRESS:-${RPC_BIND_ADDRESS:-}}"
  local configured_chain_id
  configured_chain_id="${SYNERGY_CHAIN_ID:-${CHAIN_ID:-338638}}"
  local configured_network_id
  configured_network_id="${SYNERGY_NETWORK_ID:-${NETWORK_ID:-$configured_chain_id}}"
  local config_path
  config_path="$BASE_DIR/config/node.toml"

  # Use a wall-clock deadline instead of a fixed attempt count so that nodes
  # far behind the chain tip (e.g. late joiners) are given enough time to
  # fully catch up.  Override with PRESTART_SYNC_TIMEOUT_SECS in the calling
  # environment (default: 600 s = 10 min; use e.g. 3600 for a late joiner).
  local timeout_secs="${PRESTART_SYNC_TIMEOUT_SECS:-600}"
  local deadline=$(( $(date +%s) + timeout_secs ))
  local attempt=0

  while [[ $(date +%s) -lt $deadline ]]; do
    attempt=$(( attempt + 1 ))
    local remaining=$(( deadline - $(date +%s) ))
    echo "Pre-start sync attempt ${attempt} for $NODE_SLOT_ID (${remaining}s remaining of ${timeout_secs}s)..."
    # Cap each individual sync attempt so a hanging binary doesn't stall the
    # installer indefinitely.  Default: 120 s per attempt; override via
    # PRESTART_SYNC_ATTEMPT_TIMEOUT.  The outer deadline loop still applies.
    if timeout "${PRESTART_SYNC_ATTEMPT_TIMEOUT:-120}" env \
      SYNERGY_VALIDATOR_ADDRESS="$validator_address" \
      NODE_ADDRESS="$validator_address" \
      SYNERGY_AUTO_REGISTER_VALIDATOR="$auto_register_validator" \
      SYNERGY_STRICT_VALIDATOR_ALLOWLIST="$strict_allowlist" \
      SYNERGY_ALLOWED_VALIDATOR_ADDRESSES="$allowed_validators" \
      SYNERGY_RPC_BIND_ADDRESS="$rpc_bind_address" \
      SYNERGY_NETWORK_ID="$configured_network_id" \
      SYNERGY_CHAIN_ID="$configured_chain_id" \
      SYNERGY_CONFIG_PATH="$config_path" \
      "$BIN_SELECTED" sync --config "$config_path" >> "$OUT_FILE" 2>> "$ERR_FILE"; then
      return 0
    fi
    # Brief pause before retrying (skip if the deadline is almost up).
    if [[ $(date +%s) -lt $(( deadline - 5 )) ]]; then
      sleep 5
    fi
  done

  return 1
}

start_node() {
  if is_running; then
    echo "$NODE_SLOT_ID already running (PID $(cat "$PID_FILE"))"
    return
  fi

  mkdir -p "$CHAIN_DIR" "$LOG_DIR"
  touch "$OUT_FILE" "$ERR_FILE"

  local validator_address
  validator_address="${SYNERGY_VALIDATOR_ADDRESS:-${NODE_ADDRESS:-}}"
  local auto_register_validator
  auto_register_validator="${SYNERGY_AUTO_REGISTER_VALIDATOR:-${AUTO_REGISTER_VALIDATOR:-false}}"
  local strict_allowlist
  strict_allowlist="${SYNERGY_STRICT_VALIDATOR_ALLOWLIST:-${STRICT_VALIDATOR_ALLOWLIST:-true}}"
  local allowed_validators
  allowed_validators="${SYNERGY_ALLOWED_VALIDATOR_ADDRESSES:-${ALLOWED_VALIDATOR_ADDRESSES:-}}"
  local rpc_bind_address
  rpc_bind_address="${SYNERGY_RPC_BIND_ADDRESS:-${RPC_BIND_ADDRESS:-}}"
  local configured_chain_id
  configured_chain_id="${SYNERGY_CHAIN_ID:-${CHAIN_ID:-338638}}"
  local configured_network_id
  configured_network_id="${SYNERGY_NETWORK_ID:-${NETWORK_ID:-$configured_chain_id}}"
  local config_path
  config_path="$BASE_DIR/config/node.toml"
  if [[ -z "$validator_address" ]]; then
    echo "Warning: NODE_ADDRESS is empty; validator identity will fallback to node_name."
  fi

  # Keep relative storage/log paths in node.toml anchored to the installer directory.
  cd "$BASE_DIR"

  if ! run_prestart_sync; then
    if sync_required_before_start; then
      echo "Pre-start sync failed for $NODE_SLOT_ID; refusing to start validator while unsynced." >&2
      return 1
    fi
    echo "Warning: pre-start sync did not complete for $NODE_SLOT_ID; continuing with node start." >&2
  fi

  nohup env \
    SYNERGY_VALIDATOR_ADDRESS="$validator_address" \
    NODE_ADDRESS="$validator_address" \
    SYNERGY_AUTO_REGISTER_VALIDATOR="$auto_register_validator" \
    SYNERGY_STRICT_VALIDATOR_ALLOWLIST="$strict_allowlist" \
    SYNERGY_ALLOWED_VALIDATOR_ADDRESSES="$allowed_validators" \
    SYNERGY_RPC_BIND_ADDRESS="$rpc_bind_address" \
    SYNERGY_NETWORK_ID="$configured_network_id" \
    SYNERGY_CHAIN_ID="$configured_chain_id" \
    SYNERGY_CONFIG_PATH="$config_path" \
    "$BIN_SELECTED" start --config "$config_path" > "$OUT_FILE" 2>&1 &
  echo $! > "$PID_FILE"

  echo "Started $NODE_SLOT_ID ($NODE_TYPE) PID $(cat "$PID_FILE")"
  echo "Logs: $OUT_FILE"
}

select_binary
apply_staged_binaries
open_ports

# SYNC_ONLY=true: run pre-start sync and exit without launching the node process.
# Used by "nodectl.sh sync" to let an operator explicitly catch up a late-joining
# node before starting it.
if [[ "${SYNC_ONLY:-false}" == "true" ]]; then
  if run_prestart_sync; then
    echo "[$NODE_SLOT_ID] Sync complete. Node is ready for manual start."
    exit 0
  else
    echo "[$NODE_SLOT_ID] Sync did not complete within the timeout." >&2
    exit 1
  fi
fi

start_node
SCRIPT
  chmod +x "$node_dir/install_and_start.sh"
}

write_nodectl_script() {
  local node_dir="$1"
  cat > "$node_dir/nodectl.sh" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$BASE_DIR/node.env"

BIN_LINUX="$BASE_DIR/bin/synergy-devnet-linux-amd64"
BIN_DARWIN="$BASE_DIR/bin/synergy-devnet-darwin-arm64"
DATA_DIR="$BASE_DIR/data"
PID_FILE="$DATA_DIR/node.pid"
OUT_FILE="$DATA_DIR/logs/node.out"
CHAIN_DIR="$DATA_DIR/chain"
LOG_DIR="$DATA_DIR/logs"

ensure_export_dir() {
  local export_dir="$BASE_DIR/exports"
  mkdir -p "$export_dir"
  echo "$export_dir"
}

select_binary() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  if [[ "$os" == "Linux" && "$arch" == "x86_64" ]]; then
    echo "$BIN_LINUX"
  elif [[ "$os" == "Darwin" && "$arch" == "arm64" ]]; then
    echo "$BIN_DARWIN"
  else
    echo ""
  fi
}

is_running() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

start_node() {
  "$BASE_DIR/install_and_start.sh"
}

setup_node() {
  "$BASE_DIR/install_and_start.sh"
}

install_node() {
  "$BASE_DIR/install_and_start.sh"
}

bootstrap_node() {
  "$BASE_DIR/install_and_start.sh"
}

# Sync only — download all missing blocks from peers without starting the node.
# Intended for late-joining nodes or nodes that have been offline for a long time.
# The sync runs until complete or until PRESTART_SYNC_TIMEOUT_SECS is exceeded
# (default: 7200 s = 2 hours for deep catch-up).
sync_node() {
  SYNC_ONLY=true \
  PRESTART_SYNC_TIMEOUT_SECS="${PRESTART_SYNC_TIMEOUT_SECS:-7200}" \
  "$BASE_DIR/install_and_start.sh"
}

stop_node() {
  if ! is_running; then
    echo "$NODE_SLOT_ID is not running"
    rm -f "$PID_FILE"
    return
  fi

  local pid
  pid="$(cat "$PID_FILE")"
  kill "$pid" 2>/dev/null || true

  for _ in {1..10}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 1
  done

  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
  fi

  rm -f "$PID_FILE"
  echo "Stopped $NODE_SLOT_ID"
}

reset_chain() {
  stop_node || true
  rm -rf "$CHAIN_DIR" "$DATA_DIR/devnet15/$NODE_SLOT_ID/chain" "$DATA_DIR/devnet15/$NODE_SLOT_ID/logs"
  rm -f "$DATA_DIR/chain.json" "$DATA_DIR/token_state.json" "$DATA_DIR/validator_registry.json" "$DATA_DIR/synergy-devnet.pid" "$DATA_DIR/.reset_flag" "$PID_FILE"
  mkdir -p "$CHAIN_DIR" "$LOG_DIR" "$DATA_DIR/devnet15/$NODE_SLOT_ID/chain" "$DATA_DIR/devnet15/$NODE_SLOT_ID/logs"
  echo "Reset chain state for $NODE_SLOT_ID. Node remains stopped."
}

status_node() {
  if is_running; then
    echo "$NODE_SLOT_ID is running (PID $(cat "$PID_FILE"))"
  else
    echo "$NODE_SLOT_ID is stopped"
  fi
}

show_logs() {
  if [[ ! -f "$OUT_FILE" ]]; then
    echo "Log file not found: $OUT_FILE"
    return
  fi
  if [[ "${1:-}" == "--follow" ]]; then
    tail -f "$OUT_FILE"
  else
    tail -n 120 "$OUT_FILE"
  fi
}

export_logs() {
  local export_dir archive
  export_dir="$(ensure_export_dir)"
  archive="$export_dir/${NODE_SLOT_ID}-logs-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  tar -czf "$archive" -C "$DATA_DIR" logs >/dev/null 2>&1
  echo "Exported logs to $archive"
}

view_chain_data() {
  du -sh "$CHAIN_DIR" 2>/dev/null || echo "Chain directory not found: $CHAIN_DIR"
  find "$CHAIN_DIR" -maxdepth 2 -type f -print 2>/dev/null | head -n 20 || true
}

export_chain_data() {
  local export_dir archive
  export_dir="$(ensure_export_dir)"
  archive="$export_dir/${NODE_SLOT_ID}-chain-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  tar -czf "$archive" -C "$DATA_DIR" chain >/dev/null 2>&1
  echo "Exported chain data to $archive"
}

show_info() {
  local bin
  bin="$(select_binary)"
  echo "Machine ID: $NODE_SLOT_ID"
  echo "Node ID: $NODE_ALIAS"
  echo "Role: $ROLE"
  echo "Node Type: $NODE_TYPE"
  echo "Address Class: $ADDRESS_CLASS"
  echo "Address: $NODE_ADDRESS"
  echo "Monitor Host: ${MONITOR_HOST:-$HOST}"
  echo "VPN IP: ${VPN_IP:-not-set}"
  echo "Transport: ${NETWORK_TRANSPORT:-standard}"
  echo "P2P: $P2P_PORT"
  echo "RPC: $RPC_PORT"
  echo "WS: $WS_PORT"
  echo "gRPC: $GRPC_PORT"
  echo "Discovery: $DISCOVERY_PORT"
  echo "Binary: ${bin:-unsupported-platform (use PowerShell on Windows)}"
  echo "Config: $BASE_DIR/config/node.toml"
}

case "${1:-}" in
  start)
    start_node
    ;;
  setup)
    setup_node
    ;;
  install_node)
    install_node
    ;;
  bootstrap_node)
    bootstrap_node
    ;;
  stop)
    stop_node
    ;;
  restart)
    stop_node
    start_node
    ;;
  sync)
    sync_node
    ;;
  reset_chain)
    reset_chain
    ;;
  status)
    status_node
    ;;
  logs)
    show_logs "${2:-}"
    ;;
  export_logs)
    export_logs
    ;;
  view_chain_data)
    view_chain_data
    ;;
  export_chain_data)
    export_chain_data
    ;;
  info)
    show_info
    ;;
  *)
    cat <<USAGE
Usage: $0 <start|setup|install_node|bootstrap_node|stop|restart|sync|reset_chain|status|logs|export_logs|view_chain_data|export_chain_data|info>

  start    Start the node (includes pre-start sync check).
  setup    Install and start the node locally.
  install_node
           Install and start the node locally.
  bootstrap_node
           Install and start the node locally.
  stop     Stop the node.
  restart  Stop then start the node.
  sync     Sync all missing blocks from peers WITHOUT starting the node.
           Use for late-joining nodes or nodes offline for a long time.
           Override timeout: PRESTART_SYNC_TIMEOUT_SECS=3600 $0 sync
  reset_chain
           Remove runtime chain state and leave the node stopped.
  status   Show whether the node process is running.
  logs     Tail node logs. Pass --follow to stream.
  export_logs
           Archive local logs under exports/.
  view_chain_data
           Show local chain data size and sample files.
  export_chain_data
           Archive local chain data under exports/.
  info     Print node configuration details.

Examples:
  $0 start
  $0 sync
  PRESTART_SYNC_TIMEOUT_SECS=3600 $0 sync
  $0 status
  $0 logs --follow
  $0 restart
USAGE
    exit 1
    ;;
esac
SCRIPT
  chmod +x "$node_dir/nodectl.sh"
}

write_install_ps1() {
  local node_dir="$1"
  cat > "$node_dir/install_and_start.ps1" <<'SCRIPT'
param(
  [switch]$OpenPortsOnly
)

$ErrorActionPreference = "Stop"

$BaseDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvPath = Join-Path $BaseDir "node.env"
$NodeEnv = @{}

if (-not (Test-Path $EnvPath)) {
  throw "Missing node.env at $EnvPath"
}

Get-Content $EnvPath | ForEach-Object {
  if ($_ -match '^\s*$' -or $_ -match '^\s*#') { return }
  $parts = $_ -split '=', 2
  if ($parts.Count -eq 2) {
    $NodeEnv[$parts[0].Trim()] = $parts[1].Trim()
  }
}

function Get-NodeEnvValue([string]$Name) {
  if ($NodeEnv.ContainsKey($Name)) { return $NodeEnv[$Name] }
  return ""
}

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$BinPath = Join-Path $BaseDir "bin/synergy-devnet-windows-amd64.exe"
$ConfigPath = Join-Path $BaseDir "config/node.toml"
$DataDir = Join-Path $BaseDir "data"
$ChainDir = Join-Path $DataDir "chain"
$LogsDir = Join-Path $DataDir "logs"
$PidFile = Join-Path $DataDir "node.pid"
$OutFile = Join-Path $LogsDir "node.out"
$ErrFile = Join-Path $LogsDir "node.err"
$StagedBinPath = "$BinPath.pending"

if (-not (Test-Path $BinPath)) {
  throw "Missing Windows binary: $BinPath"
}
if (-not (Test-Path $ConfigPath)) {
  throw "Missing config file: $ConfigPath"
}

function Test-NodeRunning {
  if (-not (Test-Path $PidFile)) { return $false }
  $pidValue = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $pidValue) { return $false }
  return $null -ne (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)
}

function Test-BootnodeSlot {
  $nodeSlotId = Get-NodeEnvValue "NODE_SLOT_ID"
  return $nodeSlotId -eq "node-01" -or $nodeSlotId -eq "node-02"
}

function Test-SyncRequired {
  if (Test-BootnodeSlot) { return $false }
  $roleGroup = (Get-NodeEnvValue "ROLE_GROUP").ToLower()
  $nodeType = (Get-NodeEnvValue "NODE_TYPE").ToLower()
  return $roleGroup -eq "consensus" -and $nodeType -eq "validator"
}

function Apply-StagedBinary {
  if (-not (Test-Path $StagedBinPath)) { return }
  if (Test-Path $BinPath) {
    Remove-Item $BinPath -Force -ErrorAction SilentlyContinue
  }
  Move-Item -Path $StagedBinPath -Destination $BinPath -Force
  Write-Host "Applied staged binary update: $BinPath"
}

function Open-Ports {
  $ports = @(
    [int](Get-NodeEnvValue "P2P_PORT"),
    [int](Get-NodeEnvValue "RPC_PORT"),
    [int](Get-NodeEnvValue "WS_PORT"),
    [int](Get-NodeEnvValue "GRPC_PORT"),
    [int](Get-NodeEnvValue "DISCOVERY_PORT"),
    47990  # Devnet agent service port
  )
  $networkTransport = (Get-NodeEnvValue "NETWORK_TRANSPORT").ToLower()
  if ([string]::IsNullOrWhiteSpace($networkTransport)) { $networkTransport = "wireguard" }
  $vpnCidr = Get-NodeEnvValue "VPN_CIDR"
  if ([string]::IsNullOrWhiteSpace($vpnCidr)) { $vpnCidr = "10.50.0.0/24" }

  if (-not (Test-Admin)) {
    $canPromptForElevation = [Environment]::UserInteractive `
      -and [string]::IsNullOrWhiteSpace($env:SSH_CONNECTION) `
      -and [string]::IsNullOrWhiteSpace($env:SSH_CLIENT)
    if ($canPromptForElevation -and -not $OpenPortsOnly) {
      try {
        $argumentList = @(
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          "`"$PSCommandPath`"",
          "-OpenPortsOnly"
        )
        $elevated = Start-Process -FilePath "powershell" -Verb RunAs -WorkingDirectory $BaseDir -ArgumentList $argumentList -Wait -PassThru
        if ($elevated.ExitCode -eq 0) {
          Write-Host "Opened Windows Firewall ports using an elevated PowerShell prompt."
          return
        }
        Write-Warning "Elevated firewall setup exited with code $($elevated.ExitCode)."
      } catch {
        Write-Warning "Unable to prompt for Windows Firewall elevation automatically: $_"
      }
    }
    Write-Warning "Run PowerShell as Administrator to auto-open Windows Firewall ports."
    Write-Host "Open these TCP ports manually: $($ports -join ', ')"
    return
  }

  $nodeSlotId = Get-NodeEnvValue "NODE_SLOT_ID"
  foreach ($port in $ports) {
    $ruleName = "Synergy-$nodeSlotId-$port"
    try {
      $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
      if (-not $existing) {
        if ($networkTransport -eq "wireguard") {
          New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port -RemoteAddress $vpnCidr | Out-Null
        } else {
          New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port | Out-Null
        }
      }
    } catch {
      Write-Warning "Failed to create firewall rule for port ${port}: $_"
    }
  }
}

function Invoke-PreStartSync {
  if (Test-BootnodeSlot) { return $true }

  # Use a wall-clock deadline instead of a fixed attempt count so that nodes
  # far behind the chain tip (e.g. late joiners) are given enough time to
  # fully catch up.  Override with PRESTART_SYNC_TIMEOUT_SECS in the calling
  # environment (default: 600 s = 10 min; use e.g. 3600 for a late joiner).
  $timeoutSecs = if ($env:PRESTART_SYNC_TIMEOUT_SECS) { [int]$env:PRESTART_SYNC_TIMEOUT_SECS } else { 600 }
  $deadline = (Get-Date).AddSeconds($timeoutSecs)
  $attempt = 0

  while ((Get-Date) -lt $deadline) {
    $attempt++
    $remaining = [int]($deadline - (Get-Date)).TotalSeconds
    Write-Host "Pre-start sync attempt $attempt for $($NodeEnv['NODE_SLOT_ID']) (${remaining}s remaining of ${timeoutSecs}s)..."
    & $BinPath sync --config $ConfigPath 1>> $OutFile 2>> $ErrFile
    if ($LASTEXITCODE -eq 0) {
      return $true
    }
    $remaining = ($deadline - (Get-Date)).TotalSeconds
    if ($remaining -gt 5) {
      Start-Sleep -Seconds 5
    }
  }

  return $false
}

function Start-Node {
  if (Test-NodeRunning) {
    $currentPid = Get-Content $PidFile | Select-Object -First 1
    Write-Host "$($NodeEnv['NODE_SLOT_ID']) already running (PID $currentPid)"
    return
  }

  Apply-StagedBinary

  New-Item -ItemType Directory -Path $ChainDir -Force | Out-Null
  New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
  New-Item -ItemType File -Path $OutFile -Force | Out-Null
  New-Item -ItemType File -Path $ErrFile -Force | Out-Null

  $validatorAddress = Get-NodeEnvValue "NODE_ADDRESS"
  if ([string]::IsNullOrWhiteSpace($validatorAddress)) {
    $validatorAddress = $env:SYNERGY_VALIDATOR_ADDRESS
  }
  if (-not [string]::IsNullOrWhiteSpace($validatorAddress)) {
    $env:SYNERGY_VALIDATOR_ADDRESS = $validatorAddress
    $env:NODE_ADDRESS = $validatorAddress
  } else {
    Write-Warning "NODE_ADDRESS is empty; validator identity will fallback to node_name."
  }

  $autoRegister = Get-NodeEnvValue "SYNERGY_AUTO_REGISTER_VALIDATOR"
  if ([string]::IsNullOrWhiteSpace($autoRegister)) { $autoRegister = Get-NodeEnvValue "AUTO_REGISTER_VALIDATOR" }
  if ([string]::IsNullOrWhiteSpace($autoRegister)) { $autoRegister = "false" }
  $env:SYNERGY_AUTO_REGISTER_VALIDATOR = $autoRegister

  $strictAllowlist = Get-NodeEnvValue "SYNERGY_STRICT_VALIDATOR_ALLOWLIST"
  if ([string]::IsNullOrWhiteSpace($strictAllowlist)) { $strictAllowlist = Get-NodeEnvValue "STRICT_VALIDATOR_ALLOWLIST" }
  if ([string]::IsNullOrWhiteSpace($strictAllowlist)) { $strictAllowlist = "true" }
  $env:SYNERGY_STRICT_VALIDATOR_ALLOWLIST = $strictAllowlist

  $allowedValidators = Get-NodeEnvValue "SYNERGY_ALLOWED_VALIDATOR_ADDRESSES"
  if ([string]::IsNullOrWhiteSpace($allowedValidators)) { $allowedValidators = Get-NodeEnvValue "ALLOWED_VALIDATOR_ADDRESSES" }
  if (-not [string]::IsNullOrWhiteSpace($allowedValidators)) {
    $env:SYNERGY_ALLOWED_VALIDATOR_ADDRESSES = $allowedValidators
  }

  $rpcBindAddress = Get-NodeEnvValue "SYNERGY_RPC_BIND_ADDRESS"
  if ([string]::IsNullOrWhiteSpace($rpcBindAddress)) { $rpcBindAddress = Get-NodeEnvValue "RPC_BIND_ADDRESS" }
  if (-not [string]::IsNullOrWhiteSpace($rpcBindAddress)) {
    $env:SYNERGY_RPC_BIND_ADDRESS = $rpcBindAddress
  }

  $configuredChainId = Get-NodeEnvValue "SYNERGY_CHAIN_ID"
  if ([string]::IsNullOrWhiteSpace($configuredChainId)) { $configuredChainId = Get-NodeEnvValue "CHAIN_ID" }
  if ([string]::IsNullOrWhiteSpace($configuredChainId)) { $configuredChainId = "338638" }
  $env:SYNERGY_CHAIN_ID = $configuredChainId

  $configuredNetworkId = Get-NodeEnvValue "SYNERGY_NETWORK_ID"
  if ([string]::IsNullOrWhiteSpace($configuredNetworkId)) { $configuredNetworkId = Get-NodeEnvValue "NETWORK_ID" }
  if ([string]::IsNullOrWhiteSpace($configuredNetworkId)) { $configuredNetworkId = $configuredChainId }
  $env:SYNERGY_NETWORK_ID = $configuredNetworkId
  $env:SYNERGY_CONFIG_PATH = $ConfigPath

  if (-not (Invoke-PreStartSync)) {
    if (Test-SyncRequired) {
      throw "Pre-start sync failed for $($NodeEnv['NODE_SLOT_ID']); refusing to start validator while unsynced."
    }
    Write-Warning "Pre-start sync did not complete for $($NodeEnv['NODE_SLOT_ID']); continuing with node start."
  }

  $args = @("start", "--config", $ConfigPath)
  $proc = Start-Process -FilePath $BinPath -ArgumentList $args -WorkingDirectory $BaseDir -RedirectStandardOutput $OutFile -RedirectStandardError $ErrFile -PassThru
  Set-Content -Path $PidFile -Value $proc.Id

  Write-Host "Started $($NodeEnv['NODE_SLOT_ID']) ($($NodeEnv['NODE_TYPE'])) PID $($proc.Id)"
  Write-Host "Logs: $OutFile"
}

Open-Ports

if ($OpenPortsOnly) {
  Write-Host "Firewall rule setup completed for $($NodeEnv['NODE_SLOT_ID'])."
  exit 0
}

# SYNC_ONLY=true: run pre-start sync and exit without launching the node process.
# Used by nodectl.ps1 sync to let an operator explicitly catch up a late-joining
# node before starting it.
if ($env:SYNC_ONLY -eq "true") {
  if (Invoke-PreStartSync) {
    Write-Host "[$($NodeEnv['NODE_SLOT_ID'])] Sync complete. Node is ready for manual start."
    exit 0
  } else {
    Write-Error "[$($NodeEnv['NODE_SLOT_ID'])] Sync did not complete within the timeout."
    exit 1
  }
}

Start-Node
SCRIPT
}

write_nodectl_ps1() {
  local node_dir="$1"
  cat > "$node_dir/nodectl.ps1" <<'SCRIPT'
param(
  [Parameter(Position = 0)]
  [ValidateSet("start", "stop", "restart", "sync", "status", "logs", "info", "setup", "install_node", "bootstrap_node", "reset_chain", "export_logs", "view_chain_data", "export_chain_data")]
  [string]$Action = "status",
  [switch]$Follow
)

$ErrorActionPreference = "Stop"

$BaseDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvPath = Join-Path $BaseDir "node.env"
$NodeEnv = @{}

if (-not (Test-Path $EnvPath)) {
  throw "Missing node.env at $EnvPath"
}

Get-Content $EnvPath | ForEach-Object {
  if ($_ -match '^\s*$' -or $_ -match '^\s*#') { return }
  $parts = $_ -split '=', 2
  if ($parts.Count -eq 2) {
    $NodeEnv[$parts[0].Trim()] = $parts[1].Trim()
  }
}

function Get-NodeEnvValue([string]$Name) {
  if ($NodeEnv.ContainsKey($Name)) { return $NodeEnv[$Name] }
  return ""
}

$DataDir = Join-Path $BaseDir "data"
$PidFile = Join-Path $DataDir "node.pid"
$OutFile = Join-Path $DataDir "logs/node.out"
$LogsDir = Join-Path $DataDir "logs"
$ChainDir = Join-Path $DataDir "chain"

function Test-NodeRunning {
  if (-not (Test-Path $PidFile)) { return $false }
  $pidValue = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $pidValue) { return $false }
  return $null -ne (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)
}

function Start-Node { & (Join-Path $BaseDir "install_and_start.ps1") }
function Setup-Node { & (Join-Path $BaseDir "install_and_start.ps1") }
function Install-Node { & (Join-Path $BaseDir "install_and_start.ps1") }
function Bootstrap-Node { & (Join-Path $BaseDir "install_and_start.ps1") }

# Sync only — download all missing blocks from peers without starting the node.
# Intended for late-joining nodes or nodes that have been offline for a long time.
function Sync-Node {
  $env:SYNC_ONLY = "true"
  if (-not $env:PRESTART_SYNC_TIMEOUT_SECS) { $env:PRESTART_SYNC_TIMEOUT_SECS = "7200" }
  & (Join-Path $BaseDir "install_and_start.ps1")
}

function Stop-Node {
  if (-not (Test-NodeRunning)) {
    Write-Host "$($NodeEnv['NODE_SLOT_ID']) is not running"
    if (Test-Path $PidFile) { Remove-Item $PidFile -Force }
    return
  }

  $pidValue = Get-Content $PidFile | Select-Object -First 1
  Stop-Process -Id $pidValue -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  if (Get-Process -Id $pidValue -ErrorAction SilentlyContinue) {
    Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path $PidFile) { Remove-Item $PidFile -Force }
  Write-Host "Stopped $($NodeEnv['NODE_SLOT_ID'])"
}

function Reset-Chain {
  Stop-Node
  foreach ($target in @(
    $ChainDir,
    (Join-Path $DataDir "devnet15\$($NodeEnv['NODE_SLOT_ID'])\chain"),
    (Join-Path $DataDir "devnet15\$($NodeEnv['NODE_SLOT_ID'])\logs"),
    (Join-Path $DataDir "chain.json"),
    (Join-Path $DataDir "token_state.json"),
    (Join-Path $DataDir "validator_registry.json"),
    (Join-Path $DataDir "synergy-devnet.pid"),
    (Join-Path $DataDir ".reset_flag"),
    $PidFile
  )) {
    if (Test-Path $target) {
      Remove-Item $target -Recurse -Force
    }
  }
  New-Item -ItemType Directory -Force -Path $ChainDir, $LogsDir | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $DataDir "devnet15\$($NodeEnv['NODE_SLOT_ID'])\chain") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $DataDir "devnet15\$($NodeEnv['NODE_SLOT_ID'])\logs") | Out-Null
  Write-Host "Reset chain state for $($NodeEnv['NODE_SLOT_ID']). Node remains stopped."
}

function Status-Node {
  if (Test-NodeRunning) {
    $pidValue = Get-Content $PidFile | Select-Object -First 1
    Write-Host "$($NodeEnv['NODE_SLOT_ID']) is running (PID $pidValue)"
  } else {
    Write-Host "$($NodeEnv['NODE_SLOT_ID']) is stopped"
  }
}

function Logs-Node {
  if (-not (Test-Path $OutFile)) {
    Write-Host "Log file not found: $OutFile"
    return
  }
  if ($Follow) {
    Get-Content -Path $OutFile -Tail 120 -Wait
  } else {
    Get-Content -Path $OutFile -Tail 120
  }
}

function New-ExportDirectory {
  $exportDir = Join-Path $BaseDir "exports"
  New-Item -ItemType Directory -Force -Path $exportDir | Out-Null
  return $exportDir
}

function Export-Logs {
  $exportDir = New-ExportDirectory
  $archive = Join-Path $exportDir "$($NodeEnv['NODE_SLOT_ID'])-logs-$(Get-Date -AsUTC -Format 'yyyyMMddTHHmmssZ').zip"
  Compress-Archive -Path $LogsDir -DestinationPath $archive -Force
  Write-Host "Exported logs to $archive"
}

function View-ChainData {
  if (-not (Test-Path $ChainDir)) {
    Write-Host "Chain directory not found: $ChainDir"
    return
  }
  Get-ChildItem $ChainDir -Recurse -File -ErrorAction SilentlyContinue |
    Sort-Object Length -Descending |
    Select-Object -First 20 FullName,Length,LastWriteTime |
    Format-Table -AutoSize
}

function Export-ChainData {
  $exportDir = New-ExportDirectory
  $archive = Join-Path $exportDir "$($NodeEnv['NODE_SLOT_ID'])-chain-$(Get-Date -AsUTC -Format 'yyyyMMddTHHmmssZ').zip"
  Compress-Archive -Path $ChainDir -DestinationPath $archive -Force
  Write-Host "Exported chain data to $archive"
}

function Info-Node {
  $binary = Get-ChildItem (Join-Path $BaseDir "bin") -Filter "synergy-devnet*" -File -ErrorAction SilentlyContinue |
    Sort-Object Name |
    Select-Object -First 1 -ExpandProperty FullName
  Write-Host "Node Slot ID: $(Get-NodeEnvValue 'NODE_SLOT_ID')"
  Write-Host "Node ID: $(Get-NodeEnvValue 'NODE_ALIAS')"
  Write-Host "Role: $(Get-NodeEnvValue 'ROLE')"
  Write-Host "Node Type: $(Get-NodeEnvValue 'NODE_TYPE')"
  Write-Host "Address Class: $(Get-NodeEnvValue 'ADDRESS_CLASS')"
  Write-Host "Address: $(Get-NodeEnvValue 'NODE_ADDRESS')"
  Write-Host "Monitor Host: $(Get-NodeEnvValue 'MONITOR_HOST')"
  Write-Host "VPN IP: $(Get-NodeEnvValue 'VPN_IP')"
  Write-Host "Transport: $(Get-NodeEnvValue 'NETWORK_TRANSPORT')"
  Write-Host "P2P: $(Get-NodeEnvValue 'P2P_PORT')"
  Write-Host "RPC: $(Get-NodeEnvValue 'RPC_PORT')"
  Write-Host "WS: $(Get-NodeEnvValue 'WS_PORT')"
  Write-Host "gRPC: $(Get-NodeEnvValue 'GRPC_PORT')"
  Write-Host "Discovery: $(Get-NodeEnvValue 'DISCOVERY_PORT')"
  Write-Host "Binary: $binary"
  Write-Host "Config: $(Join-Path $BaseDir 'config/node.toml')"
}

switch ($Action) {
  "start"   { Start-Node }
  "setup"   { Setup-Node }
  "install_node" { Install-Node }
  "bootstrap_node" { Bootstrap-Node }
  "stop"    { Stop-Node }
  "restart" { Stop-Node; Start-Node }
  "sync"    { Sync-Node }
  "reset_chain" { Reset-Chain }
  "status"  { Status-Node }
  "logs"    { Logs-Node }
  "export_logs" { Export-Logs }
  "view_chain_data" { View-ChainData }
  "export_chain_data" { Export-ChainData }
  "info"    { Info-Node }
}
SCRIPT
}

write_commands_file() {
  local node_dir="$1"
  local node_slot_id="$2"
  local node_type="$3"
  local p2p_port="$4"
  local rpc_port="$5"
  local ws_port="$6"
  local grpc_port="$7"
  local discovery_port="$8"

  cat > "$node_dir/COMMANDS.txt" <<TXT
Synergy Devnet Node Command Reference
====================================

Node Slot: $node_slot_id
Type: $node_type

Ports
-----
P2P: $p2p_port
RPC: $rpc_port
WebSocket: $ws_port
gRPC: $grpc_port
Discovery: $discovery_port

Linux/macOS Commands
--------------------
# One-command installation + firewall + start
./install_and_start.sh

# Status
./nodectl.sh status

# Live logs
./nodectl.sh logs --follow

# Last logs
./nodectl.sh logs

# Restart
./nodectl.sh restart

# Stop
./nodectl.sh stop

# Node metadata/ports
./nodectl.sh info

Windows PowerShell Commands
---------------------------
# One-command installation + start
powershell -ExecutionPolicy Bypass -File .\\install_and_start.ps1

# Status
powershell -ExecutionPolicy Bypass -File .\\nodectl.ps1 status

# Live logs
powershell -ExecutionPolicy Bypass -File .\\nodectl.ps1 logs -Follow

# Last logs
powershell -ExecutionPolicy Bypass -File .\\nodectl.ps1 logs

# Restart
powershell -ExecutionPolicy Bypass -File .\\nodectl.ps1 restart

# Stop
powershell -ExecutionPolicy Bypass -File .\\nodectl.ps1 stop

# Node metadata/ports
powershell -ExecutionPolicy Bypass -File .\\nodectl.ps1 info

Direct Binary Commands
----------------------
Linux:
./bin/synergy-devnet-linux-amd64 start --config ./config/node.toml

macOS:
./bin/synergy-devnet-darwin-arm64 start --config ./config/node.toml

Windows:
.\\bin\\synergy-devnet-windows-amd64.exe start --config .\\config\\node.toml

Data Paths
----------
PID file: ./data/node.pid
Logs: ./data/logs/node.out
Chain data: ./data/chain
Config: ./config/node.toml
Keys: ./keys/
TXT
}

write_readme() {
  local node_dir="$1"
  local node_slot_id="$2"
  local role_group="$3"
  local role="$4"
  local node_type="$5"
  local linux_source="$6"
  local darwin_source="$7"
  local windows_source="$8"

  cat > "$node_dir/README.txt" <<TXT
Synergy Lean 15 Devnet Installer
================================

Node Slot: $node_slot_id
Role Group: $role_group
Role: $role
Node Type: $node_type

Quick Start (Linux/macOS)
-------------------------
1) Copy this entire folder to the target machine.
2) Run:
   ./install_and_start.sh
3) Verify:
   ./nodectl.sh status
   ./nodectl.sh logs --follow

Quick Start (Windows)
---------------------
1) Copy this entire folder to the target machine.
2) Run in PowerShell:
   powershell -ExecutionPolicy Bypass -File .\\install_and_start.ps1
3) Verify:
   powershell -ExecutionPolicy Bypass -File .\\nodectl.ps1 status
   powershell -ExecutionPolicy Bypass -File .\\nodectl.ps1 logs -Follow

Notes
-----
- The installer includes Linux x86_64, macOS arm64, and Windows x86_64 binaries.
- Linux firewall automation supports ufw, firewalld, and iptables.
- In WireGuard mode, firewall rules are scoped to VPN CIDR traffic.
- Windows firewall automation prompts for elevation when needed and otherwise prints the required TCP ports.
- This folder is self-contained for this node instance.
- Public DNS should resolve to public hosts only; never point public DNS at private VPN IPs.
- Binary provenance:
  - Linux: $linux_source
  - macOS: $darwin_source
  - Windows: $windows_source
- See BINARY_STATUS.txt for SHA-256 checksums and build-source details.
TXT
}

write_binary_status_file() {
  local node_dir="$1"
  local linux_source="$2"
  local darwin_source="$3"
  local windows_source="$4"
  local linux_sha="$5"
  local darwin_sha="$6"
  local windows_sha="$7"

  cat > "$node_dir/BINARY_STATUS.txt" <<TXT
Synergy Devnet Binary Status
============================

Linux Binary
------------
Path: ./bin/synergy-devnet-linux-amd64
Source: $linux_source
SHA-256: $linux_sha

Darwin Binary
-------------
Path: ./bin/synergy-devnet-darwin-arm64
Source: $darwin_source
SHA-256: $darwin_sha

Windows Binary
--------------
Path: ./bin/synergy-devnet-windows-amd64.exe
Source: $windows_source
SHA-256: $windows_sha

Interpretation
--------------
- Source containing "fresh" indicates locally built binaries from this workspace.
- Source containing "fallback-prebuilt" indicates prebuilt artifacts copied from /binaries.
- For production-grade deployment, prefer fresh builds for all target platforms.
TXT
}

ALLOWED_VALIDATOR_ADDRESSES_CSV="$(collect_allowlisted_validators_csv)"

while IFS=, read -r node_slot_id node_alias role_group role node_type address_class p2p_port rpc_port ws_port grpc_port discovery_port host vpn_ip physical_machine_id auto_register enable_pruning vrf_enabled operator device operating_system public_ip local_ip || [[ -n "${node_slot_id:-}" ]]; do
  [[ "$node_slot_id" == "node_slot_id" ]] && continue

  auto_register="$(normalize_bool "$auto_register")"
  enable_pruning="$(normalize_bool "$enable_pruning")"
  vrf_enabled="$(normalize_bool "$vrf_enabled")"

  node_dir="$OUT_DIR/$node_slot_id"
  rm -rf "$node_dir"
  mkdir -p "$node_dir/bin" "$node_dir/config" "$node_dir/keys"

  cp "$LINUX_BINARY" "$node_dir/bin/synergy-devnet-linux-amd64"
  cp "$DARWIN_BINARY" "$node_dir/bin/synergy-devnet-darwin-arm64"
  cp "$WINDOWS_BINARY" "$node_dir/bin/synergy-devnet-windows-amd64.exe"
  chmod +x "$node_dir/bin/synergy-devnet-linux-amd64" "$node_dir/bin/synergy-devnet-darwin-arm64"

  cp "$CONFIG_DIR/${node_slot_id}.toml" "$node_dir/config/node.toml"
  cp "$GENESIS_FILE" "$node_dir/config/genesis.json"
  cp "$KEYS_DIR/${node_slot_id}"/* "$node_dir/keys/"

  cat > "$node_dir/node.env" <<ENV
NODE_SLOT_ID=$node_slot_id
NODE_ALIAS=$node_alias
ROLE_GROUP=$role_group
ROLE=$role
NODE_TYPE=$node_type
ADDRESS_CLASS=$address_class
NODE_ADDRESS=$(cat "$KEYS_DIR/${node_slot_id}/address.txt")
SYNERGY_VALIDATOR_ADDRESS=$(cat "$KEYS_DIR/${node_slot_id}/address.txt")
P2P_PORT=$p2p_port
RPC_PORT=$rpc_port
WS_PORT=$ws_port
GRPC_PORT=$grpc_port
DISCOVERY_PORT=$discovery_port
HOST=$host
MONITOR_HOST=$host
VPN_IP=$vpn_ip
NETWORK_TRANSPORT=wireguard
WIREGUARD_INTERFACE=wg0
VPN_CIDR=10.50.0.0/24
CHAIN_ID=$DEVNET_CHAIN_ID
NETWORK_ID=$DEVNET_NETWORK_ID
AUTO_REGISTER_VALIDATOR=$auto_register
ENABLE_PRUNING=$enable_pruning
VRF_ENABLED=$vrf_enabled
STRICT_VALIDATOR_ALLOWLIST=true
ALLOWED_VALIDATOR_ADDRESSES=$ALLOWED_VALIDATOR_ADDRESSES_CSV
RPC_BIND_ADDRESS=${vpn_ip}:${rpc_port}
SYNERGY_CHAIN_ID=$DEVNET_CHAIN_ID
SYNERGY_NETWORK_ID=$DEVNET_NETWORK_ID
SYNERGY_AUTO_REGISTER_VALIDATOR=$auto_register
SYNERGY_STRICT_VALIDATOR_ALLOWLIST=true
SYNERGY_ALLOWED_VALIDATOR_ADDRESSES=$ALLOWED_VALIDATOR_ADDRESSES_CSV
SYNERGY_RPC_BIND_ADDRESS=${vpn_ip}:${rpc_port}
SYNERGY_CONFIG_PATH=config/node.toml
ENV

  write_install_script "$node_dir"
  write_nodectl_script "$node_dir"
  write_install_ps1 "$node_dir"
  write_nodectl_ps1 "$node_dir"
  write_commands_file "$node_dir" "$node_slot_id" "$node_type" "$p2p_port" "$rpc_port" "$ws_port" "$grpc_port" "$discovery_port"
  write_readme "$node_dir" "$node_slot_id" "$role_group" "$role" "$node_type" \
    "$LINUX_BINARY_SOURCE" "$DARWIN_BINARY_SOURCE" "$WINDOWS_BINARY_SOURCE"
  write_binary_status_file "$node_dir" "$LINUX_BINARY_SOURCE" "$DARWIN_BINARY_SOURCE" "$WINDOWS_BINARY_SOURCE" \
    "$(sha256_file "$node_dir/bin/synergy-devnet-linux-amd64")" \
    "$(sha256_file "$node_dir/bin/synergy-devnet-darwin-arm64")" \
    "$(sha256_file "$node_dir/bin/synergy-devnet-windows-amd64.exe")"

  echo "Built installer: $node_dir"
done < "$INVENTORY_FILE"

echo "All node installers generated in: $OUT_DIR"
