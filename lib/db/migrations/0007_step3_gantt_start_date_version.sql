-- Migration 0007: Step 3 — Gantt scheduling columns
-- Run with: npx tsx lib/db/migrations/run-0007.ts
--
-- Adds two columns to the milestones table:
--
--   start_date  DATE            — task start date stored as date-only (YYYY-MM-DD).
--                                 All UTC conversion is performed in the reorder
--                                 route to avoid off-by-one timezone errors.
--                                 Nullable: existing rows have no start date yet.
--
--   version     INTEGER NOT NULL DEFAULT 0
--                               — optimistic concurrency counter.
--                                 The reorder route reads the current version,
--                                 increments it, and uses WHERE version = :expected.
--                                 If 0 rows are updated the write is rejected with
--                                 409 Conflict (someone else moved the task first).
--
-- Both statements are idempotent (IF NOT EXISTS) so re-running is safe.

ALTER TABLE milestones
  ADD COLUMN IF NOT EXISTS start_date DATE;

ALTER TABLE milestones
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 0;
