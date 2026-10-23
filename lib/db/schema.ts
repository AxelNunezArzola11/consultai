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
// Re-export primaryKey and uniqueIndex for external use
// ---------------------------------------------------------------------------
export { primaryKey, uniqueIndex };

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
  // Phase 1 / legacy
  "pending",
  "shortlisted",
  "nda_sent",
  "nda_signed",
  "scheduled",
  "selected",
  "rejected",
  "cascaded",
  // Phase 4 full pipeline
  "found",
  "booking_unlocked",
  "booked",
  "meeting_held",
  "declined",
  "expired",
  "cancelled",
  "no_show",
  "invalid_booking",
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
  // Phase 6 additions — match PayPal dispute_state values (UNVERIFIED until sandbox observed)
  "under_review",               // UNDER_PAYPAL_REVIEW
  "waiting_for_buyer",          // REQUIRED_OTHER_PARTY_ACTION (buyer must respond)
  "waiting_for_seller",         // REQUIRED_ACTION (seller must respond — our state)
  "closed",                     // terminal — no further action possible
]);

export const disputeEvidenceStatusEnum = pgEnum("dispute_evidence_status", [
  "not_submitted",  // default — no evidence sent yet
  "submitted",      // evidence successfully sent to PayPal
  "failed",         // submission attempt failed
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
  /** Normalized BriefPlan JSON — set after BriefAgent saveStructuredBrief tool call */
  structuredPlan: jsonb("structured_plan"),
  /**
   * Sanitized project summary shown to candidates BEFORE NDA acceptance.
   * This is a separate stored field — never the full brief.
   * Only the full brief fields (rawBrief, structuredBrief) are served after NDA_SIGNED.
   */
  sanitizedSummary: text("sanitized_summary"),
  /**
   * GitHub repository URL for this project (e.g. https://github.com/owner/repo).
   * Used by the GitHub Webhook to match incoming PR/push events to this project
   * and auto-evaluate milestone acceptance criteria.
   */
  githubRepoUrl: text("github_repo_url"),
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

  /**
   * Phase 4 — Dependency engine fields.
   * dependsOnId: FK to milestones(id) — this milestone's due_date is calculated
   *   as dependsOn.due_date + offsetDays.
   * offsetDays: number of calendar days after the dependency's due_date.
   * Both are nullable — a milestone with no dependency has a fixed due_date.
   * Funded milestones are never recalculated (financial consistency rule).
   */
  dependsOnId: text("depends_on_id"),
  offsetDays: integer("offset_days"),

  /**
   * Step 3 — Gantt scheduling fields.
   *
   * startDate: the task's start date stored as a date-only ISO string "YYYY-MM-DD".
   *   All UTC conversion is performed in one place (the reorder route) to avoid
   *   off-by-one errors from timezone drift. Bryntum receives and sends dates as
   *   ISO strings; this column stores them verbatim.
   *
   * version: optimistic concurrency counter. The reorder route reads the current
   *   version, increments it, and uses a WHERE version = :expected predicate.
   *   If 0 rows are updated the write is rejected with 409 Conflict.
   *   Default 0 so existing rows start at a known baseline.
   */
  startDate: date("start_date"),
  version: integer("version").notNull().default(0),

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
  /** Phase 5: candidate gives in-app consent before vetting begins */
  vettingConsentAt: timestamp("vetting_consent_at", { withTimezone: true }),
  /** Phase 5: timestamp of last completed vetting run (for cache-by-hash) */
  vettingRanAt: timestamp("vetting_ran_at", { withTimezone: true }),
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

  /**
   * Phase 4 — Invite token fields.
   *
   * NEVER store the raw token — only its SHA-256 hash.
   * The raw token is sent in the invite link; the hash is stored here.
   * Single-use: inviteTokenUsed is set to true after first consumption.
   * Rate-limited: inviteTokenRateLimit increments on each attempt.
   * inviteTokenExpiresAt: independent of NDA expiry — token window (e.g. 72h).
   *
   * Legacy inviteToken column (plain text) is kept for backward compat
   * with existing rows; new rows must use inviteTokenHash.
   */
  /** Plain text token — DEPRECATED for new rows; use inviteTokenHash */
  inviteToken: text("invite_token").unique(),
  /** SHA-256 hex of the 128-bit random invite token — stored instead of raw */
  inviteTokenHash: text("invite_token_hash").unique(),
  /** True after the token is consumed (single-use) */
  inviteTokenUsed: boolean("invite_token_used").notNull().default(false),
  /** Rate-limit counter — incremented on each attempt (valid or not) */
  inviteTokenRateLimit: integer("invite_token_rate_limit").notNull().default(0),
  /** When the invite link itself expires (independent of NDA expiry window) */
  inviteTokenExpiresAt: timestamp("invite_token_expires_at", { withTimezone: true }),

  status: ndaStatusEnum("status").notNull().default("pending"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  /** Typed name at acceptance */
  acceptedName: text("accepted_name"),
  /** IP address at acceptance */
  acceptedIp: text("accepted_ip"),
  /** SHA-256 of the exact NDA document text shown to the candidate */
  documentHash: text("document_hash"),
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
  paypalDisputeId: text("paypal_dispute_id").unique(),
  status: disputeStatusEnum("status").notNull().default("open"),
  claimedBy: text("claimed_by"),

  // Phase 6: richer dispute metadata from PayPal webhook resource
  /** PayPal dispute_state — e.g. REQUIRED_ACTION, UNDER_PAYPAL_REVIEW */
  paypalStatus: text("paypal_status"),
  /** PayPal dispute reason code — e.g. ITEM_NOT_RECEIVED, UNAUTHORIZED_TRANSACTION */
  disputeReason: text("dispute_reason"),
  /** PayPal dispute_channel — e.g. INTERNAL, EXTERNAL */
  disputeChannel: text("dispute_channel"),
  /** PayPal dispute_life_cycle_stage — e.g. INQUIRY, CHARGEBACK */
  disputeLifeCycleStage: text("dispute_life_cycle_stage"),
  /** USD amount in dispute from PayPal dispute_amount.value */
  disputeAmountUsd: decimal("dispute_amount_usd", { precision: 10, scale: 2 }),
  /** ISO 4217 code from dispute_amount.currency_code */
  disputeAmountCurrency: text("dispute_amount_currency"),

  // Phase 6: evidence packet
  /**
   * Evidence items assembled from DB — array of:
   * { type: string, url: string | null, description: string, source: string, submitted_at: string | null }
   */
  evidence: jsonb("evidence"),
  evidenceStatus: disputeEvidenceStatusEnum("evidence_status")
    .notNull()
    .default("not_submitted"),
  /** ISO timestamp when evidence was successfully submitted to PayPal */
  evidenceSubmittedAt: timestamp("evidence_submitted_at", { withTimezone: true }),

  // Phase 6: settlement offer (UNVERIFIED until sandbox call)
  /** Offer amount in USD proposed by the platform — NULL until offer made */
  offerAmountUsd: decimal("offer_amount_usd", { precision: 10, scale: 2 }),
  /** ISO timestamp when the offer was successfully submitted to PayPal */
  offerSubmittedAt: timestamp("offer_submitted_at", { withTimezone: true }),

  // Phase 6: resolution
  /** Outcome after resolution — e.g. RESOLVED_BUYER_FAVOR, RESOLVED_SELLER_FAVOR */
  resolutionOutcome: text("resolution_outcome"),

  /** LLM-generated written response / resolution suggestion */
  agentResolution: text("agent_resolution"),
  /** Human-edited version of the agent's suggested response (set before submission) */
  humanEditedResponse: text("human_edited_response"),

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

// ---------------------------------------------------------------------------
// brief_drafts  (Phase 3 — BriefAgent draft persistence)
// ---------------------------------------------------------------------------

export const briefDrafts = pgTable("brief_drafts", {
  id: text("id").primaryKey(),
  projectId: text("project_id").references(() => projects.id),
  agentSessionId: text("agent_session_id").notNull(),
  /** Partial or complete BriefPlan JSON — saved on every agent step */
  planJson: jsonb("plan_json"),
  /** Raw user brief text — used to pre-fill fallback manual editor */
  briefText: text("brief_text"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// brief_rate_limit  (Phase 3 — per-session LLM call quota)
// ---------------------------------------------------------------------------

export const briefRateLimit = pgTable("brief_rate_limit", {
  agentSessionId: text("agent_session_id").primaryKey(),
  callCount: integer("call_count").notNull().default(1),
  windowStart: timestamp("window_start", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// cal_webhook_deliveries  (Phase 4 — Cal.com idempotency)
// ---------------------------------------------------------------------------

export const calWebhookDeliveries = pgTable("cal_webhook_deliveries", {
  id: text("id").primaryKey(),
  /**
   * Dedup key = triggerEvent + '|' + bookingUid + '|' + createdAt (ISO string).
   * UNIQUE constraint enforces idempotency across serverless invocations.
   */
  dedupKey: text("dedup_key").notNull().unique(),
  triggerEvent: text("trigger_event").notNull(),
  bookingUid: text("booking_uid").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// qstash_deliveries  (Phase 4 — QStash message idempotency)
// ---------------------------------------------------------------------------

export const qstashDeliveries = pgTable("qstash_deliveries", {
  /** Upstash-Message-Id header value — used as PRIMARY KEY for dedup */
  messageId: text("message_id").primaryKey(),
  /** Payload type, e.g. NDA_EXPIRY | NO_SHOW_CHECK */
  payloadType: text("payload_type").notNull(),
  /** The entity this message acts on (ndaId or meetingId) */
  entityId: text("entity_id").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// cascade_log  (Phase 4 — audit trail for candidate cascade events)
// ---------------------------------------------------------------------------

export const cascadeLog = pgTable("cascade_log", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id),
  fromCandidateId: text("from_candidate_id")
    .notNull()
    .references(() => candidates.id),
  /**
   * Next candidate invited — NULL if no more candidates are available.
   * FK to candidates(id).
   */
  toCandidateId: text("to_candidate_id"),
  /** Reason for cascade: EXPIRED | DECLINED | CANCELLED | NO_SHOW */
  reason: text("reason").notNull(),
  /** Which round of cascade this is (1-based) */
  round: integer("round").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------
// signals (Phase 5 — vetting agent evidence model)
// ---------------------------------------------------------------------------

export const signals = pgTable("signals", {
  id: text("id").primaryKey(),
  candidateId: text("candidate_id")
    .notNull()
    .references(() => candidates.id),
  /** Links to acceptance_criteria[].id from the project brief */
  requirementId: text("requirement_id").notNull(),
  signalType: evidenceSourceTypeEnum("signal_type").notNull(),
  sourceUrl: text("source_url").notNull(),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull().defaultNow(),
  /** SHA-256 hex of fetched content — used for cache-by-hash */
  contentHash: text("content_hash").notNull(),
  /** Fact extracted by LLM and code-verified (excerpt must exist in content) */
  extractedFact: text("extracted_fact").notNull(),
  /** Verbatim excerpt from source; verified to exist in fetched content before storing */
  quotedExcerpt: text("quoted_excerpt").notNull(),
  /**
   * Confidence score set by code, not LLM.
   * Based on signal type and verified excerpt quality.
   * Range: 0.000–1.000
   */
  confidence: decimal("confidence", { precision: 4, scale: 3 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
