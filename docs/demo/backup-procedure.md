# ConsultAI — Backup Presentation Procedure

Use when Neon, Render, AI providers, or PayPal Sandbox are unavailable.
The DEMO deployment/tab runs the complete presentation with zero external services.

## Option 1 — Separate DEMO deployment (recommended)

1. In Vercel, set `DEMO_MODE=true` on a preview deployment (or a second project
   you own — do NOT create a new production project without approval).
2. Open `<preview-url>/api/health` → expect `{"status":"simulated"}`.
3. Open `<preview-url>/admin` → Demo Control Center → Reset demo fixtures.
4. Present using `presentation-script.md` — every step works offline.

## Option 2 — Local laptop demo (no internet at all)

1. `DEMO_MODE=true npm run dev` (or `npm run build && npm run start`).
2. Open `http://localhost:3000/api/health` → `simulated`.
3. No `.env.local` needed: role switching uses an ephemeral per-instance secret
   (sessions don't survive restart — re-pick the role after restarting).
4. Present the full script; funding/PayPal buttons explain their unavailability.

## What works in DEMO mode

- All pages, grids, timelines, ledgers with the TechNova fixtures.
- Project creation, AI plan simulation, Approve & Save (in-memory).
- Vetting search/evaluate/shortlist; NDA generate → invite → sign loop.
- Delivery verification (simulated checks, real policy engine), proposals,
  human approvals/rejections (decisions recorded, payouts never executed).
- Reschedule proposals + authorize/apply; dispute review + simulated analysis.
- Supervisor multi-agent runs (deterministic labeled traces).
- Demo reset (company/admin only).

## What honestly doesn't (by design)

- Real PayPal orders/captures/payouts/dispute actions → 503 `demo_mode_unavailable`.
- Live LLM chats (payment chat, planning free chat) → 503 with guidance.
- Webhooks (PayPal/GitHub/Cal/QStash) → 503.
- Data persists per server instance only; serverless may reset between invocations —
  re-check `/admin` if a page looks pristine mid-demo, and re-run the step.

## Mid-presentation failover lines

1. "Our health endpoint shows the database is unreachable — the app tells you that
   instead of showing fake empty dashboards."
2. Open the DEMO URL: "Same app, offline scenario — TechNova Solutions, a fictional
   $25,000 project. Everything here is labeled simulated."
3. Continue the script; point at the DEMO banner at least once per section.

## Failover triggers (switch proactively, don't debug on stage)

- `/api/health` returns `unavailable`, or any page shows the red degraded banner.
- PayPal Sandbox login fails → do Scenario F on DEMO (proposals + approvals).
- Groq rate-limits → planning chat + vetting runs continue on DEMO (simulated).
- Render backend down → note it from the health checks, continue (no flow needs it live).
