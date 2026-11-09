"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface LoginFailure {
  message: string;
  requestId: string | null;
}

/**
 * Maps API error codes to user-facing copy. Never exposes infrastructure
 * details; service failures include the server's request correlation id
 * so support can find the matching log line.
 */
function describeLoginFailure(
  data: {
    error?: string;
    message?: string;
    retryAfterSec?: number;
    requestId?: string;
  } | null
): LoginFailure {
  const requestId =
    typeof data?.requestId === "string" && data.requestId.length > 0
      ? data.requestId
      : null;
  switch (data?.error) {
    case "invalid_credentials":
      return {
        message:
          "Incorrect email or password, or no account exists for this email. " +
          "Check both and try again.",
        requestId: null,
      };
    case "account_locked":
    case "rate_limited": {
      const wait =
        typeof data?.retryAfterSec === "number" && data.retryAfterSec > 0
          ? ` Wait about ${data.retryAfterSec} seconds before retrying.`
          : " Wait a little before retrying.";
      return {
        message: `Too many sign-in attempts.${wait}`,
        requestId: null,
      };
    }
    case "auth_service_misconfigured":
      return {
        message:
          "Sign-in is not available on this deployment yet — the server setup " +
          "is incomplete. If you run this deployment, apply the auth database " +
          "migration and try again.",
        requestId,
      };
    case "auth_unavailable":
      return {
        message:
          "The sign-in service is temporarily unavailable. Please try again " +
          "in a moment; your entries are preserved.",
        requestId,
      };
    case "csrf_origin_mismatch":
      return {
        message:
          "This sign-in request was blocked by a security check. Refresh the " +
          "page and try again.",
        requestId: null,
      };
    case "missing_credentials":
    case "validation_error":
    case "invalid_json":
      return {
        message: "Enter a valid email address and password.",
        requestId: null,
      };
    default:
      return {
        message:
          data?.message || "Sign in failed. Please try again.",
        requestId,
      };
  }
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failureRef, setFailureRef] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (loading) return;
    setError(null);
    setFailureRef(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const failure = describeLoginFailure(data);
        setError(failure.message);
        setFailureRef(failure.requestId);
        return;
      }
      const target = data?.redirectTo || "/dashboard";
      router.push(target);
      router.refresh();
    } catch {
      setError("Network error while signing in. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  function fillDemoCredentials(type: "company" | "freelancer") {
    if (type === "company") {
      setEmail("founder@acme-demo.consultai.local");
      setPassword("DemoCompany2026!");
    } else {
      setEmail("alex.rivera@freelancer-demo.consultai.local");
      setPassword("DemoFreelancer2026!");
    }
    setError(null);
  }

  return (
    <div className="min-h-screen bg-[#090c12] text-slate-100 flex flex-col justify-between">
      {/* Top Bar */}
      <header className="border-b border-slate-800/90 bg-[#090c12]/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-blue-600 font-mono text-xs font-bold text-white shadow-sm shadow-blue-600/30">
              CA
            </span>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold tracking-tight text-white">ConsultAI</span>
              <span className="rounded border border-slate-800 bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] font-medium text-slate-400">
                v4.2
              </span>
            </div>
          </Link>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-slate-400">New to ConsultAI?</span>
            <Link
              href="/register"
              className="rounded-md border border-slate-700 bg-slate-900 px-3.5 py-1.5 font-medium text-slate-200 transition hover:border-slate-600 hover:bg-slate-800"
            >
              Create Account →
            </Link>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="mx-auto flex w-full max-w-5xl flex-1 items-center px-6 py-12">
        <div className="grid w-full grid-cols-1 gap-10 lg:grid-cols-12">
          {/* Left Column: Value Proposition & Security Posture */}
          <div className="flex flex-col justify-center space-y-6 lg:col-span-6">
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
                Sign in to your ConsultAI workspace
              </h1>
              <p className="mt-3 text-sm leading-relaxed text-slate-400">
                Access multi-agent project orchestration, Bryntum critical-path scheduling,
                verified GitHub consultant vetting, and PayPal milestone escrow.
              </p>
            </div>

            <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-slate-800 bg-slate-800 sm:grid-cols-2">
              <div className="bg-[#0f141e] p-4">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-semibold text-blue-400">
                    COMPANY PORTAL
                  </span>
                  <span className="h-1.5 w-1.5 rounded-full bg-blue-400" />
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                  Scope briefs with AI, vet GitHub signals, issue NDAs, and authorize milestone payouts.
                </p>
              </div>
              <div className="bg-[#0f141e] p-4">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-semibold text-emerald-400">
                    FREELANCER PORTAL
                  </span>
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                  Review matched engagements, sign NDAs, submit pull requests, and track escrow releases.
                </p>
              </div>
            </div>

            {/* Synthetic Test Account Quick-Fill for Evaluators */}
            <div className="rounded-lg border border-slate-800 bg-[#0f141e] p-4">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-slate-300">
                  Synthetic Evaluation Accounts
                </span>
                <span className="rounded border border-slate-800 bg-slate-900/90 px-2 py-0.5 font-mono text-[10px] text-slate-400">
                  Zero-secret local fixtures
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-400">
                Use pre-seeded synthetic accounts to inspect Company or Freelancer portals immediately:
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => fillDemoCredentials("company")}
                  data-testid="fill-demo-company"
                  className="rounded-md border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-xs font-medium text-blue-300 transition hover:bg-blue-500/20"
                >
                  Fill Demo Company Login
                </button>
                <button
                  type="button"
                  onClick={() => fillDemoCredentials("freelancer")}
                  data-testid="fill-demo-freelancer"
                  className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/20"
                >
                  Fill Demo Freelancer Login
                </button>
              </div>
            </div>
          </div>

          {/* Right Column: Login Card */}
          <div className="lg:col-span-6">
            <div className="rounded-xl border border-slate-800 bg-[#0f141e] p-7 shadow-2xl shadow-black/50">
              <div className="mb-6 flex items-center justify-between border-b border-slate-800/80 pb-4">
                <div>
                  <h2 className="text-lg font-bold tracking-tight text-white">Account Sign In</h2>
                  <p className="mt-0.5 text-xs text-slate-400">
                    Enter your registered work or consultant email and password.
                  </p>
                </div>
                <span className="rounded border border-slate-800 bg-slate-900 px-2 py-1 font-mono text-[10px] text-slate-400">
                  scrypt · SHA-256
                </span>
              </div>

              {error && (
                <div
                  role="alert"
                  data-testid="login-error"
                  className="mb-5 rounded-lg border border-rose-500/40 bg-rose-950/40 px-4 py-3 text-xs text-rose-200"
                >
                  {error}
                  {failureRef && (
                    <span className="mt-1 block font-mono text-[10px] text-rose-300/80">
                      Reference: {failureRef}
                    </span>
                  )}
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label
                    htmlFor="login-email"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Email Address
                  </label>
                  <input
                    id="login-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@company.com"
                    className="mt-1.5 w-full rounded-lg border border-slate-700/90 bg-[#090c12] px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                  />
                </div>

                <div>
                  <label
                    htmlFor="login-password"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Password
                  </label>
                  <input
                    id="login-password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    className="mt-1.5 w-full rounded-lg border border-slate-700/90 bg-[#090c12] px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                  />
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  data-testid="login-submit"
                  className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-600/25 transition hover:bg-blue-500 disabled:opacity-50"
                >
                  {loading ? "Signing in…" : "Sign In to Workspace"}
                </button>
              </form>

              <div className="mt-6 border-t border-slate-800/80 pt-5 text-center text-xs text-slate-400">
                Don&apos;t have an account yet?{" "}
                <Link
                  href="/register/company"
                  className="font-semibold text-blue-400 hover:underline"
                >
                  Register as a Company
                </Link>{" "}
                or{" "}
                <Link
                  href="/register/freelancer"
                  className="font-semibold text-emerald-400 hover:underline"
                >
                  Join as a Freelancer
                </Link>
              </div>
            </div>
          </div>
        </div>
      </main>

      <footer className="border-t border-slate-800/80 py-4 text-center text-xs text-slate-400">
        ConsultAI Enterprise Platform · Role-Isolated Sessions &amp; Human-Gated Escrow
      </footer>
    </div>
  );
}
