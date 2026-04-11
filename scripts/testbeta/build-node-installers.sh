#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INVENTORY_FILE="$ROOT_DIR/testbeta/runtime/node-inventory.csv"
CONFIG_DIR="$ROOT_DIR/testbeta/runtime/configs"
GENESIS_FILE="${SYNERGY_TESTBETA_CANONICAL_GENESIS_FILE:-$ROOT_DIR/../config/genesis.json}"
MANIFEST_FILE="${SYNERGY_TESTBETA_CANONICAL_MANIFEST_FILE:-$ROOT_DIR/../config/operational-manifest.json}"
NODE_ADDRESSES_FILE="$ROOT_DIR/testbeta/runtime/keys/node-addresses.csv"
KEYS_DIR="$ROOT_DIR/testbeta/runtime/keys"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/testbeta/runtime/installers}"
TESTBETA_CHAIN_ID="${TESTBETA_CHAIN_ID:-338639}"
TESTBETA_NETWORK_ID="${TESTBETA_NETWORK_ID:-synergy-testnet-beta}"
SOURCE_REPO_ROOT="${SYNERGY_TESTBETA_SOURCE_REPO_ROOT:-$(cd "$ROOT_DIR/../.." && pwd)}"
PREFER_BUNDLED_BINARIES="${PREFER_BUNDLED_BINARIES:-1}"
TESTBETA_ENV_DIR_DEFAULT="${TESTBETA_ENV_DIR_DEFAULT:-$ROOT_DIR/testbeta/runtime/env-files}"
ENV_OVERRIDE_HELPER="${ENV_OVERRIDE_HELPER:-$ROOT_DIR/../scripts/testbeta/testbeta-env-overrides.sh}"

if [[ -f "$ENV_OVERRIDE_HELPER" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_OVERRIDE_HELPER"
fi

FRESH_HOST_BINARY="$ROOT_DIR/target/release/synergy-testbeta"
FRESH_DARWIN_BINARY="$ROOT_DIR/target/aarch64-apple-darwin/release/synergy-testbeta"
FRESH_LINUX_BINARY="$ROOT_DIR/target/x86_64-unknown-linux-gnu/release/synergy-testbeta"
FRESH_WINDOWS_BINARY_MSVC="$ROOT_DIR/target/x86_64-pc-windows-msvc/release/synergy-testbeta.exe"
FRESH_WINDOWS_BINARY_GNU="$ROOT_DIR/target/x86_64-pc-windows-gnu/release/synergy-testbeta.exe"

SOURCE_HOST_BINARY="$SOURCE_REPO_ROOT/target/release/synergy-testbeta"
SOURCE_DARWIN_BINARY="$SOURCE_REPO_ROOT/target/aarch64-apple-darwin/release/synergy-testbeta"
SOURCE_LINUX_BINARY="$SOURCE_REPO_ROOT/target/x86_64-unknown-linux-gnu/release/synergy-testbeta"
SOURCE_WINDOWS_BINARY_MSVC="$SOURCE_REPO_ROOT/target/x86_64-pc-windows-msvc/release/synergy-testbeta.exe"
SOURCE_WINDOWS_BINARY_GNU="$SOURCE_REPO_ROOT/target/x86_64-pc-windows-gnu/release/synergy-testbeta.exe"

FALLBACK_DARWIN_BINARY="$ROOT_DIR/binaries/synergy-testbeta-darwin-arm64"
FALLBACK_LINUX_BINARY="$ROOT_DIR/binaries/synergy-testbeta-linux-amd64"
FALLBACK_WINDOWS_BINARY="$ROOT_DIR/binaries/synergy-testbeta-windows-amd64.exe"

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
  python3 - "$MANIFEST_FILE" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    manifest = json.load(handle)

addresses = []
for entry in manifest.get("validators", []):
    address = str(entry.get("address") or "").strip()
    if address:
        addresses.append(address)

print(",".join(addresses))
PY
}

print_binary_requirements() {
  cat <<REQ
Required binary locations:
  source repo root:
    - preferred override root: ${SOURCE_REPO_ROOT}
  macOS arm64:
    - preferred (source repo native): $SOURCE_HOST_BINARY
    - preferred (source repo target): $SOURCE_DARWIN_BINARY
    - preferred: $FRESH_DARWIN_BINARY
    - fallback:  $FALLBACK_DARWIN_BINARY
  Linux x86_64:
    - preferred (source repo native): $SOURCE_HOST_BINARY
    - preferred (source repo target): $SOURCE_LINUX_BINARY
    - preferred: $FRESH_LINUX_BINARY
    - fallback:  $FALLBACK_LINUX_BINARY
  Windows x86_64:
    - preferred (source repo native): $SOURCE_REPO_ROOT/target/release/synergy-testbeta.exe
    - preferred (source repo target MSVC): $SOURCE_WINDOWS_BINARY_MSVC
    - preferred (source repo target GNU):  $SOURCE_WINDOWS_BINARY_GNU
    - preferred (MSVC): $FRESH_WINDOWS_BINARY_MSVC
    - preferred (GNU):  $FRESH_WINDOWS_BINARY_GNU
    - fallback:         $FALLBACK_WINDOWS_BINARY
REQ
}

resolve_binaries() {
  local host_os host_arch
  host_os="$(uname -s)"
  host_arch="$(uname -m)"

  if [[ "$PREFER_BUNDLED_BINARIES" == "1" ]]; then
    if [[ -f "$FALLBACK_DARWIN_BINARY" ]]; then
      DARWIN_BINARY="$FALLBACK_DARWIN_BINARY"
      DARWIN_BINARY_SOURCE="bundled-release-binary(binaries/synergy-testbeta-darwin-arm64)"
    fi

    if [[ -f "$FALLBACK_LINUX_BINARY" ]]; then
      LINUX_BINARY="$FALLBACK_LINUX_BINARY"
      LINUX_BINARY_SOURCE="bundled-release-binary(binaries/synergy-testbeta-linux-amd64)"
    fi

    if [[ -f "$FALLBACK_WINDOWS_BINARY" ]]; then
      WINDOWS_BINARY="$FALLBACK_WINDOWS_BINARY"
      WINDOWS_BINARY_SOURCE="bundled-release-binary(binaries/synergy-testbeta-windows-amd64.exe)"
    fi

    if [[ -n "$DARWIN_BINARY" && -n "$LINUX_BINARY" && -n "$WINDOWS_BINARY" ]]; then
      return
    fi
  fi

  if [[ "$host_os" == "Darwin" && "$host_arch" == "arm64" && -f "$FRESH_HOST_BINARY" ]]; then
    DARWIN_BINARY="$FRESH_HOST_BINARY"
    DARWIN_BINARY_SOURCE="fresh-local-build(target/release/synergy-testbeta)"
  elif [[ "$host_os" == "Darwin" && "$host_arch" == "arm64" && -f "$SOURCE_HOST_BINARY" ]]; then
    DARWIN_BINARY="$SOURCE_HOST_BINARY"
    DARWIN_BINARY_SOURCE="source-repo-native-build(${SOURCE_HOST_BINARY#$SOURCE_REPO_ROOT/})"
  elif [[ -f "$SOURCE_DARWIN_BINARY" ]]; then
    DARWIN_BINARY="$SOURCE_DARWIN_BINARY"
    DARWIN_BINARY_SOURCE="source-repo-target-build(${SOURCE_DARWIN_BINARY#$SOURCE_REPO_ROOT/})"
  elif [[ -f "$FRESH_DARWIN_BINARY" ]]; then
    DARWIN_BINARY="$FRESH_DARWIN_BINARY"
    DARWIN_BINARY_SOURCE="fresh-target-build(target/aarch64-apple-darwin/release/synergy-testbeta)"
  elif [[ -f "$FALLBACK_DARWIN_BINARY" ]]; then
    DARWIN_BINARY="$FALLBACK_DARWIN_BINARY"
    DARWIN_BINARY_SOURCE="fallback-prebuilt(binaries/synergy-testbeta-darwin-arm64)"
  fi

  if [[ "$host_os" == "Linux" && "$host_arch" == "x86_64" && -f "$SOURCE_HOST_BINARY" ]]; then
    LINUX_BINARY="$SOURCE_HOST_BINARY"
    LINUX_BINARY_SOURCE="source-repo-native-build(${SOURCE_HOST_BINARY#$SOURCE_REPO_ROOT/})"
  elif [[ -f "$SOURCE_LINUX_BINARY" ]]; then
    LINUX_BINARY="$SOURCE_LINUX_BINARY"
    LINUX_BINARY_SOURCE="source-repo-target-build(${SOURCE_LINUX_BINARY#$SOURCE_REPO_ROOT/})"
  elif [[ -f "$FRESH_LINUX_BINARY" ]]; then
    LINUX_BINARY="$FRESH_LINUX_BINARY"
    LINUX_BINARY_SOURCE="fresh-cross-build(target/x86_64-unknown-linux-gnu/release/synergy-testbeta)"
  elif [[ -f "$FALLBACK_LINUX_BINARY" ]]; then
    LINUX_BINARY="$FALLBACK_LINUX_BINARY"
    LINUX_BINARY_SOURCE="fallback-prebuilt(binaries/synergy-testbeta-linux-amd64)"
  fi

  if [[ "$host_os" =~ ^(MINGW|MSYS|CYGWIN) && "$host_arch" == "x86_64" && -f "$SOURCE_REPO_ROOT/target/release/synergy-testbeta.exe" ]]; then
    WINDOWS_BINARY="$SOURCE_REPO_ROOT/target/release/synergy-testbeta.exe"
    WINDOWS_BINARY_SOURCE="source-repo-native-build(target/release/synergy-testbeta.exe)"
  elif [[ -f "$SOURCE_WINDOWS_BINARY_MSVC" ]]; then
    WINDOWS_BINARY="$SOURCE_WINDOWS_BINARY_MSVC"
    WINDOWS_BINARY_SOURCE="source-repo-target-build(${SOURCE_WINDOWS_BINARY_MSVC#$SOURCE_REPO_ROOT/})"
  elif [[ -f "$SOURCE_WINDOWS_BINARY_GNU" ]]; then
    WINDOWS_BINARY="$SOURCE_WINDOWS_BINARY_GNU"
    WINDOWS_BINARY_SOURCE="source-repo-target-build(${SOURCE_WINDOWS_BINARY_GNU#$SOURCE_REPO_ROOT/})"
  elif [[ -f "$FRESH_WINDOWS_BINARY_MSVC" ]]; then
    WINDOWS_BINARY="$FRESH_WINDOWS_BINARY_MSVC"
    WINDOWS_BINARY_SOURCE="fresh-cross-build(target/x86_64-pc-windows-msvc/release/synergy-testbeta.exe)"
  elif [[ -f "$FRESH_WINDOWS_BINARY_GNU" ]]; then
    WINDOWS_BINARY="$FRESH_WINDOWS_BINARY_GNU"
    WINDOWS_BINARY_SOURCE="fresh-cross-build(target/x86_64-pc-windows-gnu/release/synergy-testbeta.exe)"
  elif [[ -f "$FALLBACK_WINDOWS_BINARY" ]]; then
    WINDOWS_BINARY="$FALLBACK_WINDOWS_BINARY"
    WINDOWS_BINARY_SOURCE="fallback-prebuilt(binaries/synergy-testbeta-windows-amd64.exe)"
  fi
}

if [[ ! -f "$INVENTORY_FILE" ]]; then
  echo "Missing inventory file: $INVENTORY_FILE" >&2
  exit 1
fi

if [[ ! -f "$GENESIS_FILE" ]]; then
  echo "Missing genesis file: $GENESIS_FILE" >&2
  echo "Sync the canonical genesis from ../config/genesis.json first." >&2
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
find "$OUT_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true

write_install_script() {
  local node_dir="$1"
  cat > "$node_dir/install_and_start.sh" <<'SCRIPT'
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

build_runtime_env_args() {
  local validator_address="$1"
  local auto_register_validator="$2"
  local strict_allowlist="$3"
  local allowed_validators="$4"
  local rpc_bind_address="$5"
  local configured_network_id="$6"
  local configured_chain_id="$7"
  local config_path="$8"
  local bind_ip="${BIND_IP:-}"
  local public_host="${NODE_PUBLIC_HOST:-${HOSTNAME:-${HOST:-}}}"
  local p2p_port_value="${P2P_PORT:-${SYNERGY_P2P_PORT:-}}"
  local rpc_port_value="${RPC_PORT:-${SYNERGY_RPC_PORT:-}}"
  local ws_port_value="${WS_PORT:-${SYNERGY_WS_PORT:-}}"
  local grpc_port_value="${GRPC_PORT:-${SYNERGY_GRPC_PORT:-}}"
  local public_p2p_port="${PUBLIC_P2P_PORT:-${P2P_PORT_EXTERNAL:-${p2p_port_value:-}}}"
  local discovery_port_value="${DISCOVERY_PORT:-${SYNERGY_DISCOVERY_PORT:-}}"
  local discovery_public_port="${DISCOVERY_PORT_EXTERNAL:-${discovery_port_value:-}}"
  local p2p_listen_address=""
  local p2p_external_address=""
  local discovery_listen_address=""
  local discovery_external_address=""

  if [[ -z "$bind_ip" && -n "$rpc_bind_address" ]]; then
    bind_ip="${rpc_bind_address%:*}"
  fi
  bind_ip="${bind_ip:-0.0.0.0}"

  if [[ -n "$p2p_port_value" ]]; then
    p2p_listen_address="${bind_ip}:${p2p_port_value}"
  else
    p2p_listen_address="${P2P_LISTEN_ADDRESS:-${SYNERGY_P2P_LISTEN_ADDRESS:-}}"
  fi

  if [[ -n "$public_host" && -n "$public_p2p_port" ]]; then
    p2p_external_address="${public_host}:${public_p2p_port}"
  else
    p2p_external_address="${P2P_EXTERNAL_ADDRESS:-${P2P_PUBLIC_ADDRESS:-${SYNERGY_P2P_EXTERNAL_ADDRESS:-${SYNERGY_P2P_PUBLIC_ADDRESS:-}}}}"
  fi

  if [[ -n "$rpc_port_value" ]]; then
    rpc_bind_address="${bind_ip}:${rpc_port_value}"
  fi

  if [[ -n "$discovery_port_value" ]]; then
    discovery_listen_address="${bind_ip}:${discovery_port_value}"
  else
    discovery_listen_address="${DISCOVERY_LISTEN_ADDRESS:-${SYNERGY_DISCOVERY_LISTEN_ADDRESS:-}}"
  fi

  if [[ -n "$public_host" && -n "$discovery_public_port" ]]; then
    discovery_external_address="${public_host}:${discovery_public_port}"
  else
    discovery_external_address="${DISCOVERY_EXTERNAL_ADDRESS:-${DISCOVERY_PUBLIC_ADDRESS:-${SYNERGY_DISCOVERY_EXTERNAL_ADDRESS:-${SYNERGY_DISCOVERY_PUBLIC_ADDRESS:-}}}}"
  fi

  RUNTIME_ENV_ARGS=(
    SYNERGY_VALIDATOR_ADDRESS="$validator_address"
    NODE_ADDRESS="$validator_address"
    SYNERGY_AUTO_REGISTER_VALIDATOR="$auto_register_validator"
    SYNERGY_STRICT_VALIDATOR_ALLOWLIST="$strict_allowlist"
    SYNERGY_ALLOWED_VALIDATOR_ADDRESSES="$allowed_validators"
    SYNERGY_RPC_BIND_ADDRESS="$rpc_bind_address"
    SYNERGY_NETWORK_ID="$configured_network_id"
    SYNERGY_CHAIN_ID="$configured_chain_id"
    SYNERGY_CONFIG_PATH="$config_path"
    SYNERGY_PROJECT_ROOT="$BASE_DIR"
  )

  if [[ -n "$p2p_port_value" ]]; then
    RUNTIME_ENV_ARGS+=(SYNERGY_P2P_PORT="$p2p_port_value")
  fi
  if [[ -n "$rpc_port_value" ]]; then
    RUNTIME_ENV_ARGS+=(SYNERGY_RPC_PORT="$rpc_port_value")
  fi
  if [[ -n "$ws_port_value" ]]; then
    RUNTIME_ENV_ARGS+=(SYNERGY_WS_PORT="$ws_port_value")
  fi
  if [[ -n "$grpc_port_value" ]]; then
    RUNTIME_ENV_ARGS+=(SYNERGY_GRPC_PORT="$grpc_port_value")
  fi
  if [[ -n "$p2p_listen_address" ]]; then
    RUNTIME_ENV_ARGS+=(SYNERGY_P2P_LISTEN_ADDRESS="$p2p_listen_address")
  fi
  if [[ -n "$p2p_external_address" ]]; then
    RUNTIME_ENV_ARGS+=(SYNERGY_P2P_EXTERNAL_ADDRESS="$p2p_external_address")
    RUNTIME_ENV_ARGS+=(SYNERGY_P2P_PUBLIC_ADDRESS="$p2p_external_address")
  fi
  if [[ -n "$discovery_port_value" ]]; then
    RUNTIME_ENV_ARGS+=(SYNERGY_DISCOVERY_PORT="$discovery_port_value")
  fi
  if [[ -n "$discovery_listen_address" ]]; then
    RUNTIME_ENV_ARGS+=(SYNERGY_DISCOVERY_LISTEN_ADDRESS="$discovery_listen_address")
  fi
  if [[ -n "$discovery_external_address" ]]; then
    RUNTIME_ENV_ARGS+=(SYNERGY_DISCOVERY_EXTERNAL_ADDRESS="$discovery_external_address")
    RUNTIME_ENV_ARGS+=(SYNERGY_DISCOVERY_PUBLIC_ADDRESS="$discovery_external_address")
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

  local config_path live_pid
  config_path="$BASE_DIR/config/node.toml"
  if command -v pgrep >/dev/null 2>&1; then
    live_pid="$(pgrep -f -o "$config_path" 2>/dev/null || true)"
    if [[ -n "$live_pid" ]]; then
      echo "$live_pid" > "$PID_FILE"
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
  build_runtime_env_args \
    "$validator_address" \
    "$auto_register_validator" \
    "$strict_allowlist" \
    "$allowed_validators" \
    "$rpc_bind_address" \
    "$configured_network_id" \
    "$configured_chain_id" \
    "$config_path"

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
      "${RUNTIME_ENV_ARGS[@]}" \
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
  build_runtime_env_args \
    "$validator_address" \
    "$auto_register_validator" \
    "$strict_allowlist" \
    "$allowed_validators" \
    "$rpc_bind_address" \
    "$configured_network_id" \
    "$configured_chain_id" \
    "$config_path"
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
    "${RUNTIME_ENV_ARGS[@]}" \
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

BIN_LINUX="$BASE_DIR/bin/synergy-testbeta-linux-amd64"
BIN_DARWIN="$BASE_DIR/bin/synergy-testbeta-darwin-arm64"
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

  local config_path live_pid
  config_path="$BASE_DIR/config/node.toml"
  if command -v pgrep >/dev/null 2>&1; then
    live_pid="$(pgrep -f -o "$config_path" 2>/dev/null || true)"
    if [[ -n "$live_pid" ]]; then
      echo "$live_pid" > "$PID_FILE"
      return 0
    fi
  fi

  return 1
}

start_node() {
  "$BASE_DIR/install_and_start.sh"
}

setup_node() {
  INSTALL_ONLY=true "$BASE_DIR/install_and_start.sh"
}

install_node() {
  INSTALL_ONLY=true "$BASE_DIR/install_and_start.sh"
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
  AUTO_START_AFTER_SYNC=true \
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
  rm -rf "$CHAIN_DIR" "$DATA_DIR/testbeta15/$NODE_SLOT_ID/chain" "$DATA_DIR/testbeta15/$NODE_SLOT_ID/logs"
  rm -f "$DATA_DIR/chain.json" "$DATA_DIR/token_state.json" "$DATA_DIR/validator_registry.json" "$DATA_DIR/synergy-testbeta.pid" "$DATA_DIR/.reset_flag" "$PID_FILE"
  mkdir -p "$CHAIN_DIR" "$LOG_DIR" "$DATA_DIR/testbeta15/$NODE_SLOT_ID/chain" "$DATA_DIR/testbeta15/$NODE_SLOT_ID/logs"
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
  echo "Inventory Address: ${MANAGEMENT_HOST:-not-set}"
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
  setup    Install the node locally but leave it offline.
  install_node
           Install the node locally but leave it offline.
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

function Initialize-NodeRuntimeEnv {
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

  $configuredChainId = Get-NodeEnvValue "SYNERGY_CHAIN_ID"
  if ([string]::IsNullOrWhiteSpace($configuredChainId)) { $configuredChainId = Get-NodeEnvValue "CHAIN_ID" }
  if ([string]::IsNullOrWhiteSpace($configuredChainId)) { $configuredChainId = "338639" }
  $env:SYNERGY_CHAIN_ID = $configuredChainId

  $configuredNetworkId = Get-NodeEnvValue "SYNERGY_NETWORK_ID"
  if ([string]::IsNullOrWhiteSpace($configuredNetworkId)) { $configuredNetworkId = Get-NodeEnvValue "NETWORK_ID" }
  if ([string]::IsNullOrWhiteSpace($configuredNetworkId)) { $configuredNetworkId = $configuredChainId }
  $env:SYNERGY_NETWORK_ID = $configuredNetworkId

  $bindIp = Get-NodeEnvValue "BIND_IP"
  $rpcBindAddress = Get-NodeEnvValue "RPC_BIND_ADDRESS"
  if ([string]::IsNullOrWhiteSpace($rpcBindAddress)) { $rpcBindAddress = Get-NodeEnvValue "SYNERGY_RPC_BIND_ADDRESS" }
  if ([string]::IsNullOrWhiteSpace($bindIp) -and -not [string]::IsNullOrWhiteSpace($rpcBindAddress)) {
    $bindIp = ($rpcBindAddress -split ':')[0]
  }
  if ([string]::IsNullOrWhiteSpace($bindIp)) { $bindIp = "0.0.0.0" }

  $p2pPort = Get-NodeEnvValue "P2P_PORT"
  if ([string]::IsNullOrWhiteSpace($p2pPort)) { $p2pPort = Get-NodeEnvValue "SYNERGY_P2P_PORT" }
  if (-not [string]::IsNullOrWhiteSpace($p2pPort)) {
    $env:SYNERGY_P2P_PORT = $p2pPort
  }

  $publicHost = Get-NodeEnvValue "NODE_PUBLIC_HOST"
  if ([string]::IsNullOrWhiteSpace($publicHost)) { $publicHost = Get-NodeEnvValue "HOSTNAME" }
  if ([string]::IsNullOrWhiteSpace($publicHost)) { $publicHost = Get-NodeEnvValue "HOST" }

  $publicP2PPort = Get-NodeEnvValue "PUBLIC_P2P_PORT"
  if ([string]::IsNullOrWhiteSpace($publicP2PPort)) { $publicP2PPort = Get-NodeEnvValue "P2P_PORT_EXTERNAL" }
  if ([string]::IsNullOrWhiteSpace($publicP2PPort)) { $publicP2PPort = $p2pPort }

  $p2pListenAddress = ""
  if (-not [string]::IsNullOrWhiteSpace($p2pPort)) {
    $p2pListenAddress = "${bindIp}:$p2pPort"
  } else {
    $p2pListenAddress = Get-NodeEnvValue "P2P_LISTEN_ADDRESS"
    if ([string]::IsNullOrWhiteSpace($p2pListenAddress)) { $p2pListenAddress = Get-NodeEnvValue "SYNERGY_P2P_LISTEN_ADDRESS" }
  }
  if (-not [string]::IsNullOrWhiteSpace($p2pListenAddress)) {
    $env:SYNERGY_P2P_LISTEN_ADDRESS = $p2pListenAddress
  }

  $p2pExternalAddress = ""
  if (-not [string]::IsNullOrWhiteSpace($publicHost) -and -not [string]::IsNullOrWhiteSpace($publicP2PPort)) {
    $p2pExternalAddress = "${publicHost}:$publicP2PPort"
  } else {
    $p2pExternalAddress = Get-NodeEnvValue "P2P_EXTERNAL_ADDRESS"
    if ([string]::IsNullOrWhiteSpace($p2pExternalAddress)) { $p2pExternalAddress = Get-NodeEnvValue "P2P_PUBLIC_ADDRESS" }
    if ([string]::IsNullOrWhiteSpace($p2pExternalAddress)) { $p2pExternalAddress = Get-NodeEnvValue "SYNERGY_P2P_EXTERNAL_ADDRESS" }
    if ([string]::IsNullOrWhiteSpace($p2pExternalAddress)) { $p2pExternalAddress = Get-NodeEnvValue "SYNERGY_P2P_PUBLIC_ADDRESS" }
  }
  if (-not [string]::IsNullOrWhiteSpace($p2pExternalAddress)) {
    $env:SYNERGY_P2P_EXTERNAL_ADDRESS = $p2pExternalAddress
    $env:SYNERGY_P2P_PUBLIC_ADDRESS = $p2pExternalAddress
  }

  $rpcPort = Get-NodeEnvValue "RPC_PORT"
  if ([string]::IsNullOrWhiteSpace($rpcPort)) { $rpcPort = Get-NodeEnvValue "SYNERGY_RPC_PORT" }
  if (-not [string]::IsNullOrWhiteSpace($rpcPort)) {
    $env:SYNERGY_RPC_PORT = $rpcPort
    $rpcBindAddress = "${bindIp}:$rpcPort"
  }
  if (-not [string]::IsNullOrWhiteSpace($rpcBindAddress)) {
    $env:SYNERGY_RPC_BIND_ADDRESS = $rpcBindAddress
  }

  $wsPort = Get-NodeEnvValue "WS_PORT"
  if ([string]::IsNullOrWhiteSpace($wsPort)) { $wsPort = Get-NodeEnvValue "SYNERGY_WS_PORT" }
  if (-not [string]::IsNullOrWhiteSpace($wsPort)) {
    $env:SYNERGY_WS_PORT = $wsPort
  }

  $grpcPort = Get-NodeEnvValue "GRPC_PORT"
  if ([string]::IsNullOrWhiteSpace($grpcPort)) { $grpcPort = Get-NodeEnvValue "SYNERGY_GRPC_PORT" }
  if (-not [string]::IsNullOrWhiteSpace($grpcPort)) {
    $env:SYNERGY_GRPC_PORT = $grpcPort
  }

  $discoveryPort = Get-NodeEnvValue "DISCOVERY_PORT"
  if ([string]::IsNullOrWhiteSpace($discoveryPort)) { $discoveryPort = Get-NodeEnvValue "SYNERGY_DISCOVERY_PORT" }
  if (-not [string]::IsNullOrWhiteSpace($discoveryPort)) {
    $env:SYNERGY_DISCOVERY_PORT = $discoveryPort
  }

  $discoveryListenAddress = ""
  if (-not [string]::IsNullOrWhiteSpace($discoveryPort)) {
    $discoveryListenAddress = "${bindIp}:$discoveryPort"
  } else {
    $discoveryListenAddress = Get-NodeEnvValue "DISCOVERY_LISTEN_ADDRESS"
    if ([string]::IsNullOrWhiteSpace($discoveryListenAddress)) { $discoveryListenAddress = Get-NodeEnvValue "SYNERGY_DISCOVERY_LISTEN_ADDRESS" }
  }
  if (-not [string]::IsNullOrWhiteSpace($discoveryListenAddress)) {
    $env:SYNERGY_DISCOVERY_LISTEN_ADDRESS = $discoveryListenAddress
  }

  $discoveryPublicPort = Get-NodeEnvValue "DISCOVERY_PORT_EXTERNAL"
  if ([string]::IsNullOrWhiteSpace($discoveryPublicPort)) { $discoveryPublicPort = $discoveryPort }

  $discoveryExternalAddress = ""
  if (-not [string]::IsNullOrWhiteSpace($publicHost) -and -not [string]::IsNullOrWhiteSpace($discoveryPublicPort)) {
    $discoveryExternalAddress = "${publicHost}:$discoveryPublicPort"
  } else {
    $discoveryExternalAddress = Get-NodeEnvValue "DISCOVERY_EXTERNAL_ADDRESS"
    if ([string]::IsNullOrWhiteSpace($discoveryExternalAddress)) { $discoveryExternalAddress = Get-NodeEnvValue "DISCOVERY_PUBLIC_ADDRESS" }
    if ([string]::IsNullOrWhiteSpace($discoveryExternalAddress)) { $discoveryExternalAddress = Get-NodeEnvValue "SYNERGY_DISCOVERY_EXTERNAL_ADDRESS" }
    if ([string]::IsNullOrWhiteSpace($discoveryExternalAddress)) { $discoveryExternalAddress = Get-NodeEnvValue "SYNERGY_DISCOVERY_PUBLIC_ADDRESS" }
  }
  if (-not [string]::IsNullOrWhiteSpace($discoveryExternalAddress)) {
    $env:SYNERGY_DISCOVERY_EXTERNAL_ADDRESS = $discoveryExternalAddress
    $env:SYNERGY_DISCOVERY_PUBLIC_ADDRESS = $discoveryExternalAddress
  }

  $env:SYNERGY_CONFIG_PATH = $ConfigPath
  $env:SYNERGY_PROJECT_ROOT = $BaseDir
}

function Test-Admin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$BinPath = Join-Path $BaseDir "bin/synergy-testbeta-windows-amd64.exe"
$ConfigPath = Join-Path $BaseDir "config/node.toml"
$DataDir = Join-Path $BaseDir "data"
$ChainDir = Join-Path $DataDir "chain"
$LogsDir = Join-Path $DataDir "logs"
$PidFile = Join-Path $DataDir "node.pid"
$OutFile = Join-Path $LogsDir "node.out"
$ErrFile = Join-Path $LogsDir "node.err"
$InstallStampFile = Join-Path $DataDir ".installed_at"
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
  $roleGroup = (Get-NodeEnvValue "ROLE_GROUP").ToLower()
  $nodeType = (Get-NodeEnvValue "NODE_TYPE").ToLower()
  return $roleGroup -eq "bootstrap" -or $nodeType -eq "bootnode"
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
    47990  # Testnet-Beta agent service port
  )
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
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $port | Out-Null
      }
    } catch {
      Write-Warning "Failed to create firewall rule for port ${port}: $_"
    }
  }
}

function Invoke-PreStartSync {
  if (Test-BootnodeSlot) { return $true }
  Initialize-NodeRuntimeEnv

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

function Set-NodeInstalled {
  if (-not (Test-Path $InstallStampFile)) {
    Set-Content -Path $InstallStampFile -Value (Get-Date -AsUTC -Format "yyyy-MM-ddTHH:mm:ssZ")
  }
}

function Initialize-InstallLayout {
  New-Item -ItemType Directory -Path $ChainDir -Force | Out-Null
  New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
  New-Item -ItemType File -Path $OutFile -Force | Out-Null
  New-Item -ItemType File -Path $ErrFile -Force | Out-Null
  Set-NodeInstalled
}

function Start-Node {
  if (Test-NodeRunning) {
    $currentPid = Get-Content $PidFile | Select-Object -First 1
    Write-Host "$($NodeEnv['NODE_SLOT_ID']) already running (PID $currentPid)"
    return
  }

  Apply-StagedBinary

  Initialize-InstallLayout
  Initialize-NodeRuntimeEnv

  $skipPrestartSync = $env:SKIP_PRESTART_SYNC -eq "true"
  if (-not $skipPrestartSync) {
    if (-not (Invoke-PreStartSync)) {
      if (Test-SyncRequired) {
        throw "Pre-start sync failed for $($NodeEnv['NODE_SLOT_ID']); refusing to start validator while unsynced."
      }
      Write-Warning "Pre-start sync did not complete for $($NodeEnv['NODE_SLOT_ID']); continuing with node start."
    }
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

if ($env:INSTALL_ONLY -eq "true") {
  Initialize-InstallLayout
  Write-Host "[$($NodeEnv['NODE_SLOT_ID'])] Install complete. Node remains offline until sync/start."
  exit 0
}

# SYNC_ONLY=true: run pre-start sync and exit without launching the node process.
# Used by nodectl.ps1 sync to let an operator explicitly catch up a late-joining
# node before starting it. AUTO_START_AFTER_SYNC=true promotes sync into the
# catch-up-and-start path for dashboard-driven node activation.
if ($env:SYNC_ONLY -eq "true") {
  Initialize-InstallLayout
  if (Invoke-PreStartSync) {
    if ($env:AUTO_START_AFTER_SYNC -eq "true") {
      Write-Host "[$($NodeEnv['NODE_SLOT_ID'])] Sync complete. Starting node automatically..."
      $env:SKIP_PRESTART_SYNC = "true"
      Start-Node
    } else {
      Write-Host "[$($NodeEnv['NODE_SLOT_ID'])] Sync complete. Node is ready for manual start."
    }
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
$InstallStampFile = Join-Path $DataDir ".installed_at"

function Test-NodeRunning {
  if (-not (Test-Path $PidFile)) { return $false }
  $pidValue = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $pidValue) { return $false }
  return $null -ne (Get-Process -Id $pidValue -ErrorAction SilentlyContinue)
}

function Start-Node { & (Join-Path $BaseDir "install_and_start.ps1") }
function Setup-Node {
  $env:INSTALL_ONLY = "true"
  & (Join-Path $BaseDir "install_and_start.ps1")
}
function Install-Node {
  $env:INSTALL_ONLY = "true"
  & (Join-Path $BaseDir "install_and_start.ps1")
}
function Bootstrap-Node { & (Join-Path $BaseDir "install_and_start.ps1") }

# Sync only — download all missing blocks from peers, then start the node when
# catch-up completes. Intended for late-joining nodes or nodes that have been
# offline for a long time.
function Sync-Node {
  $env:SYNC_ONLY = "true"
  $env:AUTO_START_AFTER_SYNC = "true"
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
    (Join-Path $DataDir "testbeta15\$($NodeEnv['NODE_SLOT_ID'])\chain"),
    (Join-Path $DataDir "testbeta15\$($NodeEnv['NODE_SLOT_ID'])\logs"),
    (Join-Path $DataDir "chain.json"),
    (Join-Path $DataDir "token_state.json"),
    (Join-Path $DataDir "validator_registry.json"),
    (Join-Path $DataDir "synergy-testbeta.pid"),
    (Join-Path $DataDir ".reset_flag"),
    $PidFile
  )) {
    if (Test-Path $target) {
      Remove-Item $target -Recurse -Force
    }
  }
  New-Item -ItemType Directory -Force -Path $ChainDir, $LogsDir | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $DataDir "testbeta15\$($NodeEnv['NODE_SLOT_ID'])\chain") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $DataDir "testbeta15\$($NodeEnv['NODE_SLOT_ID'])\logs") | Out-Null
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
  $binary = Get-ChildItem (Join-Path $BaseDir "bin") -Filter "synergy-testbeta*" -File -ErrorAction SilentlyContinue |
    Sort-Object Name |
    Select-Object -First 1 -ExpandProperty FullName
  Write-Host "Node Slot ID: $(Get-NodeEnvValue 'NODE_SLOT_ID')"
  Write-Host "Node ID: $(Get-NodeEnvValue 'NODE_ALIAS')"
  Write-Host "Role: $(Get-NodeEnvValue 'ROLE')"
  Write-Host "Node Type: $(Get-NodeEnvValue 'NODE_TYPE')"
  Write-Host "Address Class: $(Get-NodeEnvValue 'ADDRESS_CLASS')"
  Write-Host "Address: $(Get-NodeEnvValue 'NODE_ADDRESS')"
  Write-Host "Monitor Host: $(Get-NodeEnvValue 'MONITOR_HOST')"
  Write-Host "Inventory Address: $(Get-NodeEnvValue 'MANAGEMENT_HOST')"
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
Synergy Testnet-Beta Node Command Reference
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
./bin/synergy-testbeta-linux-amd64 start --config ./config/node.toml

macOS:
./bin/synergy-testbeta-darwin-arm64 start --config ./config/node.toml

Windows:
.\\bin\\synergy-testbeta-windows-amd64.exe start --config .\\config\\node.toml

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
Synergy Lean 15 Testnet-Beta Installer
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
- Windows firewall automation prompts for elevation when needed and otherwise prints the required TCP ports.
- This folder is self-contained for this node instance.
- Public DNS should resolve only to approved public hosts.
- See BINARY_STATUS.txt for bundled binary paths and SHA-256 checksums.
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
Synergy Testnet-Beta Binary Status
============================

Linux Binary
------------
Path: ./bin/synergy-testbeta-linux-amd64
SHA-256: $linux_sha

Darwin Binary
-------------
Path: ./bin/synergy-testbeta-darwin-arm64
SHA-256: $darwin_sha

Windows Binary
--------------
Path: ./bin/synergy-testbeta-windows-amd64.exe
SHA-256: $windows_sha

Interpretation
--------------
- These checksums reflect the exact bundled binaries shipped in this installer.
TXT
}

write_companion_peers_config() {
  local node_config_path="$1"
  local peers_config_path="$2"

  python3 - "$node_config_path" "$peers_config_path" <<'PY'
import ast
import json
import pathlib
import re
import sys

node_config_path = pathlib.Path(sys.argv[1])
peers_config_path = pathlib.Path(sys.argv[2])
node_config = node_config_path.read_text(encoding="utf-8")

def read_array(key):
    match = re.search(rf'^[ \t]*{re.escape(key)}[ \t]*=[ \t]*(\[[^\n]*\])', node_config, re.MULTILINE)
    if not match:
        return []
    try:
        value = ast.literal_eval(match.group(1))
    except Exception:
        return []
    if isinstance(value, list):
        return [str(item) for item in value]
    return []

bootnodes = read_array("bootnodes")
seed_servers = read_array("seed_servers")
bootstrap_dns_records = read_array("bootstrap_dns_records")
additional_dial_targets = read_array("additional_dial_targets")
persistent_peers = read_array("persistent_peers") or list(additional_dial_targets)

def render_array(values):
    return "[" + ", ".join(json.dumps(str(value)) for value in values) + "]"

content = "\n".join(
    [
        "# Auto-generated by scripts/testbeta/build-node-installers.sh",
        "[global]",
        f"bootnodes = {render_array(bootnodes)}",
        f"seed_servers = {render_array(seed_servers)}",
        f"bootstrap_dns_records = {render_array(bootstrap_dns_records)}",
        f"additional_dial_targets = {render_array(additional_dial_targets)}",
        f"persistent_peers = {render_array(persistent_peers)}",
        "",
        "[testbeta]",
        'core_rpc = "https://testbeta-core-rpc.synergynode.xyz"',
        'core_ws = "wss://testbeta-core-ws.synergynode.xyz"',
        'wallet_api = "https://testbeta-wallet-api.synergy-network.io"',
        'sxcp_api = "https://testbeta-sxcp-api.synergy-network.io"',
        "",
        "[security]",
        "strict_tls = true",
        "allow_unpinned_dev_endpoints = false",
        "bootstrap_connectivity_required = false",
        "",
    ]
)

peers_config_path.write_text(content, encoding="utf-8")
PY
}

append_source_env_key_if_present() {
  local node_dir="$1"
  local env_file="$2"
  local key="$3"

  [[ -n "$env_file" && -f "$env_file" ]] || return 0
  if ! testbeta_env_has_key "$env_file" "$key"; then
    return 0
  fi

  local value
  value="$(testbeta_env_value "$env_file" "$key" || true)"
  printf '%s=%s\n' "$key" "$value" >> "$node_dir/node.env"
}

lookup_node_address() {
  local node_slot_id="$1"
  [[ -f "$NODE_ADDRESSES_FILE" ]] || return 1
  awk -F, -v id="$node_slot_id" 'NR > 1 && $1 == id { print $6; exit }' "$NODE_ADDRESSES_FILE"
}

resolve_setup_package_file() {
  local node_slot_id="$1"
  local node_type="$2"
  local role="$3"
  local node_alias="${4:-}"

  if declare -F testbeta_setup_package_file_for_inventory_node >/dev/null 2>&1; then
    testbeta_setup_package_file_for_inventory_node "$node_slot_id" "$node_type" "$role" "$node_alias" || true
  fi
}

lookup_address_from_setup_package() {
  local package_file="$1"
  [[ -n "$package_file" && -f "$package_file" ]] || return 1

  python3 - "$package_file" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    package = json.load(handle)

runtime_identity = package.get("runtime_identity") or {}
validator_public = package.get("validator_public") or {}
address = str(runtime_identity.get("address") or validator_public.get("address") or "").strip()
if address:
    print(address)
PY
}

populate_validator_keys_from_setup_package() {
  local package_file="$1"
  local key_dir="$2"
  local manifest_file="$3"
  local node_slot_id="$4"
  local node_alias="$5"
  local role="$6"
  local node_type="$7"
  local address_class="$8"

  python3 - "$package_file" "$GENESIS_FILE" "$manifest_file" "$key_dir" "$node_slot_id" "$node_alias" "$role" "$node_type" "$address_class" <<'PY'
import json
import pathlib
import sys

package_file, canonical_genesis_file, canonical_manifest_file, key_dir, node_slot_id, node_alias, role, node_type, address_class = sys.argv[1:]

with open(package_file, encoding="utf-8") as handle:
    package = json.load(handle)

with open(canonical_genesis_file, encoding="utf-8") as handle:
    canonical_genesis = json.load(handle)

with open(canonical_manifest_file, encoding="utf-8") as handle:
    canonical_manifest = json.load(handle)

def replace_strings(value):
    if isinstance(value, dict):
        return {key: replace_strings(item) for key, item in value.items()}
    if isinstance(value, list):
        return [replace_strings(item) for item in value]
    if isinstance(value, str):
        return (
            value
            .replace("testbeta-core-rpc.synergy-network.io", "testbeta-core-rpc.synergynode.xyz")
            .replace("testbeta-core-ws.synergy-network.io", "testbeta-core-ws.synergynode.xyz")
            .replace("synergynode.xyz:5623", "synergynode.xyz:5622")
            .replace("synergynode.xyz:5624", "synergynode.xyz:5622")
        )
    return value

artifacts = package.get("artifacts")
if not isinstance(artifacts, dict):
    artifacts = {}
    package["artifacts"] = artifacts
artifacts["genesis"] = canonical_genesis
artifacts["operational_manifest"] = canonical_manifest

package["network_id"] = canonical_manifest.get("network_id", package.get("network_id"))
package["chain_id"] = canonical_manifest.get("chain_id", package.get("chain_id"))

canonical_ports = canonical_manifest.get("ports") or {}
assigned_ports = package.get("assigned_ports")
if not isinstance(assigned_ports, dict):
    assigned_ports = {}
    package["assigned_ports"] = assigned_ports
assigned_ports["p2p_port"] = canonical_ports.get("node_listener_base", assigned_ports.get("p2p_port"))
assigned_ports["rpc_port"] = canonical_ports.get("rpc_base", assigned_ports.get("rpc_port"))
assigned_ports["ws_port"] = canonical_ports.get("ws_base", assigned_ports.get("ws_port"))
assigned_ports["grpc_port"] = canonical_ports.get("rpc_base", assigned_ports.get("grpc_port"))
assigned_ports["discovery_port"] = canonical_ports.get("discovery_base", assigned_ports.get("discovery_port"))
assigned_ports["metrics_port"] = canonical_ports.get("metrics_base", assigned_ports.get("metrics_port"))

package = replace_strings(package)

runtime_identity = package.get("runtime_identity") or {}
validator_public = package.get("validator_public") or {}
node_identity = validator_public.get("node_identity_key") or {}
consensus_key = validator_public.get("consensus_key") or {}
account_key = validator_public.get("account_key") or {}
entropy_key = validator_public.get("entropy_contribution_key") or {}

address = str(runtime_identity.get("address") or validator_public.get("address") or "").strip()
public_key = str(runtime_identity.get("public_key") or validator_public.get("public_key") or "").strip()
private_key = str(runtime_identity.get("private_key") or "").strip()

if not address:
    raise SystemExit(f"Missing runtime address in setup package: {package_file}")
if not public_key:
    raise SystemExit(f"Missing runtime public key in setup package: {package_file}")
if not private_key:
    raise SystemExit(f"Missing runtime private key in setup package: {package_file}")

mesh_peers = []
for entry in canonical_manifest.get("validators", []):
    slot = entry.get("slot")
    peer_address = str(entry.get("address") or "").strip()
    if slot is None or not peer_address or peer_address == address:
        continue
    mesh_peers.append(f"snr://{peer_address}@genesisval{slot}.synergynode.xyz:5622")

runtime_config = package.get("runtime_config")
if not isinstance(runtime_config, dict):
    runtime_config = {}
    package["runtime_config"] = runtime_config

network_config = runtime_config.get("network")
if not isinstance(network_config, dict):
    network_config = {}
    runtime_config["network"] = network_config
network_config["additional_dial_targets"] = mesh_peers
network_config["persistent_peers"] = mesh_peers

consensus_config = runtime_config.get("consensus")
if not isinstance(consensus_config, dict):
    consensus_config = {}
    runtime_config["consensus"] = consensus_config
consensus_config.update({
    "min_validators": 4,
    "validator_vote_threshold": 3,
    "max_validators": 5,
    "status_ready_gate_enabled": True,
    "status_ready_min_validators": 3,
    "status_ready_genesis_grace_secs": 15,
    "allow_genesis_status_bypass": True,
    "mesh_settle_secs": 3,
    "leader_timeout_secs": 15,
    "vote_timeout_secs": 12,
    "block_timeout_secs": 10,
})

out_dir = pathlib.Path(key_dir)
out_dir.mkdir(parents=True, exist_ok=True)

(out_dir / "address.txt").write_text(address + "\n", encoding="utf-8")
(out_dir / "public.key").write_text(public_key + "\n", encoding="utf-8")
(out_dir / "private.key").write_text(private_key + "\n", encoding="utf-8")

node_env = "\n".join([
    f"NODE_SLOT_ID={node_slot_id}",
    f"NODE_ALIAS={node_alias}",
    f"ROLE={role}",
    f"NODE_TYPE={node_type}",
    f"ADDRESS_CLASS={address_class}",
    f"NODE_ADDRESS={address}",
    "PUBLIC_KEY_FILE=public.key",
    "PRIVATE_KEY_FILE=private.key",
    "",
])
(out_dir / "node.env").write_text(node_env, encoding="utf-8")

identity_payload = {
    "node_slot_id": node_slot_id,
    "node_alias": node_alias,
    "role": role,
    "node_type": node_type,
    "address_class": int(address_class) if str(address_class).isdigit() else address_class,
    "runtime_identity": runtime_identity,
    "validator_public": validator_public,
}
(out_dir / "identity.json").write_text(json.dumps(identity_payload, indent=2) + "\n", encoding="utf-8")

identity_toml = [
    f'node_slot_id = "{node_slot_id}"',
    f'node_alias = "{node_alias}"',
    f'role = "{role}"',
    f'node_type = "{node_type}"',
    f'address_class = {address_class}',
    "",
    "[runtime_identity]",
    f'label = "{runtime_identity.get("label", "")}"',
    f'address = "{address}"',
    f'address_type = "{runtime_identity.get("address_type", validator_public.get("address_type", ""))}"',
    f'algorithm = "{runtime_identity.get("algorithm", validator_public.get("algorithm", ""))}"',
    f'created_at = "{runtime_identity.get("created_at", validator_public.get("created_at", ""))}"',
    f'public_key = "{public_key}"',
    f'private_key = "{private_key}"',
    "",
    "[node_identity_key]",
    f'algorithm = "{node_identity.get("algorithm", "")}"',
    f'public_key = "{node_identity.get("public_key", "")}"',
    f'peer_id = "{node_identity.get("peer_id", "")}"',
    "",
    "[consensus_key]",
    f'algorithm = "{consensus_key.get("algorithm", "")}"',
    f'public_key = "{consensus_key.get("public_key", "")}"',
    "",
    "[account_key]",
    f'algorithm = "{account_key.get("algorithm", "")}"',
    f'public_key = "{account_key.get("public_key", "")}"',
    "",
    "[entropy_contribution_key]",
    f'algorithm = "{entropy_key.get("algorithm", "")}"',
    f'public_key = "{entropy_key.get("public_key", "")}"',
    "",
]
(out_dir / "identity.toml").write_text("\n".join(identity_toml), encoding="utf-8")
(out_dir / "setup-package.json").write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")
PY
}

resolve_key_source_dir() {
  local node_slot_id="$1"
  local node_type="$2"
  local candidate="$KEYS_DIR/$node_slot_id"
  local legacy_key_dir=""

  if [[ -d "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  if declare -F testbeta_legacy_key_dir_for_inventory_node >/dev/null 2>&1; then
    legacy_key_dir="$(testbeta_legacy_key_dir_for_inventory_node "$node_slot_id" || true)"
  fi
  if [[ -n "$legacy_key_dir" && -d "$KEYS_DIR/$legacy_key_dir" ]]; then
    printf '%s\n' "$KEYS_DIR/$legacy_key_dir"
    return 0
  fi

  if [[ "$(printf '%s' "$node_type" | tr '[:upper:]' '[:lower:]')" == "bootnode" ]]; then
    return 1
  fi

  echo "Missing key directory for $node_slot_id" >&2
  return 1
}

write_key_metadata() {
  local key_dir="$1"
  local node_slot_id="$2"
  local node_alias="$3"
  local role="$4"
  local node_type="$5"
  local address_class="$6"
  local address="$7"
  local public_key private_key

  public_key="$(tr -d '\r\n' < "$key_dir/public.key" 2>/dev/null || true)"
  private_key="$(tr -d '\r\n' < "$key_dir/private.key" 2>/dev/null || true)"

  printf '%s\n' "$address" > "$key_dir/address.txt"

  cat > "$key_dir/node.env" <<EOF
NODE_SLOT_ID=$node_slot_id
NODE_ALIAS=$node_alias
ROLE=$role
NODE_TYPE=$node_type
ADDRESS_CLASS=$address_class
NODE_ADDRESS=$address
PUBLIC_KEY_FILE=public.key
PRIVATE_KEY_FILE=private.key
EOF

  cat > "$key_dir/identity.json" <<EOF
{
  "node_slot_id": "$node_slot_id",
  "node_alias": "$node_alias",
  "role": "$role",
  "node_type": "$node_type",
  "address_class": $address_class,
  "address": "$address",
  "public_key": "$public_key",
  "private_key": "$private_key"
}
EOF

  cat > "$key_dir/identity.toml" <<EOF
node_slot_id = "$node_slot_id"
node_alias = "$node_alias"
role = "$role"
node_type = "$node_type"
address_class = $address_class

[address]
value = "$address"

[keys]
public_key = "$public_key"
private_key = "$private_key"
EOF
}

ALLOWED_VALIDATOR_ADDRESSES_CSV="$(collect_allowlisted_validators_csv)"

while IFS=, read -r node_slot_id node_alias role_group role node_type address_class p2p_port rpc_port ws_port grpc_port discovery_port host management_host physical_machine_id auto_register enable_pruning vrf_enabled operator device operating_system public_ip local_ip || [[ -n "${node_slot_id:-}" ]]; do
  [[ "$node_slot_id" == "node_slot_id" ]] && continue
  if [[ "$(printf '%s' "$node_type" | tr '[:upper:]' '[:lower:]')" == "bootnode" ]]; then
    continue
  fi

  source_env_file="$(testbeta_env_file_for_inventory_node "$node_slot_id" "$node_type" "" "$host" || true)"
  setup_package_file="$(resolve_setup_package_file "$node_slot_id" "$node_type" "$role" "$node_alias")"
  key_source_dir=""
  if [[ "$(printf '%s' "$node_type" | tr '[:upper:]' '[:lower:]')" != "validator" || -z "$setup_package_file" ]]; then
    key_source_dir="$(resolve_key_source_dir "$node_slot_id" "$node_type")"
  fi
  validator_address="$(testbeta_first_nonempty \
    "$(testbeta_env_value "$source_env_file" "NODE_WALLET" || true)" \
    "$(lookup_node_address "$node_slot_id" || true)" \
    "$(lookup_address_from_setup_package "$setup_package_file" || true)" \
    "$( [[ -n "$key_source_dir" && -f "$key_source_dir/address.txt" ]] && cat "$key_source_dir/address.txt" || true )" \
  )"
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
    "$public_ip" \
    "$local_ip" \
    "$management_host" \
    "$host" \
  )"

  auto_register="$(normalize_bool "$auto_register")"
  enable_pruning="$(normalize_bool "$enable_pruning")"
  vrf_enabled="$(normalize_bool "$vrf_enabled")"

  node_dir="$OUT_DIR/$node_slot_id"
  rm -rf "$node_dir"
  mkdir -p "$node_dir/bin" "$node_dir/config" "$node_dir/keys"

  cp "$LINUX_BINARY" "$node_dir/bin/synergy-testbeta-linux-amd64"
  cp "$DARWIN_BINARY" "$node_dir/bin/synergy-testbeta-darwin-arm64"
  cp "$WINDOWS_BINARY" "$node_dir/bin/synergy-testbeta-windows-amd64.exe"
  chmod +x "$node_dir/bin/synergy-testbeta-linux-amd64" "$node_dir/bin/synergy-testbeta-darwin-arm64"

  cp "$CONFIG_DIR/${node_slot_id}.toml" "$node_dir/config/node.toml"
  cp "$GENESIS_FILE" "$node_dir/config/genesis.json"
  write_companion_peers_config "$node_dir/config/node.toml" "$node_dir/config/peers.toml"
  if [[ "$(printf '%s' "$node_type" | tr '[:upper:]' '[:lower:]')" == "validator" && -n "$setup_package_file" ]]; then
    populate_validator_keys_from_setup_package \
      "$setup_package_file" \
      "$node_dir/keys" \
      "$MANIFEST_FILE" \
      "$node_slot_id" \
      "$node_alias" \
      "$role" \
      "$node_type" \
      "$address_class"
  else
    cp "$key_source_dir"/* "$node_dir/keys/"
  fi

  public_address="$(awk -F'"' '/^[[:space:]]*public_address[[:space:]]*=/ { print $2; exit }' "$node_dir/config/node.toml")"
  listen_address="$(awk -F'"' '/^[[:space:]]*listen_address[[:space:]]*=/ { print $2; exit }' "$node_dir/config/node.toml")"
  discovery_listen_address="$(awk -F'"' '/^[[:space:]]*discovery_listen_address[[:space:]]*=/ { print $2; exit }' "$node_dir/config/node.toml")"
  discovery_public_address="$(awk -F'"' '/^[[:space:]]*discovery_public_address[[:space:]]*=/ { print $2; exit }' "$node_dir/config/node.toml")"
  rpc_bind_address="$(awk -F'"' '/^[[:space:]]*bind_address[[:space:]]*=/ { print $2; exit }' "$node_dir/config/node.toml")"
  public_host="${public_address%:*}"
  public_p2p_port="${public_address##*:}"
  if [[ -z "$public_address" || -z "$public_host" || -z "$public_p2p_port" ]]; then
    public_host="$host"
    public_p2p_port="$p2p_port"
  fi
  if [[ -z "$listen_address" ]]; then
    listen_address="0.0.0.0:${p2p_port}"
  fi
  if [[ -z "$discovery_listen_address" ]]; then
    discovery_listen_address="0.0.0.0:${discovery_port}"
  fi
  if [[ -z "$discovery_public_address" ]]; then
    discovery_public_address="${public_host}:${discovery_port}"
  fi
  bind_host="${rpc_bind_address%:*}"
  if [[ -z "$rpc_bind_address" || -z "$bind_host" ]]; then
    bind_host="$(testbeta_first_nonempty "$bind_ip" "$local_ip" "$management_host" "$public_host")"
    rpc_bind_address="${bind_host}:${rpc_port}"
  fi

  cat > "$node_dir/node.env" <<ENV
NODE_SLOT_ID=$node_slot_id
NODE_ALIAS=$node_alias
ROLE_GROUP=$role_group
ROLE=$role
NODE_TYPE=$node_type
ADDRESS_CLASS=$address_class
NODE_ADDRESS=$validator_address
SYNERGY_VALIDATOR_ADDRESS=$validator_address
HOSTNAME=$public_host
NODE_HOSTNAME=$public_host
PUBLIC_IP=$public_ip
LOCAL_IP=$local_ip
BIND_IP=$bind_host
P2P_PORT=$p2p_port
P2P_LISTEN_ADDRESS=$listen_address
PUBLIC_P2P_PORT=$public_p2p_port
P2P_EXTERNAL_ADDRESS=$public_address
P2P_PUBLIC_ADDRESS=$public_address
RPC_PORT=$rpc_port
WS_PORT=$ws_port
GRPC_PORT=$grpc_port
DISCOVERY_PORT=$discovery_port
DISCOVERY_LISTEN_ADDRESS=$discovery_listen_address
DISCOVERY_EXTERNAL_ADDRESS=$discovery_public_address
DISCOVERY_PUBLIC_ADDRESS=$discovery_public_address
HOST=$public_host
NODE_PUBLIC_HOST=$public_host
NODE_PUBLIC_IP=$public_ip
MONITOR_HOST=$management_host
MANAGEMENT_HOST=$management_host
NETWORK_TRANSPORT=public
CHAIN_ID=$TESTBETA_CHAIN_ID
NETWORK_ID=$TESTBETA_NETWORK_ID
AUTO_REGISTER_VALIDATOR=$auto_register
ENABLE_PRUNING=$enable_pruning
VRF_ENABLED=$vrf_enabled
STRICT_VALIDATOR_ALLOWLIST=true
ALLOWED_VALIDATOR_ADDRESSES=$ALLOWED_VALIDATOR_ADDRESSES_CSV
RPC_BIND_ADDRESS=$rpc_bind_address
SYNERGY_CHAIN_ID=$TESTBETA_CHAIN_ID
SYNERGY_NETWORK_ID=$TESTBETA_NETWORK_ID
SYNERGY_P2P_LISTEN_ADDRESS=$listen_address
SYNERGY_P2P_EXTERNAL_ADDRESS=$public_address
SYNERGY_P2P_PUBLIC_ADDRESS=$public_address
SYNERGY_DISCOVERY_PORT=$discovery_port
SYNERGY_DISCOVERY_LISTEN_ADDRESS=$discovery_listen_address
SYNERGY_DISCOVERY_EXTERNAL_ADDRESS=$discovery_public_address
SYNERGY_DISCOVERY_PUBLIC_ADDRESS=$discovery_public_address
SYNERGY_AUTO_REGISTER_VALIDATOR=$auto_register
SYNERGY_STRICT_VALIDATOR_ALLOWLIST=true
SYNERGY_ALLOWED_VALIDATOR_ADDRESSES=$ALLOWED_VALIDATOR_ADDRESSES_CSV
SYNERGY_RPC_BIND_ADDRESS=$rpc_bind_address
SYNERGY_CONFIG_PATH=config/node.toml
ENV

  for extra_key in \
    NETWORK_NAME \
    NODE_ID \
    NODE_ROLE \
    ADVERTISE_IP \
    P2P_PORT_EXTERNAL \
    DISCOVERY_PORT_EXTERNAL \
    METRICS_PORT \
    INDEXER_INGEST_PORT \
    INDEXER_API_PORT \
    EXPLORER_API_PORT \
    INDEXER_WS_PORT \
    INDEXER_WS_HOSTNAME \
    POSTGRES_HOST \
    POSTGRES_PORT \
    POSTGRES_DB \
    POSTGRES_USER \
    POSTGRES_PASSWORD \
    POSTGRES_SSLMODE \
    NGINX_HTTP_PORT \
    NGINX_HTTPS_PORT \
    DATA_DIR \
    CONFIG_DIR \
    LOG_DIR \
    NODE_KEY_PATH \
    RPC_FALLBACK_URL \
    RPC_HOSTNAME \
    BOOTNODES
  do
    append_source_env_key_if_present "$node_dir" "$source_env_file" "$extra_key"
  done

  if [[ "$(printf '%s' "$node_type" | tr '[:upper:]' '[:lower:]')" == "validator" && -n "$setup_package_file" ]]; then
    printf '%s\n' "$validator_address" > "$node_dir/keys/address.txt"
  else
    write_key_metadata "$node_dir/keys" "$node_slot_id" "$node_alias" "$role" "$node_type" "$address_class" "$validator_address"
  fi

  write_install_script "$node_dir"
  write_nodectl_script "$node_dir"
  write_install_ps1 "$node_dir"
  write_nodectl_ps1 "$node_dir"
  write_commands_file "$node_dir" "$node_slot_id" "$node_type" "$p2p_port" "$rpc_port" "$ws_port" "$grpc_port" "$discovery_port"
  write_readme "$node_dir" "$node_slot_id" "$role_group" "$role" "$node_type" \
    "$LINUX_BINARY_SOURCE" "$DARWIN_BINARY_SOURCE" "$WINDOWS_BINARY_SOURCE"
  write_binary_status_file "$node_dir" "$LINUX_BINARY_SOURCE" "$DARWIN_BINARY_SOURCE" "$WINDOWS_BINARY_SOURCE" \
    "$(sha256_file "$node_dir/bin/synergy-testbeta-linux-amd64")" \
    "$(sha256_file "$node_dir/bin/synergy-testbeta-darwin-arm64")" \
    "$(sha256_file "$node_dir/bin/synergy-testbeta-windows-amd64.exe")"

  echo "Built installer: $node_dir"
done < "$INVENTORY_FILE"

echo "All node installers generated in: $OUT_DIR"
