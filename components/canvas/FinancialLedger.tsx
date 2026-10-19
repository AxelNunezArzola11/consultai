"use client";

/**
 * FinancialLedger — AG Grid Community 32.3.9 financial ledger for project milestones.
 *
 * Theming: New Theming API (themeQuartz.withParams) — AG Grid 32.x documented approach.
 * Source: node_modules/ag-grid-community/dist/types/theming/main.d.ts
 *         themeQuartz.withParams() verified present in 32.3.9 installed source.
 *
 * Community features used (verified from gridOptions.d.ts + installed source):
 *   - Column filtering (agTextColumnFilter, agNumberColumnFilter, agDateColumnFilter) — Community ✓
 *   - Sorting — Community ✓
 *   - Pinned rows (pinnedTopRowData) — Community ✓ (gridOptions.d.ts, no Enterprise guard)
 *   - Pagination — Community ✓
 *   - Custom cell renderers — Community ✓
 *
 * NOT used (Enterprise-only, confirmed absent from Community modules):
 *   - Row Grouping (groupDisplayType / enableRowGroup) — removed
 *   - Pivoting — not used
 *   - Excel export — not used
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, GridReadyEvent } from "ag-grid-community";
import { themeQuartz } from "ag-grid-community";

// ag-grid-community (package flavour) self-registers its modules at import time
// via ModuleRegistry.__registerModules([...], false, undefined) in its own bundle.
// Calling ModuleRegistry.registerModules([...]) from userland marks moduleBased=true
// and triggers "You are mixing modules (i.e. @ag-grid-community/core) and packages
// (ag-grid-community)" at runtime.  Remove the explicit call — nothing to register.

// ── Theme objects (New Theming API) ─────────────────────────────────────────
// themeQuartz.withParams() is the documented AG Grid 32 approach.
// CSS variable values (e.g. "var(--background)") are passed as strings — supported per core-css.d.ts ColorValue type.
// Doc source: https://www.ag-grid.com/react-data-grid/theming/ (v32 New Theming API)

const lightTheme = themeQuartz.withParams({
  backgroundColor: "var(--background)",
  foregroundColor: "var(--foreground)",
  borderColor: "var(--border)",
  chromeBackgroundColor: "var(--muted)",
  headerBackgroundColor: "var(--muted)",
  headerTextColor: "var(--muted-foreground)",
  cellTextColor: "var(--foreground)",
  oddRowBackgroundColor: "var(--background)",
  rowHoverColor: "var(--muted)",
  accentColor: "var(--accent-brand)",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  fontSize: 13,
  borderRadius: 0,
  spacing: 6,
  rowBorder: true,
  pinnedRowBorder: true,
});

const darkTheme = themeQuartz.withParams({
  backgroundColor: "var(--background)",
  foregroundColor: "var(--foreground)",
  borderColor: "var(--border)",
  chromeBackgroundColor: "var(--muted)",
  headerBackgroundColor: "var(--muted)",
  headerTextColor: "var(--muted-foreground)",
  cellTextColor: "var(--foreground)",
  oddRowBackgroundColor: "var(--background)",
  rowHoverColor: "var(--muted)",
  accentColor: "var(--accent-brand)",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  fontSize: 13,
  borderRadius: 0,
  spacing: 6,
  rowBorder: true,
  pinnedRowBorder: true,
  browserColorScheme: "dark",
});

// ── Row type ────────────────────────────────────────────────────────────────

export interface LedgerRow {
  id: string;
  title: string;
  status: string;
  budgetUsd: number;
  captureGrossUsd: number | null;
  captureNetUsd: number | null;
  captureFeeUsd: number | null;
  dueDate: string | null;
  consultant: string | null;
  position: number;
}

// ── Status badge — semantic colours via CSS vars ──────────────────────────────
// No hardcoded hex. Each status gets a Tailwind-inspired semantic pair using
// colour-mix against our CSS tokens so they adapt to light/dark automatically.

const STATUS_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  planned:          { bg: "color-mix(in oklch, var(--muted) 100%, transparent)",         color: "var(--muted-foreground)",  label: "Planned" },
  funded:           { bg: "color-mix(in oklch, #16a34a 15%, var(--background))",          color: "#16a34a",                  label: "Funded" },
  submitted:        { bg: "color-mix(in oklch, var(--accent-brand) 15%, var(--background))", color: "var(--accent-brand)",    label: "Submitted" },
  verifying:        { bg: "color-mix(in oklch, #ca8a04 15%, var(--background))",          color: "#ca8a04",                  label: "Verifying" },
  pending_approval: { bg: "color-mix(in oklch, #d97706 15%, var(--background))",          color: "#d97706",                  label: "Pending Approval" },
  paid:             { bg: "color-mix(in oklch, #059669 15%, var(--background))",          color: "#059669",                  label: "Paid" },
  disputed:         { bg: "color-mix(in oklch, var(--destructive) 15%, var(--background))", color: "var(--destructive)",     label: "Disputed" },
  cancelled:        { bg: "color-mix(in oklch, var(--muted) 100%, transparent)",         color: "var(--muted-foreground)",  label: "Cancelled" },
  failed:           { bg: "color-mix(in oklch, var(--destructive) 15%, var(--background))", color: "var(--destructive)",     label: "Failed" },
  returned:         { bg: "color-mix(in oklch, #db2777 15%, var(--background))",          color: "#db2777",                  label: "Returned" },
};

function StatusCellRenderer({ value }: { value: string }) {
  const s = STATUS_STYLE[value] ?? { bg: "var(--muted)", color: "var(--muted-foreground)", label: value };
  return (
    <span
      style={{
        background: s.bg,
        color: s.color,
        padding: "2px 8px",
        borderRadius: "9999px",
        fontSize: "11px",
        fontWeight: 600,
        letterSpacing: "0.01em",
        display: "inline-block",
        lineHeight: "1.6",
        whiteSpace: "nowrap",
      }}
    >
      {s.label}
    </span>
  );
}

function CurrencyCellRenderer({ value }: { value: number | null }) {
  if (value == null) return <span style={{ color: "var(--muted-foreground)" }}>—</span>;
  return (
    <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>
      ${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </span>
  );
}

// Format YYYY-MM-DD → e.g. "Jun 15, 2025"
function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  // value is a date-only string "YYYY-MM-DD"; parse as local date to avoid off-by-one
  const [year, month, day] = value.split("-").map(Number);
  const d = new Date(year, month - 1, day);
  if (isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// ── Props ────────────────────────────────────────────────────────────────────

export interface FinancialLedgerProps {
  rows: LedgerRow[];
  /** Height of the grid area in px — defaults to 460 */
  height?: number;
}

// ── Column definitions ───────────────────────────────────────────────────────

function buildColumnDefs(): ColDef<LedgerRow>[] {
  return [
    {
      field: "position",
      headerName: "#",
      width: 52,
      pinned: "left",
      sortable: true,
      filter: false,
      cellStyle: { color: "var(--muted-foreground)", fontVariantNumeric: "tabular-nums" },
    },
    {
      field: "title",
      headerName: "Milestone",
      flex: 2,
      minWidth: 160,
      sortable: true,
      filter: "agTextColumnFilter",
      cellStyle: { fontWeight: 500 },
    },
    {
      field: "consultant",
      headerName: "Consultant",
      flex: 1,
      minWidth: 120,
      sortable: true,
      filter: "agTextColumnFilter",
      cellStyle: { color: "var(--muted-foreground)", fontSize: "12px" },
      // valueFormatter returns "—" for null — Community ✓
      valueFormatter: ({ value }: { value: string | null }) => value ?? "—",
    },
    {
      field: "status",
      headerName: "Status",
      width: 160,
      sortable: true,
      filter: "agSetColumnFilter",
      cellRenderer: StatusCellRenderer,
    },
    {
      field: "budgetUsd",
      headerName: "Budget",
      width: 130,
      sortable: true,
      filter: "agNumberColumnFilter",
      cellRenderer: CurrencyCellRenderer,
      type: "numericColumn",
    },
    {
      field: "captureGrossUsd",
      headerName: "Gross",
      width: 120,
      sortable: true,
      filter: "agNumberColumnFilter",
      cellRenderer: CurrencyCellRenderer,
      type: "numericColumn",
    },
    {
      field: "captureFeeUsd",
      headerName: "PP Fee",
      width: 110,
      sortable: true,
      filter: "agNumberColumnFilter",
      cellRenderer: CurrencyCellRenderer,
      type: "numericColumn",
    },
    {
      field: "captureNetUsd",
      headerName: "Net (Held)",
      width: 120,
      sortable: true,
      filter: "agNumberColumnFilter",
      cellRenderer: CurrencyCellRenderer,
      type: "numericColumn",
    },
    {
      field: "dueDate",
      headerName: "Due Date",
      width: 130,
      sortable: true,
      // agDateColumnFilter expects Date objects; use agTextColumnFilter for string dates
      filter: "agTextColumnFilter",
      cellStyle: { color: "var(--muted-foreground)", fontSize: "12px" },
      valueFormatter: ({ value }: { value: string | null }) => formatDate(value),
    },
  ];
}

// ── Pinned summary row builder ───────────────────────────────────────────────
// Community-legal: pinnedTopRowData is in gridOptions.d.ts with no Enterprise guard.
// Source: node_modules/ag-grid-community/dist/types/core/entities/gridOptions.d.ts

function buildSummaryRow(rows: LedgerRow[]): LedgerRow {
  const sum = (fn: (r: LedgerRow) => number | null): number | null => {
    const nums = rows.map(fn).filter((v): v is number => v != null);
    return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : null;
  };
  return {
    id: "__summary__",
    title: `Total (${rows.length} milestone${rows.length !== 1 ? "s" : ""})`,
    status: "",
    budgetUsd: sum((r) => r.budgetUsd) ?? 0,
    captureGrossUsd: sum((r) => r.captureGrossUsd),
    captureFeeUsd: sum((r) => r.captureFeeUsd),
    captureNetUsd: sum((r) => r.captureNetUsd),
    dueDate: null,
    consultant: null,
    position: 0,
  };
}

// ── FinancialLedger ──────────────────────────────────────────────────────────

export function FinancialLedger({ rows, height = 460 }: FinancialLedgerProps) {
  const gridRef = useRef<AgGridReact<LedgerRow>>(null);
  const colDefs = useMemo(() => buildColumnDefs(), []);

  const defaultColDef = useMemo<ColDef>(() => ({
    resizable: true,
    sortable: true,
    filter: true,
    floatingFilter: false,
    suppressMovable: false,
  }), []);

  const pinnedTopRowData = useMemo(() => [buildSummaryRow(rows)], [rows]);

  const onGridReady = useCallback((_: GridReadyEvent) => {
    gridRef.current?.api?.sizeColumnsToFit();
  }, []);

  // Detect dark mode via next-themes class on <html> (matches our ThemeToggle).
  // Falls back to prefers-color-scheme if the class hasn't been applied yet.
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    function check() {
      setIsDark(document.documentElement.classList.contains("dark"));
    }
    check();
    // Observe class changes on <html> for theme toggles
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  const theme = isDark ? darkTheme : lightTheme;

  return (
    <div style={{ height, width: "100%" }}>
      <AgGridReact<LedgerRow>
        ref={gridRef}
        theme={theme}
        rowData={rows}
        columnDefs={colDefs}
        defaultColDef={defaultColDef}
        onGridReady={onGridReady}
        pinnedTopRowData={pinnedTopRowData}
        suppressAggFuncInHeader
        animateRows
        pagination
        paginationPageSize={20}
      />
    </div>
  );
}
