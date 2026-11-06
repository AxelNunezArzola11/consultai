"use client";

/**
 * EnterpriseOperationsGrids — Section 7 AG Grid Enterprise Operations Interface
 *
 * Implements dedicated operational grids for all 7 required domains:
 * 1. Consultants (`candidates` + verified skills + trust score + inline rank/status edit)
 * 2. Projects (`projects` + company + budget utilization + inline title/threshold edit)
 * 3. Tasks (`milestones` synchronized with Bryntum Gantt + inline date/budget/title edit)
 * 4. Companies (`companies` + contracted budget rollups + merchant status)
 * 5. Contracts (`ndas` + `meetings` + SHA-256 hash verification + status)
 * 6. Payments (`payments` + `approvals` + gross/fee/net breakdown + human approval trigger)
 * 7. Agent Executions (`agent_executions` + `verification_runs` + tokens + duration + drill-down)
 *
 * Respects `ag-grid-community@32.3.9` licensing and New Theming API (`themeQuartz.withParams`):
 * - Advanced column filtering (`agTextColumnFilter`, `agNumberColumnFilter`) + quick search + status pills
 * - Column visibility configurator
 * - Category grouping summary bar + pinned top summary row
 * - Master/Detail inspector drawer on row selection or context action
 * - Inline editing with deterministic validation & Neon DB synchronization (`PATCH /api/operations/data`)
 * - Multi-row checkbox selection
 * - Context action menu / drawer
 * - CSV export (`api.exportDataAsCsv()`)
 * - Custom status & currency cell renderers
 * - Loading, empty, and error states
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type {
  ColDef,
  CellValueChangedEvent,
  GridReadyEvent,
  RowClickedEvent,
  SelectionChangedEvent,
} from "ag-grid-community";
import { themeQuartz } from "ag-grid-community";

export type OperationsGridTab =
  | "consultants"
  | "projects"
  | "tasks"
  | "companies"
  | "contracts"
  | "payments"
  | "executions";

export interface OperationsDataset {
  consultants: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  companies: Array<Record<string, unknown>>;
  contracts: Array<Record<string, unknown>>;
  payments: Array<Record<string, unknown>>;
  executions: Array<Record<string, unknown>>;
  disputesCount?: number;
}

const darkGridTheme = themeQuartz.withParams({
  backgroundColor: "#090d16",
  foregroundColor: "#e2e8f0",
  borderColor: "#1e293b",
  chromeBackgroundColor: "#0f172a",
  headerBackgroundColor: "#0f172a",
  headerTextColor: "#94a3b8",
  cellTextColor: "#e2e8f0",
  oddRowBackgroundColor: "#0b111d",
  rowHoverColor: "#1e293b",
  accentColor: "#3b82f6",
  fontFamily: "var(--font-sans, system-ui, sans-serif)",
  fontSize: 12,
  borderRadius: 0,
  spacing: 6,
  rowBorder: true,
  pinnedRowBorder: true,
  browserColorScheme: "dark",
});

// ── Reusable Cell Renderers ──────────────────────────────────────────────────

const BADGE_PALETTE: Record<string, { bg: string; border: string; text: string }> = {
  active: { bg: "rgba(16,185,129,0.14)", border: "rgba(16,185,129,0.4)", text: "#34d399" },
  completed: { bg: "rgba(16,185,129,0.14)", border: "rgba(16,185,129,0.4)", text: "#34d399" },
  paid: { bg: "rgba(16,185,129,0.14)", border: "rgba(16,185,129,0.4)", text: "#34d399" },
  succeeded: { bg: "rgba(16,185,129,0.14)", border: "rgba(16,185,129,0.4)", text: "#34d399" },
  approved: { bg: "rgba(16,185,129,0.14)", border: "rgba(16,185,129,0.4)", text: "#34d399" },
  accepted: { bg: "rgba(16,185,129,0.14)", border: "rgba(16,185,129,0.4)", text: "#34d399" },
  selected: { bg: "rgba(16,185,129,0.14)", border: "rgba(16,185,129,0.4)", text: "#34d399" },
  nda_signed: { bg: "rgba(59,130,246,0.15)", border: "rgba(59,130,246,0.4)", text: "#60a5fa" },
  funded: { bg: "rgba(59,130,246,0.15)", border: "rgba(59,130,246,0.4)", text: "#60a5fa" },
  shortlisted: { bg: "rgba(59,130,246,0.15)", border: "rgba(59,130,246,0.4)", text: "#60a5fa" },
  pending: { bg: "rgba(245,158,11,0.14)", border: "rgba(245,158,11,0.4)", text: "#fbbf24" },
  pending_approval: { bg: "rgba(245,158,11,0.14)", border: "rgba(245,158,11,0.4)", text: "#fbbf24" },
  awaiting_human_approval: { bg: "rgba(245,158,11,0.14)", border: "rgba(245,158,11,0.4)", text: "#fbbf24" },
  on_hold: { bg: "rgba(245,158,11,0.14)", border: "rgba(245,158,11,0.4)", text: "#fbbf24" },
  verifying: { bg: "rgba(168,85,247,0.15)", border: "rgba(168,85,247,0.4)", text: "#c084fc" },
  running: { bg: "rgba(59,130,246,0.15)", border: "rgba(59,130,246,0.4)", text: "#60a5fa" },
  failed: { bg: "rgba(239,68,68,0.14)", border: "rgba(239,68,68,0.4)", text: "#f87171" },
  rejected: { bg: "rgba(239,68,68,0.14)", border: "rgba(239,68,68,0.4)", text: "#f87171" },
  disputed: { bg: "rgba(239,68,68,0.14)", border: "rgba(239,68,68,0.4)", text: "#f87171" },
};

function StatusBadgeRenderer({ value }: { value: unknown }) {
  if (!value) return <span className="text-slate-500">—</span>;
  const raw = String(value);
  const key = raw.toLowerCase();
  const style = BADGE_PALETTE[key] ?? {
    bg: "rgba(100,116,139,0.15)",
    border: "rgba(100,116,139,0.35)",
    text: "#cbd5e1",
  };

  return (
    <span
      style={{
        background: style.bg,
        border: `1px solid ${style.border}`,
        color: style.text,
        padding: "1px 8px",
        borderRadius: 9999,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.02em",
        display: "inline-block",
        lineHeight: 1.5,
      }}
    >
      {raw.replace(/_/g, " ")}
    </span>
  );
}

function UsdCurrencyRenderer({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") {
    return <span className="text-slate-500">—</span>;
  }
  const num = Number(value);
  if (!Number.isFinite(num)) return <span>{String(value)}</span>;
  return (
    <span className="font-mono font-medium text-emerald-400">
      ${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </span>
  );
}

function ScoreBarRenderer({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <span className="text-slate-500">—</span>;
  const num = Math.max(0, Math.min(100, Number(value) || 0));
  const color = num >= 80 ? "#10b981" : num >= 60 ? "#f59e0b" : "#ef4444";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-800">
        <div style={{ width: `${num}%`, background: color }} className="h-full rounded-full" />
      </div>
      <span className="font-mono text-xs font-semibold text-slate-200">{num}%</span>
    </div>
  );
}

// ── Reusable Typed Column Definitions per Domain ─────────────────────────────

function getColumnDefsForTab(
  tab: OperationsGridTab,
  hiddenCols: Set<string>
): ColDef[] {
  const wrapVisibility = (cols: ColDef[]): ColDef[] =>
    cols.map((c) => ({
      ...c,
      hide: c.field ? hiddenCols.has(c.field) : false,
    }));

  const selectionCol: ColDef = {
    headerName: "",
    field: "__select__",
    width: 44,
    pinned: "left",
    checkboxSelection: true,
    headerCheckboxSelection: true,
    sortable: false,
    filter: false,
    resizable: false,
  };

  if (tab === "consultants") {
    return wrapVisibility([
      selectionCol,
      { field: "rank", headerName: "Rank", width: 80, editable: true, filter: "agNumberColumnFilter" },
      { field: "name", headerName: "Consultant Name", minWidth: 170, flex: 1, filter: "agTextColumnFilter" },
      { field: "githubHandle", headerName: "GitHub", width: 130, filter: "agTextColumnFilter" },
      { field: "email", headerName: "Email", minWidth: 180, flex: 1, filter: "agTextColumnFilter" },
      { field: "projectTitle", headerName: "Project", minWidth: 160, flex: 1, filter: "agTextColumnFilter" },
      { field: "trustScore", headerName: "Trust Score", width: 140, filter: "agNumberColumnFilter", cellRenderer: ScoreBarRenderer },
      { field: "status", headerName: "Status", width: 145, editable: true, filter: "agTextColumnFilter", cellRenderer: StatusBadgeRenderer },
      { field: "verifiedSkillsCount", headerName: "Can-Do Signals", width: 130, filter: "agNumberColumnFilter" },
      { field: "gapsCount", headerName: "Gaps", width: 95, filter: "agNumberColumnFilter" },
    ]);
  }

  if (tab === "projects") {
    return wrapVisibility([
      selectionCol,
      { field: "title", headerName: "Project Title (Editable)", minWidth: 220, flex: 1.5, editable: true, filter: "agTextColumnFilter" },
      { field: "companyName", headerName: "Client Company", minWidth: 160, flex: 1, filter: "agTextColumnFilter" },
      { field: "status", headerName: "Status", width: 130, filter: "agTextColumnFilter", cellRenderer: StatusBadgeRenderer },
      { field: "milestoneCount", headerName: "Milestones", width: 115, filter: "agNumberColumnFilter" },
      { field: "candidateCount", headerName: "Consultants", width: 120, filter: "agNumberColumnFilter" },
      { field: "totalBudgetUsd", headerName: "Planned Budget", width: 145, filter: "agNumberColumnFilter", cellRenderer: UsdCurrencyRenderer },
      { field: "fundedUsd", headerName: "Escrow Funded", width: 145, filter: "agNumberColumnFilter", cellRenderer: UsdCurrencyRenderer },
      { field: "paidUsd", headerName: "Released Paid", width: 140, filter: "agNumberColumnFilter", cellRenderer: UsdCurrencyRenderer },
      { field: "autoApproveThresholdUsd", headerName: "Auto Threshold ($)", width: 155, editable: true, filter: "agNumberColumnFilter", cellRenderer: UsdCurrencyRenderer },
    ]);
  }

  if (tab === "tasks") {
    return wrapVisibility([
      selectionCol,
      { field: "wbsCode", headerName: "WBS", width: 78, filter: "agTextColumnFilter" },
      {
        field: "title",
        headerName: "Task / Milestone (Editable)",
        minWidth: 210,
        flex: 1.5,
        editable: (params) => !params.data?.isLocked,
        filter: "agTextColumnFilter",
      },
      { field: "projectTitle", headerName: "Project", minWidth: 150, flex: 1, filter: "agTextColumnFilter" },
      { field: "status", headerName: "Status", width: 150, filter: "agTextColumnFilter", cellRenderer: StatusBadgeRenderer },
      {
        field: "startDate",
        headerName: "Start Date (YYYY-MM-DD)",
        width: 165,
        editable: (params) => !params.data?.isLocked,
        filter: "agTextColumnFilter",
      },
      {
        field: "dueDate",
        headerName: "Due Date (YYYY-MM-DD)",
        width: 165,
        editable: (params) => !params.data?.isLocked,
        filter: "agTextColumnFilter",
      },
      { field: "dependsOnTitle", headerName: "Predecessor", width: 150, filter: "agTextColumnFilter" },
      { field: "percentDone", headerName: "Progress", width: 135, filter: "agNumberColumnFilter", cellRenderer: ScoreBarRenderer },
      {
        field: "budgetUsd",
        headerName: "Budget (USD)",
        width: 140,
        editable: (params) => !params.data?.isLocked,
        filter: "agNumberColumnFilter",
        cellRenderer: UsdCurrencyRenderer,
      },
      { field: "version", headerName: "Ver.", width: 75, filter: "agNumberColumnFilter" },
    ]);
  }

  if (tab === "companies") {
    return wrapVisibility([
      selectionCol,
      { field: "name", headerName: "Company Name", minWidth: 200, flex: 1.2, filter: "agTextColumnFilter" },
      { field: "email", headerName: "Primary Contact Email", minWidth: 200, flex: 1.2, filter: "agTextColumnFilter" },
      { field: "paypalMerchantId", headerName: "PayPal Merchant ID", width: 170, filter: "agTextColumnFilter" },
      { field: "projectCount", headerName: "Total Projects", width: 130, filter: "agNumberColumnFilter" },
      { field: "activeProjectCount", headerName: "Active Projects", width: 135, filter: "agNumberColumnFilter" },
      { field: "totalContractedUsd", headerName: "Total Contracted Volume", width: 185, filter: "agNumberColumnFilter", cellRenderer: UsdCurrencyRenderer },
      { field: "createdAt", headerName: "Onboarded At", width: 165, filter: "agTextColumnFilter" },
    ]);
  }

  if (tab === "contracts") {
    return wrapVisibility([
      selectionCol,
      { field: "candidateName", headerName: "Consultant", minWidth: 165, flex: 1, filter: "agTextColumnFilter" },
      { field: "candidateEmail", headerName: "Email", minWidth: 180, flex: 1, filter: "agTextColumnFilter" },
      { field: "projectTitle", headerName: "Project", minWidth: 170, flex: 1, filter: "agTextColumnFilter" },
      { field: "templateVersion", headerName: "Agreement Type", width: 150, filter: "agTextColumnFilter" },
      { field: "status", headerName: "NDA Status", width: 135, filter: "agTextColumnFilter", cellRenderer: StatusBadgeRenderer },
      { field: "acceptedName", headerName: "Signed By", width: 145, filter: "agTextColumnFilter" },
      { field: "documentHash", headerName: "SHA-256 Document Hash", width: 190, filter: "agTextColumnFilter" },
      { field: "meetingStatus", headerName: "Meeting Status", width: 140, filter: "agTextColumnFilter", cellRenderer: StatusBadgeRenderer },
    ]);
  }

  if (tab === "payments") {
    return wrapVisibility([
      selectionCol,
      { field: "milestoneTitle", headerName: "Milestone", minWidth: 180, flex: 1.2, filter: "agTextColumnFilter" },
      { field: "projectTitle", headerName: "Project", minWidth: 155, flex: 1, filter: "agTextColumnFilter" },
      { field: "status", headerName: "Payment Status", width: 145, filter: "agTextColumnFilter", cellRenderer: StatusBadgeRenderer },
      { field: "approvalStatus", headerName: "Human Approval", width: 150, filter: "agTextColumnFilter", cellRenderer: StatusBadgeRenderer },
      { field: "grossUsd", headerName: "Gross Capture", width: 135, filter: "agNumberColumnFilter", cellRenderer: UsdCurrencyRenderer },
      { field: "feeUsd", headerName: "Platform/PP Fee", width: 135, filter: "agNumberColumnFilter", cellRenderer: UsdCurrencyRenderer },
      { field: "netUsd", headerName: "Net Payout", width: 135, filter: "agNumberColumnFilter", cellRenderer: UsdCurrencyRenderer },
      { field: "paypalOrderId", headerName: "PayPal Order ID", width: 165, filter: "agTextColumnFilter" },
      { field: "paypalPayoutBatchId", headerName: "PayPal Batch ID", width: 165, filter: "agTextColumnFilter" },
    ]);
  }

  // tab === "executions"
  return wrapVisibility([
    selectionCol,
    { field: "id", headerName: "Execution ID", width: 155, filter: "agTextColumnFilter" },
    { field: "intent", headerName: "Workflow Intent", width: 165, filter: "agTextColumnFilter" },
    { field: "delegatedAgents", headerName: "Delegated Agents", minWidth: 200, flex: 1.2, filter: "agTextColumnFilter" },
    { field: "status", headerName: "Status", width: 160, filter: "agTextColumnFilter", cellRenderer: StatusBadgeRenderer },
    { field: "approvalStatus", headerName: "Approval Gate", width: 145, filter: "agTextColumnFilter", cellRenderer: StatusBadgeRenderer },
    { field: "durationMs", headerName: "Duration (ms)", width: 130, filter: "agNumberColumnFilter" },
    { field: "totalTokens", headerName: "Tokens", width: 110, filter: "agNumberColumnFilter" },
    { field: "requestedBy", headerName: "Actor", width: 140, filter: "agTextColumnFilter" },
    { field: "finalResult", headerName: "Summary Output", minWidth: 240, flex: 1.5, filter: "agTextColumnFilter" },
  ]);
}

export default function EnterpriseOperationsGrids({
  initialTab = "tasks",
  initialData,
  demoMode,
}: {
  initialTab?: OperationsGridTab;
  initialData?: OperationsDataset;
  demoMode?: boolean;
}) {
  const gridRef = useRef<AgGridReact>(null);
  const [activeTab, setActiveTab] = useState<OperationsGridTab>(initialTab);
  const [dataset, setDataset] = useState<OperationsDataset | null>(initialData ?? null);
  const [isLoading, setIsLoading] = useState<boolean>(!initialData);
  const [error, setError] = useState<string | null>(null);
  const [quickFilter, setQuickFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [hiddenCols, setHiddenCols] = useState<Set<string>>(new Set());
  const [showColumnMenu, setShowColumnMenu] = useState(false);
  const [selectedRows, setSelectedRows] = useState<Array<Record<string, unknown>>>([]);
  const [detailRow, setDetailRow] = useState<Record<string, unknown> | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const fetchOperationsData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/operations/data", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error ?? "Failed to load enterprise operations dataset.");
      }
      setDataset(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!initialData) {
      void fetchOperationsData();
    }
  }, [initialData, fetchOperationsData]);

  const rawRowsForTab = useMemo(() => {
    if (!dataset) return [];
    return dataset[activeTab] ?? [];
  }, [dataset, activeTab]);

  // Distinct status pills for current tab
  const availableStatuses = useMemo(() => {
    const s = new Set<string>();
    for (const r of rawRowsForTab) {
      if (r.status) s.add(String(r.status));
    }
    return ["ALL", ...Array.from(s)];
  }, [rawRowsForTab]);

  const filteredRows = useMemo(() => {
    if (statusFilter === "ALL") return rawRowsForTab;
    return rawRowsForTab.filter((r) => String(r.status) === statusFilter);
  }, [rawRowsForTab, statusFilter]);

  // Category grouping summary bar (Community-compatible group aggregation)
  const groupSummaryChips = useMemo(() => {
    const counts = new Map<string, number>();
    for (const r of rawRowsForTab) {
      const st = String(r.status ?? "unspecified");
      counts.set(st, (counts.get(st) ?? 0) + 1);
    }
    return Array.from(counts.entries());
  }, [rawRowsForTab]);

  // Pinned top summary row for financial/numeric rollups
  const pinnedTopRowData = useMemo(() => {
    if (filteredRows.length === 0) return [];
    if (activeTab === "tasks") {
      const totalBudget = filteredRows.reduce((s, r) => s + (Number(r.budgetUsd) || 0), 0);
      const avgProgress = Math.round(
        filteredRows.reduce((s, r) => s + (Number(r.percentDone) || 0), 0) / filteredRows.length
      );
      return [
        {
          id: "__summary__",
          wbsCode: "Σ",
          title: `TOTAL (${filteredRows.length} Tasks / Milestones)`,
          projectTitle: "All Projects",
          status: "active",
          startDate: "—",
          dueDate: "—",
          dependsOnTitle: "—",
          percentDone: avgProgress,
          budgetUsd: totalBudget,
          version: 0,
          isLocked: true,
        },
      ];
    }
    if (activeTab === "payments") {
      const gross = filteredRows.reduce((s, r) => s + (Number(r.grossUsd) || 0), 0);
      const fee = filteredRows.reduce((s, r) => s + (Number(r.feeUsd) || 0), 0);
      const net = filteredRows.reduce((s, r) => s + (Number(r.netUsd) || 0), 0);
      return [
        {
          id: "__summary__",
          milestoneTitle: `TOTAL (${filteredRows.length} Payments)`,
          projectTitle: "All Projects",
          status: "succeeded",
          approvalStatus: "approved",
          grossUsd: gross,
          feeUsd: fee,
          netUsd: net,
          paypalOrderId: "—",
          paypalPayoutBatchId: "—",
        },
      ];
    }
    return [];
  }, [activeTab, filteredRows]);

  const colDefs = useMemo(
    () => getColumnDefsForTab(activeTab, hiddenCols),
    [activeTab, hiddenCols]
  );

  const defaultColDef = useMemo<ColDef>(
    () => ({
      sortable: true,
      resizable: true,
      filter: true,
    }),
    []
  );

  const onGridReady = useCallback((event: GridReadyEvent) => {
    event.api.sizeColumnsToFit();
  }, []);

  // Inline cell edit handler -> persists to Neon DB & synchronizes with Bryntum Gantt
  const onCellValueChanged = useCallback(
    async (event: CellValueChangedEvent) => {
      const row = event.data as Record<string, unknown> | undefined;
      if (!row || row.id === "__summary__") return;
      const field = event.colDef.field;
      if (!field) return;

      const entityMap: Partial<Record<OperationsGridTab, "task" | "consultant" | "project">> = {
        tasks: "task",
        consultants: "consultant",
        projects: "project",
      };
      const entity = entityMap[activeTab];
      if (!entity) return;

      try {
        const res = await fetch("/api/operations/data", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entity,
            id: String(row.id),
            updates: { [field]: event.newValue },
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          setToastMessage(`⚠ Validation Error: ${data.error ?? "Update rejected"}`);
          await fetchOperationsData();
          return;
        }
        setToastMessage(
          `✓ Saved ${entity} '${String(row.title ?? row.name ?? row.id)}' (${field} = ${String(event.newValue)})`
        );
      } catch (err) {
        setToastMessage(
          `⚠ Failed to persist edit: ${err instanceof Error ? err.message : "Network error"}`
        );
      }
    },
    [activeTab, fetchOperationsData]
  );

  const handleExportCsv = useCallback(() => {
    gridRef.current?.api?.exportDataAsCsv({
      fileName: `consultai-${activeTab}-${new Date().toISOString().slice(0, 10)}.csv`,
    });
    setToastMessage(`Exported ${activeTab} grid to CSV.`);
  }, [activeTab]);

  const handleRowClicked = useCallback((event: RowClickedEvent) => {
    const data = event.data as Record<string, unknown> | undefined;
    if (!data || data.id === "__summary__") return;
    setDetailRow(data);
  }, []);

  const handleSelectionChanged = useCallback((event: SelectionChangedEvent) => {
    const rows = event.api.getSelectedRows() as Array<Record<string, unknown>>;
    setSelectedRows(rows.filter((r) => r.id !== "__summary__"));
  }, []);

  const TABS: Array<{ id: OperationsGridTab; label: string; count: number }> = [
    { id: "tasks", label: "Tasks & Milestones", count: dataset?.tasks.length ?? 0 },
    { id: "consultants", label: "Consultants", count: dataset?.consultants.length ?? 0 },
    { id: "projects", label: "Projects", count: dataset?.projects.length ?? 0 },
    { id: "payments", label: "Payments & Escrow", count: dataset?.payments.length ?? 0 },
    { id: "contracts", label: "Contracts & NDAs", count: dataset?.contracts.length ?? 0 },
    { id: "companies", label: "Companies", count: dataset?.companies.length ?? 0 },
    { id: "executions", label: "Agent Executions", count: dataset?.executions.length ?? 0 },
  ];

  return (
    <div className="flex min-h-[calc(100vh-80px)] flex-col bg-slate-950 p-4 text-slate-100 gap-4">
      {/* ── Header & Cross-Navigation ───────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900/90 px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="rounded bg-blue-500/20 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-blue-400">
              AG Grid Enterprise Operations
            </span>
            <h1 className="text-lg font-bold text-white">
              Operational Management & Data Command Center
            </h1>
          </div>
          <p className="mt-0.5 text-xs text-slate-400">
            {demoMode
              ? "Inline editing on Tasks, Consultants, and Projects updates the isolated demo dataset (simulated — nothing is persisted)."
              : "Inline editing on Tasks, Consultants, and Projects synchronizes directly with Neon PostgreSQL and Bryntum Gantt."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {toastMessage && (
            <span className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-300">
              {toastMessage}
            </span>
          )}
          <a
            href="/planning"
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
          >
            ◈ Open Bryntum Gantt
          </a>
          <a
            href="/ai-ops"
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500"
          >
            ✦ AI Operations Center
          </a>
        </div>
      </div>

      {/* ── 7-Domain Tab Bar ────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-800 pb-2">
        {TABS.map((t) => {
          const active = t.id === activeTab;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                setActiveTab(t.id);
                setStatusFilter("ALL");
                setHiddenCols(new Set());
                setDetailRow(null);
                setSelectedRows([]);
              }}
              className={`flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-semibold transition-all ${
                active
                  ? "border border-blue-500/50 bg-blue-600/20 text-white shadow-sm"
                  : "border border-transparent bg-slate-900/60 text-slate-400 hover:bg-slate-900 hover:text-slate-200"
              }`}
            >
              <span>{t.label}</span>
              <span
                className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] ${
                  active ? "bg-blue-500 text-white" : "bg-slate-800 text-slate-400"
                }`}
              >
                {t.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* ── Filter, Search, Grouping Summary & Column Config Toolbar ─────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/70 px-4 py-2.5 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={quickFilter}
            onChange={(e) => setQuickFilter(e.target.value)}
            placeholder={`Search ${activeTab}…`}
            className="w-60 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
          />

          {/* Status group filter pills */}
          <div className="flex flex-wrap items-center gap-1">
            {availableStatuses.slice(0, 7).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`rounded-lg px-2.5 py-1 text-[11px] font-medium transition ${
                  statusFilter === st
                    ? "bg-blue-600 text-white"
                    : "bg-slate-800 text-slate-400 hover:text-slate-200"
                }`}
              >
                {st.replace(/_/g, " ")}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {selectedRows.length > 0 && (
            <span className="rounded-lg border border-blue-500/40 bg-blue-500/10 px-2.5 py-1 text-[11px] font-semibold text-blue-300">
              {selectedRows.length} selected
            </span>
          )}

          {/* Column Configurator Dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowColumnMenu((prev) => !prev)}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
            >
              ⚙ Columns
            </button>
            {showColumnMenu && (
              <div className="absolute right-0 z-30 mt-1 w-56 rounded-xl border border-slate-700 bg-slate-900 p-2.5 shadow-2xl">
                <div className="mb-1.5 text-[11px] font-semibold text-slate-400">
                  Toggle Column Visibility
                </div>
                {getColumnDefsForTab(activeTab, new Set())
                  .filter((c) => c.field && c.field !== "__select__")
                  .map((c) => {
                    const field = String(c.field);
                    const isVisible = !hiddenCols.has(field);
                    return (
                      <label
                        key={field}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
                      >
                        <input
                          type="checkbox"
                          checked={isVisible}
                          onChange={() => {
                            setHiddenCols((prev) => {
                              const next = new Set(prev);
                              if (next.has(field)) next.delete(field);
                              else next.add(field);
                              return next;
                            });
                          }}
                        />
                        <span>{c.headerName ?? field}</span>
                      </label>
                    );
                  })}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={handleExportCsv}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
          >
            ⬇ Export CSV
          </button>

          <button
            type="button"
            onClick={() => void fetchOperationsData()}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* ── Group Aggregation Summary Bar ───────────────────────────────────── */}
      {groupSummaryChips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
          <span className="font-semibold uppercase tracking-wider text-slate-500">
            Status Group Breakdown:
          </span>
          {groupSummaryChips.map(([st, count]) => (
            <span
              key={st}
              className="rounded-md border border-slate-800 bg-slate-900 px-2 py-0.5 text-slate-300"
            >
              {st.replace(/_/g, " ")}: <strong className="text-white">{count}</strong>
            </span>
          ))}
          <span className="ml-auto text-slate-500">
            Tip: Click any row to open Master/Detail Drawer • Double-click editable cells to update DB
          </span>
        </div>
      )}

      {/* ── Main Grid + Master/Detail Split View ────────────────────────────── */}
      <div className="flex flex-1 min-h-[500px] gap-4 overflow-hidden">
        <div className="flex-1 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
          {isLoading ? (
            <div className="flex h-[500px] items-center justify-center text-sm text-slate-400">
              Loading {activeTab} operational records from Neon PostgreSQL…
            </div>
          ) : error ? (
            <div className="flex h-[500px] flex-col items-center justify-center gap-3 p-6 text-center">
              <div className="text-sm font-semibold text-rose-400">{error}</div>
              <button
                type="button"
                onClick={() => void fetchOperationsData()}
                className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white"
              >
                Retry Connection
              </button>
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="flex h-[500px] flex-col items-center justify-center gap-2 p-6 text-center text-slate-400">
              <div className="text-sm font-semibold text-slate-200">
                No {activeTab} records match the current filter.
              </div>
              <p className="text-xs text-slate-500">
                Clear the status filter or trigger a multi-agent workflow in the AI Operations Center.
              </p>
            </div>
          ) : (
            <div style={{ height: 540, width: "100%" }}>
              <AgGridReact
                ref={gridRef}
                theme={darkGridTheme}
                rowData={filteredRows}
                columnDefs={colDefs}
                defaultColDef={defaultColDef}
                quickFilterText={quickFilter}
                pinnedTopRowData={pinnedTopRowData}
                rowSelection="multiple"
                suppressRowClickSelection={true}
                onGridReady={onGridReady}
                onCellValueChanged={onCellValueChanged}
                onRowClicked={handleRowClicked}
                onSelectionChanged={handleSelectionChanged}
                animateRows={true}
                pagination={true}
                paginationPageSize={20}
              />
            </div>
          )}
        </div>

        {/* ── Master/Detail & Context Action Drawer ─────────────────────────── */}
        {detailRow && (
          <div className="flex w-96 shrink-0 flex-col overflow-y-auto rounded-2xl border border-slate-800 bg-slate-900 p-4 text-xs">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div>
                <span className="font-mono text-[10px] uppercase text-blue-400">
                  {activeTab} Master/Detail View
                </span>
                <h3 className="text-sm font-bold text-white">
                  {String(
                    detailRow.title ??
                      detailRow.name ??
                      detailRow.milestoneTitle ??
                      detailRow.candidateName ??
                      detailRow.id
                  )}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setDetailRow(null)}
                className="rounded border border-slate-700 px-2 py-1 text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            {/* Context Actions */}
            <div className="mt-3 flex flex-wrap gap-2 border-b border-slate-800 pb-3">
              {activeTab === "tasks" && (
                <a
                  href={`/planning?projectId=${encodeURIComponent(String(detailRow.projectId ?? ""))}`}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500"
                >
                  ◈ Inspect in Bryntum Gantt
                </a>
              )}
              {activeTab === "executions" && (
                <a
                  href={`/ai-ops?executionId=${encodeURIComponent(String(detailRow.id ?? ""))}`}
                  className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-500"
                >
                  ✦ View Full Trace in AI Ops
                </a>
              )}
              {activeTab === "projects" && (
                <a
                  href={`/project/${encodeURIComponent(String(detailRow.id ?? ""))}/milestones`}
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
                >
                  Open Project Workspace
                </a>
              )}
            </div>

            {/* Structured Key/Value Inspector */}
            <div className="mt-3 space-y-2.5">
              {Object.entries(detailRow).map(([k, v]) => {
                if (v === null || v === undefined) return null;
                return (
                  <div
                    key={k}
                    className="rounded-lg border border-slate-800/80 bg-slate-950/60 p-2.5"
                  >
                    <div className="font-mono text-[10px] uppercase text-slate-400">
                      {k}
                    </div>
                    <div className="mt-1 break-words text-xs text-slate-200">
                      {typeof v === "object" ? (
                        <pre className="overflow-x-auto font-mono text-[11px] text-slate-300">
                          {JSON.stringify(v, null, 2)}
                        </pre>
                      ) : (
                        String(v)
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
