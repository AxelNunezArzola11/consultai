"use client";

import { useRouter } from "next/navigation";
import { ThemeToggle } from "@/components/shared/ThemeToggle";

/**
 * Role switcher — landing page.
 *
 * No auth required. Stores chosen role in localStorage under "consultai_role".
 * Navigates to the appropriate view on click.
 *
 * Phase 0: two large buttons (Company / Freelancer).
 * Later phases will add proper onboarding when auth is wired.
 */
export default function HomePage() {
  const router = useRouter();

  function selectRole(role: "company" | "freelancer") {
    if (typeof window !== "undefined") {
      localStorage.setItem("consultai_role", role);
    }
    if (role === "company") {
      router.push("/dashboard");
    } else {
      router.push("/demo-inbox");
    }
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-10 px-4 py-16">
      <div className="text-center space-y-2">
        <h1 className="text-4xl font-bold tracking-tight">ConsultAI</h1>
        <p className="text-muted-foreground text-lg max-w-md">
          AI-agent platform matching companies with vetted freelance consultants.
          PayPal-rails milestone payments.
        </p>
      </div>

      <div className="flex flex-col sm:flex-row gap-4">
        <button
          onClick={() => selectRole("company")}
          className="rounded-xl border-2 border-primary bg-primary text-primary-foreground px-10 py-6 text-xl font-semibold hover:opacity-90 transition-opacity"
        >
          🏢 I&apos;m a Company
        </button>
        <button
          onClick={() => selectRole("freelancer")}
          className="rounded-xl border-2 border-border bg-card text-card-foreground px-10 py-6 text-xl font-semibold hover:bg-muted transition-colors"
        >
          💼 I&apos;m a Freelancer
        </button>
      </div>

      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
    </main>
  );
}
