#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG_DIR="${1:-$ROOT_DIR/testbeta/lean15/configs}"
INVENTORY_FILE="$ROOT_DIR/testbeta/lean15/node-inventory.csv"

if [[ ! -d "$CONFIG_DIR" ]]; then
  echo "Config directory not found: $CONFIG_DIR" >&2
  exit 1
fi

if [[ ! -f "$INVENTORY_FILE" ]]; then
  echo "Inventory file not found: $INVENTORY_FILE" >&2
  exit 1
fi

is_private_host() {
  local host="$1"
  if [[ "$host" == "localhost" ]]; then
    return 0
  fi
  if [[ "$host" =~ ^127\. ]]; then
    return 0
  fi
  if [[ "$host" =~ ^10\. ]]; then
    return 0
  fi
  if [[ "$host" =~ ^192\.168\. ]]; then
    return 0
  fi
  if [[ "$host" =~ ^172\.([1][6-9]|2[0-9]|3[0-1])\. ]]; then
    return 0
  fi
  if [[ "$host" =~ \.internal$ ]]; then
    return 0
  fi
  return 1
}

extract_toml_string() {
  local key="$1"
  local file="$2"
  sed -n "s/^${key} = \"\\([^\"]*\\)\"$/\\1/p" "$file" | head -n 1
}

extract_bootnode_hosts() {
  local file="$1"
  local line
  line="$(sed -n 's/^bootnodes = //p' "$file" | head -n 1)"
  if [[ -z "$line" || "$line" == "[]" ]]; then
    return 0
  fi
  echo "$line" | grep -oE '@[^",\]]+' | sed 's/^@//' | cut -d: -f1
}

failures=0
checked=0

for config in "$CONFIG_DIR"/node-*.toml; do
  [[ -f "$config" ]] || continue
  checked=$((checked + 1))
  name="$(basename "$config")"

  if ! rg -q '^name = "synergy-testnet-beta"$' "$config"; then
    echo "[$name] network name is not synergy-testnet-beta" >&2
    failures=$((failures + 1))
  fi

  if ! rg -q '^enable_discovery = false$' "$config"; then
    echo "[$name] p2p discovery must be disabled" >&2
    failures=$((failures + 1))
  fi

  if ! rg -q '^cors_enabled = false$' "$config"; then
    echo "[$name] rpc cors_enabled must be false" >&2
    failures=$((failures + 1))
  fi

  if ! rg -q '^cors_origins = \[\]$' "$config"; then
    echo "[$name] rpc cors_origins must be []" >&2
    failures=$((failures + 1))
  fi

  for key in bind_address listen_address public_address; do
    value="$(extract_toml_string "$key" "$config")"
    if [[ -z "$value" ]]; then
      echo "[$name] missing ${key}" >&2
      failures=$((failures + 1))
      continue
    fi
    host="${value%:*}"
    if ! is_private_host "$host"; then
      echo "[$name] ${key} host is not private/internal: ${host}" >&2
      failures=$((failures + 1))
    fi
  done

  while IFS= read -r boot_host; do
    [[ -z "$boot_host" ]] && continue
    if ! is_private_host "$boot_host"; then
      echo "[$name] bootnode host is not private/internal: ${boot_host}" >&2
      failures=$((failures + 1))
    fi
  done < <(extract_bootnode_hosts "$config")
done

validator_count="$(
  awk -F, '
    NR == 1 {
      for (i = 1; i <= NF; i++) {
        header[$i] = i
      }
      next
    }
    {
      idx = header["auto_register_validator"]
      if (!idx) {
        next
      }
      v = tolower($(idx))
      if (v == "true" || v == "1" || v == "yes") {
        c++
      }
    }
    END { print c + 0 }
  ' "$INVENTORY_FILE"
)"
if (( validator_count < 3 )); then
  echo "[inventory] requires at least 3 validators, found ${validator_count}" >&2
  failures=$((failures + 1))
fi

if (( checked == 0 )); then
  echo "No node config files found in $CONFIG_DIR" >&2
  exit 1
fi

if (( failures > 0 )); then
  echo "Closed-testbeta validation failed (${failures} issue(s))." >&2
  exit 2
fi

echo "Closed-testbeta validation passed (${checked} config files checked, validators=${validator_count})."
