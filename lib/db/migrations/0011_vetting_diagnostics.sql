-- Migration 0011 — vetting run diagnostics on candidates.
--
-- Adds `candidates.vetting_diagnostics` (jsonb): a durable per-run record of
-- why a vetting run scored what it did (repos analyzed, LLM-fallback state,
-- verbatim-verification drops, non-fatal errors). Rendered on the vetting
-- card so a 0 score always carries its reason.
--
-- Idempotent: safe to run multiple times. Existing rows get NULL (diagnostics
-- appear after the next vetting run). Runtime bootstrap in
-- lib/vetting/orchestrator.ts (ensureVettingDiagnosticsColumn) applies the
-- same DDL on vetting runs, so deployments that skip this script self-heal.
--
-- Apply with: psql "$DATABASE_URL" -f lib/db/migrations/0011_vetting_diagnostics.sql

ALTER TABLE "candidates"
  ADD COLUMN IF NOT EXISTS "vetting_diagnostics" jsonb;
