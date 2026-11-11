# ConsultAI

**ConsultAI** is an enterprise **AI-powered project-management and Pay on Delivery** platform. It takes work from brief to verified payout: AI agents plan the project, vet consultants, verify milestone delivery against GitHub evidence, and release milestone payments through PayPal — with every financial step gated by deterministic policy checks and human approval.

> **Stack at a glance:** Next.js 16 + React 19 + TypeScript · Python FastAPI multi-agent backend · Groq LLMs via the Vercel AI SDK · Neon Postgres (Drizzle ORM) · PayPal Sandbox · GitHub webhooks · Bryntum Gantt · AG Grid

---

## ⚠️ Important Testing Note (READ BEFORE TESTING)

> ### 🚨 CRITICAL — GitHub Milestone Verification
>
> **To successfully test the GitHub Milestone verification feature, you MUST register a NEW freelancer account in the app using the EXACT GitHub username that you will use to submit the Pull Request.**
>
> Delivery verification matches the Pull Request author against the freelancer's registered GitHub username. If the names differ, verification will fail.

---

## ✨ Key Features

- **🤖 AI-supervised project delivery** — a Central Supervisor Agent routes work across specialist agents for planning, talent, delivery, finance, and rescheduling.
- **📅 Visual planning workspace** — an AG Grid backlog feeding a Bryntum Gantt scheduling engine with WBS, dependencies, and critical-path analysis.
- **🧑‍💼 Consultant vetting with Trust Scores** — transparent, evidence-backed trust signals computed from real GitHub portfolio data.
- **✅ Delivery verification** — GitHub Pull Requests are evaluated against milestone acceptance criteria to produce an auditable verification result.
- **💰 Pay on Delivery** — escrow funds are captured via PayPal Sandbox and milestone payouts are released only after deterministic AI verification plus human approval.
- **📊 Operational Command Center** — high-performance grids over consultant pipelines, escrow ledgers, and multi-agent execution logs.
- **🔒 Auditability by design** — append-only audit records for milestone transitions, webhook deliveries, and payment events.

---

## 🚀 Setup Instructions

Follow these steps to run the project locally.

### Prerequisites

- **Node.js 20+** and **npm**
- **Python 3.11+** (for the FastAPI multi-agent backend)
- A **Neon Postgres** database (connection string)
- A **Groq API key** (for live AI responses)
- **PayPal Sandbox** credentials — Client ID, Client Secret, and Webhook ID (for payment testing)
- **GitHub** personal access token + webhook secret (for delivery verification)

### 1. Install frontend dependencies

```bash
npm install
```

### 2. Configure environment variables

Copy the template and fill in your own values:

```bash
cp .env.example .env.local
```

Key variables in `.env.local`:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string |
| `GROQ_API_KEY` | Groq API authentication for AI agents |
| `BACKEND_API_URL` | URL of the FastAPI backend (default `http://localhost:10000`) |
| `INTERNAL_API_SECRET` | Shared secret between Next.js and the FastAPI backend |
| `PAYPAL_ENV` | `sandbox` for testing |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | PayPal Sandbox API credentials |
| `PAYPAL_WEBHOOK_ID` | PayPal webhook registration ID |
| `NEXT_PUBLIC_PAYPAL_CLIENT_ID` | Browser-visible PayPal SDK client ID |
| `GITHUB_TOKEN` | GitHub API access for delivery evidence |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for GitHub webhook verification |
| `MILESTONE_EVAL_THRESHOLD` | Trust-score threshold for milestone submission |
| `ROLE_COOKIE_SECRET` | Secret used to sign the demo role cookie |
| `APP_BASE_URL` | Canonical app URL (default `http://localhost:3000`) |

> 🔐 **Never commit secrets.** Use `.env.local` for development and your hosting provider's secret manager in production.

### 3. Set up the database

```bash
npm run db:push
```

### 4. Start the FastAPI backend (multi-agent orchestration)

```bash
pip install -r requirements.txt
uvicorn backend.main:app --host 0.0.0.0 --port 10000
```

The backend exposes the agent orchestrator, GitHub webhook verification, payout policy checks, and health probes (`GET /health`, `GET /ready`).

### 5. Start the development server

```bash
npm run dev
```

Then open **http://localhost:3000** in your browser.

> ℹ️ The dev server runs on the **Webpack** Next.js pipeline (`next dev --webpack`), as required by the Bryntum Gantt integration.

### Common commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start the local Next.js development server |
| `npm run build` | Create a production build |
| `npm run start` | Start the production server |
| `npm run typecheck` | Run TypeScript without emitting files |
| `npm run lint` | Run ESLint |
| `npm test` | Run the Vitest suite |

---

## 🤖 AI Integration

AI is the operating core of ConsultAI — not a chatbot bolted on the side. A coordinated **multi-agent architecture** (Python FastAPI backend + Next.js) powered by **Groq models via the Vercel AI SDK** drives planning, vetting, verification, and scheduling, while **deterministic server-side policies** keep every decision auditable and every payment human-gated.

### 🧠 Central Supervisor Agent

- Implemented in `backend/orchestrator/supervisor.py` (+ `backend/orchestrator/workflow.py`).
- **Classifies** each incoming request and **routes** it to the right specialist agent with structured context.
- **Validates** agent outputs against deterministic business policies before anything is applied.
- **Tracks** token consumption and execution duration for every run (visible in the AI Operations Center at `/ai-ops` with live SSE updates).
- **Halts at Human Approval Gates** for sensitive financial or schedule operations — the AI can propose, but never unilaterally authorize transfers or bypass approval.

### 📋 Planning Copilot

- Implemented in `backend/agents/planning.py`, served to the UI through `POST /api/ai/planning` (`app/api/ai/planning/route.ts`).
- Turns **natural-language requests into structured scheduling actions** via function calling (e.g. the `scheduleTask` tool with `taskId` + `targetStartDate`).
- Generates **WBS task breakdowns, dependencies, timeline estimates, critical paths, project risks**, and Bryntum-ready Gantt task structures.
- The client re-validates every proposed task ID against the live backlog before mutating the timeline, so stale or fabricated IDs can never corrupt the schedule.

### 🔍 Talent Vetting with Trust Scores

- Implemented in `backend/agents/talent.py` with GitHub evidence utilities under `lib/vetting/`.
- Evaluates consultant profiles against **real GitHub repository signals** — never fabricating verification evidence.
- Computes a transparent **Trust Score** from passed evidence checks, with cited sources and an always-visible human-review notice.
- Vetting runs only after recorded candidate consent, and every cited URL is verified against actually fetched data.

### 🔄 Reschedule Copilot

- Implemented in `backend/agents/reschedule.py`, acting on the Bryntum scheduling engine.
- Analyzes **project delays**, propagates Finish-to-Start shifts across unlocked milestones, and detects **resource and dependency conflicts**.
- Produces **validated Bryntum scheduling proposals** (start/due-date shifts with optimistic-concurrency protection) that a human reviews before anything moves.
- Funded, in-payout, or paid milestones are **rejected from rescheduling** — the copilot fails closed to protect money in flight.

> 🛡️ **Safety rule across all agents:** model output is always *advisory*. Policy decisions live in deterministic server-side code (`backend/policies/`, `lib/delivery/`, `lib/payments/`), and external content (GitHub PRs, webhooks) is always treated as untrusted input.

---

## 💳 PayPal Integration

ConsultAI uses **PayPal Sandbox** end-to-end for its **Pay on Delivery** escrow model:

1. **Escrow capture** — when a milestone is funded, the platform captures the escrow amount through the **PayPal Orders API** in Sandbox mode. Funds are held against the milestone — not paid out.
2. **Deterministic AI verification** — when the freelancer submits delivery, a GitHub PR webhook triggers the Delivery Agent (`backend/agents/delivery.py`), which evaluates the PR against the milestone's acceptance criteria using deterministic checks plus a Groq-backed evaluator, producing an auditable **trust score**.
3. **Automatic payout release** — when the trust score meets the configured threshold (`MILESTONE_EVAL_THRESHOLD`) and the company approves, the platform **automatically releases the milestone payout** through the **PayPal Payouts API**.
4. **Webhook truth** — the PayPal webhook handler (`app/api/paypal/webhook/route.ts`) verifies signatures, records deliveries idempotently, and applies milestone/payment state-machine transitions, so duplicate or out-of-order events can never double-pay.
5. **Six-stage financial security policy** — AI assessment (advisory only) → deterministic rule validation → explicit human authorization → actual PayPal transaction → confirmation (`payout_batch_id`) → persistent append-only audit record (`backend/policies/payments.py`, `lib/payments/payment-chat-tools.ts`, `app/api/paypal/payout/route.ts`).

Live mode is **opt-in only**: `PAYPAL_ENV=sandbox` by default, and production calls additionally require `ALLOW_LIVE=true`.

---

## 🧩 Sponsors & Tools Integrations

### ▲ Render

**Render** is our robust **PaaS infrastructure**: it hosts the application, securely manages API webhooks (GitHub delivery events and PayPal payment notifications), and ensures the stable orchestration of our multi-agent AI workflows. The FastAPI backend deploys as a Render web service (`render.yaml`) with managed environment secrets (`GROQ_API_KEY`, `PAYPAL_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`, `INTERNAL_API_SECRET`), health-check probes (`/health`, `/ready`), and CORS-locked origins — so agent execution, webhook ingestion, and payout policy checks stay reliable around the clock.

### 📊 Bryntum Gantt

**Bryntum Gantt** powers our **interactive scheduling engine**. It visualizes the project's **Work Breakdown Structure (WBS)** — hierarchy, dates, durations, dependencies, progress, and critical paths — on a transactional timeline with undo/redo. From the planning workspace (`/planning`), users drag backlog tasks onto the chart or **trigger the AI Copilot to calculate critical paths and generate rescheduling proposals**, which land on the timeline only after validation. Bryntum is isolated to a browser-only component tree (`components/bryntum-gantt/`, dynamically imported with `ssr: false`) to keep server rendering clean.

### ⚡ AG Grid

**AG Grid** acts as our high-performance **Operational Command Center**. It empowers managers to **sort, filter, and edit massive relational datasets with zero latency**: the unscheduled-task backlog feeding the Gantt chart, the 7-domain enterprise operations grids at `/operations` (**consultant pipelines, escrow ledgers**, tasks, companies, contracts, payments, and **multi-agent execution logs**), and the financial ledger with themed Community-tier features. Stable row IDs bind every rendered row to its underlying record, keeping grid state and timeline state perfectly in sync.

---

## 🗺️ Repository Structure

```text
app/
  (company)/planning/       Planning route and server-side prop shaping
  api/ai/planning/          Groq scheduling agent endpoint
  api/agent/                Brief, vetting, harness, and payment agents
  api/delivery/             Delivery verification and payout proposals
  api/github/webhook/       Signed GitHub delivery evaluation
  api/paypal/               PayPal orders, payouts, disputes, and webhooks
backend/
  orchestrator/             Central Supervisor Agent + workflow engine
  agents/                   Planning, Talent, Delivery, Finance, Reschedule
  policies/                 Deterministic payment and permission policies
components/
  bryntum-gantt/            Split planning UI: backlog + Gantt + AI chat
  operations/               AG Grid enterprise operations grids
  agent/                    General AI chat and agent surfaces
  payments/                 Payment-related UI (approvals, ledger)
lib/
  db/                       Drizzle schema, migrations, and audit helpers
  paypal/                   PayPal client and webhook verification
  delivery/                 Delivery policy and LLM evaluation
  vetting/                  Candidate and GitHub evidence utilities
render.yaml                 Render PaaS deployment definition
requirements.txt            Python backend dependencies
```

---

## 📄 License

This project is licensed under the **MIT License** — an [OSI-approved](https://opensource.org/licenses/MIT) open-source license. See the [LICENSE](./LICENSE) file for the full text.

> **Third-party components:** this project integrates third-party services and libraries (including Bryntum Gantt trial packages and PayPal services) whose own licenses and terms apply. Review the corresponding vendor agreements before production distribution or commercial deployment.
