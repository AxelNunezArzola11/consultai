"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

interface StepSummary {
  seq: number;
  tool: string;
  output: string;
}

interface VerifyResult {
  runId: string;
  proposalId: string;
  policyDecision: "AUTO_RELEASE_ELIGIBLE" | "REQUIRES_APPROVAL" | "REJECT_RECOMMENDED";
  reasons: string[];
  headSha: string;
  justification: string;
  justificationFallback: boolean;
  flags: string[];
  steps: StepSummary[];
  durationMs: number;
}

interface PRSubmitFormProps {
  milestoneId: string;
  milestoneTitle: string;
}

const DEMO_SCENARIOS = [
  {
    label: "All green",
    url: "https://github.com/demo/repo/pull/1",
    description: "PR passes all checks, merged, no flags",
  },
  {
    label: "Failing CI",
    url: "https://github.com/demo/repo/pull/2",
    description: "CI check is failing",
  },
  {
    label: "Workflow modified",
    url: "https://github.com/demo/repo/pull/3",
    description: "PR touches .github/workflows — flags raised",
  },
];

function policyBadgeVariant(d: string) {
  if (d === "AUTO_RELEASE_ELIGIBLE") return "default";
  if (d === "REJECT_RECOMMENDED") return "destructive";
  return "outline";
}

export function PRSubmitForm({ milestoneId, milestoneTitle }: PRSubmitFormProps) {
  const [prUrl, setPrUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<VerifyResult | null>(null);

  async function submit(url: string) {
    if (!url.trim()) { setError("Please enter a PR URL"); return; }
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/delivery/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ milestoneId, prUrl: url }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `Error ${res.status}`);
      } else {
        setResult(data as VerifyResult);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Real submission form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Submit your PR for milestone: {milestoneTitle}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <label className="text-sm font-medium text-foreground" htmlFor="pr-url">
            GitHub Pull Request URL
          </label>
          <div className="flex gap-2">
            <input
              id="pr-url"
              type="url"
              value={prUrl}
              onChange={(e) => setPrUrl(e.target.value)}
              placeholder="https://github.com/owner/repo/pull/123"
              className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              disabled={loading}
            />
            <Button
              onClick={() => submit(prUrl)}
              disabled={loading || !prUrl.trim()}
              size="sm"
            >
              {loading ? "Verifying…" : "Submit PR"}
            </Button>
          </div>
          {error && (
            <p className="text-sm text-destructive rounded border border-destructive/30 bg-destructive/10 px-3 py-2">
              {error}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Demo scenarios — clearly labelled */}
      <Card className="border-dashed">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            <CardTitle className="text-sm text-muted-foreground">Demo scenarios</CardTitle>
            <Badge variant="outline" className="text-xs text-amber-600 border-amber-400">demo-only</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            These simulate a freelancer submitting a PR. They call the real verification path — you still need{" "}
            <code className="bg-muted px-1 rounded">DELIVERY_AGENT_REPO</code> and{" "}
            <code className="bg-muted px-1 rounded">GITHUB_TOKEN</code> configured for real GitHub calls.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          {DEMO_SCENARIOS.map((s) => (
            <button
              key={s.label}
              onClick={() => { setPrUrl(s.url); submit(s.url); }}
              disabled={loading}
              className="w-full text-left rounded border bg-muted/40 hover:bg-muted px-3 py-2 text-sm disabled:opacity-50"
            >
              <span className="font-medium">{s.label}</span>
              <span className="text-muted-foreground ml-2">— {s.description}</span>
              <code className="block text-xs text-muted-foreground mt-0.5">{s.url}</code>
            </button>
          ))}
        </CardContent>
      </Card>

      {/* Result */}
      {result && <VerificationResult result={result} />}
    </div>
  );
}

function VerificationResult({ result }: { result: VerifyResult }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Verification Result</CardTitle>
          <Badge variant={policyBadgeVariant(result.policyDecision) as never}>
            {result.policyDecision.replace(/_/g, " ")}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          Run <code>{result.runId}</code> · HEAD <code>{result.headSha}</code> · {result.durationMs}ms
          {result.justificationFallback && (
            <span className="ml-2 text-amber-600">[LLM fallback — deterministic template used]</span>
          )}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Flags */}
        {result.flags.length > 0 && (
          <div className="rounded border border-amber-400 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-sm">
            <p className="font-medium text-amber-700 dark:text-amber-400 mb-1">Flags raised</p>
            <ul className="list-disc list-inside space-y-0.5">
              {result.flags.map((f) => (
                <li key={f} className="text-amber-700 dark:text-amber-300 text-xs">{f}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Justification */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-1">Justification</p>
          <p className="text-sm border rounded px-3 py-2 bg-muted/30">{result.justification}</p>
        </div>

        {/* Reasons */}
        {result.reasons.length > 0 && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1">Policy reasons</p>
            <ul className="text-xs text-muted-foreground space-y-0.5">
              {result.reasons.map((r, i) => <li key={i}>• {r}</li>)}
            </ul>
          </div>
        )}

        {/* Activity steps */}
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-1">Steps</p>
          <div className="space-y-1">
            {result.steps.map((s) => (
              <div key={s.seq} className="flex gap-2 text-xs">
                <span className="text-muted-foreground w-4 text-right shrink-0">{s.seq + 1}.</span>
                <span className="font-mono text-muted-foreground shrink-0">{s.tool}</span>
                <span className="text-foreground">{s.output}</span>
              </div>
            ))}
          </div>
        </div>

        {result.policyDecision === "REQUIRES_APPROVAL" && (
          <p className="text-xs text-muted-foreground border rounded px-3 py-2 bg-muted/20">
            ✅ Verification complete. The company will review this in the Approvals panel.
          </p>
        )}
        {result.policyDecision === "AUTO_RELEASE_ELIGIBLE" && (
          <p className="text-xs text-green-700 dark:text-green-400 border border-green-400 rounded px-3 py-2 bg-green-50 dark:bg-green-950/30">
            🎉 Auto-release eligible — payout will be issued automatically.
          </p>
        )}
        {result.policyDecision === "REJECT_RECOMMENDED" && (
          <p className="text-xs text-destructive border border-destructive/30 rounded px-3 py-2 bg-destructive/10">
            ❌ Rejection recommended — one or more required criteria failed.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
