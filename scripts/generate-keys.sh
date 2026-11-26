#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SECRETS_DIR="${PROJECT_ROOT}/infra/secrets"

mkdir -p "${SECRETS_DIR}"

PRIV_KEY="${SECRETS_DIR}/ed25519_private.pem"
PUB_KEY="${SECRETS_DIR}/ed25519_public.pem"
ENC_KEY="${SECRETS_DIR}/platform_encryption.key"

if [ ! -f "${PRIV_KEY}" ] || [ ! -f "${PUB_KEY}" ]; then
  echo "[generate-keys] Generating Ed25519 keypair in ${SECRETS_DIR}..."
  openssl genpkey -algorithm ed25519 -out "${PRIV_KEY}"
  openssl pkey -in "${PRIV_KEY}" -pubout -out "${PUB_KEY}"
  echo "[generate-keys] Keypair generated successfully."
else
  echo "[generate-keys] Keypair already exists."
fi

if [ ! -f "${ENC_KEY}" ]; then
  echo "[generate-keys] Generating 32-byte AES-256 encryption key in ${ENC_KEY}..."
  openssl rand -base64 32 | tr -d '\r\n' > "${ENC_KEY}"
  echo "[generate-keys] Encryption key generated successfully."
else
  echo "[generate-keys] Encryption key already exists."
fi

# Ensure strict permissions: chmod 600 for private and symmetric keys, 644 for public key
chmod 600 "${PRIV_KEY}"
chmod 600 "${ENC_KEY}"
chmod 644 "${PUB_KEY}"

# If running on an environment where the current user is not UID 1000 (e.g. CI runner UID 1001),
# adjust ownership to 1000:1000 so the container user 'node' (UID 1000) can read them with chmod 600
if [ "$(id -u)" != "1000" ]; then
  if command -v sudo >/dev/null 2>&1; then
    sudo chown 1000:1000 "${PRIV_KEY}" "${ENC_KEY}" "${PUB_KEY}" 2>/dev/null || true
  else
    chown 1000:1000 "${PRIV_KEY}" "${ENC_KEY}" "${PUB_KEY}" 2>/dev/null || true
  fi
fi

echo "[generate-keys] File permissions verified: private keys chmod 600, public key chmod 644."
