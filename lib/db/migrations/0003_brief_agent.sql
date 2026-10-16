-- Phase 3 (BriefAgent): add structured_plan column to projects + brief_drafts table
-- Run with: npx tsx lib/db/migrations/run-0003.ts

-- 1. Add structured_plan to projects
--    Stores the final normalized BriefPlan JSON after saveStructuredBrief tool call.
--    Nullable — only set after the brief is complete.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS structured_plan JSONB;

-- 2. brief_drafts: persisted draft plans (auto-save on every edit)
--    agent_session_id: ephemeral browser session key (nanoid)
--    plan_json: partial or complete BriefPlan JSON
--    brief_text: raw user brief (for fallback pre-fill)
CREATE TABLE IF NOT EXISTS brief_drafts (
  id             TEXT PRIMARY KEY,
  project_id     TEXT REFERENCES projects(id),
  agent_session_id TEXT NOT NULL,
  plan_json      JSONB,
  brief_text     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS brief_drafts_session_idx
  ON brief_drafts (agent_session_id);

-- 3. brief_rate_limit: tracks per-session LLM call count
--    Resets are handled by created_at age (TTL in app layer, not DB).
CREATE TABLE IF NOT EXISTS brief_rate_limit (
  agent_session_id TEXT PRIMARY KEY,
  call_count       INTEGER NOT NULL DEFAULT 1,
  window_start     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
