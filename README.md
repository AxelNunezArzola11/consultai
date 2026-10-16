# ConsultAI

AI-assisted consultant hiring platform with milestone payments.
**PayPal "Business Solutions" track** — AI agent verifies deliverables against acceptance criteria before releasing funds.

Live demo: **https://consultai-rho.vercel.app**

## Quick start

```bash
nvm use 20          # Node 20 required (see .nvmrc)
npm install
npm run dev        # uses --webpack (required for Bryntum/Tailwind v4)
npm test           # 169 tests passing (all with DATABASE_URL, else 166)
npm run build      # next build --webpack
```

## Phase 3 — BriefAgent + Live Plan Canvas ✅ IMPLEMENTED

The BriefAgent turns a plain-language company brief into a structured milestone plan. Chat on the left; plan builds itself on the right.

### How it works

```
Company types brief at /project/new
    → POST /api/agent/brief (streamText, Groq qwen3-32b, stopWhen: stepCountIs(10))
    → System prompt hardened: user brief wrapped in <user_brief>…</user_brief> delimiters
    → Tools: askClarification (question to user) + saveStructuredBrief (DB write + audit log)
    → normalizeBriefPlan():
        • Unsupported criterion kinds → SUBJECTIVE + needsHumanApproval: true
        • Budget limits enforced (BRIEF_MIN_MILESTONE_USD / BRIEF_MAX_MILESTONE_USD)
        • At most 6 milestones
        • Total budget = sum of milestone budgets (±$0.01)
        • Input capped at BRIEF_INPUT_MAX_CHARS
    → Plan saved to projects.structured_plan (JSONB)
    → Draft saved to brief_drafts on every update (debounced 1s)
    → MilestoneCanvas: drag to reorder, inline budget edits, totals recalculated instantly
    → GanttView: timeline bar chart + draggable table (@hello-pangea/dnd)
    → Fallback: ManualPlanEditor shown if LLM fails or rate-limits
```

### Design invariants

- **No money tools in BriefAgent** — tool allowlist is `{askClarification, saveStructuredBrief}` only — asserted by test
- **Injection defense** — user brief wrapped in XML-style delimiters; `</user_brief>` stripped before wrapping
- **Unsupported criteria downgraded** — anything not in supported kinds → SUBJECTIVE + human review flag
- **Budget limits code-enforced** — server-side validation independent of LLM output
- **Total consistency** — sum of milestone budgets must equal totalBudgetUsd ±$0.01
- **Rate limit** — `BRIEF_SESSION_RATE_LIMIT` (default 10) per session per hour, backed by `brief_rate_limit` table
- **Draft persistence** — `brief_drafts` table; auto-saved on every plan update
- **Fallback** — if LLM errors, `ManualPlanEditor` pre-fills from draft or example plan; "Use example brief" button labelled demo-only

### New routes (Phase 3)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/agent/brief` | BriefAgent stream (streamText → toUIMessageStreamResponse) |
| `POST` | `/api/agent/brief-draft` | Draft upsert (debounced auto-save) |
| `GET` | `/project/new` | Split-screen new project page |

### New env vars (Phase 3)

| Variable | Default | Description |
|---|---|---|
| `BRIEF_MIN_MILESTONE_USD` | `100` | Minimum budget per milestone in USD |
| `BRIEF_MAX_MILESTONE_USD` | `50000` | Maximum budget per milestone in USD |
| `BRIEF_MAX_MILESTONES` | `6` | Hard cap on milestones (max 6) |
| `BRIEF_INPUT_MAX_CHARS` | `4000` | Max raw brief length |
| `BRIEF_SESSION_RATE_LIMIT` | `10` | LLM calls per session per hour |

### Migration (Phase 3)

```bash
DATABASE_URL=<neon-url> npx tsx lib/db/migrations/run-0003.ts
```
Adds: `projects.structured_plan` (JSONB), `brief_drafts` table, `brief_rate_limit` table.

### Tests added

23 new tests in `lib/brief/schema.test.ts`:
- Invalid LLM output rejected (Zod parse fails)
- Unsupported criteria downgraded to SUBJECTIVE + `needsHumanApproval: true`
- Total consistency enforced (±$0.01 tolerance)
- Budget min/max limits enforced
- Milestone count limit (max 6)
- `briefAgentTools` has exactly 2 tools, no money-related names
- `wrapUserBrief` strips injection attempts, enforces char limit

---

## Phase 2 — Delivery Agent

The Delivery Agent verifies a submitted GitHub PR against project acceptance criteria and proposes a payout.

### How it works

```
Freelancer submits PR URL
    → POST /api/delivery/verify
    → GitHub REST: fetch PR details, files, check-runs, reviews
    → Flag detection (WORKFLOW_FILE_MODIFIED / TEST_FILE_DELETED / DRAFT_PR / WRONG_AUTHOR)
    → Deterministic checks: ci_passes, pr_merged, required_review_approved, files_present,
                             no_workflow_or_test_tampering
    → LLM step (Groq qwen3-32b, UNTRUSTED_DATA delimiters, Zod schema, fallback on error)
    → Evidence ref validation (fabricated refs dropped)
    → Policy engine (pure code — LLM CANNOT change decision):
        AUTO_RELEASE_ELIGIBLE | REQUIRES_APPROVAL | REJECT_RECOMMENDED
    → payment_proposal created (bound to head SHA)

Company reviews in /project/[id]/delivery:
    → POST /api/delivery/propose/approve
    → SHA re-checked from GitHub — if changed: proposal SUPERSEDED, 409
    → If approved: payout triggered via existing /api/paypal/payout
```

### Design invariants

- **LLM cannot change the policy decision** — `evaluatePolicy()` is pure deterministic code
- **Injection defense** — PR body/title wrapped in `<<UNTRUSTED_DATA>>` delimiters
- **Fabricated evidence refs dropped** — `validateEvidenceRefs()` validates all LLM refs against fetched data
- **No money tools in delivery modules** — asserted by test
- **SHA bound to proposal** — re-fetched at approval; mismatch → SUPERSEDED
- **Auto-release disabled by default** — `AUTO_RELEASE_LIMIT_USD=0` fail-closed

### New routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/auth/set-role` | — | Sets signed httpOnly role cookie (demo auth) |
| `POST` | `/api/delivery/verify` | any role | Full verification run |
| `GET` | `/api/delivery/run/[runId]` | any role | Poll run status + steps + proposal |
| `POST` | `/api/delivery/propose/approve` | company | Approve/reject proposal (SHA re-check) |

### Freelancer flow

1. Navigate to `/deliver/[milestoneId]` (share link from company)
2. Enter GitHub PR URL → submit
3. Watch verification steps appear
4. Result shows policy decision + justification

### Company flow

1. Navigate to `/project/[id]/delivery`
2. See all verification runs for this project
3. Activity stream shows each step with expandable evidence
4. Approval card: criteria checklist (objective/subjective badges), flags, justification, bound SHA, Approve/Reject buttons

### Demo scenarios

Three prepared scenarios are available in the freelancer submit form (demo-only labels):
- **All green** — PR passes all checks, merged, no flags
- **Failing CI** — CI check failing
- **Workflow modified** — `.github/workflows/` file touched → WORKFLOW_FILE_MODIFIED flag raised

Requires `DELIVERY_AGENT_REPO` and `GITHUB_TOKEN` to be configured for real GitHub calls.

---

## Deploy checklist

### 1. Required environment variables

Set ALL of the following in Vercel → Settings → Environment Variables **before** deploying.
None of these have hardcoded defaults — the app will throw a clear error at startup if any are missing.

| Variable | Description | Phase |
|---|---|---|
| `APP_BASE_URL` | Stable production domain, e.g. `https://your-app.vercel.app` — no trailing slash. Used to build webhook callback URLs. Never use `VERCEL_URL` or `window.location`. | 0 |
| `DATABASE_URL` | Neon connection string (pooled) | 0 |
| `PAYPAL_ENV` | `sandbox` or `live` — controls SDK script URL and API base | 1 |
| `NEXT_PUBLIC_PAYPAL_CLIENT_ID` | PayPal Client ID (public — used in browser for SDK v6) | 1 |
| `PAYPAL_CLIENT_ID` | PayPal Client ID (server-side duplicate for API auth) | 1 |
| `PAYPAL_CLIENT_SECRET` | PayPal Client Secret (**sensitive** — Vercel will not allow read-back) | 1 |
| `PAYPAL_WEBHOOK_ID` | Bare 17-char Webhook ID from PayPal Developer Dashboard. **NOT the WH-... event id.** | 1 |
| `ROLE_COOKIE_SECRET` | Min 32 chars. Signs the role cookie. Generate: `openssl rand -hex 32` | 2 |
| `ALLOW_LIVE` | Set `true` to permit `PAYPAL_ENV=live`. Omit or set `false` to block (fail-closed guard). | 2 |
| `GITHUB_TOKEN` | Fine-grained read-only PAT — Contents/PRs/Checks read on the demo repo | 2 |
| `DELIVERY_AGENT_REPO` | `owner/repo` — restricts verification to this repo only | 2 |
| `AUTO_RELEASE_LIMIT_USD` | Auto-release limit in USD. Default `0` = disabled (fail-closed). | 2 |
| `GROQ_API_KEY` | Groq API key for LLM step. Absent = deterministic fallback used. | 2 |

> **PAYPAL_WEBHOOK_ID vs event id**: The Dashboard webhook registration ID is a bare 17-character alphanumeric string (e.g. `1A2B3C4D5E6F7G8`). PayPal webhook event IDs start with `WH-` (e.g. `WH-1234-...`). These are different. Use the bare registration ID in `PAYPAL_WEBHOOK_ID`.

### 2. Register the production webhook

After deploying to the stable production domain (`APP_BASE_URL`):

1. Go to [PayPal Developer Dashboard → My Apps → Webhooks](https://developer.paypal.com/dashboard/applications/sandbox) (sandbox) or live equivalent.
2. **Add webhook** pointing to: `$APP_BASE_URL/api/paypal/webhook`
3. Subscribe to all 7 events:
   - `PAYMENT.CAPTURE.COMPLETED`
   - `PAYMENT.PAYOUTSBATCH.PROCESSING`
   - `PAYMENT.PAYOUTSBATCH.SUCCESS`
   - `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`
   - `PAYMENT.PAYOUTS-ITEM.FAILED`
   - `PAYMENT.PAYOUTS-ITEM.RETURNED`
   - `CUSTOMER.DISPUTE.CREATED`
4. Copy the **Webhook ID** (bare 17-char value, not the event id) → set as `PAYPAL_WEBHOOK_ID` in Vercel.
5. **Delete the old ngrok webhook** (if any) from the Dashboard.
6. Redeploy after updating the env var.

### 3. Post-deploy verification

Run these curls against the **deployed domain** (not localhost):

```bash
# Should return our generic 400 (not Vercel's 401 page, not a 404)
curl -s -o /dev/null -D - \
  -X POST https://consultai-s7a6b5qdw-fabricpilot.vercel.app/api/paypal/webhook \
  -H "Content-Type: application/json" \
  -d '{}' | head -12
# Observed output (2026-10-13):
#   HTTP/2 400
#   content-type: application/json
#   x-matched-path: /api/paypal/webhook    ← confirms OUR route answered, not Vercel's error page

# Body must be our generic JSON (no reason leaked):
curl -s -X POST https://consultai-s7a6b5qdw-fabricpilot.vercel.app/api/paypal/webhook \
  -H "Content-Type: application/json" \
  -d '{}'
# Observed: {"error":"invalid request"}
```

```bash
# Should return 200 with milestone status
curl -s https://consultai-s7a6b5qdw-fabricpilot.vercel.app/api/milestone-status/milestone-1 | head -c 200
# Observed: {"milestoneId":"milestone-1","status":"pending_approval","captureGrossUsd":"800.00",...}
```

### 4. Database schema

Schema is managed by Drizzle ORM. To apply on Neon:

```bash
DATABASE_URL=<your-neon-url> npx drizzle-kit push
```

Migrations are in `lib/db/migrations/`. The `audit_log` table has DB-level triggers that reject UPDATE and DELETE — enforcing append-only at the Postgres level.

### 5. Build notes

- **Compiler**: `next build --webpack` — never remove the `--webpack` flag (required for Bryntum/Tailwind v4).
- **Node version**: `20` required (see `.nvmrc`). Vitest 4 requires Node ≥ 20. Use `nvm use 20`.
- **Tests**: `npm test` runs Vitest — 189 tests across 8 files (3 skipped DB integration). DB integration tests require `DATABASE_URL`.
- **Migration (Phase 2)**: run `npx tsx lib/db/migrations/run-0002.ts`
- **Migration (Phase 3)**: run `npx tsx lib/db/migrations/run-0003.ts`

### 6. Post-deploy curl checks (Phase 2)

```bash
BASE=https://consultai-rho.vercel.app

# 1. No role cookie → payout 403
curl -s -o/dev/null -w "%{http_code}" -X POST $BASE/api/paypal/payout \
  -H "Content-Type: application/json" -d '{"paymentId":"x","recipientEmail":"a@b.com"}'
# → 403

# 2. Set company cookie
curl -s -c /tmp/jar -X POST $BASE/api/auth/set-role \
  -H "Content-Type: application/json" -d '{"role":"company"}'
# → {"ok":true,"role":"company"}

# 3. Payout with company cookie — passes auth, 404 (no payment row)
curl -s -b /tmp/jar -X POST $BASE/api/paypal/payout \
  -H "Content-Type: application/json" -d '{"paymentId":"nonexistent","recipientEmail":"a@b.com"}'
# → {"error":"Payment not found"}

# 4. Verify route — missing milestoneId → 400
curl -s -o/dev/null -w "%{http_code}" -b /tmp/jar -X POST $BASE/api/delivery/verify \
  -H "Content-Type: application/json" -d '{}'
# → 400

# 5. Run poll — unknown runId → 404
curl -s -o/dev/null -w "%{http_code}" -b /tmp/jar $BASE/api/delivery/run/nonexistent
# → 404

# 6. Approve — missing proposalId → 400
curl -s -o/dev/null -w "%{http_code}" -b /tmp/jar -X POST $BASE/api/delivery/propose/approve \
  -H "Content-Type: application/json" -d '{}'
# → 400

# 7. Freelancer cookie → approve 403
curl -s -c /tmp/jar2 -X POST $BASE/api/auth/set-role \
  -H "Content-Type: application/json" -d '{"role":"freelancer"}'
curl -s -o/dev/null -w "%{http_code}" -b /tmp/jar2 -X POST $BASE/api/delivery/propose/approve \
  -H "Content-Type: application/json" -d '{"proposalId":"x","decision":"approved","recipientEmail":"a@b.com"}'
# → 403
```

---

## Architecture (Phase 1)

```
Company → [PayPal Orders v2] → Capture → Held (simulated) → [Approval] → [PayPal Payouts v1] → Consultant
                                    ↓
                              webhook /api/paypal/webhook
                                    ↓
                         Drizzle ORM → Neon (Postgres)
                         audit_log (append-only trigger)
                         paypal_webhook_deliveries (dedup by event_id)
```

### Webhook processing order (strict)

1. Read raw body as bytes — never parse before verifying
2. Verify RSA-SHA256 signature (local, cert cached) — generic 400 on failure (reason server-logs only)
3. Check duplicate in `paypal_webhook_deliveries` — 200 if already processed
4. Parse JSON, route to handler
5. **Record `event_id` ONLY after successful processing** — allows retry on handler errors

### State machine

```
Milestone: planned → funded → pending_approval → verifying → paid
                                                           → failed
                                                           → returned
           funded  → disputed → paid
```

### Money amounts

All stored as Postgres `DECIMAL(10,2)`. Columns:
- `payments.gross_usd` — company paid
- `payments.fee_usd` — PayPal Orders processing fee
- `payments.net_usd` — platform receives (basis for payout)
- `payments.payout_fee_usd` — PayPal Payout item fee (UNVERIFIED in webhook payload; observed in batch GET: $0.25 on $1.00)

---

## Cleanup note (after Phase 1 sign-off)

Before Phase 2:
- Remove old ngrok webhook from PayPal Dashboard if not already done
- Remove demo seed rows from `milestones` table that have no corresponding `payments` row (milestone-2 "Backend API")
- The `MilestonePaymentPanel` component is superseded by `MoneyFlowPanel` — can be deleted
- Check Neon connection pool settings for production load (currently using default pooled URL)

---

## Phase 5 — Vetting Agent + Trust Score + Can/Can't-Do Matrix ✅ IMPLEMENTED

The VettingAgent gathers evidence from public sources, computes a transparent trust score, and builds a can/can't-do matrix per candidate.

### How it works

```
Company views candidates at /project/[id]/vetting
    → Candidate consent gate (vetting_consent_at must be set first)
    → POST /api/agent/vetting (per-candidate)
        → fetchGitHubRepos (github.com API, read-only)
        → safeFetch(portfolioUrl) (SSRF-protected, HTTPS-only, size-limited)
            LinkedIn URLs: display-only, NEVER fetched
        → extractSignals (LLM: Groq qwen3-32b, UNTRUSTED_CONTENT delimiters)
            → verifyQuotedExcerpts: fabricated excerpts dropped before any signal is created
        → computeTrustScore: Σ(weight_i × confidence_i) / Σ(weight_i) — pure code
        → buildMatrix: requirements × signals → can/partial/unknown/no (unknown = no evidence)
        → signals persisted to DB (cache-by-hash: skip re-extraction if content unchanged)
        → candidate.trustScore + canDo + cannotDo updated

VettingCard UI:
    → Trust score (0–100) with colored ring
    → "How this is scored" panel (weights shown)
    → Can/can't-do matrix (full, collapsible)
    → Evidence signals with source links + quoted excerpts
    → Human-review notice (always visible)
    → Side-by-side compare (2 candidates)
    → Shortlist → feeds Phase 4 pipeline
    → Re-run vetting button
```

### Design invariants

- **Trust score computed by CODE, never LLM** — `computeTrustScore()` is a pure deterministic function; LLM only extracts facts
- **Fabricated excerpts dropped** — `verifyQuotedExcerpts()` checks every LLM-quoted excerpt exists verbatim in fetched content
- **LinkedIn never fetched** — `LinkedInBlockedError` thrown before any network call; displayed as link only
- **SSRF protection** — HTTPS-only; localhost, private ranges (10.x, 172.16-31.x, 192.168.x), link-local (169.254.x), metadata address (169.254.169.254), IPv6 loopback/link-local, IPv4-mapped IPv6, redirects all blocked
- **Protected attributes never scored** — name, photo, gender, age, nationality, location not in Signal interface; asserted by test
- **"Unknown" never inferred** — `buildMatrix()` uses "unknown" only when zero signals exist for a requirement
- **Deterministic fallback** — if GROQ_API_KEY absent or LLM error, zero signals produced; matrix shows "unknown"; score = 0
- **Cache-by-hash** — signals cached by content_hash; re-extraction skipped if content unchanged
- **Signals link to source** — every signal has sourceUrl; every quoted excerpt is verified

### New routes (Phase 5)

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/agent/vetting` | company | Run vetting for a candidate |
| `PUT` | `/api/agent/vetting` | — | Record candidate consent |
| `POST` | `/api/candidates/shortlist` | company | Shortlist a candidate → feeds Phase 4 |
| `GET` | `/api/candidates/search` | — | Postgres full-text search over candidates |
| `GET` | `/project/[id]/vetting` | company | Vetting dashboard (cards, matrix, compare, search) |

### New env vars (Phase 5)

No new required env vars. `GITHUB_TOKEN`/`GITHUB_PAT` and `GROQ_API_KEY` from Phase 2 are reused.

### Migration (Phase 5)

```bash
DATABASE_URL=<neon-url> npm run migrate:0005
# Adds: signals table, vetting_consent_at/vetting_ran_at columns, search_vector tsvector column + trigger
```

### Seed (Phase 5)

```bash
npm run seed            # creates company, project, 3 candidates
npm run seed:vetting    # seeds signals + consent; attempts 1 live GitHub lookup
```

### Tests added (Phase 5)

| File | Tests | Coverage |
|---|---|---|
| `lib/vetting/signals.test.ts` | 24 | Score formula, matrix, determinism, protected attrs |
| `lib/vetting/ssrf-safe-fetch.test.ts` | 39 | All SSRF cases, LinkedIn blocked, redirects |
| `lib/vetting/llm-extraction.test.ts` | 21 | Fabricated quotes, fallback, injection defense |
| `lib/vetting/invariants.test.ts` | 39 | All 7 required invariants combined |
| **Phase 5 total** | **123** | — |
| **Cumulative total** | **373** | (3 DB integration skipped without DATABASE_URL) |

### Post-deploy curl checks (Phase 5)

```bash
BASE=https://consultai-rho.vercel.app

# 1. Vetting endpoint — no role cookie → 403
curl -s -o/dev/null -w "%{http_code}" -X POST $BASE/api/agent/vetting \
  -H "Content-Type: application/json" -d '{"candidateId":"x","projectId":"y"}'
# → 403

# 2. Set company cookie
curl -s -c /tmp/jar -X POST $BASE/api/auth/set-role \
  -H "Content-Type: application/json" -d '{"role":"company"}'
# → {"ok":true,"role":"company"}

# 3. Vetting with company cookie — missing candidate → 404
curl -s -b /tmp/jar -X POST $BASE/api/agent/vetting \
  -H "Content-Type: application/json" -d '{"candidateId":"nonexistent","projectId":"project-1"}'
# → {"error":"Candidate not found"}

# 4. Shortlist — no cookie → 403
curl -s -o/dev/null -w "%{http_code}" -X POST $BASE/api/candidates/shortlist \
  -H "Content-Type: application/json" -d '{"candidateId":"candidate-1","projectId":"project-1"}'
# → 403

# 5. Search — no query → all candidates
curl -s "$BASE/api/candidates/search?projectId=project-1" | head -c 200
# → {"results":[...],"query":null}

# 6. Search with query
curl -s "$BASE/api/candidates/search?projectId=project-1&q=React" | head -c 200
# → {"results":[...],"query":"React","method":"fts"}
```

