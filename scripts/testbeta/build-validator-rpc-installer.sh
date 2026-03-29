#!/usr/bin/env bash
set -euo pipefail

umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PUBLIC_HOST="${PUBLIC_HOST:-74.208.227.23}"
BUNDLE_NAME="${BUNDLE_NAME:-validator-rpc-${PUBLIC_HOST}}"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/dist/$BUNDLE_NAME}"
ARCHIVE_PATH="${ARCHIVE_PATH:-$ROOT_DIR/dist/${BUNDLE_NAME}.tar.gz}"

NODE_ID="${NODE_ID:-tbeta-validator-rpc-74-208-227-23}"
DISPLAY_LABEL="${DISPLAY_LABEL:-Validator RPC ${PUBLIC_HOST}}"
SERVICE_NAME="${SERVICE_NAME:-synergy-validator-rpc}"

CHAIN_ID="${CHAIN_ID:-338639}"
P2P_PORT="${P2P_PORT:-5634}"
RPC_PORT="${RPC_PORT:-5734}"
WS_PORT="${WS_PORT:-5834}"
METRICS_PORT="${METRICS_PORT:-6034}"
DISCOVERY_PORT="${DISCOVERY_PORT:-5934}"

BINARY_SOURCE="$ROOT_DIR/binaries/synergy-testbeta-linux-amd64"
ADDRESS_ENGINE_MANIFEST="$ROOT_DIR/synergy-address-engine/Cargo.toml"

BOOTNODES=(
  "bootnode1.synergynode.xyz:5620"
  "bootnode2.synergynode.xyz:5620"
  "bootnode3.synergynode.xyz:5620"
)

SEEDS=(
  "http://seed1.synergynode.xyz:5621"
  "http://seed2.synergynode.xyz:5621"
  "http://seed3.synergynode.xyz:5621"
)

require_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "Missing required file: $path" >&2
    exit 1
  fi
}

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

json_array() {
  local first="true"
  local value
  printf "["
  for value in "$@"; do
    if [[ "$first" == "true" ]]; then
      first="false"
    else
      printf ", "
    fi
    printf "\"%s\"" "$value"
  done
  printf "]"
}

write_executable() {
  local path="$1"
  shift
  cat >"$path"
  chmod 755 "$path"
}

require_file "$BINARY_SOURCE"
require_file "$ADDRESS_ENGINE_MANIFEST"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"/{bin,config,keys,logs,data,manifests,service}

cargo run --quiet --manifest-path "$ADDRESS_ENGINE_MANIFEST" --bin generate-identity -- \
  --address-type validator \
  --label "$DISPLAY_LABEL Identity" \
  --output-dir "$OUT_DIR/keys"

VALIDATOR_ADDRESS="$(tr -d '\n' < "$OUT_DIR/keys/address.txt")"
VALIDATOR_PUBLIC_KEY="$(tr -d '\n' < "$OUT_DIR/keys/public.key")"
BINARY_SHA256="$(sha256_file "$BINARY_SOURCE")"
GENERATED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

cp "$BINARY_SOURCE" "$OUT_DIR/bin/synergy-testbeta"
chmod 755 "$OUT_DIR/bin/synergy-testbeta"
printf "%s  synergy-testbeta\n" "$BINARY_SHA256" > "$OUT_DIR/bin/synergy-testbeta.sha256"

cat >"$OUT_DIR/validator.env" <<EOF
PUBLIC_HOST=$PUBLIC_HOST
NODE_ID=$NODE_ID
DISPLAY_LABEL=$DISPLAY_LABEL
SERVICE_NAME=$SERVICE_NAME
CHAIN_ID=$CHAIN_ID
P2P_PORT=$P2P_PORT
RPC_PORT=$RPC_PORT
WS_PORT=$WS_PORT
METRICS_PORT=$METRICS_PORT
DISCOVERY_PORT=$DISCOVERY_PORT
VALIDATOR_ADDRESS=$VALIDATOR_ADDRESS
EOF

cat >"$OUT_DIR/config/node.toml" <<EOF
[identity]
node_id = "$NODE_ID"
role = "validator"
role_display = "Validator Node"
environment = "testbeta"
display_environment = "Synergy Testnet-Beta"
address = "$VALIDATOR_ADDRESS"
label = "$DISPLAY_LABEL"

[network]
id = $CHAIN_ID
name = "Synergy Testnet-Beta"
chain_name = "Synergy Testnet-Beta"
chain_id = $CHAIN_ID
p2p_port = $P2P_PORT
rpc_port = $RPC_PORT
ws_port = $WS_PORT
p2p_listen = "0.0.0.0:$P2P_PORT"
bootnodes = $(json_array "${BOOTNODES[@]}")
seed_servers = $(json_array "${SEEDS[@]}")
bootstrap_dns_records = ["_dnsaddr.bootstrap.synergynode.xyz"]
quic = true
max_peers = 128
bootstrap_connectivity_required = false
bootstrap_mode = "multi-source-signed"
public_host = "$PUBLIC_HOST"

[blockchain]
block_time = 5
max_gas_limit = "0x2fefd8"
chain_id = $CHAIN_ID

[consensus]
algorithm = "Proof of Synergy"
block_time_secs = 5
epoch_length = 30000
min_validators = 3
validator_cluster_size = 5
max_validators = 21
synergy_score_decay_rate = 0.05
vrf_enabled = true
vrf_seed_epoch_interval = 1000
max_synergy_points_per_epoch = 100
max_tasks_per_validator = 10

[consensus.reward_weighting]
task_accuracy = 0.5
uptime = 0.3
collaboration = 0.2

[logging]
log_level = "info"
log_file = "logs/synergy-testbeta.log"
enable_console = true
max_file_size = 10485760
max_files = 5

[rpc]
bind_address = "0.0.0.0:$RPC_PORT"
enable_http = true
http_port = $RPC_PORT
enable_ws = true
ws_port = $WS_PORT
enable_grpc = false
grpc_port = 0
cors_enabled = false
cors_origins = []

[p2p]
listen_address = "0.0.0.0:$P2P_PORT"
public_address = "$PUBLIC_HOST:$P2P_PORT"
node_name = "$NODE_ID"
enable_discovery = true
discovery_port = $DISCOVERY_PORT
heartbeat_interval = 30

[storage]
database = "rocksdb"
engine = "rocksdb"
path = "data"
mode = "role-bounded"
enable_pruning = false
pruning_interval = 86400

[node]
bootstrap_only = false
auto_register_validator = true
validator_address = "$VALIDATOR_ADDRESS"
strict_validator_allowlist = false
allowed_validator_addresses = []

[telemetry]
metrics_bind = "127.0.0.1:$METRICS_PORT"
structured_logs = true
log_level = "info"

[policy]
allow_remote_admin = false
require_signed_updates = true
quarantine_on_policy_failure = true
quarantine_on_key_role_mismatch = true
connectivity_fail_mode = "warn-and-continue"

[wallet]
reward_address = "$VALIDATOR_ADDRESS"
sponsored_stake_snrg = "5000.000000000"
sponsored_stake_nwei = "5000000000000"

[bootstrap]
status = "configured"
note = "Node will resolve peers from bootnodes, dnsaddr records, and seed services at startup."

[role]
compiled_profile = "validator_node"
services = ["p2p", "consensus", "mempool", "state", "aegis-verifier", "telemetry"]

[validator]
participation = "active"
verify_quorum_certificates = true
state_sync_before_join = true
EOF

cat >"$OUT_DIR/config/peers.toml" <<EOF
# Testnet-Beta multi-source bootstrap inputs.
# Nodes consume these endpoints directly for hardcoded bootnode dialing, dnsaddr resolution, and seed-service fallbacks.
[global]
bootnodes = $(json_array "${BOOTNODES[@]}")
seed_servers = $(json_array "${SEEDS[@]}")
bootstrap_dns_records = ["_dnsaddr.bootstrap.synergynode.xyz"]

[testbeta]
core_rpc = "https://testbeta-core-rpc.synergy-network.io"
core_ws = "wss://testbeta-core-ws.synergy-network.io"
wallet_api = "https://testbeta-wallet-api.synergy-network.io"
sxcp_api = "https://testbeta-sxcp-api.synergy-network.io"

[security]
strict_tls = true
allow_unpinned_dev_endpoints = false
bootstrap_connectivity_required = false
EOF

cat >"$OUT_DIR/config/aegis.toml" <<EOF
[verify]
enabled = true
endpoint = "https://127.0.0.1:3050"

[kms]
enabled = true
endpoint = "https://127.0.0.1:3051"
mtls = true

[lifecycle]
quarantine_on_key_role_mismatch = true
require_rotation_receipts = true
EOF

cat >"$OUT_DIR/manifests/bootstrap.json" <<EOF
{
  "environment_id": "testbeta",
  "display_name": "Synergy Testnet-Beta",
  "generated_at_utc": "$GENERATED_AT",
  "node_id": "$NODE_ID",
  "role_id": "validator",
  "role_display_name": "Validator Node",
  "display_label": "$DISPLAY_LABEL",
  "public_host": "$PUBLIC_HOST",
  "validator_address": "$VALIDATOR_ADDRESS",
  "ports": {
    "p2p": $P2P_PORT,
    "rpc": $RPC_PORT,
    "ws": $WS_PORT,
    "metrics": $METRICS_PORT,
    "discovery": $DISCOVERY_PORT
  },
  "notes": [
    "74.208.227.23 already exposes bootnode1/seed1 defaults, so this validator bundle uses alternate ports to avoid collisions.",
    "Identity was generated with the Synergy Address Engine.",
    "This bundle is designed for Linux x86_64 hosts."
  ]
}
EOF

cat >"$OUT_DIR/validator-info.txt" <<EOF
Validator Registration Information
==================================

Display Label: $DISPLAY_LABEL
Validator Address: $VALIDATOR_ADDRESS
Public Key: $VALIDATOR_PUBLIC_KEY
Server IP: $PUBLIC_HOST
P2P Port: $P2P_PORT
RPC Port: $RPC_PORT
WS Port: $WS_PORT
Generated: $GENERATED_AT

Share this file if validator registration or funding needs to be coordinated.
Do not share keys/private.key or keys/identity.json.
EOF

cat >"$OUT_DIR/service/${SERVICE_NAME}.service.template" <<'EOF'
[Unit]
Description=Synergy Testnet-Beta Validator RPC Node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=__RUN_USER__
Group=__RUN_GROUP__
WorkingDirectory=__WORKDIR__
ExecStart=__WORKDIR__/bin/synergy-testbeta start --config __WORKDIR__/config/node.toml
ExecStop=__WORKDIR__/bin/synergy-testbeta stop --config __WORKDIR__/config/node.toml
Restart=always
RestartSec=5
LimitNOFILE=65535
TimeoutStopSec=45

[Install]
WantedBy=multi-user.target
EOF

write_executable "$OUT_DIR/install.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$BASE_DIR/validator.env"

run_as_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

require_linux_x86_64() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  if [[ "$os" != "Linux" || "$arch" != "x86_64" ]]; then
    echo "This bundle targets Linux x86_64. Detected ${os}/${arch}." >&2
    exit 1
  fi
}

install_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    run_as_root apt-get update
    run_as_root apt-get install -y curl jq ufw ca-certificates
  else
    echo "apt-get not found. Install curl, jq, ufw, and ca-certificates manually before continuing." >&2
  fi
}

verify_binary() {
  local expected actual
  expected="$(awk '{print $1}' "$BASE_DIR/bin/synergy-testbeta.sha256")"
  if [[ -z "$expected" ]]; then
    echo "Missing expected SHA256 value." >&2
    exit 1
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$BASE_DIR/bin/synergy-testbeta" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$BASE_DIR/bin/synergy-testbeta" | awk '{print $1}')"
  else
    echo "No SHA256 tool found; skipping binary verification."
    return
  fi

  if [[ "$expected" != "$actual" ]]; then
    echo "Binary checksum mismatch. Expected $expected, got $actual." >&2
    exit 1
  fi
}

ensure_permissions() {
  mkdir -p "$BASE_DIR/data" "$BASE_DIR/logs" "$BASE_DIR/manifests"
  chmod 755 "$BASE_DIR/bin/synergy-testbeta" "$BASE_DIR/start.sh" "$BASE_DIR/stop.sh" "$BASE_DIR/status.sh" "$BASE_DIR/register-with-seeds.sh"
  chmod 700 "$BASE_DIR/keys"
  chmod 600 "$BASE_DIR/keys/private.key" "$BASE_DIR/keys/public.key" "$BASE_DIR/keys/identity.json" "$BASE_DIR/keys/address.txt"
}

port_is_in_use() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "( sport = :$port )" | tail -n +2 | grep -q .
    return
  fi

  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
    return
  fi

  return 1
}

check_port_conflicts() {
  local port
  for port in "$P2P_PORT" "$RPC_PORT" "$WS_PORT" "$METRICS_PORT" "$DISCOVERY_PORT"; do
    if port_is_in_use "$port"; then
      echo "Port $port is already in use on this host. Update validator.env and config/node.toml before starting." >&2
      exit 1
    fi
  done
}

configure_firewall() {
  if ! command -v ufw >/dev/null 2>&1; then
    echo "ufw not available; open these ports manually: $P2P_PORT/tcp, $RPC_PORT/tcp, $WS_PORT/tcp"
    return
  fi

  run_as_root ufw allow OpenSSH >/dev/null || true
  run_as_root ufw allow "$P2P_PORT/tcp" comment "Synergy validator P2P" >/dev/null || true
  run_as_root ufw allow "$RPC_PORT/tcp" comment "Synergy validator RPC" >/dev/null || true
  run_as_root ufw allow "$WS_PORT/tcp" comment "Synergy validator WS" >/dev/null || true
}

install_service() {
  local run_user run_group unit_path template rendered

  if [[ "$(id -u)" -eq 0 && -n "${SUDO_USER:-}" ]]; then
    run_user="$SUDO_USER"
  elif [[ "$(id -u)" -eq 0 ]]; then
    run_user="root"
  else
    run_user="$USER"
  fi

  run_group="$(id -gn "$run_user")"
  template="$BASE_DIR/service/${SERVICE_NAME}.service.template"
  unit_path="/etc/systemd/system/${SERVICE_NAME}.service"
  rendered="$(mktemp)"

  sed \
    -e "s|__WORKDIR__|$BASE_DIR|g" \
    -e "s|__RUN_USER__|$run_user|g" \
    -e "s|__RUN_GROUP__|$run_group|g" \
    "$template" > "$rendered"

  run_as_root install -m 0644 "$rendered" "$unit_path"
  rm -f "$rendered"

  run_as_root systemctl daemon-reload
  run_as_root systemctl enable "$SERVICE_NAME"
}

print_summary() {
  cat <<SUMMARY
Bundle installed.

Service: $SERVICE_NAME
Directory: $BASE_DIR
Validator address: $VALIDATOR_ADDRESS
Ports:
  P2P: $P2P_PORT
  RPC: $RPC_PORT
  WS:  $WS_PORT
  Metrics: 127.0.0.1:$METRICS_PORT

Next step:
  ./start.sh
SUMMARY
}

require_linux_x86_64
install_packages
verify_binary
ensure_permissions
check_port_conflicts
configure_firewall
install_service
print_summary
EOF

write_executable "$OUT_DIR/register-with-seeds.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$BASE_DIR/validator.env"

TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
PAYLOAD="$(cat <<JSON
{
  "node_id": "$NODE_ID",
  "role_id": "validator",
  "role_display_name": "Validator Node",
  "wallet_address": "$VALIDATOR_ADDRESS",
  "public_host": "$PUBLIC_HOST",
  "p2p_port": $P2P_PORT,
  "dial": "snr://peer@$PUBLIC_HOST:$P2P_PORT",
  "chain_id": $CHAIN_ID,
  "registered_at_utc": "$TIMESTAMP"
}
JSON
)"

for seed_url in \
  "http://seed1.synergynode.xyz:5621/peers/register" \
  "http://seed2.synergynode.xyz:5621/peers/register" \
  "http://seed3.synergynode.xyz:5621/peers/register"
do
  if curl -fsS --max-time 5 -H "Content-Type: application/json" -d "$PAYLOAD" "$seed_url" >/dev/null; then
    echo "Registered with $seed_url"
  else
    echo "Seed registration failed for $seed_url" >&2
  fi
done
EOF

write_executable "$OUT_DIR/start.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$BASE_DIR/validator.env"

run_service() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

wait_for_rpc() {
  local attempts=30
  local payload
  payload='{"jsonrpc":"2.0","id":1,"method":"synergy_blockNumber","params":[]}'
  while (( attempts > 0 )); do
    if curl -fsS --max-time 3 -H "Content-Type: application/json" -d "$payload" "http://127.0.0.1:$RPC_PORT" >/dev/null 2>&1; then
      return 0
    fi
    attempts=$((attempts - 1))
    sleep 2
  done
  return 1
}

mkdir -p "$BASE_DIR/logs" "$BASE_DIR/data"

if [[ ! -f "$BASE_DIR/data/.initial_sync_complete" ]]; then
  echo "Running initial sync..."
  "$BASE_DIR/bin/synergy-testbeta" sync --config "$BASE_DIR/config/node.toml" | tee "$BASE_DIR/logs/initial-sync.log"
  touch "$BASE_DIR/data/.initial_sync_complete"
fi

run_service systemctl start "$SERVICE_NAME"

if wait_for_rpc; then
  "$BASE_DIR/register-with-seeds.sh" || true
  echo "Validator service is up. RPC available at http://$PUBLIC_HOST:$RPC_PORT"
  exit 0
fi

echo "Validator service started but local RPC did not answer in time." >&2
run_service systemctl status "$SERVICE_NAME" --no-pager || true
exit 1
EOF

write_executable "$OUT_DIR/stop.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$BASE_DIR/validator.env"

if [[ "$(id -u)" -eq 0 ]]; then
  systemctl stop "$SERVICE_NAME"
else
  sudo systemctl stop "$SERVICE_NAME"
fi
EOF

write_executable "$OUT_DIR/status.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$BASE_DIR/validator.env"

PAYLOAD='{"jsonrpc":"2.0","id":1,"method":"synergy_blockNumber","params":[]}'

if [[ "$(id -u)" -eq 0 ]]; then
  systemctl status "$SERVICE_NAME" --no-pager || true
else
  sudo systemctl status "$SERVICE_NAME" --no-pager || true
fi

echo
echo "RPC probe:"
curl -sS --max-time 5 -H "Content-Type: application/json" -d "$PAYLOAD" "http://127.0.0.1:$RPC_PORT" || true

echo
echo "Recent log tail:"
tail -n 40 "$BASE_DIR/logs/synergy-testbeta.log" 2>/dev/null || true
EOF

cat >"$OUT_DIR/README.md" <<EOF
# $DISPLAY_LABEL

This bundle is a portable Linux \`x86_64\` validator + RPC workspace for **Synergy Testnet-Beta**.

## Why these ports

\`74.208.227.23\` already answers as \`bootnode1.synergynode.xyz\` on \`5620/tcp\` and as \`seed1.synergynode.xyz\` on \`5621/tcp\`. To avoid collisions on that VPS, this validator bundle uses:

- P2P: \`$P2P_PORT\`
- RPC: \`$RPC_PORT\`
- WebSocket: \`$WS_PORT\`
- Metrics: \`127.0.0.1:$METRICS_PORT\`

## Files

- \`bin/synergy-testbeta\`: Linux runtime binary
- \`keys/\`: validator identity generated by the **Synergy Address Engine**
- \`config/node.toml\`: validator runtime config
- \`install.sh\`: installs packages, firewall rules, and systemd service
- \`start.sh\`: performs initial sync once, starts the service, and registers with seed servers
- \`stop.sh\`: stops the service
- \`status.sh\`: checks systemd and local RPC

## Deploy

1. Copy this whole folder to the VPS.
2. SSH into the VPS.
3. Run:

\`\`\`bash
cd $BUNDLE_NAME
./install.sh
./start.sh
\`\`\`

## Validator Info

- Address: \`$VALIDATOR_ADDRESS\`
- Public host: \`$PUBLIC_HOST\`
- Service: \`$SERVICE_NAME\`

Do not share \`keys/private.key\` or \`keys/identity.json\`.
EOF

tar -czf "$ARCHIVE_PATH" -C "$(dirname "$OUT_DIR")" "$(basename "$OUT_DIR")"

cat <<EOF
Created bundle:
  Folder:  $OUT_DIR
  Archive: $ARCHIVE_PATH
  Address: $VALIDATOR_ADDRESS
  P2P:     $P2P_PORT
  RPC:     $RPC_PORT
  WS:      $WS_PORT
EOF
