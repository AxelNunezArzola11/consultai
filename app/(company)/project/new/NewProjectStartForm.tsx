"use client";

/**
 * NewProjectStartForm — the /project/new landing step.
 *
 * Collects the project title and brief, then creates ONE draft row via
 * POST /api/projects on explicit submit. The project ID is generated once per
 * form instance, so retries and double-clicks cannot create duplicates.
 * Navigation uses the server-returned canonical project ID and carries the
 * creation title so demo mode can rehydrate the draft on any serverless
 * instance (see resolveDemoDraftForPlanning).
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { nanoid } from "nanoid";

export function NewProjectStartForm() {
  const router = useRouter();
  const [projectId] = useState(() => nanoid());
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const resp = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          title: title.trim() || "New project",
          brief: brief.trim() || undefined,
        }),
      });
      const data = (await resp.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (!resp.ok) {
        setError(
          resp.status === 403
            ? "Creating projects requires the company or admin role. Use Switch Role to continue as a company operator."
            : `Could not create the project (${String(data.error ?? "unknown error")}).`
        );
        setSubmitting(false);
        return;
      }
      // Navigate with the server-canonical persisted ID — never assume the
      // request echo. A missing ID means persistence did not confirm.
      const canonicalId =
        typeof data.projectId === "string" ? data.projectId.trim() : "";
      if (!canonicalId) {
        setError("Could not create the project (missing project ID).");
        setSubmitting(false);
        return;
      }
      const params = new URLSearchParams({
        projectId: canonicalId,
        title: title.trim() || "New project",
      });
      if (brief.trim()) params.set("brief", brief.trim());
      router.push(`/project/new?${params.toString()}`);
    } catch {
      setError("Network error. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl flex-1 px-6 py-12">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-6">
        <h1 className="text-xl font-bold text-white">Start a new project</h1>
        <p className="mt-1 text-sm text-slate-400">
          Give your project a title and describe what you need. The AI planner
          builds phases, milestones, and dependencies on the next step — nothing
          is saved until you continue.
        </p>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <div className="space-y-1">
            <label htmlFor="project-title" className="text-sm font-medium text-slate-200">
              Project title
            </label>
            <input
              id="project-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Enterprise SaaS Implementation"
              maxLength={200}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
          </div>

          <div className="space-y-1">
            <label htmlFor="project-brief" className="text-sm font-medium text-slate-200">
              Project brief
            </label>
            <textarea
              id="project-brief"
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="Objectives, scope, timeline, budget…"
              rows={6}
              maxLength={20000}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:ring-2 focus:ring-blue-500 focus:outline-none"
            />
          </div>

          {error && (
            <p className="rounded-lg border border-red-500/40 bg-red-950/40 px-3 py-2 text-sm text-red-300">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {submitting ? "Creating draft…" : "Continue to AI planning"}
          </button>
        </form>
      </div>
    </div>
  );
}
