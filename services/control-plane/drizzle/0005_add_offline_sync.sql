CREATE TABLE IF NOT EXISTS "pos_roster_issues" (
	"jti" varchar(64) PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL REFERENCES "pos_devices"("id") ON DELETE CASCADE,
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
	"member_ids" uuid[] NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS "device_number_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
	"device_id" uuid NOT NULL REFERENCES "pos_devices"("id") ON DELETE CASCADE,
	"doc_type" varchar(50) NOT NULL,
	"range_start" bigint NOT NULL,
	"range_end" bigint NOT NULL,
	"allocated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "pos_devices" ADD COLUMN IF NOT EXISTS "odoo_uid" integer;
ALTER TABLE "pos_devices" ADD COLUMN IF NOT EXISTS "api_key_enc" text;
ALTER TABLE "pos_devices" ADD COLUMN IF NOT EXISTS "key_expires_at" timestamp with time zone;

GRANT SELECT ON TABLE "pos_roster_issues" TO iteso_gateway;
