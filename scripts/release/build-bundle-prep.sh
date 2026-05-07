#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "== Bundle prep =="

ensure_version_alignment() {
  local package_version cargo_version

  package_version="$(node -e 'const fs=require("fs"); const pkg=JSON.parse(fs.readFileSync("package.json","utf8")); process.stdout.write(pkg.version);')"
  cargo_version="$(python3 - <<'PY'
import pathlib
import re

content = pathlib.Path("control-service/Cargo.toml").read_text(encoding="utf-8")
match = re.search(r'^version\s*=\s*"([^"]+)"', content, re.MULTILINE)
if not match:
    raise SystemExit("Missing version in control-service/Cargo.toml")
print(match.group(1), end="")
PY
)"

  if [[ "$package_version" != "$cargo_version" ]]; then
    cat >&2 <<EOF
Version mismatch detected:
  package.json:                $package_version
  control-service/Cargo.toml: $cargo_version
Keep the desktop package version and control-service version aligned before tagging a release.
EOF
    exit 1
  fi
}

sync_platform_binaries() {
  local target_dir="$ROOT_DIR/binaries"
  local source_dir=""
  local candidates=()

  if [[ -n "${SYNERGY_TESTBETA_BINARY_SOURCE_DIR:-}" ]]; then
    candidates+=("${SYNERGY_TESTBETA_BINARY_SOURCE_DIR}")
  fi

  if [[ -n "${SYNERGY_TESTBETA_SOURCE_REPO_ROOT:-}" ]]; then
    candidates+=("${SYNERGY_TESTBETA_SOURCE_REPO_ROOT}/binaries")
  fi

  candidates+=(
    "$ROOT_DIR/../binaries"
    "$ROOT_DIR/../../synergy-testnet-beta/binaries"
    "$ROOT_DIR/../../../synergy-testnet-beta/binaries"
  )

  mkdir -p "$target_dir"

  for candidate in "${candidates[@]}"; do
    if [[ -d "$candidate" ]]; then
      source_dir="$(cd "$candidate" && pwd)"
      break
    fi
  done

  if [[ ! -d "$source_dir" ]]; then
    echo "Platform binary source not found; keeping existing binaries in binaries/."
    echo "Checked: ${candidates[*]}"
    return
  fi

  if [[ "$source_dir" == "$target_dir" ]]; then
    echo "Platform binary source resolves to binaries/; skipping sync."
    return
  fi

  echo "Syncing platform binaries from $source_dir"

  for binary_name in \
    synergy-testbeta-darwin-arm64 \
    synergy-testbeta-linux-amd64 \
    "synergy-testbeta-windows-amd64.exe"
  do
    if [[ -f "$source_dir/$binary_name" ]]; then
      cp "$source_dir/$binary_name" "$target_dir/$binary_name"
      echo "  Synced: $binary_name"
    fi
  done
}

refresh_platform_binary_checksums() {
  local binary_path

  for binary_path in \
    "$ROOT_DIR/binaries/synergy-testbeta-macos-arm64" \
    "$ROOT_DIR/binaries/synergy-testbeta-linux-amd64" \
    "$ROOT_DIR/binaries/synergy-testbeta-windows-amd64.exe"
  do
    if [[ -f "$binary_path" ]]; then
      if command -v shasum >/dev/null 2>&1; then
        printf "%s  %s\n" "$(shasum -a 256 "$binary_path" | awk '{print $1}')" "$(basename "$binary_path")" > "${binary_path}.sha256"
      elif command -v sha256sum >/dev/null 2>&1; then
        printf "%s  %s\n" "$(sha256sum "$binary_path" | awk '{print $1}')" "$(basename "$binary_path")" > "${binary_path}.sha256"
      fi
    fi
  done
}

sha256_for_file() {
  local file_path="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file_path" | awk '{print $1}'
  else
    sha256sum "$file_path" | awk '{print $1}'
  fi
}

write_bundle_binary_status() {
  local bundle_dir="$1"
  local linux_path="$bundle_dir/bin/synergy-testbeta-linux-amd64"
  local darwin_path="$bundle_dir/bin/synergy-testbeta-darwin-arm64"
  local windows_path="$bundle_dir/bin/synergy-testbeta-windows-amd64.exe"

  cat > "$bundle_dir/BINARY_STATUS.txt" <<EOF
Synergy Testnet-Beta Binary Status
============================

Linux Binary
------------
Path: ./bin/synergy-testbeta-linux-amd64
SHA-256: $(sha256_for_file "$linux_path")

Darwin Binary
-------------
Path: ./bin/synergy-testbeta-darwin-arm64
SHA-256: $(sha256_for_file "$darwin_path")

Windows Binary
--------------
Path: ./bin/synergy-testbeta-windows-amd64.exe
SHA-256: $(sha256_for_file "$windows_path")

Interpretation
--------------
- These checksums reflect the exact bundled binaries shipped in this installer.
EOF
}

sync_bundle_binary_payload() {
  local bundle_dir="$1"
  local bin_dir="$bundle_dir/bin"

  mkdir -p "$bin_dir"
  cp "$ROOT_DIR/binaries/synergy-testbeta-linux-amd64" "$bin_dir/synergy-testbeta-linux-amd64"
  cp "$ROOT_DIR/binaries/synergy-testbeta-darwin-arm64" "$bin_dir/synergy-testbeta-darwin-arm64"
  cp "$ROOT_DIR/binaries/synergy-testbeta-windows-amd64.exe" "$bin_dir/synergy-testbeta-windows-amd64.exe"
  chmod +x "$bin_dir/synergy-testbeta-linux-amd64" "$bin_dir/synergy-testbeta-darwin-arm64"
  write_bundle_binary_status "$bundle_dir"
}

sync_installer_bundle_binaries() {
  local installer_root="$ROOT_DIR/testbeta/runtime/installers"
  local bundle_dir

  [[ -d "$installer_root" ]] || return 0
  echo "Syncing runtime binaries into installer bundles"
  for bundle_dir in "$installer_root"/*; do
    [[ -d "$bundle_dir" ]] || continue
    sync_bundle_binary_payload "$bundle_dir"
  done
}

sync_bootstrap_bundle_binaries() {
  local bootstrap_root="$ROOT_DIR/../bootstrap-bundles"
  local bundle_dir

  [[ -d "$bootstrap_root" ]] || return 0
  echo "Syncing runtime binaries into bootstrap bundles"
  for bundle_dir in "$bootstrap_root"/bootnode*; do
    [[ -d "$bundle_dir" ]] || continue
    sync_bundle_binary_payload "$bundle_dir"
  done
}

sync_canonical_runtime_assets() {
  echo "Syncing canonical runtime genesis"
  ./scripts/testbeta/generate-testbeta-genesis.sh
  echo "Generating canonical Testnet-Beta node keys"
  ./scripts/testbeta/generate-node-keys.sh
  echo "Rendering canonical Testnet-Beta configs"
  ./scripts/testbeta/render-configs.sh
  echo "Using committed canonical Testnet-Beta installer templates"
}

sync_installer_bundle_configs() {
  local configs_root="$ROOT_DIR/testbeta/runtime/configs"
  local installers_root="$ROOT_DIR/testbeta/runtime/installers"
  local config_path
  local node_id
  local bundle_dir

  [[ -d "$configs_root" && -d "$installers_root" ]] || return 0

  echo "Syncing rendered node configs into installer bundles"
  for config_path in "$configs_root"/*.toml; do
    [[ -f "$config_path" ]] || continue
    node_id="$(basename "$config_path" .toml)"
    bundle_dir="$installers_root/$node_id"
    [[ -d "$bundle_dir" ]] || continue
    mkdir -p "$bundle_dir/config"
    cp "$config_path" "$bundle_dir/config/node.toml"
  done

  python3 - <<'PY' "$ROOT_DIR"
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
installers_root = root / "testbeta/runtime/installers"

def parse_value(raw):
    raw = raw.strip()
    if raw in ("true", "false"):
        return raw == "true"
    if raw.startswith('"') and raw.endswith('"'):
        return raw[1:-1]
    if raw.startswith("[") and raw.endswith("]"):
        body = raw[1:-1].strip()
        if not body:
            return []
        values = []
        current = []
        in_string = False
        escaped = False
        for char in body:
            if escaped:
                current.append(char)
                escaped = False
                continue
            if char == "\\" and in_string:
                escaped = True
                continue
            if char == '"':
                in_string = not in_string
                continue
            if char == "," and not in_string:
                values.append("".join(current).strip())
                current = []
                continue
            current.append(char)
        values.append("".join(current).strip())
        return values
    try:
        return int(raw)
    except ValueError:
        return raw

def parse_node_toml(path):
    parsed = {}
    section = None
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("[") and stripped.endswith("]"):
            section = stripped.strip("[]")
            parsed.setdefault(section, {})
            continue
        if "=" not in stripped or section is None:
            continue
        key, value = stripped.split("=", 1)
        parsed.setdefault(section, {})[key.strip()] = parse_value(value)
    return parsed

consensus_keys = [
    "min_validators",
    "validator_vote_threshold",
    "max_validators",
    "status_ready_gate_enabled",
    "status_ready_min_validators",
    "status_ready_genesis_grace_secs",
    "allow_genesis_status_bypass",
    "mesh_settle_secs",
    "leader_timeout_secs",
    "vote_timeout_secs",
    "block_timeout_secs",
    "validator_cluster_size",
    "penalization_enabled",
]
p2p_keys = [
    "enable_discovery",
    "heartbeat_interval",
    "bootstrap_refresh_secs",
    "public_address",
]
network_keys = [
    "additional_dial_targets",
    "persistent_peers",
    "bootnodes",
    "seed_servers",
    "bootstrap_dns_records",
]
node_keys = [
    "auto_register_validator",
    "validator_address",
    "strict_validator_allowlist",
    "allowed_validator_addresses",
]
validator_keys = [
    "participation",
    "verify_quorum_certificates",
    "state_sync_before_join",
]

for package_path in sorted(installers_root.glob("GenVal-*/keys/setup-package.json")):
    node_toml = package_path.parents[1] / "config/node.toml"
    if not node_toml.exists():
        continue

    config = parse_node_toml(node_toml)
    package = json.loads(package_path.read_text(encoding="utf-8"))
    runtime = package.setdefault("runtime_config", {})

    consensus = config.get("consensus", {})
    runtime["consensus"] = {key: consensus[key] for key in consensus_keys if key in consensus}

    p2p = config.get("p2p", {})
    runtime["p2p"] = {key: p2p[key] for key in p2p_keys if key in p2p}

    network = config.get("network", {})
    runtime["network"] = {key: network.get(key, []) for key in network_keys}

    node = config.get("node", {})
    runtime["node"] = {key: node[key] for key in node_keys if key in node}

    validator = config.get("validator", {})
    existing_validator = runtime.get("validator") or {}
    runtime["validator"] = {
        key: validator.get(key, existing_validator.get(key))
        for key in validator_keys
        if key in validator or key in existing_validator
    }

    package_path.write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")
PY
}

resolve_explorer_root() {
  local candidate=""
  local candidates=()

  if [[ -n "${SYNERGY_TESTBETA_EXPLORER_APP_ROOT:-}" ]]; then
    candidates+=("${SYNERGY_TESTBETA_EXPLORER_APP_ROOT}")
  fi

  candidates+=(
    "$ROOT_DIR/../explorer-app"
    "$ROOT_DIR/../../explorer-app"
    "$ROOT_DIR/../../../explorer-app"
  )

  for candidate in "${candidates[@]}"; do
    if [[ -d "$candidate" ]]; then
      (cd "$candidate" && pwd)
      return 0
    fi
  done

  echo "Atlas explorer source not found. Checked: ${candidates[*]}" >&2
  return 1
}

sync_atlas_runtime_bundle() {
  local explorer_root node_exp_bundle frontend_dist_root
  explorer_root="$(resolve_explorer_root)"
  node_exp_bundle="$ROOT_DIR/testbeta/runtime/installers/Node-EXP/explorer-app"
  frontend_dist_root="$node_exp_bundle/dist"

  echo "Building Atlas runtime from $explorer_root"
  npm ci --prefix "$explorer_root"
  npm run build --prefix "$explorer_root"

  for package_dir in "$explorer_root/backend" "$explorer_root/indexer"; do
    npm ci --prefix "$package_dir"
    npm run build --prefix "$package_dir"
    npm prune --omit=dev --prefix "$package_dir"
  done

  rm -rf "$node_exp_bundle"
  mkdir -p "$node_exp_bundle/backend" "$node_exp_bundle/indexer"

  rsync -a --delete \
    --exclude '.DS_Store' \
    "$explorer_root/dist/" \
    "$frontend_dist_root/"

  for service_dir in backend indexer; do
    mkdir -p "$node_exp_bundle/$service_dir"
    rsync -a --delete \
      --exclude '.DS_Store' \
      --exclude '.env' \
      "$explorer_root/$service_dir/dist/" \
      "$node_exp_bundle/$service_dir/dist/"
    rsync -a --delete \
      --exclude '.DS_Store' \
      "$explorer_root/$service_dir/migrations/" \
      "$node_exp_bundle/$service_dir/migrations/"
    rsync -a --delete \
      --exclude '.DS_Store' \
      --exclude '.bin' \
      "$explorer_root/$service_dir/node_modules/" \
      "$node_exp_bundle/$service_dir/node_modules/"
    mkdir -p "$node_exp_bundle/$service_dir/scripts"
    cp "$explorer_root/$service_dir/package.json" "$node_exp_bundle/$service_dir/package.json"
    cp "$explorer_root/$service_dir/package-lock.json" "$node_exp_bundle/$service_dir/package-lock.json"
    cp "$explorer_root/$service_dir/.env.example" "$node_exp_bundle/$service_dir/.env.example"
    cp "$explorer_root/$service_dir/scripts/migrate.js" "$node_exp_bundle/$service_dir/scripts/migrate.js"
  done
}

render_public_service_nginx_configs() {
  local rpc_bundle explorer_bundle
  local rpc_host rpc_ws_host rpc_port ws_port
  local explorer_host atlas_api_host indexer_ws_host atlas_api_port indexer_ws_port explorer_static_root

  rpc_bundle="$ROOT_DIR/testbeta/runtime/installers/Node-RPC"
  explorer_bundle="$ROOT_DIR/testbeta/runtime/installers/Node-EXP"

  # shellcheck disable=SC1090
  source "$rpc_bundle/node.env"
  rpc_host="${HOSTNAME}"
  rpc_ws_host="${RPC_WS_HOSTNAME:-testbeta-core-ws.synergy-network.io}"
  rpc_port="${RPC_PORT}"
  ws_port="${WS_PORT}"

  cat > "$rpc_bundle/nginx.conf" <<EOF
# Canonical Testnet-Beta RPC gateway reverse proxy.
# Deploy this file on the public RPC host and enable it in nginx.

upstream testbeta_rpc_http {
  server 127.0.0.1:${rpc_port};
}

upstream testbeta_rpc_ws {
  server 127.0.0.1:${ws_port};
}

server {
  listen 80;
  server_name ${rpc_host} ${rpc_ws_host};
  location ^~ /.well-known/acme-challenge/ {
    root /var/www/letsencrypt;
    default_type "text/plain";
    try_files \$uri =404;
  }
  return 301 https://\$host\$request_uri;
}

server {
  listen 443 ssl http2;
  server_name ${rpc_host};
  ssl_certificate /etc/letsencrypt/live/${rpc_host}/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/${rpc_host}/privkey.pem;
  include /etc/letsencrypt/options-ssl-nginx.conf;
  ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

  location = /healthz {
    return 200 "ok\n";
  }

  location / {
    proxy_pass http://testbeta_rpc_http;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 60s;
    add_header Access-Control-Allow-Origin *;
    add_header Access-Control-Allow-Methods "GET, POST, OPTIONS";
    add_header Access-Control-Allow-Headers "Content-Type";
  }
}

server {
  listen 443 ssl http2;
  server_name ${rpc_ws_host};
  ssl_certificate /etc/letsencrypt/live/${rpc_host}/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/${rpc_host}/privkey.pem;
  include /etc/letsencrypt/options-ssl-nginx.conf;
  ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

  location / {
    proxy_pass http://testbeta_rpc_ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_read_timeout 3600s;
  }
}
EOF

  # shellcheck disable=SC1090
  source "$explorer_bundle/node.env"
  explorer_host="${EXPLORER_UI_HOSTNAME:-${HOSTNAME}}"
  atlas_api_host="${ATLAS_API_HOSTNAME:-testbeta-atlas-api.synergy-network.io}"
  indexer_ws_host="${INDEXER_WS_HOSTNAME:-testbeta-indexer.synergy-network.io}"
  atlas_api_port="${EXPLORER_API_PORT:-3020}"
  indexer_ws_port="${INDEXER_WS_PORT:-${WS_PORT}}"
  explorer_static_root="${EXPLORER_STATIC_ROOT:-/opt/synergy/testbeta/indexer-explorer/explorer-app/dist}"

  cat > "$explorer_bundle/nginx.conf" <<EOF
# Canonical Testnet-Beta Atlas and explorer reverse proxy.
# Deploy this file on the public explorer host and enable it in nginx.

upstream testbeta_atlas_api {
  server 127.0.0.1:${atlas_api_port};
}

upstream testbeta_indexer_ws {
  server 127.0.0.1:${indexer_ws_port};
}

server {
  listen 80;
  server_name ${explorer_host} ${atlas_api_host} ${indexer_ws_host};
  location ^~ /.well-known/acme-challenge/ {
    root /var/www/letsencrypt;
    default_type "text/plain";
    try_files \$uri =404;
  }
  return 301 https://\$host\$request_uri;
}

server {
  listen 443 ssl http2;
  server_name ${explorer_host};
  ssl_certificate /etc/letsencrypt/live/${explorer_host}/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/${explorer_host}/privkey.pem;
  include /etc/letsencrypt/options-ssl-nginx.conf;
  ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

  root ${explorer_static_root};
  index index.html;

  location /api/ {
    proxy_pass http://testbeta_atlas_api;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 60s;
  }

  location = /healthz {
    proxy_pass http://testbeta_atlas_api/healthz;
  }

  location = /readyz {
    proxy_pass http://testbeta_atlas_api/readyz;
  }

  location / {
    try_files \$uri \$uri/ /index.html;
  }
}

server {
  listen 443 ssl http2;
  server_name ${atlas_api_host};
  ssl_certificate /etc/letsencrypt/live/${explorer_host}/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/${explorer_host}/privkey.pem;
  include /etc/letsencrypt/options-ssl-nginx.conf;
  ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

  location / {
    proxy_pass http://testbeta_atlas_api;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 60s;
  }
}

server {
  listen 443 ssl http2;
  server_name ${indexer_ws_host};
  ssl_certificate /etc/letsencrypt/live/${explorer_host}/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/${explorer_host}/privkey.pem;
  include /etc/letsencrypt/options-ssl-nginx.conf;
  ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

  location / {
    proxy_pass http://testbeta_indexer_ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_read_timeout 3600s;
  }
}
EOF
}

# Ensure Unix platform binaries are executable
for binary_path in \
  "$ROOT_DIR/binaries/synergy-testbeta-darwin-arm64" \
  "$ROOT_DIR/binaries/synergy-testbeta-linux-amd64"
do
  if [[ -f "$binary_path" ]]; then
    chmod +x "$binary_path"
  fi
done

ensure_version_alignment
sync_platform_binaries
refresh_platform_binary_checksums
sync_canonical_runtime_assets
sync_installer_bundle_configs
sync_installer_bundle_binaries
sync_bootstrap_bundle_binaries
sync_atlas_runtime_bundle
render_public_service_nginx_configs
./scripts/release/generate-workspace-manifest.sh
SKIP_BUNDLED_ASSET_GIT_CLEAN_CHECK=1 ./scripts/release/validate-bundled-assets.sh

npm run build
