-- Migration 0012 — payout failure reason on payments.
--
-- Adds `payments.payout_failure_reason` (text): the human-readable reason
-- extracted from a failed-payout webhook payload (resource.errors name +
-- message, or resource.reason). Written by the PAYOUTS-ITEM.FAILED and
-- PAYOUTSBATCH.DENIED|FAILED webhook handlers; surfaced on the approvals
-- queue, the money-flow panel, and the operations payments grid.
--
-- Idempotent: safe to run multiple times. Existing rows get NULL (no
-- failure recorded). Runtime bootstrap in app/api/paypal/webhook/route.ts
-- (ensurePayoutFailureReasonColumn) applies the same DDL on failure
-- webhooks, so deployments that skip this script self-heal and the
-- status update never breaks on a missing column.
--
-- Apply with: psql "$DATABASE_URL" -f lib/db/migrations/0012_payout_failure_reason.sql

ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "payout_failure_reason" text;
