#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INVENTORY_FILE="$ROOT_DIR/devnet/lean15/node-inventory.csv"
HOSTS_ENV_FILE="${SYNERGY_MONITOR_HOSTS_ENV:-$ROOT_DIR/devnet/lean15/hosts.env}"
OUT_DIR="${1:-$ROOT_DIR/devnet/lean15/wireguard}"
KEYS_DIR="$OUT_DIR/keys"
CONFIGS_DIR="$OUT_DIR/configs"
PORT_BASE="${WIREGUARD_PORT_BASE:-51820}"

usage() {
  cat <<USAGE
Usage: $0 [output-dir]

Generates hub-and-spoke WireGuard configs for all machines in:
- devnet/lean15/node-inventory.csv

Environment:
- WIREGUARD_PORT_BASE (default: 51820)
- SYNERGY_DEVNET_WG_HUB_PUBLIC_IP (default: 64.227.107.57)
- SYNERGY_DEVNET_WG_HUB_VPN_IP (default: 10.50.0.254)
- SYNERGY_DEVNET_WG_HUB_PORT (default: 51820)
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ ! -f "$INVENTORY_FILE" ]]; then
  echo "Missing inventory file: $INVENTORY_FILE" >&2
  exit 1
fi

if [[ -f "$HOSTS_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$HOSTS_ENV_FILE"
fi

if ! command -v wg >/dev/null 2>&1; then
  echo "WireGuard tooling not found. Install 'wg' first." >&2
  exit 1
fi

mkdir -p "$KEYS_DIR" "$CONFIGS_DIR"

HUB_PUBLIC_IP="${SYNERGY_DEVNET_WG_HUB_PUBLIC_IP:-64.227.107.57}"
HUB_VPN_IP="${SYNERGY_DEVNET_WG_HUB_VPN_IP:-10.50.0.254}"
HUB_PORT="${SYNERGY_DEVNET_WG_HUB_PORT:-51820}"
HUB_KEY_DIR="$KEYS_DIR/hub"

resolve_var() {
  local name="$1"
  printf '%s' "${!name:-}"
}

logical_node_slots=()
logical_physical_indexes=()
physical_keys=()
physical_primary_node_slots=()
physical_vpn_ips=()
physical_hosts=()
physical_listen_ports=()

physical_index_for_key() {
  local target="$1"
  local idx
  for idx in "${!physical_keys[@]}"; do
    if [[ "${physical_keys[$idx]}" == "$target" ]]; then
      echo "$idx"
      return 0
    fi
  done
  echo "-1"
}

while IFS=, read -r node_slot_id _ _ _ _ _ _ _ _ _ _ host vpn_ip physical_machine_id _ _ _ _ _ _ _ _ || [[ -n "${node_slot_id:-}" ]]; do
  [[ "$node_slot_id" == "node_slot_id" ]] && continue
  if [[ -z "$node_slot_id" || -z "$vpn_ip" ]]; then
    continue
  fi

  node_slot_id="${node_slot_id//$'\r'/}"
  host="${host//$'\r'/}"
  vpn_ip="${vpn_ip//$'\r'/}"
  physical_machine_id="${physical_machine_id//$'\r'/}"

  node_slot_key="$(printf '%s' "$node_slot_id" | tr '[:lower:]-' '[:upper:]_')"
  host_override_var="${node_slot_key}_HOST"
  host_override="$(resolve_var "$host_override_var")"
  if [[ -n "$host_override" ]]; then
    host="$host_override"
  fi
  if [[ -z "$host" ]]; then
    host="$vpn_ip"
  fi

  # WireGuard is machine-level. Multiple logical nodes can share one physical machine.
  # Reuse the same keypair/listen port/address for logical nodes with the same physical identity.
  physical_key="$physical_machine_id"
  if [[ -z "$physical_key" ]]; then
    physical_key="$vpn_ip"
  fi
  physical_key="$(printf '%s' "$physical_key" | tr '[:upper:]' '[:lower:]')"

  idx="$(physical_index_for_key "$physical_key")"
  if [[ "$idx" == "-1" ]]; then
    idx="${#physical_keys[@]}"
    physical_keys+=("$physical_key")
    physical_primary_node_slots+=("$node_slot_id")
    physical_vpn_ips+=("$vpn_ip")
    physical_hosts+=("$host")
    physical_listen_ports+=("$((PORT_BASE + idx))")
  fi

  logical_node_slots+=("$node_slot_id")
  logical_physical_indexes+=("$idx")
done < "$INVENTORY_FILE"

mkdir -p "$HUB_KEY_DIR"
if [[ ! -f "$HUB_KEY_DIR/privatekey" || ! -f "$HUB_KEY_DIR/publickey" ]]; then
  hub_private_key="$(wg genkey)"
  hub_public_key="$(printf '%s' "$hub_private_key" | wg pubkey)"
  printf '%s\n' "$hub_private_key" > "$HUB_KEY_DIR/privatekey"
  printf '%s\n' "$hub_public_key" > "$HUB_KEY_DIR/publickey"
  chmod 600 "$HUB_KEY_DIR/privatekey" "$HUB_KEY_DIR/publickey"
fi

hub_private_key="$(cat "$HUB_KEY_DIR/privatekey")"
hub_public_key="$(cat "$HUB_KEY_DIR/publickey")"

for node_slot_id in "${physical_primary_node_slots[@]}"; do
  key_dir="$KEYS_DIR/$node_slot_id"
  mkdir -p "$key_dir"
  private_key_file="$key_dir/privatekey"
  public_key_file="$key_dir/publickey"

  if [[ ! -f "$private_key_file" || ! -f "$public_key_file" ]]; then
    private_key="$(wg genkey)"
    public_key="$(printf '%s' "$private_key" | wg pubkey)"
    printf '%s\n' "$private_key" > "$private_key_file"
    printf '%s\n' "$public_key" > "$public_key_file"
    chmod 600 "$private_key_file" "$public_key_file"
  fi
done

hub_conf_file="$CONFIGS_DIR/hub.conf"
{
  echo "[Interface]"
  echo "Address = ${HUB_VPN_IP}/24"
  echo "ListenPort = ${HUB_PORT}"
  echo "PrivateKey = ${hub_private_key}"
  echo ""
} > "$hub_conf_file"

for j in "${!physical_keys[@]}"; do
  peer_machine="${physical_primary_node_slots[$j]}"
  peer_vpn_ip="${physical_vpn_ips[$j]}"
  peer_public_key="$(cat "$KEYS_DIR/$peer_machine/publickey")"

  {
    echo "[Peer]"
    echo "PublicKey = ${peer_public_key}"
    echo "AllowedIPs = ${peer_vpn_ip}/32"
    echo ""
  } >> "$hub_conf_file"
done

for i in "${!logical_node_slots[@]}"; do
  node_slot_id="${logical_node_slots[$i]}"
  machine_physical_index="${logical_physical_indexes[$i]}"
  machine_primary_id="${physical_primary_node_slots[$machine_physical_index]}"
  machine_vpn_ip="${physical_vpn_ips[$machine_physical_index]}"
  machine_listen_port="${physical_listen_ports[$machine_physical_index]}"
  machine_private_key="$(cat "$KEYS_DIR/$machine_primary_id/privatekey")"

  conf_file="$CONFIGS_DIR/$node_slot_id.conf"
  {
    echo "[Interface]"
    echo "PrivateKey = $machine_private_key"
    echo "Address = ${machine_vpn_ip}/32"
    echo "ListenPort = $machine_listen_port"
    echo ""
    echo "[Peer]"
    echo "PublicKey = ${hub_public_key}"
    echo "AllowedIPs = 10.50.0.0/24"
    echo "Endpoint = ${HUB_PUBLIC_IP}:${HUB_PORT}"
    echo "PersistentKeepalive = 25"
    echo ""
  } > "$conf_file"

  echo "Generated WireGuard config: $conf_file"
done

echo "Generated WireGuard config: $hub_conf_file"
echo "WireGuard mesh artifacts written to: $OUT_DIR"
