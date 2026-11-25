ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "session_started_at" timestamp with time zone DEFAULT now() NOT NULL;
