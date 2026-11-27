DO $$ BEGIN
  CREATE TYPE "public"."branch_status" AS ENUM('active', 'disabled');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "public"."pos_device_status" AS ENUM('active', 'revoked');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS "branches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "status" "public"."branch_status" DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "branches_tenant_id_code_unique" UNIQUE("tenant_id", "code")
);

CREATE TABLE IF NOT EXISTS "pos_devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "branch_id" uuid NOT NULL REFERENCES "branches"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "token_hash" text NOT NULL UNIQUE,
  "status" "public"."pos_device_status" DEFAULT 'active' NOT NULL,
  "paired_by_membership_id" uuid REFERENCES "memberships"("id") ON DELETE SET NULL,
  "paired_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone,
  "revoked_at" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "pos_pairing_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "branch_id" uuid NOT NULL REFERENCES "branches"("id") ON DELETE CASCADE,
  "device_name" text NOT NULL,
  "code_hash" text NOT NULL,
  "created_by_membership_id" uuid REFERENCES "memberships"("id") ON DELETE SET NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "membership_pins" (
  "membership_id" uuid PRIMARY KEY NOT NULL REFERENCES "memberships"("id") ON DELETE CASCADE,
  "pin_hash" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "failed_attempts" integer DEFAULT 0 NOT NULL,
  "locked_until" timestamp with time zone
);

ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "device_id" uuid REFERENCES "pos_devices"("id") ON DELETE CASCADE;
