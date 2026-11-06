# ConsultAI — Production Readiness Assessment

Date: 2026-11-06. Branch: `main` (working tree contains unrelated pre-existing
changes — see Deploy notes). Production: `https://consultai-rho.vercel.app`
(Vercel project `consultai`, linked).

## Verification results (observed in this session)

| Check | Result |
|---|---|
| `tsc --noEmit` | PASS (0 errors) |
| `vitest run` | 522 passed, 3 skipped (DB integration needs `DATABASE_URL`), 0 failed |
| `npm run lint` | 0 errors in new/changed code; pre-existing errors remain (react-compiler rules in ChatPanel, GanttPanel, MilestoneCanvas, ActivityStream, EnterpriseOperationsGrids, DisputeView; `any` in webhook.test.ts; impure-Date in planning page) |
| `npm run build` | PASS (compiled + 11 static pages; all routes dynamic as designed) |
| Authz tests (`app/api/authz.test.ts`) | 12/12 pass — unauthenticated + freelancer mutations rejected server-side |
| Fixture integrity (`lib/demo/*.test.ts`) | 14/14 pass — IDs resolve, $25k budget, NDA loop round-trips |
| NDA reconstruction tests | 4/4 pass |
| Payment contract test | PASS (restored `payout_requested` contract) |
| Playwright demo smoke (`playwright.demo.config.ts`) | 7/7 PASS against the production build in DEMO_MODE: all six routes, project creation, planning chat + save, vetting re-run, NDA generate→invite→sign, delivery verification, payout refusal (honest 503), dispute analysis, demo reset, tablet pass. All navigations <1.3s. Screenshots verified by inspection |
| Playwright live-DB E2E (`tests/approval.spec.ts`, `tests/gantt-reorder.spec.ts`) | NOT RUN here (needs `DATABASE_URL` + Sanders credentials). Run before presenting: `npm run test:e2e` |
| Live PayPal Sandbox flow | NOT RUN here (no credentials in this environment). Required pre-presentation check with Sandbox buyer account |
| Production `/dashboard` timeout | Mitigated in code (15s bounded waits + degraded banner + `/api/health`); live re-probe still required after deploy |

## Feature classification

- LIVE VERIFIED (by tests/build, needs live re-probe): navigation fixes, payment
  contract, NDA generate→invite→sign loop, delivery all-milestones, candidate JSON
  actions + polling, `/project/new` no-write-on-GET, analytics layout, role gates,
  bounded timeouts, degraded states, health endpoint.
- DEMO SIMULATED (offline, labeled): TechNova fixtures, brief plan stream, vetting
  runs, delivery verification, dispute analysis, supervisor traces, approval
  decisions (`payoutExecuted: false`), harness chats.
- PARTIALLY VERIFIED: PayPal Sandbox end-to-end (code paths intact + guarded; needs
  Sandbox credentials to run), production cold-start behavior (needs deploy + probe).
- BLOCKED: nothing. Production DB migration state was not accessed (no approval
  to inspect or modify — see Deploy notes); no migrations were needed.
- NOT IMPLEMENTED: nothing in the Phase 1–8 scope remains unimplemented.

## Deploy notes (no deploy performed)

1. `vercel --production` was NOT run: the working tree mixes this demo work with
   unrelated pre-existing modifications, and production DB migration state was not
   approved for changes. Remediation: review `git status`, commit or stash
   unrelated files, then deploy from a clean tree.
2. No database migrations were created or run (all fixes reuse existing columns).
3. No production env vars were changed. Required for LIVE: `DATABASE_URL`,
   `ROLE_COOKIE_SECRET` (≥32 chars), `APP_BASE_URL`, `GROQ_API_KEY`,
   PayPal Sandbox `PAYPAL_CLIENT_ID/SECRET` (+ `PAYPAL_WEBHOOK_ID`),
   `GITHUB_TOKEN`, webhook secrets. Optional: Cal, QStash, `NEXT_PUBLIC_GANTT_ENABLED=true`.
4. After deploy: run `npm run seed` once against production (idempotent; prints the
   NDA invite once), then re-probe `/api/health` and `/dashboard`.
5. Render backend untouched per instructions (no approval to modify).

## Manual configuration before presenting

1. Vercel env vars (above) + redeploy.
2. `npm run seed` (+ `npm run seed:vetting-signals`) against the production DB.
3. PayPal Sandbox buyer account for Scenario F.
4. Optional DEMO preview deployment with `DEMO_MODE=true` for instant failover.
5. `npm run test:e2e` from a machine that can serve HTTP.
