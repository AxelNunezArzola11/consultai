# ConsultAI — 10-Minute Judge Presentation Script

Audience: hackathon judges, investors, potential customers.
Modes: **LIVE** (real Neon DB + PayPal Sandbox + AI keys) or **DEMO** (fully offline,
fictional TechNova scenario). The banner at the top of every page always shows the mode.

Start at the Demo Control Center: **`/admin`** (mode, health, all scenario links, reset).

---

## 0:00–1:00 — The problem and the product (/, /dashboard)

1. Open **`/`**. "ConsultAI is an AI-agent platform for hiring and managing vetted
   freelance consultants, with PayPal powering milestone funding and payouts."
2. Click **Company**. Land on **`/dashboard`**.
3. Point at KPIs: active projects, funded vs paid, pending approvals, open disputes.
   "Every dollar here is gated by human approval — agents propose, humans dispose."

## 1:00–2:30 — Create a project + AI planning (Scenario A + B)

1. **`/project/new`** → title + brief → **Continue to AI planning**.
2. Chat streams a phased plan with milestones, budgets, acceptance criteria.
   (DEMO: labeled `SIMULATED PLANNING RUN`, deterministic.)
3. Review the plan canvas → **Approve & Save** → milestones persist.
4. Open **`/planning?projectId=…`** → Gantt timeline with dependencies.

Talking point: "The planner never writes without approval. Save validates budgets
and criteria server-side."

## 2:30–4:00 — Talent vetting + NDA (Scenario C)

1. **`/project/<id>/vetting`** → search consultants, open a candidate card.
2. Consent → **Run evaluation** → trust score, score breakdown, requirement matrix.
   (DEMO: deterministic run over fictional signals, same scoring code.)
3. **Shortlist** → **`/project/<id>/candidates`** → **Send NDA**.
4. Copy the one-time invite link → open **`/invite/<ndaId:token>`** → sign as the
   candidate. Candidate advances to `nda_signed`; booking unlocks.
5. Show **`/demo-inbox`** (reissue links; raw tokens are never stored).

Talking point: "Tokens are hashed, single-use, rate-limited, expiring — and the
signature binds the exact document hash."

## 4:00–5:30 — Delivery, money, approvals (Scenario D + F)

1. Freelancer view: **`/deliver/<milestoneId>`** → submit PR URL → verification runs.
   (DEMO: simulated checks; the real policy engine renders the decision.)
2. **`/project/<id>/delivery`** → run history for every milestone.
3. **`/project/<id>/ledger`** → captures, fees, nets per milestone.
4. **`/project/<id>/approvals`** → payment proposal over the $500 threshold →
   human **Approve**. "No payout executes without this click — enforced server-side."
5. LIVE only: fund a planned milestone via PayPal Sandbox; show webhook verification.

## 5:30–7:00 — Delay, reschedule, dispute (Scenario E + G)

1. **`/planning`** → drag a task (or invoke the reschedule copilot: "delay by 3 days").
2. Proposal appears: affected milestones, propagated dates, resource conflict →
   **Authorize & Apply** or reject. Decision is audited.
3. **`/project/<id>/disputes/<id>`** → evidence packet, agent advisory, role-scoped
   actions (provide evidence / make offer / accept claim — PayPal Sandbox in LIVE).

Talking point: "Funded and paid milestones are schedule-locked; disputes never
auto-resolve — every action is human-authorized."

## 7:00–8:30 — Multi-agent orchestration (Scenario H)

1. **`/ai-ops`** → click the **Full Multi-Agent Project Audit** preset → run.
2. Show: supervisor classification, delegation to Planning / Talent / Delivery /
   Finance / Reschedule, execution trace, structured outputs, errors/retries,
   pending approvals, final consolidated report.
   (DEMO: deterministic trace, every artifact labeled simulated.)

## 8:30–9:30 — Portals and trust

1. **`/freelancer`** — assigned work, deliverables, payment status.
2. **`/operations`** — 7 enterprise grids, inline edits (company/admin only, audited).
3. **`/admin`** — governance, audit log, webhook deliveries, Demo Control Center.
4. **`/api/health`** — `connected | degraded | unavailable | simulated`. "The system
   never reports healthy when the database is down — pages show degraded states."

## 9:30–10:00 — Close

- Recap: plan → vet → sign → deliver → verify → approve → pay, all agent-assisted,
  all human-governed, all audited.
- "Try breaking it: deep links, expired NDAs, double submits — every path fails
  honestly." (Reset demo fixtures from the Control Center.)

---

## Emergency lines (if something fails live)

- Any page hangs/errors → open **`/api/health`**, read the status aloud, then:
  "This is exactly why we built the offline mode — switching to DEMO," and continue
  on the DEMO deployment/tab. See `backup-procedure.md`.
