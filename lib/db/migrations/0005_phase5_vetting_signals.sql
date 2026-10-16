-- Migration 0005: Phase 5 — Vetting agent signals table + consent flag
-- Run with: npx tsx lib/db/migrations/run-0005.ts
--
-- Adds the signals table (richer evidence model):
--   candidate_id, requirement_id, signal_type, source_url, retrieved_at,
--   content_hash, extracted_fact, quoted_excerpt, confidence
--
-- Adds vetting_consent_at to candidates (candidate must consent before vetting starts).
-- Adds vetting_ran_at to candidates (timestamp of last vetting run, for caching).

-- 1. Extend evidence_source_type enum with signal_type values
--    (reuse the existing enum — same domain)
DO $$
BEGIN
  -- These may already exist from earlier phases; ADD VALUE IF NOT EXISTS is idempotent
  BEGIN ALTER TYPE evidence_source_type ADD VALUE IF NOT EXISTS 'github_repo'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TYPE evidence_source_type ADD VALUE IF NOT EXISTS 'github_pr'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TYPE evidence_source_type ADD VALUE IF NOT EXISTS 'portfolio'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TYPE evidence_source_type ADD VALUE IF NOT EXISTS 'public_review'; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TYPE evidence_source_type ADD VALUE IF NOT EXISTS 'provided_link'; EXCEPTION WHEN others THEN NULL; END;
END $$;

-- 2. Create the signals table
--    One row per (candidate, requirement, source) signal.
--    content_hash allows cache-by-hash: if hash unchanged, skip re-extraction.
CREATE TABLE IF NOT EXISTS signals (
  id                TEXT PRIMARY KEY,
  candidate_id      TEXT NOT NULL REFERENCES candidates(id),
  requirement_id    TEXT NOT NULL,          -- acceptance_criteria[].id from the project
  signal_type       evidence_source_type NOT NULL,
  source_url        TEXT NOT NULL,
  retrieved_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  content_hash      TEXT NOT NULL,          -- SHA-256 hex of fetched content
  extracted_fact    TEXT NOT NULL,          -- LLM-extracted fact, code-verified
  quoted_excerpt    TEXT NOT NULL,          -- verbatim excerpt, verified present in content
  confidence        DECIMAL(4,3) NOT NULL   -- 0.000–1.000 (code-set, not LLM-set)
    CHECK (confidence >= 0 AND confidence <= 1),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for common access patterns
CREATE INDEX IF NOT EXISTS signals_candidate_idx ON signals(candidate_id);
CREATE INDEX IF NOT EXISTS signals_requirement_idx ON signals(candidate_id, requirement_id);
-- Content-hash index for cache lookup (skip re-extraction if content unchanged)
CREATE INDEX IF NOT EXISTS signals_hash_idx ON signals(content_hash);

-- 3. Add vetting consent and run timestamps to candidates
ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS vetting_consent_at   TIMESTAMPTZ,   -- NULL = not yet consented
  ADD COLUMN IF NOT EXISTS vetting_ran_at        TIMESTAMPTZ;   -- NULL = never run

-- 4. Add search vector column to candidates for Postgres full-text search
--    (Phase 5 step 5 — Search)
ALTER TABLE candidates
  ADD COLUMN IF NOT EXISTS search_vector TSVECTOR;

-- Trigger to keep search_vector up-to-date
CREATE OR REPLACE FUNCTION candidates_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    to_tsvector('english',
      coalesce(NEW.name, '') || ' ' ||
      coalesce(NEW.github_handle, '') || ' ' ||
      coalesce(NEW.vetting_summary, '')
    );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS candidates_search_vector_trigger ON candidates;
CREATE TRIGGER candidates_search_vector_trigger
  BEFORE INSERT OR UPDATE ON candidates
  FOR EACH ROW EXECUTE FUNCTION candidates_search_vector_update();

-- GIN index for fast full-text search
CREATE INDEX IF NOT EXISTS candidates_search_vector_idx
  ON candidates USING GIN(search_vector);

-- 5. Backfill existing candidates (safe to run multiple times)
UPDATE candidates
SET search_vector =
  to_tsvector('english',
    coalesce(name, '') || ' ' ||
    coalesce(github_handle, '') || ' ' ||
    coalesce(vetting_summary, '')
  )
WHERE search_vector IS NULL;
