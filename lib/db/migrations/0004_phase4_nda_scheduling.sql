-- Migration 0004: Phase 4 — NDA gate, scheduling, QStash timers, candidate cascade
-- Run with: npx tsx lib/db/migrations/run-0004.ts

-- 1. Extend candidate_status enum with full Phase 4 states
--    New values: found, shortlisted, nda_sent, nda_signed, booking_unlocked, booked,
--    meeting_held, selected, declined, expired, cancelled, no_show, invalid_booking
--    (existing DB enum has partial overlap — add only missing values)
DO $$
BEGIN
  -- Add values that don't already exist
  BEGIN ALTER TYPE candidate_status ADD VALUE IF NOT EXISTS 'found'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TYPE candidate_status ADD VALUE IF NOT EXISTS 'booking_unlocked'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TYPE candidate_status ADD VALUE IF NOT EXISTS 'booked'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TYPE candidate_status ADD VALUE IF NOT EXISTS 'meeting_held'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TYPE candidate_status ADD VALUE IF NOT EXISTS 'declined'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TYPE candidate_status ADD VALUE IF NOT EXISTS 'expired'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TYPE candidate_status ADD VALUE IF NOT EXISTS 'cancelled'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TYPE candidate_status ADD VALUE IF NOT EXISTS 'no_show'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TYPE candidate_status ADD VALUE IF NOT EXISTS 'invalid_booking'; EXCEPTION WHEN others THEN NULL; END;
END $$;

-- 2. Add sanitized_summary to projects
--    Shown to candidates before NDA acceptance — never the full brief
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS sanitized_summary TEXT;

-- 3. Add dependency fields to milestones
--    depends_on_id: FK to milestones(id) — this milestone starts after the dependency completes
--    offset_days: number of days after the dependency's due_date this milestone is due
ALTER TABLE milestones
  ADD COLUMN IF NOT EXISTS depends_on_id TEXT REFERENCES milestones(id),
  ADD COLUMN IF NOT EXISTS offset_days   INTEGER;

-- Index for dependency traversal
CREATE INDEX IF NOT EXISTS milestones_depends_on_idx ON milestones(depends_on_id);

-- 4. Add invite token fields to ndas
--    invite_token_hash: SHA-256 hex of the raw 128-bit random token (never store raw)
--    invite_token_used: single-use flag — true after the token is consumed
--    invite_token_rate_limit: number of times the token has been attempted
ALTER TABLE ndas
  ADD COLUMN IF NOT EXISTS invite_token_hash       TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS invite_token_used        BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS invite_token_rate_limit  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS invite_token_expires_at  TIMESTAMPTZ;

-- 5. cal_webhook_deliveries — idempotency for Cal.com webhook events
--    Dedup key: trigger_event || '|' || booking_uid || '|' || created_at_iso
CREATE TABLE IF NOT EXISTS cal_webhook_deliveries (
  id            TEXT PRIMARY KEY,           -- nanoid
  dedup_key     TEXT NOT NULL UNIQUE,       -- triggerEvent|uid|createdAt
  trigger_event TEXT NOT NULL,
  booking_uid   TEXT NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cal_webhook_deliveries_uid_idx
  ON cal_webhook_deliveries(booking_uid);

-- 6. qstash_deliveries — idempotency for QStash messages
--    message_id: Upstash-Message-Id header value
CREATE TABLE IF NOT EXISTS qstash_deliveries (
  message_id   TEXT PRIMARY KEY,            -- Upstash-Message-Id
  payload_type TEXT NOT NULL,               -- e.g. NDA_EXPIRY, NO_SHOW_CHECK
  entity_id    TEXT NOT NULL,               -- ndaId or meetingId
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. cascade_log — audit trail for automatic cascade events
CREATE TABLE IF NOT EXISTS cascade_log (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id),
  from_candidate_id TEXT NOT NULL REFERENCES candidates(id),
  to_candidate_id   TEXT REFERENCES candidates(id),    -- NULL if no next candidate
  reason          TEXT NOT NULL,                        -- EXPIRED|DECLINED|CANCELLED|NO_SHOW
  round           INTEGER NOT NULL DEFAULT 1,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cascade_log_project_idx ON cascade_log(project_id);
