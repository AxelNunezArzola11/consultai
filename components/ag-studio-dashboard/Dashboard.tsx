/**
 * AG Studio Payments Dashboard — Client Component
 *
 * Isolation boundary: this file and the data.ts sibling are the ONLY places
 * that import from `ag-studio` or `ag-studio-react`. No other file in the
 * project should import from those packages.
 *
 * Architecture:
 *   Page.tsx  (Server)  → fetches DB rows, calls buildStudioData()
 *       ↓ passes AgDataSourcesDefinition + serialised initialState as props
 *   Dashboard.tsx (Client) → renders <AgStudioProvider> + <AgStudio>
 *
 * AI Harness:
 *   Uses a mock OpenAI-compatible adapter that logs prompts to the console.
 *   Replace MockOpenAiAdapter.chat() with a real fetch() to
 *   /api/ag-studio/ai (or directly to the OpenAI API) once a key is available.
 */
"use client";

import React, { useRef, useState, useEffect } from "react";

import {
  AgStudio,
  AgStudioProvider,
  AgStudioAiModule,
  createAiHarness,
  type AgStudioApi,
  type AgAiMessage,
  type AgAiHarness,
} from "ag-studio-react";

import { studioTheme } from "ag-studio";
import type { AgDataSourcesDefinition, AgStudioState } from "ag-studio";

// ---------------------------------------------------------------------------
// Mock OpenAI Adapter
// ---------------------------------------------------------------------------
// Swap this class for a real implementation that POSTs to your AI backend.
// The interface expected by AG Studio is identical to the OpenAI chat
// completions API — just return the assistant message content as a string.

class MockOpenAiAdapter {
  async chat(messages: AgAiMessage[]): Promise<string> {
    // Log the conversation for debugging
    console.debug("[AG Studio AI Harness] Received messages:", messages);

    // Mirror the last user message back so the harness has something to render
    const last = messages.findLast((m) => m.role === "user");
    const preview = last
      ? last.content.slice(0, 120)
      : "(no user message)";

    // Simulate a short network delay
    await new Promise((r) => setTimeout(r, 300));

    return (
      `🤖 Mock response — replace MockOpenAiAdapter with a real OpenAI ` +
      `fetch call.\n\nYour prompt: "${preview}${last && last.content.length > 120 ? "…" : ""}"`
    );
  }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

const dashboardTheme = studioTheme.withParams({
  fontFamily:              "var(--font-sans, system-ui, -apple-system, sans-serif)",
  backgroundColor:         "var(--pp-surface, #0f1117)",
  textColor:               "var(--pp-text, #e2e8f0)",
  gridHeaderTextColor:     "var(--pp-text-muted, #94a3b8)",
  chartPaletteFills1Color: "var(--pp-blue, #3b82f6)",
});

// ---------------------------------------------------------------------------
// Initial State
// ---------------------------------------------------------------------------
// A minimal serialised workspace state. AG Studio will restore this on load so
// users always start with a useful first view rather than a blank canvas.
// Extend this object with a real persisted snapshot once users start saving.

const INITIAL_STATE: AgStudioState = {
  version: 1,
  // Cross-source summary report open by default
  activeReport: {
    id:    "payments-overview",
    title: "Payments Overview",
    type:  "pivot",
    rows:  ["invoices.createdAt|invoiceDate:month"],
    cols:  ["invoices.status"],
    values: ["invoices.totalGross", "invoices.totalFees"],
  },
};

// ---------------------------------------------------------------------------
// Component props
// ---------------------------------------------------------------------------

export interface AgStudioDashboardProps {
  /** Produced by buildStudioData() on the server */
  studioData: AgDataSourcesDefinition;
  /**
   * Optional persisted state from the DB / local storage.
   * Falls back to INITIAL_STATE when undefined.
   */
  savedState?: AgStudioState;
  /**
   * Called whenever the user changes the workspace.
   * Persist the state to localStorage or the DB in this callback.
   */
  onStateChange?: (state: AgStudioState) => void;
}

// ---------------------------------------------------------------------------
// Dashboard Component
// ---------------------------------------------------------------------------

export default function AgStudioDashboard({
  studioData,
  savedState,
  onStateChange,
}: AgStudioDashboardProps) {
  const apiRef  = useRef<AgStudioApi | null>(null);
  const [ai, setAi] = useState<AgAiHarness | null>(null);

  // Wire up the AI harness once the AG Studio API is ready
  function handleApiReady(event: { api: AgStudioApi }) {
    apiRef.current = event.api;

    const harness = createAiHarness(event.api, {
      adapter:       new MockOpenAiAdapter(),
      promptStarters: [
        "Show me total gross revenue by month",
        "Which customers have the highest trust scores?",
        "Compare paid vs pending invoice amounts",
        "Show fee breakdown as a percentage of gross",
        "List top 5 milestones by budget",
      ],
    });

    setAi(harness);
  }

  function handleStateUpdated(event: { state: AgStudioState }) {
    onStateChange?.(event.state);
  }

  // ---------------------------------------------------------------------------
  // Undo / Redo keyboard shortcuts (Cmd/Ctrl + Z / Shift+Z)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const api = apiRef.current;
      if (!api) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === "z" && !e.shiftKey && api.canUndo()) {
        e.preventDefault();
        api.undo();
      }
      if (mod && (e.key === "Z" || (e.key === "z" && e.shiftKey)) && api.canRedo()) {
        e.preventDefault();
        api.redo();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    // ── Isolation wrapper ────────────────────────────────────────────────────
    // This div uses explicit class names that won't conflict with the main UI.
    // The ag-studio-shell class can be used for targeted CSS overrides if needed.
    <div className="ag-studio-shell" style={{ width: "100%", height: "100%" }}>

      {/* Toolbar */}
      <div
        style={{
          display:        "flex",
          alignItems:     "center",
          gap:            8,
          padding:        "10px 16px",
          borderBottom:   "1px solid #1e293b",
          background:     "#0a0e18",
        }}
      >
        <span style={{ color: "#94a3b8", fontSize: 13, fontWeight: 600, letterSpacing: "0.02em" }}>
          ◈ Payments Analytics
        </span>

        <span style={{ flex: 1 }} />

        <ToolbarButton
          label="↩ Undo"
          title="Undo (Cmd+Z)"
          onClick={() => apiRef.current?.undo()}
        />
        <ToolbarButton
          label="↪ Redo"
          title="Redo (Cmd+Shift+Z)"
          onClick={() => apiRef.current?.redo()}
        />
      </div>

      {/* AG Studio canvas */}
      <AgStudioProvider
        licenseKey={process.env.NEXT_PUBLIC_AG_STUDIO_LICENSE_KEY ?? ""}
        modules={[AgStudioAiModule]}
      >
        <AgStudio
          data={studioData}
          initialState={savedState ?? INITIAL_STATE}
          theme={dashboardTheme}
          ai={ai ?? undefined}
          onApiReady={handleApiReady}
          onStateUpdated={handleStateUpdated}
          style={{ width: "100%", height: "calc(100% - 45px)" }}
        />
      </AgStudioProvider>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny toolbar button — no shared UI library to keep the component isolated
// ---------------------------------------------------------------------------

function ToolbarButton({
  label,
  title,
  onClick,
}: {
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{
        background:    "transparent",
        border:        "1px solid #1e293b",
        borderRadius:  6,
        color:         "#64748b",
        cursor:        "pointer",
        fontSize:      12,
        padding:       "3px 10px",
        transition:    "color 0.15s, border-color 0.15s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.color = "#e2e8f0";
        (e.currentTarget as HTMLButtonElement).style.borderColor = "#334155";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.color = "#64748b";
        (e.currentTarget as HTMLButtonElement).style.borderColor = "#1e293b";
      }}
    >
      {label}
    </button>
  );
}
