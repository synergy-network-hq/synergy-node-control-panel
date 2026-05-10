#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INVENTORY_FILE="$ROOT_DIR/testbeta/runtime/node-inventory.csv"
KEY_DIR="$ROOT_DIR/testbeta/runtime/keys"
FORCE="false"
HOST_OS="$(uname -s)"
HOST_ARCH="$(uname -m)"
BINARY_OVERRIDE="${SYNERGY_TESTBETA_BINARY:-}"
SOURCE_REPO_ROOT="${SYNERGY_TESTBETA_SOURCE_REPO_ROOT:-$(cd "$ROOT_DIR/.." && pwd)}"
ADDRESS_ENGINE_MANIFEST="$ROOT_DIR/synergy-address-engine/Cargo.toml"
TESTBETA_ENV_DIR_DEFAULT="${TESTBETA_ENV_DIR_DEFAULT:-$ROOT_DIR/testbeta/runtime/env-files}"
ENV_OVERRIDE_HELPER="${ENV_OVERRIDE_HELPER:-$ROOT_DIR/../scripts/testbeta/testbeta-env-overrides.sh}"
BINARY=""
BINARY_SOURCE=""

if [[ "${1:-}" == "--force" ]]; then
  FORCE="true"
fi

if [[ ! -f "$INVENTORY_FILE" ]]; then
  echo "Missing inventory file: $INVENTORY_FILE" >&2
  exit 1
fi

if [[ ! -f "$ADDRESS_ENGINE_MANIFEST" ]]; then
  echo "Missing address engine manifest: $ADDRESS_ENGINE_MANIFEST" >&2
  exit 1
fi

if [[ -f "$ENV_OVERRIDE_HELPER" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_OVERRIDE_HELPER"
fi

generate_identity_with_address_engine() {
  local address_class="$1"
  local label="$2"
  local output_dir="$3"
  local address_type="node-class-${address_class}"

  if [[ "$address_class" == "1" ]]; then
    address_type="validator"
  fi

  cargo run --quiet --manifest-path "$ADDRESS_ENGINE_MANIFEST" --bin generate-identity -- \
    --address-type "$address_type" \
    --label "$label" \
    --output-dir "$output_dir" >/dev/null
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
    BINARY=""
    BINARY_SOURCE="address-engine-fallback"
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

populate_identity_from_setup_package() {
  local package_file="$1"
  local node_key_dir="$2"
  local node_slot_id="$3"
  local node_alias="$4"
  local role="$5"
  local node_type="$6"
  local address_class="$7"

  python3 - "$package_file" "$node_key_dir" "$node_slot_id" "$node_alias" "$role" "$node_type" "$address_class" <<'PY'
import json
import pathlib
import sys

package_file, node_key_dir, node_slot_id, node_alias, role, node_type, address_class = sys.argv[1:]

with open(package_file, encoding="utf-8") as handle:
    package = json.load(handle)

runtime_identity = package.get("runtime_identity") or {}
validator_public = package.get("validator_public") or {}

address = str(runtime_identity.get("address") or validator_public.get("address") or "").strip()
public_key = str(runtime_identity.get("public_key") or validator_public.get("public_key") or "").strip()
private_key = str(runtime_identity.get("private_key") or "").strip()

if not address:
    raise SystemExit(f"Missing runtime address in setup package: {package_file}")
if not public_key:
    raise SystemExit(f"Missing runtime public key in setup package: {package_file}")
if not private_key:
    raise SystemExit(f"Missing runtime private key in setup package: {package_file}")

out_dir = pathlib.Path(node_key_dir)
out_dir.mkdir(parents=True, exist_ok=True)
out_dir.joinpath("address.txt").write_text(address + "\n", encoding="utf-8")
out_dir.joinpath("public.key").write_text(public_key + "\n", encoding="utf-8")
out_dir.joinpath("private.key").write_text(private_key + "\n", encoding="utf-8")

identity_json = {
    "node_slot_id": node_slot_id,
    "node_alias": node_alias,
    "role": role,
    "node_type": node_type,
    "address_class": int(address_class) if str(address_class).isdigit() else address_class,
    "address": address,
    "public_key": public_key,
    "private_key": private_key,
}
out_dir.joinpath("identity.json").write_text(json.dumps(identity_json, indent=2) + "\n", encoding="utf-8")

identity_toml = "\n".join([
    f'node_slot_id = "{node_slot_id}"',
    f'node_alias = "{node_alias}"',
    f'role = "{role}"',
    f'node_type = "{node_type}"',
    f'address_class = {address_class}',
    "",
    "[address]",
    f'value = "{address}"',
    "",
    "[keys]",
    f'public_key = "{public_key}"',
    f'private_key = "{private_key}"',
    "",
])
out_dir.joinpath("identity.toml").write_text(identity_toml, encoding="utf-8")

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
out_dir.joinpath("node.env").write_text(node_env, encoding="utf-8")
PY
}

while IFS=, read -r node_slot_id node_alias _ role node_type address_class _ _ _ _ _ _ _ _ _ _ || [[ -n "${node_slot_id:-}" ]]; do
  [[ "$node_slot_id" == "node_slot_id" ]] && continue
  if [[ "$address_class" != [1-5] ]]; then
    echo "Skipping $node_slot_id ($node_type) because address_class=$address_class is not provisionable by the runtime key generator."
    continue
  fi

  node_key_dir="$KEY_DIR/$node_slot_id"
  setup_package_file="$(resolve_setup_package_file "$node_slot_id" "$node_type" "$role" "$node_alias" || true)"

  if [[ -f "$node_key_dir/private.key" && "$FORCE" != "true" ]]; then
    if [[ ! -f "$node_key_dir/public.key" ]]; then
      echo "Skipping $node_slot_id (existing key directory is missing public.key). Use --force to regenerate." >&2
      continue
    fi
    echo "Reusing existing keys for $node_slot_id"
  elif [[ -n "$setup_package_file" && -f "$setup_package_file" ]]; then
    rm -rf "$node_key_dir"
    mkdir -p "$node_key_dir"
    populate_identity_from_setup_package \
      "$setup_package_file" \
      "$node_key_dir" \
      "$node_slot_id" \
      "$node_alias" \
      "$role" \
      "$node_type" \
      "$address_class"
    echo "Loaded canonical identity for $node_slot_id from $(basename "$setup_package_file")"
  else
    rm -rf "$node_key_dir"
    mkdir -p "$node_key_dir"
    if [[ -n "$BINARY" ]]; then
      "$BINARY" generate-keypair --class "$address_class" --output "$node_key_dir" >/dev/null
    else
      generate_identity_with_address_engine "$address_class" "$node_alias Identity" "$node_key_dir"
    fi
    echo "Generated keys for $node_slot_id ($node_type)"
  fi

  public_key="$(cat "$node_key_dir/public.key")"
  private_key="$(cat "$node_key_dir/private.key")"
  address="$(tr -d '\r\n' < "$node_key_dir/address.txt" 2>/dev/null || true)"
  if [[ -z "$address" ]]; then
    address="$(derive_address_from_public_key "$node_key_dir/public.key" "$address_class")"
  fi
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
