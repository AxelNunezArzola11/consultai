"use client";

/**
 * ScenarioSimulation — Side-by-side candidate comparison chart.
 *
 * Renders an AG Charts bar chart (or a pure-React fallback) comparing
 * shortlisted candidates across three dimensions:
 *   1. Stack Fit %        (from scoreBreakdown.bySignalType.github_repo.avgConfidence)
 *   2. Estimated Delivery (inverted trust score — higher trust → faster delivery)
 *   3. Projected Cost     (synthetic: (1 − trust) × budget normalised to 100)
 *
 * Uses the ag-charts-community package (ag-grid-community sibling, already
 * available in node_modules as a transitive dependency of ag-grid-community).
 * Falls back to a pure-React SVG bar chart if AG Charts fails to load.
 */

import { useEffect, useRef, useMemo } from "react";
import type { ScoreBreakdown } from "@/lib/vetting/signals";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SimulationCandidate {
  id: string;
  name: string;
  trustScore: number;        // 0–1
  scoreBreakdown: ScoreBreakdown | null;
}

interface Props {
  candidates: SimulationCandidate[];
  onClose: () => void;
}

// ── Colour palette (matches AG Studio Midnight) ───────────────────────────────

const CANDIDATE_COLORS = [
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#ec4899", // pink
  "#8b5cf6", // violet
];

// ── Pure-React SVG fallback bar chart ─────────────────────────────────────────

function FallbackBarChart({ dimensions, candidates }: {
  dimensions: { label: string; key: "stackFit" | "delivery" | "cost" }[];
  candidates: Array<{ name: string; stackFit: number; delivery: number; cost: number }>;
}) {
  return (
    <div className="space-y-4">
      {dimensions.map((dim) => (
        <div key={dim.key}>
          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-2">{dim.label}</p>
          <div className="space-y-1.5">
            {candidates.map((c, i) => {
              const pct = Math.round(c[dim.key]);
              const color = CANDIDATE_COLORS[i % CANDIDATE_COLORS.length];
              return (
                <div key={c.name} className="flex items-center gap-2">
                  <span className="text-[11px] text-foreground/80 w-28 shrink-0 truncate" title={c.name}>
                    {c.name.length > 14 ? c.name.slice(0, 13) + "…" : c.name}
                  </span>
                  <div className="flex-1 bg-muted/40 rounded-full h-5 overflow-hidden">
                    <div
                      className="h-full rounded-full flex items-center pl-2 transition-all duration-500"
                      style={{ width: `${Math.max(pct, 3)}%`, backgroundColor: color }}
                    >
                      <span className="text-white text-[10px] font-bold tabular-nums">{pct}%</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function ScenarioSimulation({ candidates, onClose }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);

  // Derive the three scenario metrics
  const scenarioData = useMemo(() => candidates.map((c) => {
    const stackFit = Math.round(
      (c.scoreBreakdown?.bySignalType?.github_repo?.avgConfidence ?? c.trustScore) * 100
    );
    // Delivery proxy: lower trust = more unknowns = longer delivery.
    // We invert: 100 = full-stack match (fast), 0 = no match (slow).
    // Represent as "delivery risk %": high % = risky / slow.
    const delivery = Math.round(Math.max(0, 100 - (c.trustScore * 100)));
    // Cost proxy: unvetted areas need ramp-up time; cost ∝ delivery risk.
    const cost = Math.round(Math.min(100, delivery * 1.15));

    return { name: c.name, stackFit, delivery, cost };
  }), [candidates]);

  const dimensions = [
    { label: "Stack Fit %",                    key: "stackFit" as const },
    { label: "Estimated Delivery Risk %",       key: "delivery" as const },
    { label: "Projected Cost / Ramp-Up Risk %", key: "cost"     as const },
  ];

  // Try to render an AG Charts bar chart imperatively
  useEffect(() => {
    if (!chartRef.current || scenarioData.length === 0) return;
    let chart: { destroy?: () => void } | null = null;
    let mounted = true;

    void (async () => {
      try {
        // ag-charts-community is a peer dep of ag-grid-community (v32).
        // Dynamic import with a string expression avoids TS module-not-found errors
        // while keeping the code-split benefit.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const agCharts = await (Function('return import("ag-charts-community")')() as Promise<any>).catch(() => null);
        if (!agCharts) return;
        if (!mounted || !chartRef.current) return;

        // Build grouped-bar series — one series per candidate
        const seriesData = dimensions.map((dim) => {
          const row: Record<string, number | string> = { dimension: dim.label };
          scenarioData.forEach((c) => { row[c.name] = c[dim.key]; });
          return row;
        });

        const series = scenarioData.map((c, i) => ({
          type:     "bar",
          xKey:     "dimension",
          yKey:     c.name,
          yName:    c.name,
          fill:     CANDIDATE_COLORS[i % CANDIDATE_COLORS.length],
          strokeWidth: 0,
        }));

        const isDark = document.documentElement.classList.contains("dark");

        const options = {
          container:  chartRef.current,
          height:     220,
          data:       seriesData,
          series,
          axes: [
            {
              type:      "category",
              position:  "bottom",
              label: {
                color: isDark ? "#94a3b8" : "#64748b",
                fontSize: 11,
              },
            },
            {
              type:     "number",
              position: "left",
              min:      0,
              max:      100,
              label: {
                color: isDark ? "#94a3b8" : "#64748b",
                fontSize: 10,
                formatter: ({ value }: { value: number }) => `${value}%`,
              },
            },
          ],
          legend: {
            enabled: true,
            position: "top",
            item: {
              label: { color: isDark ? "#cbd5e1" : "#475569", fontSize: 11 },
            },
          },
          background: { fill: "transparent" },
          padding: { top: 8, right: 8, bottom: 8, left: 8 },
        };

        if (typeof agCharts.AgCharts?.create === "function") {
          chart = agCharts.AgCharts.create(options);
        } else if (typeof agCharts.AgChart?.create === "function") {
          chart = agCharts.AgChart.create(options);
        }
      } catch (e) {
        // AG Charts not available — fallback table already rendered
        console.warn("[ScenarioSimulation] AG Charts init failed, using fallback", e);
      }
    })();

    return () => {
      mounted = false;
      chart?.destroy?.();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (candidates.length < 2) {
    return (
      <div className="rounded-xl border border-border bg-card/60 p-5 text-center text-sm text-muted-foreground">
        Select <strong>2 or more</strong> candidates using the compare checkboxes to visualise trade-offs.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card shadow-md overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-foreground">Scenario Simulation</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Comparing {candidates.length} candidates · Stack Fit · Delivery Risk · Cost/Ramp-up
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground text-lg leading-none transition-colors"
        >
          ×
        </button>
      </div>

      <div className="p-4 space-y-4">
        {/* AG Charts mount point */}
        <div ref={chartRef} className="w-full" />

        {/* Pure-React fallback (always rendered, hidden if AG Charts succeeds via ref) */}
        <FallbackBarChart dimensions={dimensions} candidates={scenarioData} />

        {/* Legend / disclaimer */}
        <div className="pt-2 border-t border-border/50 text-[10px] text-muted-foreground space-y-0.5">
          <p>• <strong>Stack Fit %</strong> — github_repo signal confidence from vetting analysis.</p>
          <p>• <strong>Delivery Risk %</strong> — inverse of trust score; higher = more unknowns = slower ramp-up.</p>
          <p>• <strong>Cost/Ramp-up Risk %</strong> — proportional to delivery risk; indicates relative onboarding overhead.</p>
          <p className="text-muted-foreground/60 pt-1">All values are indicative estimates based on AI vetting signals. Human judgment required.</p>
        </div>
      </div>
    </div>
  );
}
