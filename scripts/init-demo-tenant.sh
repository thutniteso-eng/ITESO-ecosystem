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

TENANT_DB="${DEMO_TENANT_DB:-t_demo_fnb}"
PG_USER="${POSTGRES_USER:-odoo}"
PG_DB="${POSTGRES_DB:-postgres}"
GW_USER="${POSTGRES_GATEWAY_USER:-iteso_gateway}"
DEMO_ADMIN_PASS="${ODOO_DEMO_ADMIN_PASSWORD:?ODOO_DEMO_ADMIN_PASSWORD is required in .env}"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

echo "[init-demo-tenant] Checking if database '$TENANT_DB' exists..."
DB_EXISTS="$(compose exec -T postgres psql -U "$PG_USER" -d "$PG_DB" -tAc "SELECT 1 FROM pg_database WHERE datname = '${TENANT_DB}'" | tr -d '[:space:]')"

if [ "$DB_EXISTS" != "1" ]; then
  echo "[init-demo-tenant] Initializing database '$TENANT_DB' with module 'iteso_base'..."
  compose exec -T odoo odoo \
    -c /tmp/odoo.conf \
    -d "$TENANT_DB" \
    -i iteso_base \
    --stop-after-init \
    --no-http
  echo "[init-demo-tenant] Database '$TENANT_DB' initialized with 'iteso_base'."
else
  echo "[init-demo-tenant] Database '$TENANT_DB' already exists."
fi

echo "[init-demo-tenant] Revoking tenant DB access from PUBLIC and '${GW_USER}'..."
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

echo "[init-demo-tenant] Updating admin password and dev JSON-2 API key on '$TENANT_DB'..."
compose exec -T \
  -e ODOO_DEMO_ADMIN_PASSWORD="$DEMO_ADMIN_PASS" \
  -e ODOO_DEV_API_KEY="${ODOO_DEV_API_KEY:-}" \
  odoo odoo shell \
  -c /tmp/odoo.conf \
  -d "$TENANT_DB" \
  --no-http <<'PYEOF'
import os
from odoo.addons.base.models.res_users import KEY_CRYPT_CONTEXT, INDEX_SIZE

admin_user = env.ref("base.user_admin").sudo()
admin_user.password = os.environ["ODOO_DEMO_ADMIN_PASSWORD"]

raw_key = os.environ.get("ODOO_DEV_API_KEY", "")
if raw_key:
    key_name = "iteso-gateway-dev"
    env.cr.execute(
        "DELETE FROM res_users_apikeys WHERE user_id = %s AND name = %s",
        (admin_user.id, key_name),
    )
    env.cr.execute(
        """
        INSERT INTO res_users_apikeys (name, user_id, scope, expiration_date, key, index)
        VALUES (%s, %s, %s, NULL, %s, %s)
        """,
        (
            key_name,
            admin_user.id,
            "rpc",
            KEY_CRYPT_CONTEXT.hash(raw_key),
            raw_key[:INDEX_SIZE],
        ),
    )

env.cr.commit()
print("Admin password updated and dev API key ready for user:", admin_user.login)
PYEOF

echo "[init-demo-tenant] Done."
