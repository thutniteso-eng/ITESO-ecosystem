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

PG_DB="${POSTGRES_DB:-postgres}"
TENANT_DB="${DEMO_TENANT_DB:-t_demo_fnb}"
GW_USER="${POSTGRES_GATEWAY_USER:-iteso_gateway}"
GW_PASS="${POSTGRES_GATEWAY_PASSWORD:?POSTGRES_GATEWAY_PASSWORD is required in .env}"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

echo "[test-db-isolation] Verifying '${GW_USER}' can connect to '${PG_DB}' and query pg_database..."
compose exec -T -e PGPASSWORD="$GW_PASS" postgres \
  psql -U "$GW_USER" -d "$PG_DB" -tAc "SELECT 1 FROM pg_database WHERE datname = '${TENANT_DB}'" | grep -qx "1"

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

echo "[test-db-isolation] PASS: '${GW_USER}' was rejected from '${TENANT_DB}': ${ERR_OUT}"
