-- Migration 0006: Phase 6 — Dispute handling
-- Run with: npx tsx lib/db/migrations/run-0006.ts
--
-- Extends the disputes table with:
--   - Richer metadata fields (paypal_status, dispute_reason, dispute_channel, etc.)
--   - Evidence tracking (evidence_status, evidence_submitted_at)
--   - Settlement offer fields (offer_amount_usd, offer_submitted_at)
--   - Resolution outcome and human-edited response
-- Adds a UNIQUE constraint on paypal_dispute_id for dedup.
-- Adds new dispute_status enum values: under_review, waiting_for_buyer, waiting_for_seller, closed
-- Adds new dispute_evidence_status enum.

-- 1. Add new dispute_status enum values (idempotent)
DO $$
BEGIN
  BEGIN ALTER TYPE dispute_status ADD VALUE IF NOT EXISTS 'under_review'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TYPE dispute_status ADD VALUE IF NOT EXISTS 'waiting_for_buyer'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TYPE dispute_status ADD VALUE IF NOT EXISTS 'waiting_for_seller'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TYPE dispute_status ADD VALUE IF NOT EXISTS 'closed'; EXCEPTION WHEN others THEN NULL; END;
END $$;

-- 2. Create dispute_evidence_status enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'dispute_evidence_status') THEN
    CREATE TYPE dispute_evidence_status AS ENUM ('not_submitted', 'submitted', 'failed');
  END IF;
END $$;

-- 3. Add new columns to disputes table (all idempotent via IF NOT EXISTS)
ALTER TABLE disputes
  ADD COLUMN IF NOT EXISTS paypal_status             TEXT,
  ADD COLUMN IF NOT EXISTS dispute_reason            TEXT,
  ADD COLUMN IF NOT EXISTS dispute_channel           TEXT,
  ADD COLUMN IF NOT EXISTS dispute_life_cycle_stage  TEXT,
  ADD COLUMN IF NOT EXISTS dispute_amount_usd        DECIMAL(10, 2),
  ADD COLUMN IF NOT EXISTS dispute_amount_currency   TEXT,
  ADD COLUMN IF NOT EXISTS evidence_status           dispute_evidence_status NOT NULL DEFAULT 'not_submitted',
  ADD COLUMN IF NOT EXISTS evidence_submitted_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS offer_amount_usd          DECIMAL(10, 2),
  ADD COLUMN IF NOT EXISTS offer_submitted_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolution_outcome        TEXT,
  ADD COLUMN IF NOT EXISTS human_edited_response     TEXT;

-- 4. Add UNIQUE constraint on paypal_dispute_id (if not already present)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'disputes_paypal_dispute_id_unique'
      AND conrelid = 'disputes'::regclass
  ) THEN
    ALTER TABLE disputes ADD CONSTRAINT disputes_paypal_dispute_id_unique UNIQUE (paypal_dispute_id);
  END IF;
END $$;

-- 5. Index for fast lookup by paypal_dispute_id (dedup on UPDATED/RESOLVED webhooks)
CREATE INDEX IF NOT EXISTS disputes_paypal_id_idx ON disputes(paypal_dispute_id);

-- 6. Index for looking up disputes by milestone
CREATE INDEX IF NOT EXISTS disputes_milestone_idx ON disputes(milestone_id);
