"use client";

/**
 * GanttView — Timeline Gantt visualization for milestones.
 *
 * Uses @hello-pangea/dnd for drag reorder (Spike 6 fallback — Bryntum requires
 * a private registry install; this component mirrors the interface so Bryntum
 * can be swapped in by replacing this file's implementation).
 *
 * Loaded via dynamic import with ssr: false from the parent page:
 *   const GanttView = dynamic(() => import("@/components/canvas/GanttView"), { ssr: false });
 *
 * Note: When Bryntum private registry access is available, replace the body of
 * this file with the @bryntum/gantt-react implementation. The props interface
 * (GanttViewProps) and the dynamic import pattern remain unchanged.
 */

import React, { useMemo } from "react";
import type { BriefPlan } from "@/lib/brief/schema";
import {
  DragDropContext,
  Droppable,
  Draggable,
  type DropResult,
} from "@hello-pangea/dnd";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GanttViewProps {
  plan: BriefPlan;
  /** Called when the user drags a milestone to a new position */
  onReorder: (milestones: BriefPlan["milestones"]) => void;
  /** Called when the user edits a milestone budget inline */
  onBudgetChange?: (milestoneId: string, newBudget: number) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusColor(index: number) {
  const palette = [
    "bg-blue-500",
    "bg-violet-500",
    "bg-emerald-500",
    "bg-amber-500",
    "bg-rose-500",
    "bg-cyan-500",
  ];
  return palette[index % palette.length];
}

function buildTimelineData(milestones: BriefPlan["milestones"]) {
  if (milestones.length === 0) return { bars: [], totalDays: 0 };

  // Sort a copy by dueDaysOffset for timeline
  const sorted = [...milestones].sort((a, b) => a.dueDaysOffset - b.dueDaysOffset);
  const totalDays = sorted[sorted.length - 1].dueDaysOffset;

  // Each bar starts at the previous milestone's end (sequential assumption)
  const bars = milestones.map((m, i) => {
    const startOffset = i === 0 ? 0 : milestones[i - 1].dueDaysOffset;
    const endOffset = m.dueDaysOffset;
    const duration = endOffset - startOffset;
    const startPct = totalDays > 0 ? (startOffset / totalDays) * 100 : 0;
    const widthPct = totalDays > 0 ? (duration / totalDays) * 100 : 100 / milestones.length;
    return {
      id: m.id,
      title: m.title,
      startPct,
      widthPct: Math.max(widthPct, 2),
      dueDaysOffset: m.dueDaysOffset,
      budgetUsd: m.budgetUsd,
    };
  });

  return { bars, totalDays };
}

// ---------------------------------------------------------------------------
// GanttView
// ---------------------------------------------------------------------------

export default function GanttView({ plan, onReorder, onBudgetChange }: GanttViewProps) {
  const { bars, totalDays } = useMemo(
    () => buildTimelineData(plan.milestones),
    [plan.milestones]
  );

  function handleDragEnd(result: DropResult) {
    if (!result.destination) return;
    const newMilestones = [...plan.milestones];
    const [moved] = newMilestones.splice(result.source.index, 1);
    newMilestones.splice(result.destination.index, 0, moved);
    onReorder(newMilestones);
  }

  return (
    <div className="space-y-4">
      {/* Timeline bar chart */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
          <span>Day 0</span>
          <span>Day {totalDays}</span>
        </div>
        {bars.map((bar, i) => (
          <div key={bar.id} className="flex items-center gap-2">
            <div className="w-5 text-xs text-muted-foreground flex-shrink-0">
              M{i + 1}
            </div>
            <div className="flex-1 h-7 bg-muted/30 rounded overflow-hidden relative">
              <div
                className={`absolute h-full rounded ${statusColor(i)} opacity-80 flex items-center px-2 text-white text-xs font-medium truncate transition-all duration-300`}
                style={{
                  left: `${bar.startPct}%`,
                  width: `${bar.widthPct}%`,
                  minWidth: "2rem",
                }}
              >
                {bar.title}
              </div>
            </div>
            <div className="text-xs text-muted-foreground w-16 text-right flex-shrink-0">
              +{bar.dueDaysOffset}d
            </div>
          </div>
        ))}
      </div>

      {/* Draggable milestone rows */}
      <div className="border rounded-lg overflow-hidden">
        <div className="grid grid-cols-[auto_1fr_auto_auto] gap-0 text-xs font-medium text-muted-foreground bg-muted/30 px-3 py-2 border-b">
          <div className="w-6" />
          <div>Milestone</div>
          <div className="w-24 text-right mr-2">Budget</div>
          <div className="w-16 text-right">Due</div>
        </div>

        <DragDropContext onDragEnd={handleDragEnd}>
          <Droppable droppableId="gantt-milestones">
            {(provided) => (
              <div
                ref={provided.innerRef}
                {...provided.droppableProps}
              >
                {plan.milestones.map((m, i) => (
                  <Draggable key={m.id} draggableId={m.id} index={i}>
                    {(prov, snap) => (
                      <div
                        ref={prov.innerRef}
                        {...prov.draggableProps}
                        className={`grid grid-cols-[auto_1fr_auto_auto] gap-0 items-center px-3 py-2.5 border-b last:border-b-0 text-sm transition-colors ${
                          snap.isDragging ? "bg-primary/5" : "hover:bg-muted/20"
                        }`}
                      >
                        {/* Drag handle */}
                        <div
                          {...prov.dragHandleProps}
                          className="w-6 text-muted-foreground cursor-grab active:cursor-grabbing select-none text-center"
                        >
                          ⠿
                        </div>

                        {/* Title */}
                        <div className="min-w-0 pr-2">
                          <div className="flex items-center gap-2">
                            <span
                              className={`w-2 h-2 rounded-full ${statusColor(i)} flex-shrink-0`}
                            />
                            <span className="font-medium truncate">{m.title}</span>
                          </div>
                          <p className="text-xs text-muted-foreground truncate mt-0.5">
                            {m.description}
                          </p>
                        </div>

                        {/* Budget */}
                        <div className="w-24 text-right mr-2">
                          {onBudgetChange ? (
                            <BudgetCell
                              milestoneId={m.id}
                              budgetUsd={m.budgetUsd}
                              onChange={onBudgetChange}
                            />
                          ) : (
                            <span className="text-sm font-semibold">
                              ${m.budgetUsd.toLocaleString()}
                            </span>
                          )}
                        </div>

                        {/* Due */}
                        <div className="w-16 text-right text-xs text-muted-foreground">
                          +{m.dueDaysOffset}d
                        </div>
                      </div>
                    )}
                  </Draggable>
                ))}
                {provided.placeholder}
              </div>
            )}
          </Droppable>
        </DragDropContext>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BudgetCell — inline editable budget cell
// ---------------------------------------------------------------------------

function BudgetCell({
  milestoneId,
  budgetUsd,
  onChange,
}: {
  milestoneId: string;
  budgetUsd: number;
  onChange: (id: string, val: number) => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(String(budgetUsd));

  React.useEffect(() => {
    setValue(String(budgetUsd));
  }, [budgetUsd]);

  if (!editing) {
    return (
      <button
        className="text-sm font-semibold hover:underline focus:outline-none focus:underline"
        onClick={() => setEditing(true)}
        title="Click to edit budget"
      >
        ${budgetUsd.toLocaleString()}
      </button>
    );
  }

  return (
    <input
      autoFocus
      type="number"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        setEditing(false);
        const parsed = parseFloat(value);
        if (!isNaN(parsed) && parsed > 0) onChange(milestoneId, parsed);
        else setValue(String(budgetUsd));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") {
          setValue(String(budgetUsd));
          setEditing(false);
        }
      }}
      className="w-20 text-right text-sm font-semibold border rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-ring bg-background"
    />
  );
}
