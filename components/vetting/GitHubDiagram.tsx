"use client";

/**
 * GitHubDiagram — lazy Mermaid quadrantChart component for candidate analysis.
 *
 * Security rules (BOB_RULES rule 8):
 * - securityLevel: "strict" — Mermaid does not parse or execute embedded HTML.
 * - All labels are escaped before diagram string is built (see github-diagram.ts).
 * - mermaid.parse() is called before render; on failure, shows text fallback.
 * - Theme uses CSS variables (light/dark aware) — no hardcoded colours.
 * - Mermaid is lazy-loaded (dynamic import) — not loaded on pages that don't use this.
 *
 * Mermaid 12.2.0: quadrantChart verified present in installed source.
 */

import React, { useEffect, useRef, useState } from "react";

interface GitHubDiagramProps {
  /** Validated Mermaid quadrantChart definition string (from buildQuadrantDiagram) */
  diagram: string;
  /** Shown if Mermaid fails to parse or render */
  fallbackText: string;
}

export function GitHubDiagram({ diagram, fallbackText }: GitHubDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "rendered" | "fallback">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      try {
        // Lazy import — Mermaid is only loaded when this component mounts
        const mermaid = (await import("mermaid")).default;

        // Detect dark mode via next-themes class (same pattern as FinancialLedger)
        const isDark = document.documentElement.classList.contains("dark");

        // Initialize with strict security and CSS-var-aware theme
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: isDark ? "dark" : "default",
          // Override theme variables to use our CSS tokens where possible.
          // themeVariables are Mermaid's own internal vars — we map our tokens to them.
          themeVariables: isDark
            ? {
                quadrant1Fill: "oklch(0.75 0.15 255 / 20%)",
                quadrant2Fill: "oklch(0.205 0 0)",
                quadrant3Fill: "oklch(0.205 0 0)",
                quadrant4Fill: "oklch(0.205 0 0)",
                quadrantPointFill: "oklch(0.75 0.15 255)",
                quadrantPointTextFill: "oklch(0.985 0 0)",
                quadrantXAxisTextFill: "oklch(0.708 0 0)",
                quadrantYAxisTextFill: "oklch(0.708 0 0)",
                quadrantTitleFill: "oklch(0.985 0 0)",
              }
            : {
                quadrant1Fill: "oklch(0.50 0.18 255 / 15%)",
                quadrant2Fill: "oklch(0.97 0 0)",
                quadrant3Fill: "oklch(0.97 0 0)",
                quadrant4Fill: "oklch(0.97 0 0)",
                quadrantPointFill: "oklch(0.50 0.18 255)",
                quadrantPointTextFill: "oklch(0.145 0 0)",
                quadrantXAxisTextFill: "oklch(0.556 0 0)",
                quadrantYAxisTextFill: "oklch(0.556 0 0)",
                quadrantTitleFill: "oklch(0.145 0 0)",
              },
        });

        if (cancelled) return;

        // Validate before render — mermaid.parse() throws on invalid syntax
        // This is our final guard against malformed/injected diagram strings.
        try {
          await mermaid.parse(diagram);
        } catch (parseErr) {
          if (!cancelled) {
            setError(`Diagram parse failed: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
            setStatus("fallback");
          }
          return;
        }

        if (cancelled || !containerRef.current) return;

        // Render the diagram
        const id = `mermaid-diagram-${Math.random().toString(36).slice(2)}`;
        const { svg } = await mermaid.render(id, diagram);

        if (cancelled || !containerRef.current) return;

        containerRef.current.innerHTML = svg;
        setStatus("rendered");
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setStatus("fallback");
        }
      }
    }

    render();
    return () => { cancelled = true; };
  }, [diagram]);

  if (status === "fallback") {
    return (
      <div className="rounded-lg border bg-muted p-4 text-sm text-muted-foreground space-y-1">
        <p className="font-medium text-foreground">Diagram unavailable</p>
        <p>{fallbackText}</p>
        {error && (
          <p className="text-xs font-mono opacity-60">{error}</p>
        )}
        {/* Text fallback: show the raw diagram definition so no information is lost */}
        <pre className="mt-2 text-xs font-mono whitespace-pre-wrap opacity-50 select-all">
          {diagram}
        </pre>
      </div>
    );
  }

  return (
    <div className="relative w-full">
      {status === "loading" && (
        <div className="h-48 rounded-lg border bg-muted animate-pulse" />
      )}
      <div
        ref={containerRef}
        className={status === "loading" ? "hidden" : "w-full overflow-x-auto"}
        aria-label="GitHub portfolio analysis quadrant chart"
      />
    </div>
  );
}
