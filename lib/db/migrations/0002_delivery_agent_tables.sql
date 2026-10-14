-- Migration 0002: Delivery Agent tables
-- Adds: verification_runs, agent_steps, payment_proposals
-- and the supporting enums: verification_status, proposal_status, agent_step_status

-- Enums -----------------------------------------------------------------------

CREATE TYPE verification_status AS ENUM ('pending', 'running', 'completed', 'failed');

CREATE TYPE proposal_status AS ENUM (
  'pending',
  'auto_release_eligible',
  'requires_approval',
  'reject_recommended',
  'approved',
  'rejected',
  'superseded'
);

CREATE TYPE agent_step_status AS ENUM ('pending', 'running', 'done', 'error');

-- verification_runs -----------------------------------------------------------

CREATE TABLE verification_runs (
  id                     text PRIMARY KEY,
  milestone_id           text NOT NULL REFERENCES milestones(id),
  pr_url                 text NOT NULL,
  pr_owner               text NOT NULL,
  pr_repo                text NOT NULL,
  pr_number              integer NOT NULL,
  head_sha               text,
  pr_author              text,
  pr_merged              boolean,
  pr_draft               boolean,
  criteria_results       jsonb,
  flags                  jsonb,
  llm_model_id           text,
  prompt_version         text,
  duration_ms            integer,
  policy_decision        text,
  justification          text,
  justification_fallback boolean DEFAULT false,
  status                 verification_status NOT NULL DEFAULT 'pending',
  submitted_by           text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- agent_steps -----------------------------------------------------------------

CREATE TABLE agent_steps (
  id              text PRIMARY KEY,
  run_id          text NOT NULL REFERENCES verification_runs(id),
  seq             integer NOT NULL DEFAULT 0,
  tool            text NOT NULL,
  input_summary   text,
  output_summary  text,
  evidence_refs   jsonb,
  status          agent_step_status NOT NULL DEFAULT 'pending',
  started_at      timestamptz,
  completed_at    timestamptz,
  error_message   text
);

CREATE INDEX agent_steps_run_id_seq ON agent_steps(run_id, seq);

-- payment_proposals -----------------------------------------------------------

CREATE TABLE payment_proposals (
  id                     text PRIMARY KEY,
  milestone_id           text NOT NULL REFERENCES milestones(id),
  run_id                 text NOT NULL REFERENCES verification_runs(id),
  bound_head_sha         text NOT NULL,
  amount_usd             numeric(10,2) NOT NULL,
  policy_decision        text NOT NULL,
  justification          text,
  justification_fallback boolean DEFAULT false,
  status                 proposal_status NOT NULL DEFAULT 'pending',
  decided_by             text,
  decided_at             timestamptz,
  decision_notes         text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
