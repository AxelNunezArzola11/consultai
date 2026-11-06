# Migration 0009 Runbook — `agent_executions` + `scheduling_proposals`

Status: **PENDING APPROVAL — do not run without explicit sign-off.**
Prepared: 2026-11-04. No production database commands were executed.

## Current state (verified from repo files only)

- `lib/db/migrations/0009_ai_ops_and_scheduling_proposals.sql` creates two tables
  with `CREATE TABLE IF NOT EXISTS`: `agent_executions` (26 cols),
  `scheduling_proposals` (14 cols). No FKs, no indexes, no enums.
- `lib/db/schema.ts:922-977` matches the SQL column-for-column.
- Drizzle does **not** track 0009: `meta/_journal.json` lists only `0000`.
  There is no `run-0009.ts` and no `db:migrate` script.
- Runtime bootstrap (`ensureAiOpsTables()` in
  `lib/ai-ops/orchestrator-engine.ts:85-137`) issues identical DDL on
  supervisor runs and dashboard loads, so the app self-heals if the tables
  are missing. Reads degrade gracefully (`.catch(() => [])`); audit writes
  are now in an independent try/catch fallback.
- Live-Neon applied state is **unverified** (no credentialed queries were run).
  If any supervisor workflow or dashboard page has run against production,
  the bootstrap has most likely already created both tables.

## Step 1 — Inspect (read-only, safe)

```bash
psql "$DATABASE_URL" -c "\d agent_executions" -c "\d scheduling_proposals"
```

Expected when applied: both table descriptions print. If either is missing,
continue to Step 2.

## Step 2 — Apply (requires approval)

From the repo root, with `DATABASE_URL` set in the environment:

```bash
psql "$DATABASE_URL" -f lib/db/migrations/0009_ai_ops_and_scheduling_proposals.sql
```

The script is idempotent (`IF NOT EXISTS`) and creates tables only; it
modifies no existing data.

## Step 3 — Verify (read-only)

```bash
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM agent_executions;" \
  -c "SELECT COUNT(*) FROM scheduling_proposals;"
```

## Recommended follow-up (separate approval): migration 0010

0009 ships without the FKs/indexes used elsewhere in this schema. Proposed
`0010_ai_ops_constraints.sql` (new file, journal it with drizzle-kit):

```sql
ALTER TABLE "agent_executions"
  ADD CONSTRAINT "agent_executions_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL;
ALTER TABLE "scheduling_proposals"
  ADD CONSTRAINT "scheduling_proposals_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
ALTER TABLE "scheduling_proposals"
  ADD CONSTRAINT "scheduling_proposals_execution_id_fkey"
  FOREIGN KEY ("execution_id") REFERENCES "agent_executions"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "agent_executions_project_id_idx"
  ON "agent_executions" ("project_id");
CREATE INDEX IF NOT EXISTS "scheduling_proposals_project_id_idx"
  ON "scheduling_proposals" ("project_id");
CREATE INDEX IF NOT EXISTS "scheduling_proposals_execution_id_idx"
  ON "scheduling_proposals" ("execution_id");
CREATE INDEX IF NOT EXISTS "scheduling_proposals_status_idx"
  ON "scheduling_proposals" ("status");
```

Note: adding FKs fails if orphaned `project_id`/`execution_id` values exist.
Check first with `SELECT DISTINCT project_id ... LEFT JOIN projects ... WHERE
projects.id IS NULL`.
