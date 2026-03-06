#!/usr/bin/env bash
# verify-signing-key.sh
# Run this BEFORE pushing a release tag to confirm the signing key is valid.
# It reads TAURI_SIGNING_PRIVATE_KEY exactly as GitHub Actions would, and
# validates it against the pubkey in tauri.conf.json.
#
# Usage:
#   TAURI_SIGNING_PRIVATE_KEY="$HOME/.synergy-devnet-control-panel/updater.key" ./scripts/verify-signing-key.sh
#
# Or pass the secret value directly:
#   export TAURI_SIGNING_PRIVATE_KEY="<value from GitHub secret>"
#   ./scripts/verify-signing-key.sh

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }
info() { echo -e "${YELLOW}→${NC} $1"; }

echo ""
echo "=== Tauri Signing Key Verifier ==="
echo ""

# 1. Resolve the env var to either a file path or the raw secret value
KEY_INPUT="${TAURI_SIGNING_PRIVATE_KEY:-${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.synergy-devnet-control-panel/updater.key}}"
if [[ -z "${KEY_INPUT:-}" ]]; then
  fail "TAURI_SIGNING_PRIVATE_KEY is not set and no default key exists."
fi

if [[ -f "$KEY_INPUT" ]]; then
  info "Reading updater private key from file: $KEY_INPUT"
  KEY_VALUE="$(tr -d '\r\n' < "$KEY_INPUT")"
else
  info "Reading updater private key from TAURI_SIGNING_PRIVATE_KEY"
  KEY_VALUE="$(printf '%s' "$KEY_INPUT" | tr -d '\r\n')"
fi

if [[ -z "$KEY_VALUE" ]]; then
  fail "Resolved updater key is empty."
fi

# 2. Verify it base64-decodes cleanly
DECODED=$(printf '%s' "$KEY_VALUE" | base64 -d 2>/dev/null) || \
  fail "Secret value is not valid base64. Check that it was copied correctly with no extra whitespace."

pass "Secret base64-decodes successfully"

# 3. Check it decodes to two lines (minisign format)
LINE_COUNT=$(echo "$DECODED" | wc -l | tr -d ' ')
if [[ "$LINE_COUNT" -lt 2 ]]; then
  fail "Decoded value only has ${LINE_COUNT} line(s). Expected 2 lines (untrusted comment + base64 key)."
fi
pass "Decoded value has correct two-line minisign format"

# 4. Check the decoded header is a supported Tauri/minisign secret-key format
FIRST_LINE=$(echo "$DECODED" | head -1)
if [[ "$FIRST_LINE" != "untrusted comment: "* ]] || [[ "$FIRST_LINE" != *"secret key"* ]]; then
  fail "First line is not a valid updater secret key header. Got: '$FIRST_LINE'"
fi
pass "First line is a supported updater secret key header: $FIRST_LINE"

# 5. Extract and check raw key bytes (use Python to handle null bytes correctly —
#    bash command substitution silently strips \x00, which corrupts kdf_alg check)
KEY_B64=$(echo "$DECODED" | sed -n '2p')

KEY_CHECK=$(python3 - <<PYEOF
import base64, sys

key_b64 = """$KEY_B64"""
try:
    raw = base64.b64decode(key_b64.strip())
except Exception as e:
    print(f"FAIL:Key line is not valid base64: {e}")
    sys.exit(0)

if len(raw) < 6:
    print(f"FAIL:Key too short ({len(raw)} bytes), expected at least 6")
    sys.exit(0)

sig_alg = raw[0:2].hex()
kdf_alg = raw[2:4].hex()
chk_alg = raw[4:6].hex()

print(f"SIG:{sig_alg}")
print(f"KDF:{kdf_alg}")
print(f"CHK:{chk_alg}")
PYEOF
) || fail "Python3 is required to verify key bytes"

if echo "$KEY_CHECK" | grep -q "^FAIL:"; then
  fail "$(echo "$KEY_CHECK" | grep "^FAIL:" | sed 's/^FAIL://')"
fi

pass "Raw key bytes decode successfully"

SIG_ALG=$(echo "$KEY_CHECK" | grep "^SIG:" | cut -d: -f2)
KDF_ALG=$(echo "$KEY_CHECK" | grep "^KDF:" | cut -d: -f2)

info "Signature algorithm: ${SIG_ALG} (expect: 4564 = 'Ed')"
info "KDF algorithm:       ${KDF_ALG} (expect: 0000 = no scrypt, or 5363 = scrypt with password)"

if [[ "$SIG_ALG" != "4564" ]]; then
  fail "Not an Ed25519 key (sig_alg bytes: $SIG_ALG, expected 4564)"
fi
pass "Ed25519 signature algorithm confirmed"

if [[ "$KDF_ALG" == "0000" ]]; then
  pass "KDF = none (passwordless key, no TAURI_SIGNING_PRIVATE_KEY_PASSWORD needed)"
elif [[ "$KDF_ALG" == "5363" ]]; then
  echo -e "${YELLOW}⚠${NC}  KDF = scrypt (key requires a password)"
  echo "   Set TAURI_SIGNING_PRIVATE_KEY_PASSWORD in your workflow/secrets."
  echo "   If this key was created with -W (no password), it still requires empty string ''"
else
  fail "Unknown KDF algorithm: $KDF_ALG"
fi

# 7. Extract pubkey from tauri.conf.json
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONF="$SCRIPT_DIR/../src-tauri/tauri.conf.json"
if [[ ! -f "$CONF" ]]; then
  fail "tauri.conf.json not found at $CONF"
fi

CONF_PUBKEY=$(python3 -c "
import json, sys
with open('$CONF') as f:
  c = json.load(f)
print(c['plugins']['updater']['pubkey'])
" 2>/dev/null) || fail "Could not read pubkey from tauri.conf.json"

pass "Found pubkey in tauri.conf.json: $CONF_PUBKEY"

# 8. Verify the private key can sign and that the resulting signature key_id matches the pubkey
KEY_ID_FROM_PUBKEY=$(python3 -c "
import base64, binascii
decoded = base64.b64decode('$CONF_PUBKEY').decode().splitlines()
raw = base64.b64decode(decoded[1].strip())
print(binascii.hexlify(raw[2:10]).decode().upper())
" 2>/dev/null) || fail "Could not decode pubkey from tauri.conf.json"

TMP_FILE="$(mktemp "${TMPDIR:-/tmp}/tauri-key-verify.XXXXXX")"
TMP_SIG="${TMP_FILE}.sig"
printf 'tauri-key-verification\n' > "$TMP_FILE"

SIGN_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-${TAURI_PRIVATE_KEY_PASSWORD:-}}"
SIGN_ARGS=()
if [[ -f "$KEY_INPUT" ]]; then
  SIGN_ARGS=(-f "$KEY_INPUT")
else
  SIGN_ARGS=(-k "$KEY_INPUT")
fi

SIGN_OUTPUT="$(env -u TAURI_SIGNING_PRIVATE_KEY -u TAURI_SIGNING_PRIVATE_KEY_PATH npx tauri signer sign "${SIGN_ARGS[@]}" -p "$SIGN_PASSWORD" "$TMP_FILE" 2>&1)" || {
  rm -f "$TMP_FILE" "$TMP_SIG"
  fail "Could not sign a test payload with the updater private key. Signer output: $SIGN_OUTPUT"
}

if [[ ! -f "$TMP_SIG" ]]; then
  rm -f "$TMP_FILE"
  fail "Signer completed but did not produce a signature file at $TMP_SIG"
fi

KEY_ID_FROM_SIGNATURE=$(python3 - <<PYEOF
import base64
import binascii
from pathlib import Path

sig_b64 = Path("$TMP_SIG").read_text(encoding="utf-8").strip()
decoded = base64.b64decode(sig_b64).decode().splitlines()
raw = base64.b64decode(decoded[1].strip())
print(binascii.hexlify(raw[2:10]).decode().upper(), end="")
PYEOF
) || {
  rm -f "$TMP_FILE" "$TMP_SIG"
  fail "Could not decode key id from generated signature."
}

rm -f "$TMP_FILE" "$TMP_SIG"

if [[ "$(echo "$KEY_ID_FROM_SIGNATURE" | tr '[:upper:]' '[:lower:]')" == "$(echo "$KEY_ID_FROM_PUBKEY" | tr '[:upper:]' '[:lower:]')" ]]; then
  pass "Key IDs match: $KEY_ID_FROM_SIGNATURE"
else
  fail "KEY ID MISMATCH!
  Signature key ID: $KEY_ID_FROM_SIGNATURE
  Public key ID:    $KEY_ID_FROM_PUBKEY
  The pubkey in tauri.conf.json does not match this private key."
fi

echo ""
echo -e "${GREEN}All checks passed. This key is ready for CI.${NC}"
echo ""
