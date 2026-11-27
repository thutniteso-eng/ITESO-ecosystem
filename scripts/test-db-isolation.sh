#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env"
COMPOSE_FILE="$ROOT_DIR/infra/docker-compose.yml"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: .env not found. Run: cp .env.example .env" >&2
  exit 1
fi

set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

PLATFORM_DB="${PLATFORM_DB:-platform}"
TENANT_DB="${DEMO_TENANT_DB:-t_demo_fnb}"
GW_USER="${POSTGRES_GATEWAY_USER:-iteso_gateway}"
GW_PASS="${POSTGRES_GATEWAY_PASSWORD:?POSTGRES_GATEWAY_PASSWORD is required in .env}"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

echo "[test-db-isolation] Verifying '${GW_USER}' can connect to '${PLATFORM_DB}' and SELECT tenants..."
compose exec -T -e PGPASSWORD="$GW_PASS" postgres \
  psql -U "$GW_USER" -d "$PLATFORM_DB" -tAc "SELECT count(*) FROM tenants WHERE code = 'demo_fnb'" | grep -qx "[1-9][0-9]*"

echo "[test-db-isolation] Verifying '${GW_USER}' is DENIED access to '${TENANT_DB}' (res_users)..."
set +e
ERR_OUT="$(compose exec -T -e PGPASSWORD="$GW_PASS" postgres \
  psql -U "$GW_USER" -d "$TENANT_DB" -c "SELECT id, login FROM res_users LIMIT 1;" 2>&1)"
STATUS=$?
set -e

if [ "$STATUS" -eq 0 ]; then
  echo "ERROR: '${GW_USER}' unexpectedly succeeded reading res_users in '${TENANT_DB}'!" >&2
  exit 1
fi

# TASK-002 requirement: Verify output explicitly contains 'permission denied'
if ! echo "$ERR_OUT" | grep -qi "permission denied"; then
  echo "ERROR: '${GW_USER}' error output does not contain 'permission denied'. Got: ${ERR_OUT}" >&2
  exit 1
fi

echo "[test-db-isolation] Verifying '${GW_USER}' cannot write to '${PLATFORM_DB}'..."
set +e
WRITE_ERR="$(compose exec -T -e PGPASSWORD="$GW_PASS" postgres \
  psql -U "$GW_USER" -d "$PLATFORM_DB" -c "INSERT INTO tenants(id, code, db_name, display_name) VALUES (gen_random_uuid(), 'hack', 't_hack', 'Hack');" 2>&1)"
WRITE_STATUS=$?
set -e

if [ "$WRITE_STATUS" -eq 0 ]; then
  echo "ERROR: '${GW_USER}' unexpectedly succeeded inserting into tenants table in '${PLATFORM_DB}'!" >&2
  exit 1
fi
if ! echo "$WRITE_ERR" | grep -qi "permission denied"; then
  echo "ERROR: '${GW_USER}' write attempt error does not contain 'permission denied'. Got: ${WRITE_ERR}" >&2
  exit 1
fi

echo "[test-db-isolation] Verifying '${GW_USER}' cannot SELECT from 'admin_audit_log' in '${PLATFORM_DB}'..."
set +e
AUDIT_ERR="$(compose exec -T -e PGPASSWORD="$GW_PASS" postgres \
  psql -U "$GW_USER" -d "$PLATFORM_DB" -c "SELECT * FROM admin_audit_log LIMIT 1;" 2>&1)"
AUDIT_STATUS=$?
set -e

if [ "$AUDIT_STATUS" -eq 0 ]; then
  echo "ERROR: '${GW_USER}' unexpectedly succeeded reading admin_audit_log in '${PLATFORM_DB}'!" >&2
  exit 1
fi
if ! echo "$AUDIT_ERR" | grep -qi "permission denied"; then
  echo "ERROR: '${GW_USER}' audit log read attempt error does not contain 'permission denied'. Got: ${AUDIT_ERR}" >&2
  exit 1
fi

echo "[test-db-isolation] Verifying '${GW_USER}' cannot SELECT from 'accounts' in '${PLATFORM_DB}'..."
set +e
ACC_ERR="$(compose exec -T -e PGPASSWORD="$GW_PASS" postgres \
  psql -U "$GW_USER" -d "$PLATFORM_DB" -c "SELECT * FROM accounts LIMIT 1;" 2>&1)"
ACC_STATUS=$?
set -e

if [ "$ACC_STATUS" -eq 0 ]; then
  echo "ERROR: '${GW_USER}' unexpectedly succeeded reading accounts in '${PLATFORM_DB}'!" >&2
  exit 1
fi
if ! echo "$ACC_ERR" | grep -qi "permission denied"; then
  echo "ERROR: '${GW_USER}' accounts read attempt error does not contain 'permission denied'. Got: ${ACC_ERR}" >&2
  exit 1
fi

echo "[test-db-isolation] Verifying '${GW_USER}' can SELECT the 6 permitted columns from 'membership_odoo_users' in '${PLATFORM_DB}'..."
compose exec -T -e PGPASSWORD="$GW_PASS" postgres \
  psql -U "$GW_USER" -d "$PLATFORM_DB" -c "SELECT membership_id, tenant_id, odoo_uid, api_key_enc, key_expires_at, status FROM membership_odoo_users LIMIT 1;" >/dev/null

echo "[test-db-isolation] Verifying '${GW_USER}' CANNOT SELECT unpermitted column 'last_error' or 'synced_at' on 'membership_odoo_users'..."
set +e
COL_ERR="$(compose exec -T -e PGPASSWORD="$GW_PASS" postgres \
  psql -U "$GW_USER" -d "$PLATFORM_DB" -c "SELECT last_error FROM membership_odoo_users LIMIT 1;" 2>&1)"
COL_STATUS=$?
set -e
if [ "$COL_STATUS" -eq 0 ]; then
  echo "ERROR: '${GW_USER}' unexpectedly succeeded reading last_error from membership_odoo_users!" >&2
  exit 1
fi
if ! echo "$COL_ERR" | grep -qi "permission denied"; then
  echo "ERROR: '${GW_USER}' column read error does not contain 'permission denied'. Got: ${COL_ERR}" >&2
  exit 1
fi

echo "[test-db-isolation] Verifying '${GW_USER}' CANNOT SELECT from 'tenant_odoo_system_keys' in '${PLATFORM_DB}'..."
set +e
SYS_KEY_ERR="$(compose exec -T -e PGPASSWORD="$GW_PASS" postgres \
  psql -U "$GW_USER" -d "$PLATFORM_DB" -c "SELECT key_enc FROM tenant_odoo_system_keys LIMIT 1;" 2>&1)"
SYS_KEY_STATUS=$?
set -e
if [ "$SYS_KEY_STATUS" -eq 0 ]; then
  echo "ERROR: '${GW_USER}' unexpectedly succeeded reading tenant_odoo_system_keys!" >&2
  exit 1
fi
if ! echo "$SYS_KEY_ERR" | grep -qi "permission denied"; then
  echo "ERROR: '${GW_USER}' system key read error does not contain 'permission denied'. Got: ${SYS_KEY_ERR}" >&2
  exit 1
fi

echo "[test-db-isolation] Verifying '${GW_USER}' CANNOT SELECT from 'refresh_tokens' in '${PLATFORM_DB}'..."
set +e
RT_ERR="$(compose exec -T -e PGPASSWORD="$GW_PASS" postgres \
  psql -U "$GW_USER" -d "$PLATFORM_DB" -c "SELECT token_hash FROM refresh_tokens LIMIT 1;" 2>&1)"
RT_STATUS=$?
set -e
if [ "$RT_STATUS" -eq 0 ]; then
  echo "ERROR: '${GW_USER}' unexpectedly succeeded reading refresh_tokens!" >&2
  exit 1
fi
if ! echo "$RT_ERR" | grep -qi "permission denied"; then
  echo "ERROR: '${GW_USER}' refresh token read error does not contain 'permission denied'. Got: ${RT_ERR}" >&2
  exit 1
fi

echo "[test-db-isolation] Verifying '${GW_USER}' can SELECT permitted 4 columns from 'pos_devices' in '${PLATFORM_DB}'..."
compose exec -T -e PGPASSWORD="$GW_PASS" postgres \
  psql -U "$GW_USER" -d "$PLATFORM_DB" -c "SELECT id, tenant_id, branch_id, status FROM pos_devices LIMIT 1;" >/dev/null

echo "[test-db-isolation] Verifying '${GW_USER}' CANNOT SELECT unpermitted column 'token_hash' on 'pos_devices'..."
set +e
POS_DEV_COL_ERR="$(compose exec -T -e PGPASSWORD="$GW_PASS" postgres \
  psql -U "$GW_USER" -d "$PLATFORM_DB" -c "SELECT token_hash FROM pos_devices LIMIT 1;" 2>&1)"
POS_DEV_COL_STATUS=$?
set -e
if [ "$POS_DEV_COL_STATUS" -eq 0 ]; then
  echo "ERROR: '${GW_USER}' unexpectedly succeeded reading token_hash from pos_devices!" >&2
  exit 1
fi
if ! echo "$POS_DEV_COL_ERR" | grep -qi "permission denied"; then
  echo "ERROR: '${GW_USER}' pos_devices column read error does not contain 'permission denied'. Got: ${POS_DEV_COL_ERR}" >&2
  exit 1
fi

echo "[test-db-isolation] Verifying '${GW_USER}' CANNOT SELECT from 'branches' in '${PLATFORM_DB}'..."
set +e
BRANCH_ERR="$(compose exec -T -e PGPASSWORD="$GW_PASS" postgres \
  psql -U "$GW_USER" -d "$PLATFORM_DB" -c "SELECT * FROM branches LIMIT 1;" 2>&1)"
BRANCH_STATUS=$?
set -e
if [ "$BRANCH_STATUS" -eq 0 ]; then
  echo "ERROR: '${GW_USER}' unexpectedly succeeded reading branches!" >&2
  exit 1
fi
if ! echo "$BRANCH_ERR" | grep -qi "permission denied"; then
  echo "ERROR: '${GW_USER}' branches read error does not contain 'permission denied'. Got: ${BRANCH_ERR}" >&2
  exit 1
fi

echo "[test-db-isolation] Verifying '${GW_USER}' CANNOT SELECT from 'pos_pairing_codes' in '${PLATFORM_DB}'..."
set +e
PAIR_ERR="$(compose exec -T -e PGPASSWORD="$GW_PASS" postgres \
  psql -U "$GW_USER" -d "$PLATFORM_DB" -c "SELECT * FROM pos_pairing_codes LIMIT 1;" 2>&1)"
PAIR_STATUS=$?
set -e
if [ "$PAIR_STATUS" -eq 0 ]; then
  echo "ERROR: '${GW_USER}' unexpectedly succeeded reading pos_pairing_codes!" >&2
  exit 1
fi
if ! echo "$PAIR_ERR" | grep -qi "permission denied"; then
  echo "ERROR: '${GW_USER}' pos_pairing_codes read error does not contain 'permission denied'. Got: ${PAIR_ERR}" >&2
  exit 1
fi

echo "[test-db-isolation] Verifying '${GW_USER}' CANNOT SELECT from 'membership_pins' in '${PLATFORM_DB}'..."
set +e
PIN_ERR="$(compose exec -T -e PGPASSWORD="$GW_PASS" postgres \
  psql -U "$GW_USER" -d "$PLATFORM_DB" -c "SELECT * FROM membership_pins LIMIT 1;" 2>&1)"
PIN_STATUS=$?
set -e
if [ "$PIN_STATUS" -eq 0 ]; then
  echo "ERROR: '${GW_USER}' unexpectedly succeeded reading membership_pins!" >&2
  exit 1
fi
if ! echo "$PIN_ERR" | grep -qi "permission denied"; then
  echo "ERROR: '${GW_USER}' membership_pins read error does not contain 'permission denied'. Got: ${PIN_ERR}" >&2
  exit 1
fi

echo "[test-db-isolation] PASS: All database isolation checks passed cleanly."
