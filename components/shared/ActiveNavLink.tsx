"use client";

/**
 * ActiveNavLink — navigation link with a clear active state.
 *
 * Highlights when the current pathname matches `href` exactly or (for section
 * links) starts with `href + "/"`, so project sub-pages keep their section
 * highlighted. No layout shift: the active state uses surface + indicator bar.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";

interface Props {
  href: string;
  children: React.ReactNode;
  className?: string;
  exact?: boolean;
}

export function ActiveNavLink({ href, children, className = "", exact = false }: Props) {
  const pathname = usePathname();
  const active = exact
    ? pathname === href
    : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={[
        "relative inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors",
        active
          ? "bg-slate-800/90 text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)]"
          : "text-slate-300 hover:bg-slate-900/80 hover:text-white",
        className,
      ].join(" ")}
    >
      {children}
      {active && (
        <span className="pointer-events-none absolute inset-x-2 -bottom-[9px] h-[2px] rounded-full bg-blue-500" />
      )}
    </Link>
  );
}
