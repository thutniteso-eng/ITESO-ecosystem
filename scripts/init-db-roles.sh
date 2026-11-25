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

PG_USER="${POSTGRES_USER:-odoo}"
PG_DB="${POSTGRES_DB:-postgres}"
GW_USER="${POSTGRES_GATEWAY_USER:-iteso_gateway}"
GW_PASS="${POSTGRES_GATEWAY_PASSWORD:?POSTGRES_GATEWAY_PASSWORD is required in .env}"

if [[ ! "$GW_USER" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "ERROR: Invalid POSTGRES_GATEWAY_USER '${GW_USER}'" >&2
  exit 1
fi

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

echo "[init-db-roles] Ensuring least-privilege role '${GW_USER}' exists..."
compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U "$PG_USER" \
  -d "$PG_DB" \
  -v gw_user="$GW_USER" \
  -v gw_pass="$GW_PASS" \
  -v pg_db="$PG_DB" <<'SQL'
SELECT format(
  'CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',
  :'gw_user', :'gw_pass'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'gw_user')
\gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',
  :'gw_user', :'gw_pass'
)
\gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'pg_db', :'gw_user')
\gexec

SELECT format('REVOKE ALL ON SCHEMA public FROM %I', :'gw_user')
\gexec
SQL

echo "[init-db-roles] Role '${GW_USER}' is configured (LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE, CONNECT on '${PG_DB}' only)."
