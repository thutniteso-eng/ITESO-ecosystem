#!/bin/sh
set -eu

RUNTIME_CONF="/tmp/odoo.conf"
cp /etc/odoo/odoo.conf "$RUNTIME_CONF"

{
  printf '\n'
  [ -n "${HOST:-}" ] && printf 'db_host = %s\n' "$HOST"
  [ -n "${PORT:-}" ] && printf 'db_port = %s\n' "$PORT"
  [ -n "${USER:-}" ] && printf 'db_user = %s\n' "$USER"
  [ -n "${PASSWORD:-}" ] && printf 'db_password = %s\n' "$PASSWORD"
  [ -n "${ODOO_ADMIN_PASSWORD:-}" ] && printf 'admin_passwd = %s\n' "$ODOO_ADMIN_PASSWORD"
} >> "$RUNTIME_CONF"

chmod 600 "$RUNTIME_CONF"

exec /entrypoint.sh odoo -c "$RUNTIME_CONF" "$@"
