#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$BASE_DIR/node.env"

BIN_LINUX="$BASE_DIR/bin/synergy-testbeta-linux-amd64"
BIN_DARWIN="$BASE_DIR/bin/synergy-testbeta-darwin-arm64"
BIN_SELECTED=""
DATA_DIR="$BASE_DIR/data"
CHAIN_DIR="$DATA_DIR/chain"
LOG_DIR="$DATA_DIR/logs"
PID_FILE="$DATA_DIR/node.pid"
OUT_FILE="$LOG_DIR/node.out"
ERR_FILE="$LOG_DIR/node.err"
INSTALL_STAMP_FILE="$DATA_DIR/.installed_at"
NETWORK_TRANSPORT="${NETWORK_TRANSPORT:-public}"
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
  for port in "$P2P_PORT" "$RPC_PORT" "$WS_PORT" "$GRPC_PORT" "$DISCOVERY_PORT"; do
    run_privileged ufw allow "${port}/tcp" >/dev/null || true
  done
}

open_ports_firewalld() {
  for port in "$P2P_PORT" "$RPC_PORT" "$WS_PORT" "$GRPC_PORT" "$DISCOVERY_PORT"; do
    run_privileged firewall-cmd --permanent --add-port="${port}/tcp" >/dev/null || true
  done
  run_privileged firewall-cmd --reload >/dev/null || true
}

open_ports_iptables() {
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
  [[ "${ROLE_GROUP:-}" == "bootstrap" || "${NODE_TYPE:-}" == "bootnode" ]]
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
  configured_chain_id="${SYNERGY_CHAIN_ID:-${CHAIN_ID:-338639}}"
  local configured_network_id
  configured_network_id="${SYNERGY_NETWORK_ID:-${NETWORK_ID:-synergy-testnet-beta}}"
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

mark_node_installed() {
  if [[ ! -f "$INSTALL_STAMP_FILE" ]]; then
    date -u +"%Y-%m-%dT%H:%M:%SZ" > "$INSTALL_STAMP_FILE"
  fi
}

prepare_install_layout() {
  mkdir -p "$CHAIN_DIR" "$LOG_DIR"
  touch "$OUT_FILE" "$ERR_FILE"
  mark_node_installed
}

start_node() {
  if is_running; then
    echo "$NODE_SLOT_ID already running (PID $(cat "$PID_FILE"))"
    return
  fi

  prepare_install_layout

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
  configured_chain_id="${SYNERGY_CHAIN_ID:-${CHAIN_ID:-338639}}"
  local configured_network_id
  configured_network_id="${SYNERGY_NETWORK_ID:-${NETWORK_ID:-synergy-testnet-beta}}"
  local config_path
  config_path="$BASE_DIR/config/node.toml"
  if [[ -z "$validator_address" ]]; then
    echo "Warning: NODE_ADDRESS is empty; validator identity will fallback to node_name."
  fi

  # Keep relative storage/log paths in node.toml anchored to the installer directory.
  cd "$BASE_DIR"

  if [[ "${SKIP_PRESTART_SYNC:-false}" != "true" ]]; then
    if ! run_prestart_sync; then
      if sync_required_before_start; then
        echo "Pre-start sync failed for $NODE_SLOT_ID; refusing to start validator while unsynced." >&2
        return 1
      fi
      echo "Warning: pre-start sync did not complete for $NODE_SLOT_ID; continuing with node start." >&2
    fi
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

if [[ "${INSTALL_ONLY:-false}" == "true" ]]; then
  prepare_install_layout
  echo "[$NODE_SLOT_ID] Install complete. Node remains offline until sync/start."
  exit 0
fi

# SYNC_ONLY=true: run pre-start sync and exit without launching the node process.
# Used by "nodectl.sh sync" to let an operator explicitly catch up a late-joining
# node before starting it. AUTO_START_AFTER_SYNC=true promotes sync into the
# catch-up-and-start path for dashboard-driven node activation.
if [[ "${SYNC_ONLY:-false}" == "true" ]]; then
  prepare_install_layout
  if run_prestart_sync; then
    if [[ "${AUTO_START_AFTER_SYNC:-false}" == "true" ]]; then
      echo "[$NODE_SLOT_ID] Sync complete. Starting node automatically..."
      SKIP_PRESTART_SYNC=true start_node
    else
      echo "[$NODE_SLOT_ID] Sync complete. Node is ready for manual start."
    fi
    exit 0
  else
    echo "[$NODE_SLOT_ID] Sync did not complete within the timeout." >&2
    exit 1
  fi
fi

start_node
