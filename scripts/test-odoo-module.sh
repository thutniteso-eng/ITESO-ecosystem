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

TEST_DB="t_test_iteso_base"
PG_USER="${POSTGRES_USER:-odoo}"
PG_DB="${POSTGRES_DB:-postgres}"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  compose exec -T postgres psql -U "$PG_USER" -d "$PG_DB" -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB}' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
  compose exec -T postgres psql -U "$PG_USER" -d "$PG_DB" -c \
    "DROP DATABASE IF EXISTS \"${TEST_DB}\";" >/dev/null 2>&1 || true
}

trap cleanup EXIT

echo "[test-odoo-module] Dropping any leftover '${TEST_DB}'..."
cleanup

echo "[test-odoo-module] Installing 'iteso_base' and 'iteso_sync' into fresh database '${TEST_DB}'..."
compose exec -T odoo odoo \
  -c /tmp/odoo.conf \
  -d "$TEST_DB" \
  -i iteso_base,iteso_sync \
  --stop-after-init \
  --no-http

# Secure test tenant DB using shared helper script
"$ROOT_DIR/scripts/lib/secure-tenant-db.sh" "$TEST_DB"

for MOD in iteso_base iteso_sync; do
  STATE="$(compose exec -T postgres psql -U "$PG_USER" -d "$TEST_DB" -tAc "SELECT state FROM ir_module_module WHERE name = '$MOD'" | tr -d '[:space:]')"
  if [ "$STATE" != "installed" ]; then
    echo "ERROR: expected $MOD state='installed', got '${STATE}'" >&2
    exit 1
  fi
  echo "[test-odoo-module] PASS: $MOD installed cleanly in '${TEST_DB}' (state=${STATE})."
done

echo "[test-odoo-module] Running automated unit tests (--test-enable --test-tags /iteso_base,/iteso_sync)..."
compose exec -T odoo odoo \
  -c /tmp/odoo.conf \
  -d "$TEST_DB" \
  --test-enable \
  --test-tags /iteso_base,/iteso_sync \
  --stop-after-init \
  --no-http

echo "[test-odoo-module] ALL TESTS PASSED for iteso_base and iteso_sync."
