/**
 * Admin section loading state — shown while server components stream.
 */
export default function AdminLoading() {
  return (
    <div className="mx-auto w-full max-w-7xl flex-1 animate-pulse space-y-4 px-6 py-6" aria-label="Loading">
      <div className="h-8 w-64 rounded-lg bg-slate-800" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 rounded-xl border border-slate-800 bg-slate-900" />
        ))}
      </div>
      <p className="text-center text-xs text-slate-500">Loading…</p>
    </div>
  );
}
