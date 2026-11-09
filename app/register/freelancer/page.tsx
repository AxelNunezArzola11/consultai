"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function RegisterFreelancerPage() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [specialty, setSpecialty] = useState("Full-Stack & AI Systems Engineer");
  const [skills, setSkills] = useState("TypeScript, Next.js, Python, FastAPI, PostgreSQL");
  const [githubUsername, setGithubUsername] = useState("");
  const [portfolioUrl, setPortfolioUrl] = useState("");
  const [hourlyRateUsd, setHourlyRateUsd] = useState("135");
  const [availability, setAvailability] = useState("available");
  const [bio, setBio] = useState("");
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
          accountType: "freelancer",
          fullName,
          email,
          specialty,
          skills,
          githubUsername,
          portfolioUrl,
          hourlyRateUsd,
          availability,
          bio,
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
      router.push(data?.redirectTo || "/freelancer");
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
                Create your Consultant Profile
              </h1>
              <p className="mt-1 text-xs text-slate-400">
                Connect your GitHub identity, review NDA invitations, submit PR deliverables, and receive verified milestone payouts.
              </p>
            </div>
            <span className="rounded border border-emerald-500/25 bg-emerald-500/10 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase text-emerald-300">
              Freelancer / Consultant
            </span>
          </div>

          {error && (
            <div
              role="alert"
              data-testid="register-freelancer-error"
              className="mb-5 rounded-lg border border-rose-500/40 bg-rose-950/40 px-4 py-3 text-xs text-rose-200"
            >
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="fullName" className="block text-xs font-medium text-slate-300">
                  Full Name *
                </label>
                <input
                  id="fullName"
                  name="fullName"
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Alex Rivera"
                  className="mt-1.5 w-full rounded-lg border border-slate-700/90 bg-[#090c12] px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="email" className="block text-xs font-medium text-slate-300">
                  Email Address *
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="alex@consultant.dev"
                  className="mt-1.5 w-full rounded-lg border border-slate-700/90 bg-[#090c12] px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="specialty" className="block text-xs font-medium text-slate-300">
                  Primary Role / Specialty *
                </label>
                <input
                  id="specialty"
                  name="specialty"
                  type="text"
                  required
                  value={specialty}
                  onChange={(e) => setSpecialty(e.target.value)}
                  placeholder="Staff Full-Stack Engineer"
                  className="mt-1.5 w-full rounded-lg border border-slate-700/90 bg-[#090c12] px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="githubUsername" className="block text-xs font-medium text-slate-300">
                  GitHub Username or Profile URL
                </label>
                <input
                  id="githubUsername"
                  name="githubUsername"
                  type="text"
                  value={githubUsername}
                  onChange={(e) => setGithubUsername(e.target.value)}
                  placeholder="@AxelNunezArzola11 or https://github.com/..."
                  className="mt-1.5 w-full rounded-lg border border-slate-700/90 bg-[#090c12] px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label htmlFor="skills" className="block text-xs font-medium text-slate-300">
                Skills / Technologies (comma-separated)
              </label>
              <input
                id="skills"
                name="skills"
                type="text"
                value={skills}
                onChange={(e) => setSkills(e.target.value)}
                placeholder="TypeScript, Next.js, Python, FastAPI, PostgreSQL"
                className="mt-1.5 w-full rounded-lg border border-slate-700/90 bg-[#090c12] px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label htmlFor="portfolioUrl" className="block text-xs font-medium text-slate-300">
                  Portfolio URL
                </label>
                <input
                  id="portfolioUrl"
                  name="portfolioUrl"
                  type="url"
                  value={portfolioUrl}
                  onChange={(e) => setPortfolioUrl(e.target.value)}
                  placeholder="https://portfolio.dev"
                  className="mt-1.5 w-full rounded-lg border border-slate-700/90 bg-[#090c12] px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="hourlyRateUsd" className="block text-xs font-medium text-slate-300">
                  Preferred Rate (USD/hr)
                </label>
                <input
                  id="hourlyRateUsd"
                  name="hourlyRateUsd"
                  type="number"
                  min="10"
                  max="2000"
                  value={hourlyRateUsd}
                  onChange={(e) => setHourlyRateUsd(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-slate-700/90 bg-[#090c12] px-3.5 py-2 font-mono text-sm tabular-nums text-white focus:border-emerald-500 focus:outline-none"
                />
              </div>

              <div>
                <label htmlFor="availability" className="block text-xs font-medium text-slate-300">
                  Availability
                </label>
                <select
                  id="availability"
                  name="availability"
                  value={availability}
                  onChange={(e) => setAvailability(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-slate-700/90 bg-[#090c12] px-3.5 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
                >
                  <option value="available">Available Immediately</option>
                  <option value="part_time">Part-Time (20 hrs/wk)</option>
                  <option value="two_weeks">2 Weeks Notice</option>
                </select>
              </div>
            </div>

            <div>
              <label htmlFor="bio" className="block text-xs font-medium text-slate-300">
                Short Professional Summary
              </label>
              <textarea
                id="bio"
                name="bio"
                rows={2}
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="Brief overview of your engineering and consulting track record…"
                className="mt-1.5 w-full rounded-lg border border-slate-700/90 bg-[#090c12] px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
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
                  className="mt-1.5 w-full rounded-lg border border-slate-700/90 bg-[#090c12] px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
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
                  className="mt-1.5 w-full rounded-lg border border-slate-700/90 bg-[#090c12] px-3.5 py-2 text-sm text-white placeholder-slate-500 focus:border-emerald-500 focus:outline-none"
                />
              </div>
            </div>

            <label className="flex items-start gap-2.5 pt-2 text-xs text-slate-300">
              <input
                type="checkbox"
                name="termsAccepted"
                checked={termsAccepted}
                onChange={(e) => setTermsAccepted(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-700 bg-[#090c12] text-emerald-600"
              />
              <span>
                I accept the ConsultAI Consultant Agreement, NDA Verification Rules, and Privacy Policy.
              </span>
            </label>

            <button
              type="submit"
              disabled={loading}
              data-testid="register-freelancer-submit"
              className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm shadow-emerald-600/20 transition hover:bg-emerald-500 disabled:opacity-50"
            >
              {loading ? "Creating Consultant Profile…" : "Create Freelancer Account"}
            </button>
          </form>
        </div>
      </main>

      <footer className="border-t border-slate-800/80 py-4 text-center text-xs text-slate-400">
        ConsultAI Enterprise Platform · Consultant Onboarding
      </footer>
    </div>
  );
}
