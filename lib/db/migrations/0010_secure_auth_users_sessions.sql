-- Migration 0010: Secure Account Registration, Users, and Authenticated Sessions
-- Backward-compatible additive migration (safe to apply without breaking existing rows).

DO $$ BEGIN
  CREATE TYPE "user_role" AS ENUM ('company', 'freelancer', 'admin');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "users" (
  "id" text PRIMARY KEY NOT NULL,
  "email" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "password_hash" text NOT NULL,
  "role" "user_role" NOT NULL,
  "company_id" text REFERENCES "companies"("id") ON DELETE SET NULL,
  "title" text,
  "github_handle" text,
  "portfolio_url" text,
  "skills" jsonb DEFAULT '[]'::jsonb,
  "bio" text,
  "hourly_rate_usd" numeric(10, 2),
  "availability" text DEFAULT 'available',
  "terms_accepted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_uidx" ON "users" (LOWER("email"));
CREATE INDEX IF NOT EXISTS "users_email_idx" ON "users" (LOWER("email"));
CREATE INDEX IF NOT EXISTS "users_company_id_idx" ON "users" ("company_id");
CREATE INDEX IF NOT EXISTS "users_github_handle_idx" ON "users" (LOWER("github_handle"));

CREATE TABLE IF NOT EXISTS "auth_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" text NOT NULL UNIQUE,
  "role" "user_role" NOT NULL,
  "company_id" text,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "auth_sessions_user_id_idx" ON "auth_sessions" ("user_id");
CREATE INDEX IF NOT EXISTS "auth_sessions_token_hash_idx" ON "auth_sessions" ("token_hash");
