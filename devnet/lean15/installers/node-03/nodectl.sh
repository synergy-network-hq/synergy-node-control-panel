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
  status)
    status_node
    ;;
  logs)
    show_logs "${2:-}"
    ;;
  info)
    show_info
    ;;
  *)
    cat <<USAGE
Usage: $0 <start|stop|restart|sync|status|logs|info>

  start    Start the node (includes pre-start sync check).
  stop     Stop the node.
  restart  Stop then start the node.
  sync     Sync all missing blocks from peers WITHOUT starting the node.
           Use for late-joining nodes or nodes offline for a long time.
           Override timeout: PRESTART_SYNC_TIMEOUT_SECS=3600 $0 sync
  status   Show whether the node process is running.
  logs     Tail node logs. Pass --follow to stream.
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
