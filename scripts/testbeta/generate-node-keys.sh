#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INVENTORY_FILE="$ROOT_DIR/testbeta/runtime/node-inventory.csv"
KEY_DIR="$ROOT_DIR/testbeta/runtime/keys"
FORCE="false"
HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"
BINARY_OVERRIDE="${SYNERGY_TESTBETA_BINARY:-}"
SOURCE_REPO_ROOT="${SYNERGY_TESTBETA_SOURCE_REPO_ROOT:-$(cd "$ROOT_DIR/../.." && pwd)}"
BINARY=""
BINARY_SOURCE=""

if [[ "${1:-}" == "--force" ]]; then
  FORCE="true"
fi

if [[ ! -f "$INVENTORY_FILE" ]]; then
  echo "Missing inventory file: $INVENTORY_FILE" >&2
  exit 1
fi

resolve_binary() {
  if [[ -n "$BINARY_OVERRIDE" ]]; then
    if [[ ! -x "$BINARY_OVERRIDE" ]]; then
      echo "Configured synergy-testbeta binary is not executable: $BINARY_OVERRIDE" >&2
      exit 1
    fi
    BINARY="$BINARY_OVERRIDE"
    return
  fi

  case "${HOST_OS}:${HOST_ARCH}" in
    Darwin:arm64)
      if [[ -x "$SOURCE_REPO_ROOT/target/release/synergy-testbeta" ]]; then
        BINARY="$SOURCE_REPO_ROOT/target/release/synergy-testbeta"
        BINARY_SOURCE="source-repo(target/release/synergy-testbeta)"
      else
        BINARY="$ROOT_DIR/binaries/synergy-testbeta-darwin-arm64"
        BINARY_SOURCE="bundled(binaries/synergy-testbeta-darwin-arm64)"
      fi
      ;;
    Linux:x86_64)
      if [[ -x "$SOURCE_REPO_ROOT/target/release/synergy-testbeta" ]]; then
        BINARY="$SOURCE_REPO_ROOT/target/release/synergy-testbeta"
        BINARY_SOURCE="source-repo(target/release/synergy-testbeta)"
      else
        BINARY="$ROOT_DIR/binaries/synergy-testbeta-linux-amd64"
        BINARY_SOURCE="bundled(binaries/synergy-testbeta-linux-amd64)"
      fi
      ;;
    Linux:aarch64|Linux:arm64)
      if [[ -x "$SOURCE_REPO_ROOT/target/release/synergy-testbeta" ]]; then
        BINARY="$SOURCE_REPO_ROOT/target/release/synergy-testbeta"
        BINARY_SOURCE="source-repo(target/release/synergy-testbeta)"
      else
        BINARY="$ROOT_DIR/binaries/synergy-testbeta-linux-arm64"
        BINARY_SOURCE="bundled(binaries/synergy-testbeta-linux-arm64)"
      fi
      ;;
    MINGW*:x86_64|MSYS*:x86_64|CYGWIN*:x86_64)
      if [[ -x "$SOURCE_REPO_ROOT/target/release/synergy-testbeta.exe" ]]; then
        BINARY="$SOURCE_REPO_ROOT/target/release/synergy-testbeta.exe"
        BINARY_SOURCE="source-repo(target/release/synergy-testbeta.exe)"
      else
        BINARY="$ROOT_DIR/binaries/synergy-testbeta-windows-amd64.exe"
        BINARY_SOURCE="bundled(binaries/synergy-testbeta-windows-amd64.exe)"
      fi
      ;;
    *)
      echo "Unsupported host platform for node key generation: ${HOST_OS}/${HOST_ARCH}" >&2
      exit 1
      ;;
  esac

  if [[ ! -x "$BINARY" ]]; then
    echo "synergy-testbeta binary not found or not executable at $BINARY" >&2
    if [[ -n "$BINARY_SOURCE" ]]; then
      echo "Resolved source: $BINARY_SOURCE" >&2
    fi
    echo "Set SYNERGY_TESTBETA_BINARY to a valid platform binary if needed." >&2
    exit 1
  fi
}

resolve_binary

mkdir -p "$KEY_DIR"
ADDRESS_REPORT="$KEY_DIR/node-addresses.csv"
echo "node_slot_id,node_alias,role,node_type,address_class,address" > "$ADDRESS_REPORT"

derive_address_from_public_key() {
  local public_key_file="$1"
  local address_class="$2"

  python3 - "$public_key_file" "$address_class" <<'PY'
import base64
import hashlib
import sys

public_key_file = sys.argv[1]
address_class = int(sys.argv[2])

with open(public_key_file, "r", encoding="utf-8") as f:
    public_key_text = f.read().strip()

try:
    public_key_bytes = base64.b64decode(public_key_text, validate=True)
except Exception:
    # Fallback for non-base64 legacy key files.
    public_key_bytes = public_key_text.encode("utf-8")

digest = hashlib.sha3_256(public_key_bytes).hexdigest()
print(f"synv{address_class}{digest[:36]}")
PY
}

write_identity_files() {
  local node_key_dir="$1"
  local node_slot_id="$2"
  local node_alias="$3"
  local role="$4"
  local node_type="$5"
  local address_class="$6"
  local address="$7"
  local public_key="$8"
  local private_key="$9"

  cat > "$node_key_dir/identity.json" <<JSON
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
JSON

  cat > "$node_key_dir/identity.toml" <<TOML
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
TOML

  cat > "$node_key_dir/node.env" <<ENV
NODE_SLOT_ID=$node_slot_id
NODE_ALIAS=$node_alias
ROLE=$role
NODE_TYPE=$node_type
ADDRESS_CLASS=$address_class
NODE_ADDRESS=$address
PUBLIC_KEY_FILE=public.key
PRIVATE_KEY_FILE=private.key
ENV
}

while IFS=, read -r node_slot_id node_alias _ role node_type address_class _ _ _ _ _ _ _ _ _ _ || [[ -n "${node_slot_id:-}" ]]; do
  [[ "$node_slot_id" == "node_slot_id" ]] && continue

  node_key_dir="$KEY_DIR/$node_slot_id"

  if [[ -f "$node_key_dir/private.key" && "$FORCE" != "true" ]]; then
    if [[ ! -f "$node_key_dir/public.key" ]]; then
      echo "Skipping $node_slot_id (existing key directory is missing public.key). Use --force to regenerate." >&2
      continue
    fi
    echo "Reusing existing keys for $node_slot_id"
  else
    rm -rf "$node_key_dir"
    mkdir -p "$node_key_dir"
    "$BINARY" generate-keypair --class "$address_class" --output "$node_key_dir" >/dev/null
    echo "Generated keys for $node_slot_id ($node_type)"
  fi

  public_key="$(cat "$node_key_dir/public.key")"
  private_key="$(cat "$node_key_dir/private.key")"
  address="$(derive_address_from_public_key "$node_key_dir/public.key" "$address_class")"
  echo "$address" > "$node_key_dir/address.txt"
  write_identity_files \
    "$node_key_dir" \
    "$node_slot_id" \
    "$node_alias" \
    "$role" \
    "$node_type" \
    "$address_class" \
    "$address" \
    "$public_key" \
    "$private_key"

  echo "$node_slot_id,$node_alias,$role,$node_type,$address_class,$address" >> "$ADDRESS_REPORT"
done < "$INVENTORY_FILE"

echo "Key generation complete."
echo "Address report: $ADDRESS_REPORT"
