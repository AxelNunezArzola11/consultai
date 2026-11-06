"use client";

/**
 * PipelinePoller — real auto-refresh for the candidate pipeline page.
 *
 * Revalidates the server-rendered pipeline via router.refresh() on an
 * interval, shows the last-refresh age honestly, pauses when the tab is
 * hidden, and offers an explicit pause/resume control.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

export function PipelinePoller({ intervalMs = 3000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [paused, setPaused] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(() => Date.now());
  const [ageS, setAgeS] = useState(0);

  const pausedRef = useRef(paused);

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    const id = setInterval(() => {
      if (pausedRef.current || document.hidden) return;
      router.refresh();
      setLastRefresh(Date.now());
    }, intervalMs);
    return () => clearInterval(id);
  }, [router, intervalMs]);

  useEffect(() => {
    const id = setInterval(() => {
      setAgeS(Math.max(0, Math.round((Date.now() - lastRefresh) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [lastRefresh]);

  return (
    <div className="flex items-center justify-center gap-3 text-center text-xs text-muted-foreground">
      <span>
        {paused
          ? "Auto-refresh paused"
          : `Auto-refresh every ${intervalMs / 1000}s · updated ${ageS}s ago`}
      </span>
      <button
        type="button"
        onClick={() => setPaused((p) => !p)}
        className="rounded border px-2 py-1 text-xs hover:bg-muted"
      >
        {paused ? "Resume" : "Pause"}
      </button>
    </div>
  );
}
