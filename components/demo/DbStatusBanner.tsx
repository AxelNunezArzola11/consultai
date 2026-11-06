/**
 * DbStatusBanner — honest user-visible state when live data cannot load.
 *
 * Rendered INSTEAD OF silently empty dashboards. Explains what failed and
 * what the operator can do (retry, check status, switch to demo mode).
 */

interface Props {
  title: string;
  detail: string;
}

export function DbStatusBanner({ title, detail }: Props) {
  return (
    <div
      role="alert"
      className="rounded-xl border border-red-500/40 bg-red-950/40 px-4 py-3"
    >
      <p className="text-sm font-semibold text-red-200">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-red-300/90">{detail}</p>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <a
          href="/api/health"
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md border border-red-500/40 px-2.5 py-1 font-medium text-red-200 hover:bg-red-900/40"
        >
          Check system status
        </a>
        <a
          href="/admin"
          className="rounded-md border border-red-500/40 px-2.5 py-1 font-medium text-red-200 hover:bg-red-900/40"
        >
          Open Demo Control Center
        </a>
      </div>
    </div>
  );
}
