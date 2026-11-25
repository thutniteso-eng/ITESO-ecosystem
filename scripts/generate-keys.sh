#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SECRETS_DIR="${PROJECT_ROOT}/infra/secrets"

mkdir -p "${SECRETS_DIR}"

PRIV_KEY="${SECRETS_DIR}/ed25519_private.pem"
PUB_KEY="${SECRETS_DIR}/ed25519_public.pem"

if [ ! -f "${PRIV_KEY}" ] || [ ! -f "${PUB_KEY}" ]; then
  echo "[generate-keys] Generating Ed25519 keypair in ${SECRETS_DIR}..."
  openssl genpkey -algorithm ed25519 -out "${PRIV_KEY}"
  openssl pkey -in "${PRIV_KEY}" -pubout -out "${PUB_KEY}"
  chmod 644 "${PRIV_KEY}"
  chmod 644 "${PUB_KEY}"
  echo "[generate-keys] Keypair generated successfully."
else
  echo "[generate-keys] Keypair already exists, skipping generation."
fi
