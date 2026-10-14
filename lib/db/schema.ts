/**
 * Drizzle ORM schema — ConsultAI
 *
 * All 12 tables defined here. Matches section 5 of consultai-plan.md.
 *
 * Invariants:
 * - audit_log is append-only: no UPDATE or DELETE in the app layer
 * - paypal_webhook_deliveries uses event_id as PRIMARY KEY for dedup
 * - idempotency_key columns are UNIQUE NOT NULL
 * - sender_batch_id on payments is UNIQUE (one payout per payment row)
 * - Status enums are defined as pgEnum for DB-level constraint enforcement
 */

import {
  pgTable,
  pgEnum,
  text,
  decimal,
  integer,
  boolean,
  jsonb,
  timestamp,
  bigserial,
  date,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const projectStatusEnum = pgEnum("project_status", [
  "draft",
  "active",
  "completed",
  "cancelled",
]);

export const milestoneStatusEnum = pgEnum("milestone_status", [
  "planned",
  "funded",
  "submitted",
  "verifying",
  "pending_approval",
  "paid",
  "disputed",
  "cancelled",
  // Phase 1 terminal states (payout failed or funds returned to sender)
  "failed",
  "returned",
]);

export const candidateStatusEnum = pgEnum("candidate_status", [
  "pending",
  "shortlisted",
  "nda_sent",
  "nda_signed",
  "scheduled",
  "selected",
  "rejected",
  "cascaded",
]);

export const ndaStatusEnum = pgEnum("nda_status", [
  "pending",
  "sent",
  "accepted",
  "declined",
  "expired",
]);

export const meetingStatusEnum = pgEnum("meeting_status", [
  "scheduled",
  "held",
  "cancelled",
  "no_show",
]);

export const paymentStatusEnum = pgEnum("payment_status", [
  "pending",
  "processing",
  "succeeded",
  "failed",
  "on_hold",
  "returned",
]);

export const approvalDecisionEnum = pgEnum("approval_decision", [
  "pending",
  "approved",
  "rejected",
]);

export const approvalRequestedByEnum = pgEnum("approval_requested_by", [
  "agent",
  "system",
]);

export const disputeStatusEnum = pgEnum("dispute_status", [
  "open",
  "resolved",
  "escalated",
]);

export const evidenceSourceTypeEnum = pgEnum("evidence_source_type", [
  "github_repo",
  "github_pr",
  "portfolio",
  "public_review",
  "provided_link",
]);

export const verificationStatusEnum = pgEnum("verification_status", [
  "pending",
  "running",
  "completed",
  "failed",
]);

export const proposalStatusEnum = pgEnum("proposal_status", [
  /** Awaiting human or auto decision */
  "pending",
  /** Auto-release eligible and within limit — payout can fire */
  "auto_release_eligible",
  /** Requires human approval */
  "requires_approval",
  /** LLM or deterministic recommends reject */
  "reject_recommended",
  /** Human approved — payout issued */
  "approved",
  /** Human rejected */
  "rejected",
  /** Head SHA changed after verification — must re-verify */
  "superseded",
]);

export const agentStepStatusEnum = pgEnum("agent_step_status", [
  "pending",
  "running",
  "done",
  "error",
]);

// ---------------------------------------------------------------------------
// companies
// ---------------------------------------------------------------------------

export const companies = pgTable("companies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  paypalMerchantId: text("paypal_merchant_id"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

export const projects = pgTable("projects", {
  id: text("id").primaryKey(),
  companyId: text("company_id")
    .notNull()
    .references(() => companies.id),
  title: text("title").notNull(),
  rawBrief: text("raw_brief"),
  /** {summary, context, goals} */
  structuredBrief: jsonb("structured_brief"),
  /** [{id, description, verifiable: bool, verified: bool}] */
  acceptanceCriteria: jsonb("acceptance_criteria"),
  status: projectStatusEnum("status").notNull().default("draft"),
  /** Payouts at or below this amount are auto-approved without human review */
  autoApproveThresholdUsd: decimal("auto_approve_threshold_usd", {
    precision: 10,
    scale: 2,
  }).default("500.00"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// milestones
// ---------------------------------------------------------------------------

export const milestones = pgTable("milestones", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  title: text("title").notNull(),
  description: text("description"),
  budgetUsd: decimal("budget_usd", { precision: 10, scale: 2 }).notNull(),
  dueDate: date("due_date"),
  status: milestoneStatusEnum("status").notNull().default("planned"),

  // PayPal Order / Capture
  paypalOrderId: text("paypal_order_id"),
  paypalCaptureId: text("paypal_capture_id"),

  /**
   * Captured fee breakdown from seller_receivable_breakdown (Spike 1b VERIFIED).
   * Doc: https://developer.paypal.com/docs/api/orders/v2/#definition-seller_receivable_breakdown
   *
   * capture_gross_usd = gross_amount.value  (company paid)
   * capture_fee_usd   = paypal_fee.value    (Orders processing fee)
   * capture_net_usd   = net_amount.value    (platform receives — basis for "Held" ledger)
   *
   * NOTE: net_amount is what the PLATFORM receives from the buyer into the Business account.
   * The CONSULTANT receives a separate Payout. The "Held (simulated)" UI amount = capture_net_usd.
   */
  captureGrossUsd: decimal("capture_gross_usd", { precision: 10, scale: 2 }),
  captureFeeUsd: decimal("capture_fee_usd", { precision: 10, scale: 2 }),
  captureNetUsd: decimal("capture_net_usd", { precision: 10, scale: 2 }),
  /** ISO 4217 currency code, e.g. "USD". Populated from capture response. */
  currency: text("currency"),

  // Payout
  paypalPayoutBatchId: text("paypal_payout_batch_id"),
  paypalPayoutItemId: text("paypal_payout_item_id"),

  /**
   * Idempotency key for the capture call (nanoid at capture time).
   * Prevents double-capture on client retry.
   */
  idempotencyKey: text("idempotency_key").unique(),

  /** Sort order within the project */
  position: integer("position").notNull().default(0),

  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// candidates
// ---------------------------------------------------------------------------

export const candidates = pgTable("candidates", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  name: text("name").notNull(),
  email: text("email").notNull(),
  githubHandle: text("github_handle"),
  portfolioUrl: text("portfolio_url"),
  trustScore: decimal("trust_score", { precision: 4, scale: 2 }),
  /** [{skill, evidence_url, confidence}] */
  canDo: jsonb("can_do"),
  /** [{skill, reason}] */
  cannotDo: jsonb("cannot_do"),
  vettingSummary: text("vetting_summary"),
  /** Rank within the project shortlist (1 = first choice) */
  rank: integer("rank"),
  status: candidateStatusEnum("status").notNull().default("pending"),
  rejectionReason: text("rejection_reason"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// evidence (trust signals)
// ---------------------------------------------------------------------------

export const evidence = pgTable("evidence", {
  id: text("id").primaryKey(),
  candidateId: text("candidate_id")
    .notNull()
    .references(() => candidates.id),
  sourceType: evidenceSourceTypeEnum("source_type").notNull(),
  sourceUrl: text("source_url"),
  title: text("title"),
  summary: text("summary"),
  relevanceScore: decimal("relevance_score", { precision: 4, scale: 2 }),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// ndas
// ---------------------------------------------------------------------------

export const ndas = pgTable("ndas", {
  id: text("id").primaryKey(),
  candidateId: text("candidate_id")
    .notNull()
    .references(() => candidates.id),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  templateVersion: text("template_version"),
  /** SHA-256 of NDA PDF bytes */
  contentHash: text("content_hash"),
  /** URL of stored NDA PDF */
  pdfUrl: text("pdf_url"),
  /** Invite token for the /invite/[token] page */
  inviteToken: text("invite_token").unique(),
  status: ndaStatusEnum("status").notNull().default("pending"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  /** Typed name at acceptance */
  acceptedName: text("accepted_name"),
  /** IP address at acceptance */
  acceptedIp: text("accepted_ip"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// meetings
// ---------------------------------------------------------------------------

export const meetings = pgTable("meetings", {
  id: text("id").primaryKey(),
  candidateId: text("candidate_id")
    .notNull()
    .references(() => candidates.id),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  calBookingUid: text("cal_booking_uid"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  status: meetingStatusEnum("status").notNull().default("scheduled"),
  calCancelReason: text("cal_cancel_reason"),
  bookingLink: text("booking_link"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// payments
// ---------------------------------------------------------------------------

export const payments = pgTable("payments", {
  id: text("id").primaryKey(),
  milestoneId: text("milestone_id")
    .notNull()
    .references(() => milestones.id),
  candidateId: text("candidate_id").references(() => candidates.id),

  /**
   * Fee breakdown from seller_receivable_breakdown (Spike 1b VERIFIED).
   * gross_usd = gross_amount.value  (company paid)
   * fee_usd   = paypal_fee.value    (Orders processing fee; Payouts fee separate — UNVERIFIED)
   * net_usd   = net_amount.value    (platform receives); basis for "Held" ledger
   *
   * NOTE: net_usd is what the PLATFORM receives from the capture into the Business account.
   * It is NOT the consultant's take-home. The consultant receives a separate Payout.
   */
  grossUsd: decimal("gross_usd", { precision: 10, scale: 2 }),
  feeUsd: decimal("fee_usd", { precision: 10, scale: 2 }),
  netUsd: decimal("net_usd", { precision: 10, scale: 2 }),
  /** ISO 4217 currency code, e.g. "USD". Populated from PayPal capture response. */
  currency: text("currency"),

  /**
   * payout_item_fee.value from GET /v1/payments/payouts/{id}.
   * Observed in Spike 1: $0.25 on $1.00. May be NULL if payout not yet issued.
   * Fee structure UNVERIFIED — confirm at https://www.paypal.com/us/webapps/mpp/paypal-fees
   */
  payoutFeeUsd: decimal("payout_fee_usd", { precision: 10, scale: 2 }),

  /** From the Orders API capture response — used for dispute lookups */
  paypalOrderId: text("paypal_order_id"),
  paypalCaptureId: text("paypal_capture_id"),

  paypalPayoutBatchId: text("paypal_payout_batch_id"),
  paypalPayoutItemId: text("paypal_payout_item_id"),

  /**
   * sender_batch_id is the idempotency key for Payouts.
   * Deterministically derived: "PAY_" + payment.id
   * UNIQUE constraint ensures one payout per payment row.
   *
   * On HTTP 400 with details[].field == "SENDER_BATCH_ID":
   *   GET the original batch via the returned self link — treat as idempotent replay.
   *   Do NOT match on error name — match only on details[].field.
   *   Observed name: "USER_BUSINESS_ERROR" (not "DUPLICATE_BATCH_ID").
   */
  senderBatchId: text("sender_batch_id").unique(),

  /**
   * Idempotency key for the Orders capture call.
   * Generated with nanoid() at capture time.
   */
  idempotencyKey: text("idempotency_key").unique(),

  status: paymentStatusEnum("status").notNull().default("pending"),
  /** Agent-generated justification for the payout */
  justification: text("justification"),
  /** [{criterion, passed, evidence_url, notes}] */
  evidenceSummary: jsonb("evidence_summary"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// approvals
// ---------------------------------------------------------------------------

export const approvals = pgTable("approvals", {
  id: text("id").primaryKey(),
  paymentId: text("payment_id")
    .notNull()
    .references(() => payments.id),
  milestoneId: text("milestone_id")
    .notNull()
    .references(() => milestones.id),
  requestedBy: approvalRequestedByEnum("requested_by").notNull(),
  decision: approvalDecisionEnum("decision").notNull().default("pending"),
  /** Email address or 'auto' */
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// disputes
// ---------------------------------------------------------------------------

export const disputes = pgTable("disputes", {
  id: text("id").primaryKey(),
  milestoneId: text("milestone_id")
    .notNull()
    .references(() => milestones.id),
  paymentId: text("payment_id").references(() => payments.id),
  paypalDisputeId: text("paypal_dispute_id"),
  status: disputeStatusEnum("status").notNull().default("open"),
  claimedBy: text("claimed_by"),
  /** [{type, url, description, submitted_at}] */
  evidence: jsonb("evidence"),
  agentResolution: text("agent_resolution"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// audit_log (append-only)
//
// IMPORTANT: Never UPDATE or DELETE rows in this table.
// Enforced at the app layer. All writes go through lib/db/audit.ts.
// ---------------------------------------------------------------------------

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  /** project | milestone | candidate | payment | nda | meeting | dispute */
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  /** e.g. PAYMENT_RELEASED, NDA_ACCEPTED, CASCADE_TRIGGERED */
  event: text("event").notNull(),
  /** Email, 'agent', or 'system' */
  actor: text("actor").notNull(),
  payload: jsonb("payload"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// paypal_webhook_deliveries (idempotency store)
//
// In-memory sets do NOT work for Vercel serverless — each invocation is a new process.
// Use this table with a PRIMARY KEY constraint. INSERT on first delivery;
// on conflict (duplicate event_id), skip processing.
//
// Usage:
//   INSERT INTO paypal_webhook_deliveries (event_id, event_type)
//   VALUES ($1, $2) ON CONFLICT (event_id) DO NOTHING;
//   If rowsAffected == 0: duplicate — return 200 {"status":"duplicate_ignored"}.
//
// Prune rows older than 30 days in the nightly cron sweep.
// ---------------------------------------------------------------------------

export const paypalWebhookDeliveries = pgTable("paypal_webhook_deliveries", {
  /** PayPal event.id — used as dedup key */
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// verification_runs
//
// One run per "verify this PR for this milestone" invocation.
// Split into short server calls (fetch → verify → explain), each persisted as
// an agent_step. A timeout loses nothing — the run can be resumed from the
// last completed step.
//
// Binding: a payment_proposal is bound to the run id + head_sha.
// ---------------------------------------------------------------------------

export const verificationRuns = pgTable("verification_runs", {
  id: text("id").primaryKey(),
  milestoneId: text("milestone_id")
    .notNull()
    .references(() => milestones.id),
  /** PR URL exactly as submitted by freelancer */
  prUrl: text("pr_url").notNull(),
  /** GitHub owner extracted from PR URL */
  prOwner: text("pr_owner").notNull(),
  /** GitHub repo extracted from PR URL */
  prRepo: text("pr_repo").notNull(),
  /** GitHub PR number extracted from PR URL */
  prNumber: integer("pr_number").notNull(),
  /** HEAD SHA at time of verification (re-checked before payout) */
  headSha: text("head_sha"),
  /** PR author login */
  prAuthor: text("pr_author"),
  /** Whether PR was merged at time of check */
  prMerged: boolean("pr_merged"),
  /** Whether PR was draft at time of check */
  prDraft: boolean("pr_draft"),
  /**
   * Objective criterion results — array of:
   * { criterionId, kind: "objective"|"subjective", met: bool|null, evidence: string[] }
   */
  criteriaResults: jsonb("criteria_results"),
  /**
   * Flags raised — array of strings, e.g.:
   * "WORKFLOW_FILE_MODIFIED", "TEST_FILE_DELETED", "DRAFT_PR",
   * "WRONG_AUTHOR", "SHA_MISMATCH"
   */
  flags: jsonb("flags"),
  /** LLM model id used for this run */
  llmModelId: text("llm_model_id"),
  /** Prompt version string (for reproducibility) */
  promptVersion: text("prompt_version"),
  /** Duration in milliseconds for the full run */
  durationMs: integer("duration_ms"),
  /** Policy decision output */
  policyDecision: text("policy_decision"),
  /** LLM-generated justification (plain language, evidence-cited) */
  justification: text("justification"),
  /** True if justification came from template fallback (LLM unavailable) */
  justificationFallback: boolean("justification_fallback").default(false),
  status: verificationStatusEnum("status").notNull().default("pending"),
  /** Freelancer login who submitted (from cookie/session) */
  submittedBy: text("submitted_by"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// agent_steps
//
// Ordered steps within a verification run — forms the activity stream.
// Each step is persisted as it completes so a timeout loses nothing.
// ---------------------------------------------------------------------------

export const agentSteps = pgTable("agent_steps", {
  id: text("id").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => verificationRuns.id),
  /** 0-based sequence within the run */
  seq: integer("seq").notNull().default(0),
  /** Tool or phase name, e.g. "fetchPRDetails", "verifyAcceptanceCriteria" */
  tool: text("tool").notNull(),
  /** Short summary of inputs (no secrets or raw payloads) */
  inputSummary: text("input_summary"),
  /** Short summary of output */
  outputSummary: text("output_summary"),
  /**
   * Evidence references — array of { kind, ref, url? }
   * kind: "commit_sha" | "check_name" | "file_path" | "review_id"
   * All refs are validated against fetched PR data before storage.
   * Fabricated refs (not present in fetched data) are dropped.
   */
  evidenceRefs: jsonb("evidence_refs"),
  status: agentStepStatusEnum("status").notNull().default("pending"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  /** Error message if status=error */
  errorMessage: text("error_message"),
});

// ---------------------------------------------------------------------------
// payment_proposals
//
// A proposal to pay out a milestone, bound to a verification run + head SHA.
// The policy engine sets the status field — LLM output NEVER changes it.
// Re-fetch head SHA at approval time and right before payout; if changed,
// mark SUPERSEDED and require re-verification.
// ---------------------------------------------------------------------------

export const paymentProposals = pgTable("payment_proposals", {
  id: text("id").primaryKey(),
  milestoneId: text("milestone_id")
    .notNull()
    .references(() => milestones.id),
  runId: text("run_id")
    .notNull()
    .references(() => verificationRuns.id),
  /**
   * HEAD SHA at the time this proposal was created.
   * Validated again at approval and immediately before payout.
   * If it changes, status → SUPERSEDED.
   */
  boundHeadSha: text("bound_head_sha").notNull(),
  /** Payout amount in USD */
  amountUsd: decimal("amount_usd", { precision: 10, scale: 2 }).notNull(),
  /**
   * Policy decision (pure code output — never LLM-determined):
   *   AUTO_RELEASE_ELIGIBLE | REQUIRES_APPROVAL | REJECT_RECOMMENDED
   */
  policyDecision: text("policy_decision").notNull(),
  /** LLM justification (plain language, evidence-cited, or template fallback) */
  justification: text("justification"),
  /** True if justification came from template fallback */
  justificationFallback: boolean("justification_fallback").default(false),
  status: proposalStatusEnum("status").notNull().default("pending"),
  /** Who approved/rejected — email, 'auto', or null */
  decidedBy: text("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  /** Notes from human reviewer */
  decisionNotes: text("decision_notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
