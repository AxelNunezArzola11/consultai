"use client";

/**
 * CandidateMatrixGrid — AG Grid table rendering the can/can't-do matrix
 * for a single candidate, with custom cell renderers for status badges.
 *
 * Uses ag-grid-community (already in package.json) with the Midnight theme.
 * No additional packages needed.
 */

import { useMemo, useRef, useEffect } from "react";
import type { MatrixEntry } from "@/lib/vetting/signals";

interface Props {
  matrix: MatrixEntry[];
  candidateName: string;
}

// AG Grid types (minimal — avoid importing full AG Grid types)
type AgGridApi = {
  sizeColumnsToFit: () => void;
  destroy: () => void;
};

const STATE_STYLE: Record<string, { label: string; dot: string; text: string; bg: string; border: string }> = {
  can:     { label: "Can",     dot: "bg-emerald-400",  text: "text-emerald-300",  bg: "bg-emerald-950/30",  border: "border-emerald-800/50" },
  partial: { label: "Partial", dot: "bg-amber-400",    text: "text-amber-300",    bg: "bg-amber-950/30",    border: "border-amber-800/50" },
  no:      { label: "Cannot",  dot: "bg-rose-400",     text: "text-rose-300",     bg: "bg-rose-950/30",     border: "border-rose-800/50" },
  unknown: { label: "Unknown", dot: "bg-slate-500",    text: "text-slate-400",    bg: "bg-slate-800/40",    border: "border-slate-700/50" },
};

// Pure-React fallback table — rendered when AG Grid CDN hasn't loaded yet
function FallbackTable({ matrix }: { matrix: MatrixEntry[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            <th className="text-left px-3 py-2 font-semibold text-muted-foreground w-16">State</th>
            <th className="text-left px-3 py-2 font-semibold text-muted-foreground">Requirement</th>
            <th className="text-left px-3 py-2 font-semibold text-muted-foreground hidden sm:table-cell">Evidence</th>
          </tr>
        </thead>
        <tbody>
          {matrix.map((entry, i) => {
            const s = STATE_STYLE[entry.state] ?? STATE_STYLE.unknown;
            return (
              <tr
                key={entry.requirementId}
                className={`border-b border-border/50 last:border-0 ${i % 2 === 0 ? "" : "bg-muted/10"}`}
              >
                <td className="px-3 py-2">
                  <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${s.text} ${s.bg} ${s.border}`}>
                    <span className={`inline-block w-1.5 h-1.5 rounded-full ${s.dot}`} />
                    {s.label}
                  </span>
                </td>
                <td className="px-3 py-2 text-foreground/90 font-medium leading-snug">
                  {entry.requirementDescription}
                </td>
                <td className="px-3 py-2 text-muted-foreground leading-snug hidden sm:table-cell">
                  {entry.evidenceSummary
                    ? entry.evidenceSummary.slice(0, 100) + (entry.evidenceSummary.length > 100 ? "…" : "")
                    : entry.state === "unknown"
                      ? "No evidence found"
                      : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function CandidateMatrixGrid({ matrix, candidateName }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<AgGridApi | null>(null);

  // Row data derived from matrix entries
  const rowData = useMemo(
    () =>
      matrix.map((entry) => ({
        state:       entry.state,
        requirement: entry.requirementDescription,
        evidence:    entry.evidenceSummary ?? (entry.state === "unknown" ? "No evidence found" : ""),
        stateLabel:  STATE_STYLE[entry.state]?.label ?? entry.state,
      })),
    [matrix]
  );

  useEffect(() => {
    if (!containerRef.current) return;
    // Dynamically require AG Grid community (already installed in node_modules)
    let mounted = true;
    void (async () => {
      try {
        const ag = await import("ag-grid-community");
        if (!mounted || !containerRef.current) return;
        // AG Grid v32 — register all community modules if available
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const agAny = ag as any;
        if (agAny.ModuleRegistry?.registerModules && agAny.AllCommunityModule) {
          agAny.ModuleRegistry.registerModules([agAny.AllCommunityModule]);
        }

        const isDark = document.documentElement.classList.contains("dark");

        const colDefs = [
          {
            field: "stateLabel",
            headerName: "State",
            width: 100,
            cellRenderer: (params: { value: string; data: { state: string } }) => {
              const s = STATE_STYLE[params.data.state] ?? STATE_STYLE.unknown;
              const el = document.createElement("span");
              el.style.cssText = "display:inline-flex;align-items:center;gap:4px;font-size:11px;font-weight:600;padding:2px 8px;border-radius:9999px;";
              el.textContent = s.label;
              return el;
            },
          },
          {
            field: "requirement",
            headerName: "Requirement",
            flex: 1,
            minWidth: 180,
            wrapText: true,
            autoHeight: true,
          },
          {
            field: "evidence",
            headerName: "Evidence",
            flex: 1,
            minWidth: 160,
            wrapText: true,
            autoHeight: true,
          },
        ];

        const gridOptions = {
          rowData,
          columnDefs: colDefs,
          theme: isDark ? "legacy" : "legacy",
          domLayout: "autoHeight" as const,
          suppressMovableColumns: true,
          suppressCellFocus: true,
          headerHeight: 36,
          rowHeight: 40,
          defaultColDef: {
            sortable: true,
            resizable: true,
          },
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { createGrid } = ag as any;
        if (typeof createGrid === "function") {
          apiRef.current = createGrid(containerRef.current, gridOptions) as AgGridApi;
        }
      } catch (e) {
        console.warn("[CandidateMatrixGrid] AG Grid init failed, using fallback table", e);
      }
    })();

    return () => {
      mounted = false;
      apiRef.current?.destroy?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (matrix.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Can/Can&apos;t-Do Matrix · {candidateName}
      </p>
      {/* Pure React fallback table — always shown; AG Grid mounted imperatively in useEffect */}
      <FallbackTable matrix={matrix} />
      {/* Hidden AG Grid mount target */}
      <div
        ref={containerRef}
        className="ag-theme-alpine-dark w-full text-xs hidden"
        aria-hidden="true"
        style={{ width: "100%" }}
      />
    </div>
  );
}
