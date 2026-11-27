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

# Secure tenant DB using shared helper script
"$ROOT_DIR/scripts/lib/secure-tenant-db.sh" "$TENANT_DB"

echo "[init-demo-tenant] Updating admin password, configuring iteso_system and registering system API key on '$TENANT_DB'..."
# Generate raw API key directly in odoo shell and pipe it directly to register-tenant-system-key.js
# The raw key is NOT printed to stdout, logged or saved to any file.
compose exec -T \
  -e ODOO_DEMO_ADMIN_PASSWORD="$DEMO_ADMIN_PASS" \
  odoo odoo shell \
  -c /tmp/odoo.conf \
  -d "$TENANT_DB" \
  --no-http <<'PYEOF' | compose exec -T control-plane node dist/cli/register-tenant-system-key.js --tenant "${DEMO_TENANT_CODE:-demo_fnb}"
import os
import sys

# 1. Update admin password
admin_user = env.ref("base.user_admin").sudo()
admin_user.password = os.environ["ODOO_DEMO_ADMIN_PASSWORD"]

# Clean up any legacy iteso-gateway-dev keys
env.cr.execute("DELETE FROM res_users_apikeys WHERE name = %s", ("iteso-gateway-dev",))

# 2. Create or find iteso_system user
group_system = env.ref("base.group_system")
Users = env["res.users"].sudo()
system_user = Users.search([("login", "=", "iteso_system")], limit=1)
if not system_user:
    system_user = Users.create({
        "name": "ITESO System Service",
        "login": "iteso_system",
        "email": "system@iteso.local",
        "active": True,
        "group_ids": [(6, 0, [group_system.id])],
    })
else:
    system_user.write({
        "active": True,
        "group_ids": [(6, 0, [group_system.id])],
    })

# Remove existing iteso-system keys for fresh key generation
env.cr.execute(
    "DELETE FROM res_users_apikeys WHERE user_id = %s AND name = %s",
    (system_user.id, "iteso-system"),
)

# 3. Generate system API key via Odoo 20 standard API (system user has no expiration limit: pass expiration_date=None)
raw_key = env["res.users.apikeys"].with_user(system_user).sudo()._generate(
    scope="rpc",
    name="iteso-system",
    expiration_date=None,
)

env.cr.commit()

# Output raw key to stdout for pipe to stdin of register-tenant-system-key CLI
sys.stdout.write(raw_key)
PYEOF

echo "[init-demo-tenant] Done."
