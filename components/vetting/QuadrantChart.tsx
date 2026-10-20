"use client";

/**
 * QuadrantChart — SVG-based scatter/quadrant chart for Trust Score vs Stack Match.
 *
 * Renders an inline SVG quadrant with candidate dots.
 * No additional packages needed beyond what is already installed.
 *
 * Based on the AG Studio AG Charts Scatter/Bubble chart aesthetic:
 * - Dark slate background matching Midnight theme
 * - Axis labels: "Trust Score →" (x) and "Stack Match →" (y)
 * - Four quadrant labels: Investigate / Prioritise / Archive / Consider
 * - Candidate points: emerald if high trust+stack, amber if mixed, slate if low
 */

import { useMemo } from "react";

interface Point {
  id: string;
  name: string;
  trustScore: number;  // 0–1
  stackMatch: number;  // 0–1
  isShortlisted?: boolean;
}

interface Props {
  points: Point[];
  onClickPoint?: (id: string) => void;
}

const W = 400;
const H = 280;
const PAD = { top: 24, right: 24, bottom: 48, left: 48 };

function toSvgX(v: number) {
  return PAD.left + v * (W - PAD.left - PAD.right);
}
function toSvgY(v: number) {
  return H - PAD.bottom - v * (H - PAD.top - PAD.bottom);
}

function dotColor(trust: number, stack: number) {
  if (trust >= 0.65 && stack >= 0.65) return { fill: "#10b981", stroke: "#059669" };
  if (trust >= 0.4 || stack >= 0.4)  return { fill: "#f59e0b", stroke: "#d97706" };
  return { fill: "#475569", stroke: "#334155" };
}

export function QuadrantChart({ points, onClickPoint }: Props) {
  const cx = toSvgX(0.5);
  const cy = toSvgY(0.5);

  const deduped = useMemo(() => {
    const seen = new Set<string>();
    return points.filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
  }, [points]);

  if (deduped.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card/50 p-4 flex items-center justify-center h-32">
        <p className="text-xs text-muted-foreground">Run vetting to see the quadrant chart</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="px-3 pt-3 pb-1 flex items-center justify-between">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Candidate Quadrant
        </p>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" /> Prioritise
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-amber-400" /> Consider
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-slate-500" /> Archive
          </span>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ maxHeight: 280 }}
        aria-label="Candidate quadrant chart"
        role="img"
      >
        {/* Background quadrant fill */}
        <rect x={cx} y={PAD.top} width={W - PAD.right - cx} height={cy - PAD.top}
          fill="rgba(16,185,129,0.04)" />
        <rect x={PAD.left} y={cy} width={cx - PAD.left} height={H - PAD.bottom - cy}
          fill="rgba(239,68,68,0.04)" />

        {/* Grid lines */}
        {[0.25, 0.5, 0.75].map((v) => (
          <g key={v}>
            <line
              x1={toSvgX(v)} y1={PAD.top}
              x2={toSvgX(v)} y2={H - PAD.bottom}
              stroke="currentColor" strokeOpacity={0.07} strokeWidth={1}
              className="text-foreground"
            />
            <line
              x1={PAD.left} y1={toSvgY(v)}
              x2={W - PAD.right} y2={toSvgY(v)}
              stroke="currentColor" strokeOpacity={0.07} strokeWidth={1}
              className="text-foreground"
            />
          </g>
        ))}

        {/* Axes */}
        <line x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom}
          stroke="currentColor" strokeOpacity={0.2} strokeWidth={1} className="text-foreground" />
        <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={H - PAD.bottom}
          stroke="currentColor" strokeOpacity={0.2} strokeWidth={1} className="text-foreground" />

        {/* Divider cross */}
        <line x1={cx} y1={PAD.top} x2={cx} y2={H - PAD.bottom}
          stroke="currentColor" strokeOpacity={0.15} strokeDasharray="4 3" strokeWidth={1}
          className="text-foreground" />
        <line x1={PAD.left} y1={cy} x2={W - PAD.right} y2={cy}
          stroke="currentColor" strokeOpacity={0.15} strokeDasharray="4 3" strokeWidth={1}
          className="text-foreground" />

        {/* Quadrant labels */}
        <text x={cx + 6} y={PAD.top + 14} fontSize={9} fill="#10b981" opacity={0.7}>Prioritise</text>
        <text x={PAD.left + 4} y={PAD.top + 14} fontSize={9} fill="#f59e0b" opacity={0.7}>Investigate</text>
        <text x={cx + 6} y={H - PAD.bottom - 6} fontSize={9} fill="#f59e0b" opacity={0.7}>Consider</text>
        <text x={PAD.left + 4} y={H - PAD.bottom - 6} fontSize={9} fill="#64748b" opacity={0.7}>Archive</text>

        {/* Axis tick labels */}
        {[0, 25, 50, 75, 100].map((v) => (
          <text
            key={v}
            x={toSvgX(v / 100)}
            y={H - PAD.bottom + 14}
            textAnchor="middle"
            fontSize={8}
            fill="currentColor"
            fillOpacity={0.4}
            className="text-foreground"
          >
            {v}
          </text>
        ))}
        {[0, 25, 50, 75, 100].map((v) => (
          <text
            key={v}
            x={PAD.left - 6}
            y={toSvgY(v / 100) + 4}
            textAnchor="end"
            fontSize={8}
            fill="currentColor"
            fillOpacity={0.4}
            className="text-foreground"
          >
            {v}
          </text>
        ))}

        {/* Axis labels */}
        <text
          x={(PAD.left + W - PAD.right) / 2}
          y={H - 4}
          textAnchor="middle"
          fontSize={9}
          fill="currentColor"
          fillOpacity={0.5}
          className="text-foreground"
        >
          Trust Score →
        </text>
        <text
          x={12}
          y={(PAD.top + H - PAD.bottom) / 2}
          textAnchor="middle"
          fontSize={9}
          fill="currentColor"
          fillOpacity={0.5}
          className="text-foreground"
          transform={`rotate(-90, 12, ${(PAD.top + H - PAD.bottom) / 2})`}
        >
          Stack Match →
        </text>

        {/* Data points */}
        {deduped.map((pt) => {
          const x = toSvgX(pt.trustScore);
          const y = toSvgY(pt.stackMatch);
          const { fill, stroke } = dotColor(pt.trustScore, pt.stackMatch);
          const label = pt.name.length > 12 ? pt.name.slice(0, 10) + "…" : pt.name;

          return (
            <g
              key={pt.id}
              style={{ cursor: onClickPoint ? "pointer" : "default" }}
              onClick={() => onClickPoint?.(pt.id)}
              role={onClickPoint ? "button" : undefined}
              aria-label={`${pt.name}: trust ${Math.round(pt.trustScore * 100)}, stack ${Math.round(pt.stackMatch * 100)}`}
            >
              {/* Glow ring for shortlisted */}
              {pt.isShortlisted && (
                <circle cx={x} cy={y} r={10} fill={fill} opacity={0.18} />
              )}
              <circle
                cx={x} cy={y} r={6}
                fill={fill}
                stroke={stroke}
                strokeWidth={1.5}
              />
              <text
                x={x + 9}
                y={y + 4}
                fontSize={9}
                fill={fill}
                opacity={0.85}
              >
                {label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
