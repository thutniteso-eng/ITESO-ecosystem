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
CP_USER="${POSTGRES_CONTROL_PLANE_USER:-iteso_control_plane}"
CP_PASS="${POSTGRES_CONTROL_PLANE_PASSWORD:?POSTGRES_CONTROL_PLANE_PASSWORD is required in .env}"
PLATFORM_DB="${PLATFORM_DB:-platform}"

if [[ ! "$GW_USER" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "ERROR: Invalid POSTGRES_GATEWAY_USER '${GW_USER}'" >&2
  exit 1
fi

if [[ ! "$CP_USER" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "ERROR: Invalid POSTGRES_CONTROL_PLANE_USER '${CP_USER}'" >&2
  exit 1
fi

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

echo "[init-db-roles] Configuring PostgreSQL roles and databases..."
compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U "$PG_USER" \
  -d "$PG_DB" \
  -v gw_user="$GW_USER" \
  -v gw_pass="$GW_PASS" \
  -v cp_user="$CP_USER" \
  -v cp_pass="$CP_PASS" \
  -v platform_db="$PLATFORM_DB" <<'SQL'
-- 1. Create or update iteso_control_plane role
SELECT format(
  'CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',
  :'cp_user', :'cp_pass'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'cp_user')
\gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L',
  :'cp_user', :'cp_pass'
)
\gexec

-- 2. Create or update iteso_gateway role (created before granting permissions)
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

-- 3. Create platform database owned by iteso_control_plane
SELECT format('CREATE DATABASE %I OWNER %I', :'platform_db', :'cp_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'platform_db')
\gexec

-- Ensure ownership
SELECT format('ALTER DATABASE %I OWNER TO %I', :'platform_db', :'cp_user')
\gexec

-- Restrict platform DB
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'platform_db')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'platform_db', :'cp_user')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'platform_db', :'gw_user')
\gexec

-- Gateway role settings
SELECT format('REVOKE ALL ON SCHEMA public FROM %I', :'gw_user')
\gexec
SQL

echo "[init-db-roles] Roles and platform database configured successfully."
