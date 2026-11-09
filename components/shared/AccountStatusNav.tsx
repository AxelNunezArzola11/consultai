"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: "company" | "freelancer" | "admin";
  companyName?: string | null;
  githubHandle?: string | null;
}

export function AccountStatusNav({
  portalRole,
}: {
  portalRole: "company" | "freelancer" | "admin";
}) {
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [demoMode, setDemoMode] = useState<boolean>(true);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((data) => {
        if (!active) return;
        if (data?.authenticated && data?.user) {
          setUser(data.user);
        } else {
          setUser(null);
        }
        if (typeof data?.demoMode === "boolean") {
          setDemoMode(data.demoMode);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
      setUser(null);
      router.push("/login");
      router.refresh();
    } finally {
      setSigningOut(false);
    }
  }

  const badgeStyles =
    portalRole === "freelancer"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
      : portalRole === "admin"
        ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-300"
        : "border-blue-500/30 bg-blue-500/10 text-blue-300";

  const roleLabel =
    portalRole === "freelancer"
      ? "Consultant"
      : portalRole === "admin"
        ? "Admin"
        : "Company";

  return (
    <div className="flex items-center gap-2 shrink-0">
      {user ? (
        <>
          <span
            data-testid="authenticated-user-badge"
            className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium whitespace-nowrap ${badgeStyles}`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            <span className="max-w-[180px] truncate">
              {user.companyName
                ? `${user.name} · ${user.companyName}`
                : user.name}
            </span>
          </span>
          <button
            type="button"
            onClick={handleSignOut}
            disabled={signingOut}
            data-testid="sign-out-btn"
            className="rounded-md border border-slate-700/80 bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-300 whitespace-nowrap transition hover:border-rose-500/40 hover:bg-rose-950/30 hover:text-rose-200 disabled:opacity-50"
          >
            {signingOut ? "Signing out…" : "Sign Out"}
          </button>
        </>
      ) : (
        <>
          <span
            className={`hidden sm:inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium whitespace-nowrap ${badgeStyles}`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            {roleLabel} {demoMode ? "· Demo" : ""}
          </span>
          <Link
            href="/login"
            className="rounded-md border border-slate-700/80 bg-slate-900 px-2.5 py-1 text-xs font-medium text-slate-200 whitespace-nowrap transition hover:border-slate-600 hover:bg-slate-800"
          >
            Sign In
          </Link>
          <Link
            href="/register"
            className="rounded-md bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white whitespace-nowrap shadow-sm shadow-blue-600/20 transition hover:bg-blue-500"
          >
            Register
          </Link>
        </>
      )}
    </div>
  );
}
