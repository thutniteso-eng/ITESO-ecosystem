#!/usr/bin/env bash
set -euo pipefail

# Secure tenant DB: revokes CONNECT from PUBLIC and iteso_gateway, and restricts iteso_gateway
TENANT_DB="${1:?Database name required as argument 1}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
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

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

echo "[secure-tenant-db] Securing database '${TENANT_DB}' (revoking access from PUBLIC and '${GW_USER}')..."
compose exec -T postgres psql -v ON_ERROR_STOP=1 \
  -U "$PG_USER" \
  -d "$PG_DB" \
  -v tenant_db="$TENANT_DB" \
  -v gw_user="$GW_USER" <<'SQL'
SELECT format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', :'tenant_db')
\gexec

SELECT format('REVOKE ALL ON DATABASE %I FROM %I', :'tenant_db', :'gw_user')
WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'gw_user')
\gexec
SQL
