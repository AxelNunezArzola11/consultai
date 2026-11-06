-- Migration 0009: AI Operations Center (agent_executions & scheduling_proposals)

CREATE TABLE IF NOT EXISTS "agent_executions" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text,
  "user_request" text NOT NULL,
  "intent" text NOT NULL,
  "supervisor_decision" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "delegated_agents" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "handoffs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "approval_status" text DEFAULT 'not_required' NOT NULL,
  "structured_outputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "retry_count" integer DEFAULT 0 NOT NULL,
  "prompt_tokens" integer DEFAULT 0 NOT NULL,
  "completion_tokens" integer DEFAULT 0 NOT NULL,
  "total_tokens" integer DEFAULT 0 NOT NULL,
  "duration_ms" integer DEFAULT 0 NOT NULL,
  "final_result" text DEFAULT '' NOT NULL,
  "requested_by" text DEFAULT 'company-operator' NOT NULL,
  "decided_by" text,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "scheduling_proposals" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL,
  "execution_id" text,
  "proposed_by_agent" text DEFAULT 'reschedule_agent' NOT NULL,
  "overall_risk" text DEFAULT 'medium' NOT NULL,
  "total_delay_days" integer DEFAULT 0 NOT NULL,
  "rationale" text DEFAULT '' NOT NULL,
  "adjustments" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" text DEFAULT 'pending_approval' NOT NULL,
  "decided_by" text,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
