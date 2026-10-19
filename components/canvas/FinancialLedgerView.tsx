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

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/projects/${projectId}/ledger`)
      .then((r) => r.json())
      .then((data: { rows?: LedgerRow[]; error?: string }) => {
        if (cancelled) return;
        if (data.error) {
          setError(data.error);
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

  return <FinancialLedger rows={rows} height={500} />;
}
