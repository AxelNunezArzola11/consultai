/**
 * AG Studio — Payments Platform Data Definition
 *
 * This file is the single source of truth for the AG Studio data model.
 * It maps the ConsultAI database entities to AG Studio sources so that the
 * studio can explore, filter, and pivot across them without any manual SQL.
 *
 * Sources
 * ───────
 *  • invoices   — One row per Milestone that has been funded / paid.
 *                 Mirrors: milestones + payments tables.
 *  • customers  — One row per Candidate (the "customer" in a payment context).
 *                 Mirrors: candidates table.
 *
 * Relationships
 * ─────────────
 *  invoices.candidate_id  →  customers.id   (many-to-one)
 *
 * To use this file:
 *  1. Fetch raw rows from the DB in a Next.js Server Component (page.tsx).
 *  2. Pass the rows into buildStudioData() to get the AgDataSourcesDefinition.
 *  3. Hand the definition down to the <AgStudio data={studioData} /> client.
 *
 * ⚠️  Never import DB clients here — keep this file pure data-shaping logic.
 */

import type { AgDataSourcesDefinition } from "ag-studio";

// ---------------------------------------------------------------------------
// Raw row shapes (returned by the DB queries in page.tsx)
// ---------------------------------------------------------------------------

export interface InvoiceRow {
  /** milestones.id */
  id: string;
  /** milestones.project_id */
  projectId: string;
  /** milestones.title */
  title: string;
  /** milestones.status */
  status: string;
  /** milestones.budget_usd */
  budgetUsd: string | null;
  /** milestones.capture_gross_usd */
  captureGrossUsd: string | null;
  /** milestones.capture_fee_usd */
  captureFeeUsd: string | null;
  /** milestones.capture_net_usd */
  captureNetUsd: string | null;
  /** milestones.currency */
  currency: string | null;
  /** milestones.due_date */
  dueDate: string | null;
  /** milestones.created_at (ISO) */
  createdAt: string;
  /** payments.candidate_id — null if the payout hasn't been assigned */
  candidateId: string | null;
  /** payments.status */
  paymentStatus: string | null;
}

export interface CustomerRow {
  /** candidates.id */
  id: string;
  /** candidates.name */
  name: string;
  /** candidates.email */
  email: string;
  /** candidates.status */
  status: string;
  /** candidates.trust_score */
  trustScore: string | null;
  /** candidates.rank */
  rank: number | null;
  /** candidates.created_at (ISO) */
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Converts raw DB rows into an `AgDataSourcesDefinition` ready for
 * `<AgStudio data={studioData} />`.
 */
export function buildStudioData(
  invoices: InvoiceRow[],
  customers: CustomerRow[]
): AgDataSourcesDefinition {
  return {
    sources: [
      // ── Invoices ──────────────────────────────────────────────────────────
      {
        tableId: "invoices",
        label: "Invoices",
        fields: [
          { fieldId: "id",              label: "Milestone ID",    format: "textFormat",     hide: true },
          { fieldId: "projectId",       label: "Project ID",      format: "textFormat",     hide: true },
          { fieldId: "title",           label: "Milestone",       format: "textFormat" },
          { fieldId: "status",          label: "Status",          format: "textFormat" },
          { fieldId: "paymentStatus",   label: "Payment Status",  format: "textFormat" },
          { fieldId: "currency",        label: "Currency",        format: "textFormat" },
          { fieldId: "budgetUsd",       label: "Budget (USD)",    format: "currencyFormat" },
          { fieldId: "captureGrossUsd", label: "Gross (USD)",     format: "currencyFormat" },
          { fieldId: "captureFeeUsd",   label: "Fee (USD)",       format: "currencyFormat" },
          { fieldId: "captureNetUsd",   label: "Net (USD)",       format: "currencyFormat" },
          { fieldId: "dueDate",         label: "Due Date",        format: "dateFormat" },
          { fieldId: "createdAt",       label: "Created",         format: "dateFormat" },
          // FK — hidden; used by the relationship only
          { fieldId: "candidateId",     label: "Candidate ID",    format: "textFormat",     hide: true },
        ],
        expressions: [
          {
            // Net margin = net / gross — useful as a standalone KPI card
            fieldId: "netMargin",
            label: "Net Margin",
            format: "percentFormat",
            isMeasure: true,
            operator: "divide",
            aggregation: "avg",
            operands: [
              { tableId: "invoices", fieldId: "captureNetUsd" },
              { tableId: "invoices", fieldId: "captureGrossUsd" },
            ],
          },
          {
            // Total gross revenue — used in summary / KPI tiles
            fieldId: "totalGross",
            label: "Total Gross Revenue",
            format: "currencyFormat",
            isMeasure: true,
            operator: "add",
            aggregation: "sum",
            operands: [{ tableId: "invoices", fieldId: "captureGrossUsd" }],
          },
          {
            // Total fees paid to PayPal
            fieldId: "totalFees",
            label: "Total Fees",
            format: "currencyFormat",
            isMeasure: true,
            operator: "add",
            aggregation: "sum",
            operands: [{ tableId: "invoices", fieldId: "captureFeeUsd" }],
          },
        ],
        // Inline the row data so AG Studio can load it immediately.
        // The cast is safe: InvoiceRow is a plain object shape.
        data: invoices as unknown as Record<string, unknown>[],
      },

      // ── Customers (Candidates) ────────────────────────────────────────────
      {
        tableId: "customers",
        label: "Customers",
        fields: [
          { fieldId: "id",         label: "ID",          format: "textFormat", hide: true },
          { fieldId: "name",       label: "Name",        format: "textFormat" },
          { fieldId: "email",      label: "Email",       format: "textFormat" },
          { fieldId: "status",     label: "Status",      format: "textFormat" },
          { fieldId: "trustScore", label: "Trust Score", format: "numberFormat" },
          { fieldId: "rank",       label: "Rank",        format: "numberFormat" },
          { fieldId: "createdAt",  label: "Joined",      format: "dateFormat" },
        ],
        expressions: [
          {
            // Average trust score KPI
            fieldId: "avgTrustScore",
            label: "Avg Trust Score",
            format: "numberFormat",
            isMeasure: true,
            operator: "add",
            aggregation: "avg",
            operands: [{ tableId: "customers", fieldId: "trustScore" }],
          },
        ],
        data: customers as unknown as Record<string, unknown>[],
      },
    ],

    // ── Relationships ───────────────────────────────────────────────────────
    relationships: [
      {
        // invoices.candidateId → customers.id  (many-to-one)
        type: "many-to-one",
        source: { tableId: "invoices",  fieldId: "candidateId" },
        target: { tableId: "customers", fieldId: "id" },
      },
    ],

    // ── Calendars ───────────────────────────────────────────────────────────
    calendars: [
      {
        calendarId: "invoiceDate",
        label: "Invoice Date",
        tableId: "invoices",
        fieldId: "createdAt",
        fragments: ["year", "quarter", "month", "week", "day"],
      },
      {
        calendarId: "dueDate",
        label: "Due Date",
        tableId: "invoices",
        fieldId: "dueDate",
        fragments: ["year", "quarter", "month", "week"],
      },
    ],
  };
}
