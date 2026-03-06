#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INVENTORY_FILE="$ROOT_DIR/devnet/lean15/node-inventory.csv"
HOSTS_ENV_FILE="${SYNERGY_MONITOR_HOSTS_ENV:-$ROOT_DIR/devnet/lean15/hosts.env}"
INSTALLERS_DIR="$ROOT_DIR/devnet/lean15/installers"
WIREGUARD_CONFIGS_DIR="${SYNERGY_WIREGUARD_CONFIGS_DIR:-$ROOT_DIR/devnet/lean15/wireguard/configs}"
REMOTE_ROOT_DEFAULT="${SYNERGY_REMOTE_ROOT:-/opt/synergy}"
REMOTE_EXPORTS_DIR="$ROOT_DIR/devnet/lean15/reports/remote-exports"

usage() {
  cat <<USAGE
Usage: $0 <machine-id> <operation>

Core Operations:
  install_node          Copy installer bundle to remote machine
  setup_node            Deploy installer bundle and run install_and_start.sh
  bootstrap_node        install_node + wireguard_install + wireguard_connect + start
  reset_chain           Stop node, delete ALL chain state, redeploy config, restart from genesis
  start                 nodectl start
  stop                  nodectl stop
  restart               nodectl restart
  status                nodectl status
  logs                  tail nodectl logs (last 120 lines)
  export_logs           Download logs archive from remote machine to local reports dir
  view_chain_data       Show chain data size and top files on remote machine
  export_chain_data     Download chain data archive from remote machine to local reports dir
  wireguard_status      Show WireGuard mesh VPN status, peer reachability, and transfer stats
  wireguard_install     Install wireguard tooling on remote machine (best-effort)
  wireguard_connect     Upload WireGuard config and bring tunnel up
  wireguard_disconnect  Bring tunnel down
  wireguard_restart     Reapply WireGuard config (down/up)

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

WireGuard operation requires:
  - devnet/lean15/wireguard/configs/<machine-id>.conf
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

HOST_VAR="${MACHINE_KEY_UPPER}_HOST"
VPN_VAR="${MACHINE_KEY_UPPER}_VPN_IP"
SSH_USER_VAR="${MACHINE_KEY_UPPER}_SSH_USER"
SSH_PORT_VAR="${MACHINE_KEY_UPPER}_SSH_PORT"
SSH_KEY_VAR="${MACHINE_KEY_UPPER}_SSH_KEY"
REMOTE_DIR_VAR="${MACHINE_KEY_UPPER}_REMOTE_DIR"
WG_INTERFACE_VAR="${MACHINE_KEY_UPPER}_WG_INTERFACE"
WG_REMOTE_CONF_VAR="${MACHINE_KEY_UPPER}_WG_REMOTE_CONF"

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

WG_INTERFACE="$(resolve_var "$WG_INTERFACE_VAR")"
if [[ -z "$WG_INTERFACE" ]]; then
  WG_INTERFACE="${SYNERGY_DEVNET_WG_INTERFACE:-wg0}"
fi

WG_REMOTE_CONF="$(resolve_var "$WG_REMOTE_CONF_VAR")"
if [[ -z "$WG_REMOTE_CONF" ]]; then
  WG_REMOTE_CONF="${SYNERGY_DEVNET_WG_REMOTE_CONF:-/etc/wireguard/${WG_INTERFACE}.conf}"
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
WG_CONFIG_FILE="$WIREGUARD_CONFIGS_DIR/$NODE_SLOT_ID.conf"

remote_run_script() {
  local script="$1"
  if [[ "$IS_LOCAL_TARGET" -eq 1 ]]; then
    bash -s <<<"$script"
  else
    ssh "${SSH_ARGS[@]}" "$REMOTE_TARGET" "bash -s" <<<"$script"
  fi
}

resolve_remote_wireguard_interface() {
  local desired_interface="$1"
  local resolved_interface

  resolved_interface="$(
    remote_run_script "
set -euo pipefail
desired='$desired_interface'
if ! command -v wg >/dev/null 2>&1; then
  printf '%s\n' \"\$desired\"
  exit 0
fi
interfaces=\$(wg show interfaces 2>/dev/null || true)
if [[ -z \"\$interfaces\" ]]; then
  if [[ \"\$desired\" == \"synergy-devnet\" ]]; then
    printf 'wg0\n'
  else
    printf '%s\n' \"\$desired\"
  fi
  exit 0
fi
if printf '%s' \"\$interfaces\" | tr ' ' '\n' | grep -Fxq \"\$desired\"; then
  printf '%s\n' \"\$desired\"
elif printf '%s' \"\$interfaces\" | tr ' ' '\n' | grep -Fxq 'wg0'; then
  printf 'wg0\n'
else
  printf '%s\n' \"\$(printf '%s' \"\$interfaces\" | tr ' ' '\n' | sed '/^$/d' | head -n1)\"
fi
" 2>/dev/null | tr -d '\r' | tail -n1
  )"

  if [[ -z "$resolved_interface" ]]; then
    resolved_interface="$desired_interface"
  fi

  printf '%s' "$resolved_interface"
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

# Recreate the directory skeleton the node binary expects.
mkdir -p data/chain data/devnet15/'$NODE_SLOT_ID'/chain data/devnet15/'$NODE_SLOT_ID'/logs data/logs
echo 'Cleared all chain state for $NODE_SLOT_ID in $REMOTE_NODE_DIR — node will start from genesis.'
"

  # Re-deploy the installer bundle so the node picks up the latest
  # configs and genesis parameters before restarting.
  if [[ -d "$INSTALLER_DIR" ]]; then
    deploy_installer_bundle
  fi

  run_nodectl "start"
  run_nodectl "status" || true
}

wireguard_install() {
  remote_run_script "
set -euo pipefail

# ── Step 1: Install WireGuard tools if missing ──
if ! command -v wg >/dev/null 2>&1 || ! command -v wg-quick >/dev/null 2>&1; then
  echo 'Installing WireGuard tools...'
  if command -v apt-get >/dev/null 2>&1; then
    if command -v sudo >/dev/null 2>&1; then sudo apt-get update -y && sudo apt-get install -y wireguard wireguard-tools; else apt-get update -y && apt-get install -y wireguard wireguard-tools; fi
  elif command -v dnf >/dev/null 2>&1; then
    if command -v sudo >/dev/null 2>&1; then sudo dnf install -y wireguard-tools; else dnf install -y wireguard-tools; fi
  elif command -v yum >/dev/null 2>&1; then
    if command -v sudo >/dev/null 2>&1; then sudo yum install -y wireguard-tools; else yum install -y wireguard-tools; fi
  elif command -v pacman >/dev/null 2>&1; then
    if command -v sudo >/dev/null 2>&1; then sudo pacman -Sy --noconfirm wireguard-tools; else pacman -Sy --noconfirm wireguard-tools; fi
  elif command -v brew >/dev/null 2>&1; then
    brew list wireguard-tools >/dev/null 2>&1 || brew install wireguard-tools
  else
    echo 'Unable to install wireguard-tools automatically (unsupported package manager).' >&2
    exit 1
  fi
else
  echo 'WireGuard tools already installed.'
fi

# ── Step 2: Import existing WireGuard config if present ──
# Search known locations for an existing wg0.conf and install it
# to /etc/wireguard/ so that wireguard_connect and other functions work.
EXISTING_CONF=''
SEARCH_PATHS=(
  \"\$HOME/wireguard/wg0.conf\"
  '/etc/wireguard/wg0.conf'
  '/opt/wireguard/wg0.conf'
  '/usr/local/etc/wireguard/wg0.conf'
  'C:/WireGuard/wg0.conf'
  'C:/Program Files/WireGuard/Data/Configurations/wg0.conf.dpapi'
)
for candidate in \"\${SEARCH_PATHS[@]}\"; do
  if [[ -f \"\$candidate\" ]]; then
    EXISTING_CONF=\"\$candidate\"
    break
  fi
done

if [[ -n \"\$EXISTING_CONF\" ]]; then
  echo \"Found existing WireGuard config at: \$EXISTING_CONF\"
  TARGET='/etc/wireguard/wg0.conf'
  # Only copy if the config isn't already at the target location
  if [[ \"\$EXISTING_CONF\" != \"\$TARGET\" ]]; then
    if command -v sudo >/dev/null 2>&1; then
      sudo mkdir -p /etc/wireguard
      sudo install -m 600 \"\$EXISTING_CONF\" \"\$TARGET\"
    else
      mkdir -p /etc/wireguard
      install -m 600 \"\$EXISTING_CONF\" \"\$TARGET\"
    fi
    echo \"Imported WireGuard config to \$TARGET\"
  else
    echo \"Config already at \$TARGET — no import needed.\"
  fi
  # Bring up the interface if it's not already running
  if command -v wg-quick >/dev/null 2>&1; then
    IFACE='wg0'
    if command -v sudo >/dev/null 2>&1; then
      if ! sudo wg show \"\$IFACE\" >/dev/null 2>&1; then
        echo \"Bringing up WireGuard interface \$IFACE...\"
        sudo wg-quick up \"\$IFACE\" || echo \"Warning: failed to bring up \$IFACE (may need manual config).\"
      else
        echo \"WireGuard interface \$IFACE is already active.\"
      fi
    else
      if ! wg show \"\$IFACE\" >/dev/null 2>&1; then
        echo \"Bringing up WireGuard interface \$IFACE...\"
        wg-quick up \"\$IFACE\" || echo \"Warning: failed to bring up \$IFACE (may need manual config).\"
      else
        echo \"WireGuard interface \$IFACE is already active.\"
      fi
    fi
  fi
else
  echo 'No existing WireGuard config found at known locations.'
  echo 'Searched: ~/wireguard/wg0.conf, /etc/wireguard/wg0.conf, /opt/wireguard/wg0.conf, /usr/local/etc/wireguard/wg0.conf'
  echo 'You can upload a config via wireguard_connect, or place wg0.conf in one of the above paths and re-run.'
fi
"
}

wireguard_connect() {
  if [[ ! -f "$WG_CONFIG_FILE" ]]; then
    # Try to use existing remote config instead of failing
    echo "Local WireGuard config not found at: $WG_CONFIG_FILE"
    echo "Checking if remote machine already has a WireGuard config..."

    local remote_has_config
    remote_has_config="$(remote_run_script "
set -euo pipefail
SEARCH_PATHS=(
  \"\$HOME/wireguard/wg0.conf\"
  '/etc/wireguard/wg0.conf'
  '/opt/wireguard/wg0.conf'
  '/usr/local/etc/wireguard/wg0.conf'
)
for candidate in \"\${SEARCH_PATHS[@]}\"; do
  if [[ -f \"\$candidate\" ]]; then
    echo \"\$candidate\"
    exit 0
  fi
done
echo ''
" 2>/dev/null | tr -d '\r' | tail -n1)"

    if [[ -n "$remote_has_config" ]]; then
      echo "Found existing config on remote at: $remote_has_config"
      echo "Importing and activating..."
      local wg_interface_effective
      wg_interface_effective="$(resolve_remote_wireguard_interface "$WG_INTERFACE")"
      local wg_remote_conf_effective="$WG_REMOTE_CONF"
      if [[ "$WG_REMOTE_CONF" == "/etc/wireguard/${WG_INTERFACE}.conf" ]]; then
        wg_remote_conf_effective="/etc/wireguard/${wg_interface_effective}.conf"
      fi

      remote_run_script "
set -euo pipefail
SOURCE='$remote_has_config'
TARGET='$wg_remote_conf_effective'
if [[ \"\$SOURCE\" != \"\$TARGET\" ]]; then
  if command -v sudo >/dev/null 2>&1; then
    sudo mkdir -p /etc/wireguard
    sudo install -m 600 \"\$SOURCE\" \"\$TARGET\"
  else
    mkdir -p /etc/wireguard
    install -m 600 \"\$SOURCE\" \"\$TARGET\"
  fi
fi
if command -v sudo >/dev/null 2>&1; then
  sudo wg-quick down '$wg_interface_effective' >/dev/null 2>&1 || true
  sudo wg-quick up '$wg_interface_effective'
  sudo wg show '$wg_interface_effective' || true
else
  wg-quick down '$wg_interface_effective' >/dev/null 2>&1 || true
  wg-quick up '$wg_interface_effective'
  wg show '$wg_interface_effective' || true
fi
"
      WG_INTERFACE="$wg_interface_effective"
      WG_REMOTE_CONF="$wg_remote_conf_effective"
      return 0
    fi

    echo "No WireGuard config found on remote machine either." >&2
    echo "Run scripts/devnet15/generate-wireguard-mesh.sh or place wg0.conf on the remote machine." >&2
    exit 1
  fi

  local wg_interface_effective
  wg_interface_effective="$(resolve_remote_wireguard_interface "$WG_INTERFACE")"
  local wg_remote_conf_effective="$WG_REMOTE_CONF"
  if [[ "$WG_REMOTE_CONF" == "/etc/wireguard/${WG_INTERFACE}.conf" ]]; then
    wg_remote_conf_effective="/etc/wireguard/${wg_interface_effective}.conf"
  fi

  local remote_tmp_conf
  remote_tmp_conf="/tmp/${NODE_SLOT_ID}-${wg_interface_effective}.conf"
  copy_to_remote "$WG_CONFIG_FILE" "$remote_tmp_conf"

  remote_run_script "
set -euo pipefail
if ! command -v wg-quick >/dev/null 2>&1; then
  echo 'wg-quick is not available. Run wireguard_install first.' >&2
  exit 1
fi
if command -v sudo >/dev/null 2>&1; then
  sudo mkdir -p /etc/wireguard
  sudo install -m 600 '$remote_tmp_conf' '$wg_remote_conf_effective'
  sudo wg-quick down '$wg_interface_effective' >/dev/null 2>&1 || true
  sudo wg-quick up '$wg_interface_effective'
  sudo wg show '$wg_interface_effective' || true
else
  mkdir -p /etc/wireguard
  install -m 600 '$remote_tmp_conf' '$wg_remote_conf_effective'
  wg-quick down '$wg_interface_effective' >/dev/null 2>&1 || true
  wg-quick up '$wg_interface_effective'
  wg show '$wg_interface_effective' || true
fi
rm -f '$remote_tmp_conf'
"

  WG_INTERFACE="$wg_interface_effective"
  WG_REMOTE_CONF="$wg_remote_conf_effective"
}

wireguard_disconnect() {
  local wg_interface_effective
  wg_interface_effective="$(resolve_remote_wireguard_interface "$WG_INTERFACE")"

  remote_run_script "
set -euo pipefail
if command -v sudo >/dev/null 2>&1; then
  sudo wg-quick down '$wg_interface_effective' >/dev/null 2>&1 || true
else
  wg-quick down '$wg_interface_effective' >/dev/null 2>&1 || true
fi
echo 'WireGuard interface $wg_interface_effective is down.'
"

  WG_INTERFACE="$wg_interface_effective"
}

wireguard_status() {
  local wg_interface_effective
  wg_interface_effective="$(resolve_remote_wireguard_interface "$WG_INTERFACE")"

  remote_run_script "
set -euo pipefail
echo '=== WireGuard Mesh VPN Status for $NODE_SLOT_ID ==='
echo ''

# Interface and endpoint info
WG_CMD='wg'
if command -v sudo >/dev/null 2>&1; then WG_CMD='sudo wg'; fi

if ! command -v wg >/dev/null 2>&1; then
  echo 'WireGuard tools NOT installed on this machine.'
  exit 0
fi

echo '--- Interface: $wg_interface_effective ---'
\$WG_CMD show '$wg_interface_effective' 2>/dev/null || {
  echo 'Interface $wg_interface_effective is DOWN or not configured.'
  exit 0
}

echo ''
echo '--- Local VPN Address ---'
ip -4 addr show dev '$wg_interface_effective' 2>/dev/null | grep inet || echo 'No IPv4 address assigned'

echo ''
echo '--- Mesh Peer Reachability ---'
for peer_ip in \$(ip -4 route show dev '$wg_interface_effective' 2>/dev/null | awk '{print \$1}' | grep -v '/'); do
  if ping -c 1 -W 1 \"\$peer_ip\" >/dev/null 2>&1; then
    echo \"  \$peer_ip  ✓ reachable\"
  else
    echo \"  \$peer_ip  ✗ unreachable\"
  fi
done

echo ''
echo '--- Connection Summary ---'
TOTAL_PEERS=\$(\$WG_CMD show '$wg_interface_effective' peers 2>/dev/null | wc -l)
HANDSHAKE_PEERS=\$(\$WG_CMD show '$wg_interface_effective' latest-handshakes 2>/dev/null | awk '\$2 != \"0\" {n++} END {print n+0}')
echo \"Connected peers: \$HANDSHAKE_PEERS / \$TOTAL_PEERS\"

TRANSFER=\$(\$WG_CMD show '$wg_interface_effective' transfer 2>/dev/null)
if [[ -n \"\$TRANSFER\" ]]; then
  echo ''
  echo '--- Transfer Stats (bytes rx / tx per peer) ---'
  echo \"\$TRANSFER\"
fi
"

  WG_INTERFACE="$wg_interface_effective"
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
WireGuard iface:    $WG_INTERFACE
WireGuard conf dst: $WG_REMOTE_CONF
Installer source:   $INSTALLER_DIR
WireGuard source:   $WG_CONFIG_FILE
INFO
}

case "$OPERATION" in
  # ── Core lifecycle ─────────────────────────────────────────────────────
  install_node)       deploy_installer_bundle ;;
  setup_node)         deploy_installer_bundle
                      remote_run_script "set -euo pipefail; cd '$REMOTE_NODE_DIR'; ./install_and_start.sh" ;;
  bootstrap_node)     deploy_installer_bundle; wireguard_install; wireguard_connect || echo "WireGuard connect skipped (may already be active)."; run_nodectl "start" ;;
  reset_chain)        reset_chain ;;
  start)              run_nodectl "start" ;;
  stop)               run_nodectl "stop" || true; kill_machine_processes "stop" ;;
  restart)            run_nodectl "stop" || true; kill_machine_processes "restart"; run_nodectl "start" ;;
  status)             run_nodectl "status" ;;
  logs)               run_nodectl "logs" ;;
  export_logs)        export_logs ;;
  view_chain_data)    view_chain_data ;;
  export_chain_data)  export_chain_data ;;

  # ── WireGuard (status only exposed in UI) ──────────────────────────────
  wireguard_install)    wireguard_install ;;
  wireguard_connect)    wireguard_connect ;;
  wireguard_disconnect) wireguard_disconnect ;;
  wireguard_status)     wireguard_status ;;
  wireguard_restart)    wireguard_disconnect; wireguard_connect ;;

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
