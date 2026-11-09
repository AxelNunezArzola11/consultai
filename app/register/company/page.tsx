"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function RegisterCompanyPage() {
  const router = useRouter();
  const [companyName, setCompanyName] = useState("");
  const [industry, setIndustry] = useState("Enterprise SaaS");
  const [companyWebsite, setCompanyWebsite] = useState("");
  const [companySize, setCompanySize] = useState("11-50");
  const [contactName, setContactName] = useState("");
  const [contactRole, setContactRole] = useState("VP of Engineering");
  const [email, setEmail] = useState("");
  const [billingCountry, setBillingCountry] = useState("US");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Password and confirmation password do not match.");
      return;
    }
    if (!termsAccepted) {
      setError("Please accept the Terms of Service and Privacy Policy.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountType: "company",
          companyName,
          industry,
          companyWebsite,
          companySize,
          contactName,
          contactRole,
          email,
          billingCountry,
          password,
          confirmPassword,
          termsAccepted,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.message || data?.error || "Registration failed.");
        return;
      }
      router.push(data?.redirectTo || "/dashboard");
      router.refresh();
    } catch {
      setError("Network error while registering. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#090c12] text-slate-100 flex flex-col justify-between">
      <header className="border-b border-slate-800/90 bg-[#090c12]/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-blue-600 font-mono text-xs font-bold text-white">
              CA
            </span>
            <span className="text-sm font-semibold tracking-tight text-white">ConsultAI</span>
          </Link>
          <div className="flex items-center gap-3 text-xs">
            <Link href="/register" className="text-slate-400 hover:text-white">
              ← Account Types
            </Link>
            <Link
              href="/login"
              className="rounded-md border border-slate-700 bg-slate-900 px-3.5 py-1.5 font-medium text-slate-200 hover:bg-slate-800"
            >
              Sign In
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
        <div className="rounded-xl border border-slate-800 bg-[#0f141e] p-7 shadow-2xl">
          <div className="mb-6 flex flex-wrap items-start justify-between gap-3 border-b border-slate-800/80 pb-4">
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-white">
                Create your Company Workspace
              </h1>
              <p className="mt-1 text-xs text-slate-400">
                Your company workspace isolates your projects, NDAs, vetted candidates, and escrow ledgers.
              </p>
            </div>
            <span className="rounded border border-blue-500/25 bg-blue-500/10 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase text-blue-300">
              Company / Client
            </span>
          </div>

          {error && (
            <div
              role="alert"
              data-testid="register-company-error"
              className="mb-5 rounded-lg border border-rose-500/40 bg-rose-950/40 px-4 py-3 text-xs text-rose-200"
            >
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="companyName" className="block text-xs font-medium text-slate-300">
                  Company / Organization Name *
                </label>
                <input
                  id="companyName"
                  name="companyName"
                  type="text"
                  required
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="Acme Technologies Inc."
                  className="mt-1.5 w-full rounded-lg border border-slate-700/90 bg-[#090c12] px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="industry" className="block text-xs font-medium text-slate-300">
                  Industry / Sector
                </label>
                <input
                  id="industry"
                  name="industry"
                  type="text"
                  value={industry}
                  onChange={(e) => setIndustry(e.target.value)}
                  placeholder="Enterprise SaaS / FinTech"
                  className="mt-1.5 w-full rounded-lg border border-slate-700/90 bg-[#090c12] px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label htmlFor="companyWebsite" className="block text-xs font-medium text-slate-300">
                  Company Website
                </label>
                <input
                  id="companyWebsite"
                  name="companyWebsite"
                  type="url"
                  value={companyWebsite}
                  onChange={(e) => setCompanyWebsite(e.target.value)}
                  placeholder="https://acme.example.com"
                  className="mt-1.5 w-full rounded-lg border border-slate-700/90 bg-[#090c12] px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="companySize" className="block text-xs font-medium text-slate-300">
                  Company Size
                </label>
                <select
                  id="companySize"
                  name="companySize"
                  value={companySize}
                  onChange={(e) => setCompanySize(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-slate-700/90 bg-[#090c12] px-3.5 py-2 text-sm text-white focus:border-blue-500 focus:outline-none"
                >
                  <option value="1-10">1-10 employees</option>
                  <option value="11-50">11-50 employees</option>
                  <option value="51-200">51-200 employees</option>
                  <option value="201-1000">201-1,000 employees</option>
                  <option value="1000+">1,000+ employees</option>
                </select>
              </div>

              <div>
                <label htmlFor="billingCountry" className="block text-xs font-medium text-slate-300">
                  Country / Region
                </label>
                <input
                  id="billingCountry"
                  name="billingCountry"
                  type="text"
                  value={billingCountry}
                  onChange={(e) => setBillingCountry(e.target.value)}
                  placeholder="US"
                  className="mt-1.5 w-full rounded-lg border border-slate-700/90 bg-[#090c12] px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="contactName" className="block text-xs font-medium text-slate-300">
                  Primary Contact Full Name *
                </label>
                <input
                  id="contactName"
                  name="contactName"
                  type="text"
                  required
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                  placeholder="Elena Vance"
                  className="mt-1.5 w-full rounded-lg border border-slate-700/90 bg-[#090c12] px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="contactRole" className="block text-xs font-medium text-slate-300">
                  Role / Title
                </label>
                <input
                  id="contactRole"
                  name="contactRole"
                  type="text"
                  value={contactRole}
                  onChange={(e) => setContactRole(e.target.value)}
                  placeholder="VP of Engineering"
                  className="mt-1.5 w-full rounded-lg border border-slate-700/90 bg-[#090c12] px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label htmlFor="email" className="block text-xs font-medium text-slate-300">
                Work Email *
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="elena@acme.example.com"
                className="mt-1.5 w-full rounded-lg border border-slate-700/90 bg-[#090c12] px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="password" className="block text-xs font-medium text-slate-300">
                  Password (min 8 chars, letter + number) *
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="mt-1.5 w-full rounded-lg border border-slate-700/90 bg-[#090c12] px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="confirmPassword" className="block text-xs font-medium text-slate-300">
                  Confirm Password *
                </label>
                <input
                  id="confirmPassword"
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="mt-1.5 w-full rounded-lg border border-slate-700/90 bg-[#090c12] px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-blue-500 focus:outline-none"
                />
              </div>
            </div>

            <label className="flex items-start gap-2.5 pt-2 text-xs text-slate-300">
              <input
                type="checkbox"
                name="termsAccepted"
                checked={termsAccepted}
                onChange={(e) => setTermsAccepted(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-700 bg-[#090c12] text-blue-600"
              />
              <span>
                I accept the ConsultAI Enterprise Terms of Service, Milestone Escrow Policy, and Privacy Policy.
              </span>
            </label>

            <button
              type="submit"
              disabled={loading}
              data-testid="register-company-submit"
              className="w-full rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-blue-600/20 transition hover:bg-blue-500 disabled:opacity-50"
            >
              {loading ? "Creating Company Workspace…" : "Create Company Account"}
            </button>
          </form>
        </div>
      </main>

      <footer className="border-t border-slate-800/80 py-4 text-center text-xs text-slate-400">
        ConsultAI Enterprise Platform · Company Onboarding
      </footer>
    </div>
  );
}
