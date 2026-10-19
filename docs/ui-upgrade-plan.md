# ConsultAI UI/UX & Data-Visualisation Upgrade Plan

> **Goal**: Physical, fluid, polished UI (Emil Kowalski standard) across ConsultAI without breaking the build, safety rules, or existing functionality. Executed in separate steps with checkpoints.
>
> **Execution order**: Step 1 → Step 2 → Step 4 → Step 6 → Step 3 → Step 5 (optional).

---

## Step 0 Audit — Observed Facts (read-only)

### Installed Versions (from `consultai/package.json`)
| Package | Version |
|---|---|
| next | 16.4.0 |
| react | 19.3.0 |
| react-dom | 19.3.0 |
| tailwindcss | ^4 (v4.x) |
| framer-motion | 11.18.2 (exact pin — package is still `framer-motion`, not `motion`) |
| sonner | ^2.0.8 (shadcn Sonner wrapper at `components/ui/sonner.tsx` — already installed) |
| @base-ui/react | ^1.9.0 (used by Sheet/drawer — Vaul not yet installed) |
| ag-grid-community | 32.3.9 (exact pin) |
| ag-grid-react | 32.3.9 (exact pin) |
| mermaid | 12.2.0 (exact pin) |
| shadcn | ^4.21.4 |
| tw-animate-css | ^1.4.0 |
| @hello-pangea/dnd | ^18.0.1 |

**framer-motion**: Correct package name at v11 — NOT `motion`. Keep pinned at `11.18.2` while its peer range accepts React 19.

**Compiler**: webpack (both `dev` and `build` use `--webpack`). Turbopack is disabled because **Bryntum panics with Turbopack** (observed in Spike 6 command output). The tw-animate-css cause was not separately observed in command output and must not be cited.

### Bryntum — Corrected (Correction 1)
Trial is on **public npm** — no private registry required:
```
npm install @bryntum/gantt@npm:@bryntum/gantt-trial
npm install @bryntum/gantt-react@<same-version>
```
Spike 6: renders without watermark in browser when built with `--webpack`.  
License terms for hackathon: ❌ UNVERIFIED — must read https://bryntum.com/products/gantt/docs/ and quote the relevant sentence before shipping.

### Vercel Max Duration — Corrected (Correction 2)
The 300 s figure comes from **Vercel docs** (https://vercel.com/docs/functions/limitations#max-duration), not from a measured function run. A 250 s function test was never run. Status: **UNMEASURED** for real long-running workloads. The docs-confirmed value is noted but real behaviour under load is unproven.

### Database — Milestones Table (observed from `lib/db/schema.ts`)
| Column | Present? |
|---|---|
| dueDate | ✅ |
| position | ✅ (integer, sort order) |
| status | ✅ |
| dependsOnId / offsetDays | ✅ (Phase 4 dependency engine) |
| captureGrossUsd / captureFeeUsd / captureNetUsd | ✅ |
| **start_date** | ❌ NOT PRESENT |
| **version** (optimistic concurrency) | ❌ NOT PRESENT |
| consultant (per-milestone) | ❌ — joined from candidates at query time |

### Phase Status — Corrected (Correction 4)
Plan uses plan numbering (Phase 1 = PayPal, Phase 2 = BriefAgent + Canvas, etc.)

| Phase (plan name) | Status |
|---|---|
| Phase 0: Foundation | ✅ COMPLETE |
| Phase 1: PayPal Sandbox Payment Flow | ✅ COMPLETE |
| Phase 2: BriefAgent + Canvas | ✅ COMPLETE — build passes; 189 pass + 3 **skipped** (not failures). The 3 skipped are the `audit_log append-only trigger (DB integration)` describe-block in `lib/db/audit.test.ts`, skipped via `describe.skipIf(!DATABASE_URL)` — DB integration tests that require a live Neon connection; they pass when run with `DATABASE_URL=... npm test`. |
| Phase 3: VettingAgent + Candidate Cards | ❌ UNVERIFIED — routes and components exist but no checkpoint evidence |
| Phase 4: NDA + Scheduling | ❌ UNVERIFIED — routes and components exist but no checkpoint evidence |
| Phase 5: DeliveryAgent + Approval Flow | ❌ UNVERIFIED — routes and components exist but no checkpoint evidence |
| Phase 6: Dispute Handling | ❌ UNVERIFIED — routes and components exist but no checkpoint evidence |

### Existing Components (observed)
| Component | Location |
|---|---|
| ChatPanel | `components/agent/ChatPanel.tsx` |
| GanttView | `components/canvas/GanttView.tsx` (@hello-pangea/dnd DnD list) |
| FinancialLedger | `components/canvas/FinancialLedger.tsx` (AG Grid 32.x Community — implemented) |
| FinancialLedgerView | `components/canvas/FinancialLedgerView.tsx` (fetch wrapper + dynamic import) |
| ApprovalCard | `components/payments/ApprovalCard.tsx` |
| VettingCard | `components/vetting/VettingCard.tsx` (trust score, matrix, evidence links, human-review notice) |
| Sonner | `components/ui/sonner.tsx` ✅ already wrapped |
| Sheet | `components/ui/sheet.tsx` (uses `@base-ui/react/dialog`) |
| Skeleton | `components/ui/skeleton.tsx` ✅ |

### Vetting Route (Correction 6 — audit)
`/api/agent/vetting/route.ts` exists and calls `lib/vetting/orchestrator.ts`. It checks role cookie, validates candidate belongs to project, and requires `vetting_consent_at IS NOT NULL`. `VettingCard.tsx` already exists. Step 4 must extend these, not create a parallel route.

### Design Tokens (observed)
- Pure monochrome — all oklch values have zero chroma (no accent)
- No motion tokens, no `prefers-reduced-motion` query

---

## Dependency Installation Protocol (BOB_RULES rule 15)
For every new package:
```bash
npm view <pkg> version peerDependencies
# pick newest version whose peer range includes React 19 and Next 16
npm install --save-exact <pkg>@<version>
next build --webpack   # must pass before continuing
```

---

## Step 1: Design System & Motion Foundation
**Status**: [ ] pending  
**Execution order**: First

**Intent**: Establish one accent colour (contrast-verified), motion preset file, Sonner token wiring, drawer decision, interactive states on Button, skeleton shimmer, and a `/dev/ui` style-guide page gated by `DEMO_MODE`.

**Accent Colour Verification (required before writing tokens)**  
Contrast ratios must be verified programmatically (report exact figures):
- Accent text on `--background` (light): target ≥ 4.5:1 for text (WCAG AA)
- Accent text on `--background` (dark): target ≥ 4.5:1
- Accent background with white text: target ≥ 4.5:1
- Large/non-text accent elements: target ≥ 3:1

Proposed accent: `oklch(0.50 0.18 255)` (mid-blue) for light; adjust for dark. Exact values set only after ratio check in code.

**Drawer Decision (Correction 8)**  
Before installing Vaul:
1. Check whether `@base-ui/react` ≥ 1.9.0 provides a bottom-sheet / drawer component (read https://base-ui.com/react/components/dialog — Dialog anchored to bottom).
2. Check what `npx shadcn add drawer` installs — does it pull in `vaul` or use `@radix-ui/react-dialog`? Run `npm view vaul version peerDependencies`.
3. If `@base-ui/react` Dialog can be positioned as a bottom sheet without extra deps, use it — no new package.
4. If Vaul is needed: pin exactly, verify peer range includes React 19, install with `--save-exact`.

**framer-motion (Correction 8)**: Keep at pinned `11.18.2`. Do not upgrade. The peer range of v11 accepts React 19 (observed from the installed working state). Only upgrade if v12+ is required for a specific feature needed here.

**Expected Outcomes**:
- `app/globals.css`: `--accent-brand` + `--accent-brand-foreground` tokens added, light and dark. Contrast ratios reported.
- `lib/motion/presets.ts`: named spring configs (`springStiff`, `springGentle`, `springMicro`), enter/exit variants, `shouldAnimate()` that returns `false` when `prefers-reduced-motion: reduce` is set
- `components/ui/sonner.tsx`: verified that existing `--normal-bg`, `--normal-text`, `--normal-border` vars resolve correctly to our palette
- `components/ui/drawer.tsx`: either Base UI Dialog positioned as sheet, or Vaul-backed — decision recorded with evidence
- `components/ui/button.tsx`: `active:scale-[0.97] transition-transform duration-150` + `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`
- `components/ui/card.tsx`: subtle `hover:shadow-md transition-shadow duration-200`
- `components/ui/skeleton.tsx`: shimmer animation via `tw-animate-css` or a single CSS keyframe — no new package
- `app/(company)/dev/ui/page.tsx`: style-guide page, **only renders when `process.env.DEMO_MODE === "true"`** (server component guard), shows: all Button variants, Card, Badge, all Skeleton variants, Sonner toast triggers, Drawer open/close, light/dark switch
- `next build --webpack` passes with zero new errors

**Todo List**:
1. Read `app/globals.css` full to confirm all existing token names
2. Write contrast-ratio verification script (pure math, no packages) — compute ratios for proposed accent, light and dark. Record exact ratios in this plan.
3. Add `--accent-brand` / `--accent-brand-foreground` to `:root` and `.dark` in `app/globals.css`
4. Add `@media (prefers-reduced-motion: reduce)` block
5. Create `lib/motion/presets.ts`
6. Check `@base-ui/react` drawer capability + `npm view vaul peerDependencies`; make drawer decision
7. Create `components/ui/drawer.tsx`
8. Update `components/ui/button.tsx` — active scale, focus ring
9. Update `components/ui/card.tsx` — hover shadow
10. Update `components/ui/skeleton.tsx` — shimmer
11. Create `app/(company)/dev/ui/page.tsx` — DEMO_MODE gated
12. Run `next build --webpack` — report exact output

**Relevant Context**:
- [`app/globals.css`](consultai/app/globals.css)
- [`components/ui/sonner.tsx`](consultai/components/ui/sonner.tsx)
- [`components/ui/button.tsx`](consultai/components/ui/button.tsx)
- [`components/ui/card.tsx`](consultai/components/ui/card.tsx)
- [`components/ui/skeleton.tsx`](consultai/components/ui/skeleton.tsx)
- [`components/ui/sheet.tsx`](consultai/components/ui/sheet.tsx)

---

## Step 2: Financial Ledger — AG Grid Theme & UX
**Status**: [ ] pending  
**Execution order**: Second (after Step 1)

**Intent**: Theme AG Grid 32.3.9 to our design tokens. Verify Community vs Enterprise features by reading the docs for the **installed version 32.3.9**.

**AG Grid 32.x Theming (Correction 7 — MUST verify before implementing)**  
AG Grid 32 introduced the "New Theming API" (CSS custom properties approach, `createTheme()` function). The legacy CSS class approach (`ag-theme-quartz`) is still supported in 32.x but deprecated.  
Docs to read before choosing:  
- Theming: https://www.ag-grid.com/react-data-grid/theming/ (confirm if this is the v32 URL)  
- Legacy theming: https://www.ag-grid.com/react-data-grid/global-style-customisation/  
Decision: use whichever approach is documented for 32.3.9 specifically.

**Community vs Enterprise (Correction 7 — MUST verify at https://www.ag-grid.com/react-data-grid/licensing/)**  
- Row Grouping (grouping rows by a column value): VERIFY — if Enterprise-only, use pinned summary row instead
- Pinned rows: VERIFY — confirm `pinnedTopRowData` is Community
- `aggFunc: "sum"` on pinned row: VERIFY — confirm works in Community without Row Grouping module

The comment in `FinancialLedger.tsx` claims row grouping is Community — this must be confirmed from docs before using it.

**Expected Outcomes**:
- AG Grid feature set documented with citations from v32.3.9 docs
- `app/globals.css`: AG Grid theme block using CSS vars (`var(--background)`, `var(--border)`, etc.), light and dark
- `FinancialLedger.tsx`: `STATUS_COLORS` replaced with CSS variable-based classes or inline CSS vars; themed grid class applied
- `dueDate` column: formatted date cell renderer
- Pinned summary row (Community-legal) OR row grouping if confirmed Community
- `consultant` column: shows "—" when null
- Light/dark mode follows `.dark` class
- `next build --webpack` passes

**Todo List**:
1. Read AG Grid v32 licensing page — document Row Grouping tier; document pinned rows tier
2. Read AG Grid v32 theming page — choose New API vs legacy
3. Add AG Grid CSS variable overrides to `app/globals.css`
4. Update `FinancialLedger.tsx` — token-based colours, date formatter, pinned summary row, consultant column
5. Update `/api/projects/[id]/ledger/route.ts` if `payoutFeeUsd` needs adding
6. Run `next build --webpack` — report result

**Relevant Context**:
- [`components/canvas/FinancialLedger.tsx`](consultai/components/canvas/FinancialLedger.tsx)
- [`app/api/projects/[id]/ledger/route.ts`](consultai/app/api/projects/[id]/ledger/route.ts)

---

## Step 3: Gantt — Bryntum Drag-to-Reschedule (after Step 4 and Step 6)
**Status**: [ ] pending  
**Execution order**: Fifth (after Steps 1, 2, 4, 6)

**Bryntum install (Correction 1)**:
```
npm install @bryntum/gantt@npm:@bryntum/gantt-trial
npm install @bryntum/gantt-react@<same-version>
```
Both on public npm. License terms: ❌ UNVERIFIED — read and quote before this step begins.

**Bryntum event**: The server action is called on `taskDrop` (fires after mouse-up), NOT `taskDrag` (fires continuously). Source: https://bryntum.com/products/gantt/docs/api/Gantt/feature/TaskDrag — UNVERIFIED; must read and cite the exact event name from that page before implementing.

**Schema Migration Protocol (Correction 5)**  
Never run `drizzle-kit push` against production.  
Correct sequence:
1. Run `drizzle-kit generate` → produces `.sql` file
2. Show SQL here for review
3. Apply to a Neon test branch first
4. After your approval, apply to production

**Columns needed** (not yet in schema):
- `milestones.start_date DATE` — for Gantt bar width and display. Store as date-only (no time, no timezone). All UTC conversion happens in one place in `lib/scheduling/date-utils.ts`.
- `milestones.version INTEGER NOT NULL DEFAULT 0` — optimistic concurrency

**What dragging changes (Correction 5)**:
Dragging a task changes its `start_date` and `due_date` (both shift by the same delta). Server-side validations:
1. Role check: company cookie required
2. Zod: `{ milestoneId: string, startDate: string (YYYY-MM-DD), dueDate: string (YYYY-MM-DD), version: number }`
3. Funded / in_payout / paid milestones: REJECT with HTTP 409
4. `dependsOnId` constraint: if this milestone has a dependency, verify `startDate >= dependency.dueDate + 1 day`
5. `offsetDays`: if another milestone depends on THIS one, do not auto-cascade (leave dependent milestones alone; show a warning toast that "X depends on this milestone — its dates were not moved")
6. Optimistic concurrency: `UPDATE milestones SET ... WHERE id=$1 AND version=$2` — if 0 rows updated, return HTTP 409 `{ error: "version_conflict" }`

**Expected Outcomes**:
- Migration SQL shown for review before application
- Feature flag `FEATURE_BRYNTUM_GANTT=true/false` env var — false uses existing `@hello-pangea/dnd` with date-picker
- Server action `/app/api/projects/[id]/milestones/reorder/route.ts`: all validations above
- Optimistic update in UI + Sonner toast + rollback on rejection
- `next build --webpack` passes
- Checkpoint: drag unfunded milestone → DB row changes + audit entry; drag funded milestone → HTTP 409 + error toast

---

## Step 4: GitHub Portfolio Verifier & Mermaid Diagram (after Step 2)
**Status**: [ ] pending  
**Execution order**: Third (after Steps 1, 2)

**Audit of existing vetting infrastructure (Correction 6)**  
Before writing any new code, audit:
- `lib/vetting/orchestrator.ts` — what signals it fetches and computes
- `lib/vetting/github-fetcher.ts` — what GitHub API calls it makes
- `lib/vetting/signals.ts` — signal types, trust score formula
- `components/vetting/VettingCard.tsx` — what it already displays
- `/api/agent/vetting/route.ts` — what it already returns

This step EXTENDS these, not adds a parallel route. The Mermaid diagram is a new subcomponent of `VettingCard` or a new `GitHubDiagram.tsx` rendered within the existing vetting page.

**Candidate Consent (Correction 6)**  
The vetting route already requires `vetting_consent_at IS NOT NULL` (observed in `/api/agent/vetting/route.ts`). The plan must document:
- Where `vetting_consent_at` is set (observed: `candidates` table — confirm column exists in schema)
- How consent is collected in the UI (observed: check `app/(company)/project/[id]/vetting/` page)
- Confirm consent is recorded in `audit_log` before any GitHub fetch

**Mermaid 12.2.0**  
Check https://mermaid.js.org/intro/changelog.html for chart types available in 12.2.0 before choosing quadrant vs flowchart — UNVERIFIED. Do not assume quadrant is available.

**Safety Rules (BOB_RULES rule 8)**:
- GitHub REST API only — no cloning, no executing code
- Read-only PAT from env (`GITHUB_PAT`)
- Cap: max 10 repos, max 50 files per repo
- ETag caching (check `If-None-Match` header before fetching)
- Rate-limit: check `x-ratelimit-remaining` header; if ≤ 5, stop and return partial result
- Human-review notice: always visible in UI
- No personal attributes in scoring
- LLM output → `GitHubSummarySchema` (Zod) → code verifies every cited URL exists in fetched data

**Expected Outcomes**:
- Audit report of existing vetting code documented here before any code is written
- Consent flow audited and documented
- `lib/vetting/github-fetcher.ts` extended (not replaced) with ETag, rate-limit, caps
- `GitHubSummarySchema` Zod schema added to `lib/vetting/llm-extraction.ts`
- `components/vetting/GitHubDiagram.tsx`: lazy Mermaid, escaped labels, `mermaid.parse()` validate before render, `securityLevel: 'strict'`, CSS var theme, text fallback, light/dark
- Hostile-content fixture test in `lib/vetting/invariants.test.ts` (extend existing file)
- `next build --webpack` passes

---

## Step 5: Render Worker (Optional — Measure First, Skip If Not Needed)
**Status**: [ ] pending  
**Execution order**: Last (skip unless Step 4 latency exceeds 60s per chunk)

**Decision gate**: Add timing instrumentation to the vetting/GitHub analysis path. If a single analysis call (10 repos cap) completes in < 30s on Vercel, document "SKIPPED — fits Vercel Hobby" and do not implement a Render worker.

If needed: verify Render free tier at https://render.com/docs/free — spin-down behaviour, cold start, background worker pricing — all UNVERIFIED.

---

## Step 6: Playwright Tests (after Steps 1, 2, 4)
**Status**: [ ] pending  
**Execution order**: Fourth (after Steps 1, 2, 4)

**Playwright Mocking Architecture (Correction 9)**  
Playwright route mocking (`page.route()`) intercepts **browser-originated requests only**. It cannot intercept server-to-PayPal or server-to-LLM calls (these happen inside Next.js API routes on the server).

Solution:
- PayPal: the PayPal base URL is read from `PAYPAL_BASE_URL` env var (default `https://api-m.sandbox.paypal.com`). In tests, set `PAYPAL_BASE_URL` to a local mock server (e.g. `http://localhost:3001`) that returns fixture JSON. The mock server is started in `playwright.config.ts` globalSetup.
- LLM: `GROQ_API_KEY` / `LLM_PROVIDER` — use a stub provider that returns fixture responses when `NODE_ENV=test`.
- **Guard**: test setup must assert `process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL` — refuse to run if equal.

**"Agent has no money tools" — Unit Test (Correction 9)**  
This is better as a **unit test** in vitest (not Playwright), since it tests code logic:
- Import the tool allowlists from `lib/brief/tools.ts` and the agent route configuration
- Assert that none of the tool names in BriefAgent, VettingAgent, NDA/SchedulingAgent match the blocked list (`capture_order`, `create_refund`, `payout`, `pay_order`, `accept_dispute_claim`, `delete_*`, `cancel_*`, `send_invoice*`)
- This can run in CI without any server (purely in-process)

**Expected Outcomes**:
- `@playwright/test` installed with `--save-exact`, Chromium only
- `playwright.config.ts`: Chromium only, baseURL from env, TEST_DATABASE_URL guard, PayPal mock server globalSetup
- Test 1: Gantt drag (or direct server action POST if Bryntum automation is unreliable — marked best-effort UI). Verifies: request made, TEST_DB row updated, audit entry exists, funded milestone → HTTP 409.
- Test 2: Approve click → payout route called exactly once → milestone state `payout_processing`. Negative: "pay now" in chat → payout route NOT called.
- Unit test (vitest): agent tool allowlists contain no money tools
- All tests pass headless. Command: `npx playwright test --project=chromium`
- `next build --webpack` passes

**Relevant Context**:
- [`lib/brief/tools.ts`](consultai/lib/brief/tools.ts)
- [`lib/payments/payment-chat-tools.ts`](consultai/lib/payments/payment-chat-tools.ts)
- [`app/api/paypal/payout/route.ts`](consultai/app/api/paypal/payout/route.ts)
