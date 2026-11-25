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

echo "[test-db-isolation] PASS: All database isolation checks passed cleanly."
