"use client";

/**
 * ActiveNavLink — navigation link with a clear active state.
 *
 * Highlights when the current pathname matches `href` exactly or (for section
 * links) starts with `href + "/"`, so project sub-pages keep their section
 * highlighted. No layout shift: the active state is color + underline only.
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
      className={`${className} ${
        active
          ? "font-semibold text-white underline decoration-blue-500 decoration-2 underline-offset-8"
          : ""
      }`}
    >
      {children}
    </Link>
  );
}
