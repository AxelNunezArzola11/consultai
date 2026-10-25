/**
 * Runtime stub for `ag-studio-react`.
 *
 * See the sibling `ag-studio.ts` stub for removal instructions once the
 * real licensed package is installed.
 */
"use client";

import React from "react";
import type { AgDataSourcesDefinition, AgStudioState, AgStudioTheme } from "ag-studio";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgStudioModule {
  moduleName: string;
}

export interface AgStudioApi {
  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Serialise current state for persistence */
  getState(): AgStudioState;
  /** Restore a previously saved state */
  setState(state: AgStudioState): void;
}

export interface AgAiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AgAiAdapter {
  chat(messages: AgAiMessage[]): Promise<string>;
}

export interface AgAiHarnessConfig {
  adapter: AgAiAdapter;
  promptStarters?: string[];
}

export interface AgAiHarness {
  /** Internal harness handle — passed directly to <AgStudio ai={} /> */
  _harness: true;
}

export interface AgStudioApiReadyEvent {
  api: AgStudioApi;
}

export interface AgStudioStateUpdatedEvent {
  state: AgStudioState;
}

export interface AgStudioProviderProps {
  licenseKey: string;
  modules?: AgStudioModule[];
  children: React.ReactNode;
}

export interface AgStudioProps {
  data: AgDataSourcesDefinition;
  initialState?: AgStudioState;
  theme?: AgStudioTheme;
  ai?: AgAiHarness;
  onApiReady?: (event: AgStudioApiReadyEvent) => void;
  onStateUpdated?: (event: AgStudioStateUpdatedEvent) => void;
  style?: React.CSSProperties;
  className?: string;
}

// ── AgStudioProvider ──────────────────────────────────────────────────────────

export function AgStudioProvider({ children }: AgStudioProviderProps) {
  return React.createElement(React.Fragment, null, children);
}

// ── AgStudio ──────────────────────────────────────────────────────────────────

const stubApi: AgStudioApi = {
  undo:     () => {},
  redo:     () => {},
  canUndo:  () => false,
  canRedo:  () => false,
  getState: () => ({}),
  setState: () => {},
};

export function AgStudio({
  onApiReady,
  style,
  className,
}: AgStudioProps) {
  // Fire the stub API once on mount so callers can attach their apiRef.
  React.useEffect(() => {
    onApiReady?.({ api: stubApi });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return React.createElement(
    "div",
    {
      style: {
        display:        "flex",
        alignItems:     "center",
        justifyContent: "center",
        background:     "#0f1117",
        color:          "#94a3b8",
        fontFamily:     "var(--font-sans, system-ui, sans-serif)",
        fontSize:       14,
        borderRadius:   12,
        border:         "1px solid #1e293b",
        minHeight:      400,
        ...style,
      },
      className,
    },
    React.createElement(
      "div",
      { style: { textAlign: "center", padding: "2rem" } },
      React.createElement(
        "div",
        { style: { fontSize: 32, marginBottom: 12, opacity: 0.3 } },
        "◈"
      ),
      React.createElement(
        "p",
        { style: { margin: 0 } },
        "AG Studio — license not installed"
      ),
      React.createElement(
        "p",
        { style: { margin: "4px 0 0", fontSize: 12, opacity: 0.6 } },
        "Replace the runtime stubs in lib/ag-studio/stubs/ with the real package."
      )
    )
  );
}

// ── AI Harness ────────────────────────────────────────────────────────────────

export function createAiHarness(
  _api: AgStudioApi,
  _config: AgAiHarnessConfig
): AgAiHarness {
  return { _harness: true };
}

// ── Modules ───────────────────────────────────────────────────────────────────

export const AgStudioAiModule: AgStudioModule = {
  moduleName: "AgStudioAiModule",
};
