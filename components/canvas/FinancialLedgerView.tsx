"use client";

/**
 * FinancialLedgerView — wrapper that fetches ledger rows and renders the AG Grid.
 * Loaded via dynamic() with ssr: false from the ledger page.
 */

import React, { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import type { LedgerRow } from "@/components/canvas/FinancialLedger";
import { Skeleton } from "@/components/ui/skeleton";

const FinancialLedger = dynamic(
  () => import("@/components/canvas/FinancialLedger").then((m) => ({ default: m.FinancialLedger })),
  { ssr: false }
);

interface Props {
  projectId: string;
}

export function FinancialLedgerView({ projectId }: Props) {
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${projectId}/ledger`)
      .then(async (r) => {
        const data = (await r.json()) as { rows?: LedgerRow[]; error?: string; message?: string };
        if (cancelled) return;
        setStatus(r.status);
        if (!r.ok || data.error) {
          setError(data.message ?? data.error ?? `Request failed (${r.status})`);
        } else {
          setRows(data.rows ?? []);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load ledger");
      });
    return () => { cancelled = true; };
  }, [projectId]);

  if (error) {
    if (status === 401) {
      return (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-center text-sm">
          <div className="font-semibold text-white">Sign in required</div>
          <p className="mt-1 text-slate-400">
            This financial ledger is visible to signed-in company members only.
          </p>
          <a
            href="/login"
            className="mt-3 inline-block rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500"
          >
            Go to sign in
          </a>
        </div>
      );
    }
    if (status === 403) {
      return (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-6 text-center text-sm">
          <div className="font-semibold text-amber-300">Access forbidden</div>
          <p className="mt-1 text-slate-400">
            {error === "forbidden"
              ? "This ledger belongs to another company."
              : error}
          </p>
        </div>
      );
    }
    return (
      <div className="rounded-xl border bg-destructive/10 p-4 text-sm text-destructive">
        Failed to load ledger: {error}
      </div>
    );
  }

  if (rows === null) {
    return (
      <div className="space-y-2 p-4">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-5/6" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-6 text-center text-sm">
        <div className="font-semibold text-white">No ledger entries yet</div>
        <p className="mt-1 text-slate-400">
          Milestones for this project will appear here once they are created.
        </p>
      </div>
    );
  }

  return <FinancialLedger rows={rows} height={500} />;
}
