DO $$ BEGIN
  CREATE TYPE "public"."odoo_user_status" AS ENUM('pending', 'active', 'disabled', 'error');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "last_totp_step" text;
ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "odoo_groups" text[] DEFAULT ARRAY['base.group_user']::text[] NOT NULL;

CREATE TABLE IF NOT EXISTS "tenant_odoo_system_keys" (
  "tenant_id" uuid PRIMARY KEY NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "key_enc" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "rotated_at" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "membership_odoo_users" (
  "membership_id" uuid PRIMARY KEY NOT NULL REFERENCES "memberships"("id") ON DELETE CASCADE,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "odoo_uid" integer,
  "odoo_login" text,
  "api_key_enc" text,
  "key_expires_at" timestamp with time zone,
  "status" "public"."odoo_user_status" DEFAULT 'pending' NOT NULL,
  "last_error" text,
  "synced_at" timestamp with time zone
);
