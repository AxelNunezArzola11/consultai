CREATE TABLE IF NOT EXISTS "delivery_workflow_runs" (
  "id" text PRIMARY KEY NOT NULL,
  "idempotency_key" text NOT NULL UNIQUE,
  "milestone_id" text NOT NULL REFERENCES "milestones"("id"),
  "pr_url" text NOT NULL,
  "task_run_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "result" jsonb,
  "error" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
