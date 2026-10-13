CREATE TYPE "public"."approval_decision" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."approval_requested_by" AS ENUM('agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."candidate_status" AS ENUM('pending', 'shortlisted', 'nda_sent', 'nda_signed', 'scheduled', 'selected', 'rejected', 'cascaded');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('open', 'resolved', 'escalated');--> statement-breakpoint
CREATE TYPE "public"."evidence_source_type" AS ENUM('github_repo', 'github_pr', 'portfolio', 'public_review', 'provided_link');--> statement-breakpoint
CREATE TYPE "public"."meeting_status" AS ENUM('scheduled', 'held', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."milestone_status" AS ENUM('planned', 'funded', 'submitted', 'verifying', 'pending_approval', 'paid', 'disputed', 'cancelled', 'failed', 'returned');--> statement-breakpoint
CREATE TYPE "public"."nda_status" AS ENUM('pending', 'sent', 'accepted', 'declined', 'expired');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'processing', 'succeeded', 'failed', 'on_hold', 'returned');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('draft', 'active', 'completed', 'cancelled');--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"payment_id" text NOT NULL,
	"milestone_id" text NOT NULL,
	"requested_by" "approval_requested_by" NOT NULL,
	"decision" "approval_decision" DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"event" text NOT NULL,
	"actor" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"github_handle" text,
	"portfolio_url" text,
	"trust_score" numeric(4, 2),
	"can_do" jsonb,
	"cannot_do" jsonb,
	"vetting_summary" text,
	"rank" integer,
	"status" "candidate_status" DEFAULT 'pending' NOT NULL,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"paypal_merchant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "disputes" (
	"id" text PRIMARY KEY NOT NULL,
	"milestone_id" text NOT NULL,
	"payment_id" text,
	"paypal_dispute_id" text,
	"status" "dispute_status" DEFAULT 'open' NOT NULL,
	"claimed_by" text,
	"evidence" jsonb,
	"agent_resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"candidate_id" text NOT NULL,
	"source_type" "evidence_source_type" NOT NULL,
	"source_url" text,
	"title" text,
	"summary" text,
	"relevance_score" numeric(4, 2),
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" text PRIMARY KEY NOT NULL,
	"candidate_id" text NOT NULL,
	"project_id" text NOT NULL,
	"cal_booking_uid" text,
	"scheduled_at" timestamp with time zone,
	"status" "meeting_status" DEFAULT 'scheduled' NOT NULL,
	"cal_cancel_reason" text,
	"booking_link" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"budget_usd" numeric(10, 2) NOT NULL,
	"due_date" date,
	"status" "milestone_status" DEFAULT 'planned' NOT NULL,
	"paypal_order_id" text,
	"paypal_capture_id" text,
	"capture_gross_usd" numeric(10, 2),
	"capture_fee_usd" numeric(10, 2),
	"capture_net_usd" numeric(10, 2),
	"currency" text,
	"paypal_payout_batch_id" text,
	"paypal_payout_item_id" text,
	"idempotency_key" text,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "milestones_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "ndas" (
	"id" text PRIMARY KEY NOT NULL,
	"candidate_id" text NOT NULL,
	"project_id" text NOT NULL,
	"template_version" text,
	"content_hash" text,
	"pdf_url" text,
	"invite_token" text,
	"status" "nda_status" DEFAULT 'pending' NOT NULL,
	"sent_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"accepted_name" text,
	"accepted_ip" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ndas_invite_token_unique" UNIQUE("invite_token")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"milestone_id" text NOT NULL,
	"candidate_id" text,
	"gross_usd" numeric(10, 2),
	"fee_usd" numeric(10, 2),
	"net_usd" numeric(10, 2),
	"currency" text,
	"payout_fee_usd" numeric(10, 2),
	"paypal_order_id" text,
	"paypal_capture_id" text,
	"paypal_payout_batch_id" text,
	"paypal_payout_item_id" text,
	"sender_batch_id" text,
	"idempotency_key" text,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"justification" text,
	"evidence_summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_sender_batch_id_unique" UNIQUE("sender_batch_id"),
	CONSTRAINT "payments_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "paypal_webhook_deliveries" (
	"event_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"company_id" text NOT NULL,
	"title" text NOT NULL,
	"raw_brief" text,
	"structured_brief" jsonb,
	"acceptance_criteria" jsonb,
	"status" "project_status" DEFAULT 'draft' NOT NULL,
	"auto_approve_threshold_usd" numeric(10, 2) DEFAULT '500.00',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ndas" ADD CONSTRAINT "ndas_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ndas" ADD CONSTRAINT "ndas_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;