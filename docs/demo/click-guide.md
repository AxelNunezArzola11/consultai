# ConsultAI — Click-by-Click Navigation Guide

Base URL: production (`https://consultai-rho.vercel.app`) or local
(`http://localhost:3000`). DEMO mode: same URLs with `DEMO_MODE=true` on the server.

 IDs: LIVE seed uses `project-1`, `milestone-1..3`, `candidate-1..3`, `nda-1`,
`payment-2`, `approval-1`, `dispute-1`. DEMO fixtures use `demo-project-saas`,
`demo-ms-*`, `demo-cand-*`, `demo-dispute-1`.

## Setup (2 min before presenting)

1. Open `/api/health` → confirm `connected` (LIVE) or `simulated` (DEMO).
2. LIVE: confirm seed ran (`npm run seed`) and note the printed NDA invite path.
3. DEMO: open `/admin` → Demo Control Center → **Reset demo fixtures**.
4. Pick the Company role at `/` (sets the signed role cookie for all gated actions).

## Scenario A — Create and manage a project

1. `/project/new` → fill title + brief → **Continue to AI planning**.
   - Page load creates nothing; only the submit creates one draft (idempotent).
2. After Approve & Save in the planner, open `/dashboard` → click the project title
   → `/project/<id>/milestones` (workspace: funding, ledger, audit, payouts).
3. `/project/<id>/timeline` → Gantt bars, dependencies, drag to reschedule.

## Scenario B — AI planning

1. In `/project/new?projectId=<draft>`, send the brief in chat.
2. Watch the streamed plan → review canvas → edit manually if desired.
3. **Approve & Save** → milestones + criteria persist (toast confirms count).
4. `/planning?projectId=<id>` → Gantt + reschedule copilot + proposals banner.

## Scenario C — Talent and vetting

1. `/project/<id>/vetting` → type a skill in search → open candidate card.
2. Record consent → **Run evaluation** → read trust score + rationale.
3. **Shortlist** → go to `/project/<id>/candidates` → **Send NDA**.
4. Copy the one-time invite link → open `/invite/<ndaId:token>` in a new tab.
5. Type name → check the box → **Accept NDA & Unlock Booking** → booking link shows.
6. Back in `/project/<id>/candidates`, confirm status `nda_signed`.
7. Anytime: `/demo-inbox` → **Issue invite link** per pending NDA (company/admin).

## Scenario D — Delivery and verification

1. As freelancer: `/deliver/<milestoneId>` (from `/freelancer` milestone list).
2. Paste PR URL → optional expected author → **Verify delivery**.
3. `/project/<id>/delivery` → run cards for ALL milestones with per-milestone titles,
   criteria results, policy decision, and linked payment proposal.

## Scenario E — Rescheduling (3-day delay)

1. `/planning?projectId=<id>` → drag `demo-ms-frontend` (or ask copilot "delay by 3 days").
2. Pending proposal banner → review adjustments + conflicts → **Authorize & Apply**.
3. Gantt updates; decision recorded in audit log. Funded/paid milestones refuse edits (409).

## Scenario F — Financial workflow (LIVE needs PayPal Sandbox keys)

1. `/project/<id>/ledger` → review budget vs captured vs net per milestone.
2. `/project/<id>/approvals` → open the pending payment proposal.
3. **Approve** with recipient email → payout executes (Sandbox) or approval gates.
4. DEMO: approval decision is recorded with `payoutExecuted: false` — no simulated
   payment is ever reported completed. Funding buttons explain their unavailability.

## Scenario G — Dispute management

1. LIVE: `/project/project-1/disputes/dispute-1`.
   DEMO: `/project/demo-project-saas/disputes/demo-dispute-1` (or via Control Center).
2. Review milestone, amount, evidence packet, agent advisory.
3. Role-scoped actions: Analyze (company/admin) → Provide evidence / Make offer /
   Accept claim (PayPal Sandbox in LIVE; honest 503 in DEMO).

## Scenario H — Multi-agent orchestration

1. `/ai-ops?projectId=<id>` → click the **Full Multi-Agent Project Audit** preset
   (or type "Run a consolidated project review") → **Dispatch Supervisor**.
2. Inspect: status, per-agent outputs, trace/handoffs, errors/retries, approvals,
   final report. DEMO runs are labeled simulated throughout.

## Portals

- Company: `/dashboard`, `/planning`, `/operations`, `/ai-ops`, `/project/new`.
- Freelancer: `/freelancer`, `/deliver/<id>`, `/demo-inbox`, `/invite/<token>`.
- Admin: `/admin` (governance + Demo Control Center), `/api/health`, `/analytics`.

## Reset / recovery during the demo

- DEMO: `/admin` → **Reset demo fixtures** (restores TechNova instantly).
- LIVE: re-run `npm run seed` (idempotent; NDA link reissued via `/demo-inbox`).
- Lost role cookie: click **Switch Role** in any header → pick a role again.
