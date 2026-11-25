-- Migration 0000_init_control_plane.sql
-- Create enums
DO $$ BEGIN
  CREATE TYPE "tenant_status" AS ENUM ('active', 'suspended');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
  CREATE TYPE "implementation_status" AS ENUM ('available', 'not_implemented');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Create tables
CREATE TABLE IF NOT EXISTS "tenants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" text NOT NULL UNIQUE,
  "db_name" text NOT NULL UNIQUE,
  "display_name" text NOT NULL,
  "status" "tenant_status" DEFAULT 'active' NOT NULL,
  "industries" text[] DEFAULT '{}' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "feature_definitions" (
  "key" text PRIMARY KEY NOT NULL,
  "group" text NOT NULL,
  "description" text NOT NULL,
  "implementation_status" "implementation_status" DEFAULT 'not_implemented' NOT NULL,
  "platform_enabled" boolean DEFAULT false NOT NULL,
  "default_enabled" boolean DEFAULT false NOT NULL
);

CREATE TABLE IF NOT EXISTS "tenant_features" (
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "feature_key" text NOT NULL REFERENCES "feature_definitions"("key") ON DELETE CASCADE,
  "enabled" boolean NOT NULL,
  "updated_by" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "note" text,
  CONSTRAINT "tenant_features_pkey" PRIMARY KEY ("tenant_id", "feature_key")
);

CREATE TABLE IF NOT EXISTS "admin_audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor" text NOT NULL,
  "action" text NOT NULL,
  "target_type" text NOT NULL,
  "target_id" text NOT NULL,
  "before" jsonb,
  "after" jsonb,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

-- Grant SELECT to iteso_gateway on specified tables
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'iteso_gateway') THEN
    GRANT USAGE ON SCHEMA public TO iteso_gateway;
    GRANT SELECT ON TABLE "tenants", "feature_definitions", "tenant_features" TO iteso_gateway;
    REVOKE ALL ON TABLE "admin_audit_log" FROM iteso_gateway;
  END IF;
END $$;
