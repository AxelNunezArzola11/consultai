/**
 * Freelancer section loading state — shown while server components stream.
 */
export default function FreelancerLoading() {
  return (
    <div className="mx-auto w-full max-w-7xl flex-1 animate-pulse space-y-4 px-6 py-6" aria-label="Loading">
      <div className="h-8 w-64 rounded-lg bg-slate-800" />
      <div className="h-40 rounded-xl border border-slate-800 bg-slate-900" />
      <div className="h-64 rounded-xl border border-slate-800 bg-slate-900" />
      <p className="text-center text-xs text-slate-500">Loading…</p>
    </div>
  );
}
