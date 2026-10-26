# ConsultAI

ConsultAI is an enterprise AI-powered project-management and **Pay on Delivery**
platform. It combines AI-assisted project planning, consultant vetting,
milestone-based delivery verification, and controlled payment workflows so that
companies can manage work from brief through verified payout.

The application is built as a Next.js web platform. Its planning workspace
combines a high-performance AG Grid backlog with a Bryntum Gantt scheduling
engine, while server-side AI agents use Groq through the Vercel AI SDK.

## Platform capabilities

- **AI-assisted project planning** — turn natural-language requests into
  structured scheduling actions.
- **Visual project planning** — manage work breakdown structures, dates,
  durations, dependencies, progress, and critical paths in Bryntum Gantt.
- **Unscheduled-task backlog** — review and drag tasks from AG Grid into the
  project timeline.
- **Consultant vetting** — collect evidence and calculate transparent trust
  signals for candidate decisions.
- **Delivery verification** — evaluate GitHub pull requests against milestone
  acceptance criteria and produce an auditable trust score.
- **Pay on Delivery** — release milestone payments through PayPal only after
  the configured delivery and approval workflow permits it.
- **Auditability and policy controls** — keep decisions, state transitions,
  webhook deliveries, and payment events behind server-side validation.

## Technology stack

| Area | Technology |
|---|---|
| Application framework | Next.js 16 with React 19 and TypeScript |
| Planning backlog | AG Grid Community 32 |
| Scheduling engine | Bryntum Gantt 7.3 with the React wrapper |
| AI orchestration | Vercel AI SDK |
| AI provider | Groq |
| Database | Neon Postgres through Drizzle ORM |
| Payments | PayPal REST APIs, Orders, Payouts, and webhooks |
| Source-control integration | GitHub REST API and signed GitHub webhooks |
| CI/CD integration | GitHub Actions-compatible repository automation and GitHub webhook workflows |
| UI | Tailwind CSS, Base UI, Lucide icons, React Markdown |
| Testing | Vitest and Playwright |
| Deployment target | Vercel-compatible Next.js deployment |

The repository currently contains GitHub integration and webhook handlers. CI
workflow files can be added under `.github/workflows/` according to the
deployment environment; the application does not treat browser-side GitHub
events as trusted.

## Architecture

### Request and rendering boundaries

The `/planning` route is rendered by
[`app/(company)/planning/page.tsx`](./app/(company)/planning/page.tsx). The
server page shapes serializable task and dependency props, then renders
[`PlanningLayout.tsx`](./components/bryntum-gantt/PlanningLayout.tsx), a client
component.

Bryntum imports are isolated to the Gantt component tree. The page uses a
dynamic `ssr: false` import for
[`BryntumGantt.tsx`](./components/bryntum-gantt/BryntumGantt.tsx), preventing
browser-only scheduling code from executing during server rendering.

At a high level:

```text
Planning page (server)
  └── PlanningLayout (client orchestrator)
      ├── UnscheduledTasksGrid (AG Grid backlog)
      └── BryntumGantt (dynamic browser-only chart)
          └── GanttChatPanel (AI scheduling UI)
```

### Split-screen planning architecture

The planning workspace is intentionally divided into two cooperating surfaces:

#### AG Grid: high-performance backlog

[`UnscheduledTasksGrid.tsx`](./components/bryntum-gantt/UnscheduledTasksGrid.tsx)
renders the local `unscheduledTasks` collection. Each row has a stable ID,
task name, priority, and estimated duration. AG Grid's `getRowId` maps the
rendered row to the underlying task, allowing the cross-component drag helper
to resolve the original task safely instead of passing a DOM row or grid node
into Bryntum.

AG Grid is the source of truth for tasks that have not yet been placed on the
timeline. Removing an item from the React array causes AG Grid to re-render and
remove that row without a page reload.

#### Bryntum Gantt: scheduling engine and WBS manager

[`BryntumGantt.tsx`](./components/bryntum-gantt/BryntumGantt.tsx) owns the
browser-only Gantt widget and its project configuration. Bryntum manages the
visual timeline, task hierarchy/WBS, dependencies, date calculations, editing,
critical-path features, and transactional undo/redo behavior.

The component receives serializable task and dependency data. Mutations are
sent directly to the active project's `taskStore`; Bryntum creates its own
`TaskModel` instances from normalized plain objects.

## Planning state mutation and render cycle

Both drag-and-drop and AI scheduling use the same normalized mutation path in
`PlanningLayout`:

1. **Identify the task.** The drag handler resolves the AG Grid row ID; the AI
   handler resolves the `taskId` returned by the `scheduleTask` tool.
2. **Validate local availability.** The ID must still exist in the current
   `unscheduledTasks` collection held in `unscheduledRef`.
3. **Normalize task data.** Only serializable task fields are copied:
   `id`, `name`, `startDate`, `duration`, `percentDone`, and `parentId`.
   Raw DOM elements, AG Grid row nodes, and internal model objects are never
   passed to Bryntum.
4. **Insert into Bryntum.** The normalized object is passed to
   `ganttRef.current.instance.project.taskStore.add()`. Bryntum constructs
   the corresponding task model and updates the timeline in place.
5. **Remove from the backlog.** After a successful store insertion,
   `setUnscheduledTasks()` filters the task out of React state. AG Grid observes
   the new array and removes the row.
6. **Render without navigation.** React re-renders the backlog while Bryntum
   refreshes its project/timeline state. No page reload or route transition is
   required.

This sequence keeps the two UI surfaces consistent while respecting each
library's data model. The same `scheduleTask()` callback is used by the
DragHelper drop handler and by AI tool execution.

### Drag-and-drop flow

`PlanningLayout` creates a Bryntum `DragHelper` after the split-screen DOM is
ready:

- `.ag-row` is the drag source.
- The right-hand `.gantt-drop-zone` is the primary drop zone, with Bryntum
  wrapper fallbacks `.b-gantt` and `.b-gridbase`.
- The drag listener explicitly marks the context valid while the pointer is
  inside the right panel.
- The drop handler computes a start date from the pointer's Gantt coordinate,
  calls `scheduleTask()`, and removes the row only after insertion succeeds.

The Gantt root is also constrained with `min-width: 0` and `overflow: hidden`
through the flex hierarchy, allowing Bryntum's internal horizontal scrollbars
to handle timeline width rather than creating page-level overflow.

## AI Copilot and function calling

The planning chat is rendered by
[`GanttChatPanel.tsx`](./components/bryntum-gantt/GanttChatPanel.tsx). It
provides a dark, rounded interface with Markdown rendering for assistant
responses and sends the user's natural-language request to the
`onAiMessage` callback.

The callback in `PlanningLayout` calls:

```text
POST /api/ai/planning
```

implemented by
[`app/api/ai/planning/route.ts`](./app/api/ai/planning/route.ts).

The route:

1. Validates the message and available task list with Zod.
2. Includes the current unscheduled task IDs and names in the model context.
3. Creates a Groq model through `@ai-sdk/groq`.
4. Exposes the `scheduleTask` tool with:
   - `taskId`
   - `targetStartDate` (`YYYY-MM-DD`)
5. Returns assistant Markdown plus structured tool calls.

The client processes returned `scheduleTask` calls and invokes the same
`scheduleTask()` state mutation used by drag-and-drop. The response is then
shown in `GanttChatPanel`, including a short scheduling confirmation.

The model is instructed to schedule only tasks present in the supplied
available-task list. The client performs a second lookup before mutation, so a
stale or fabricated task ID cannot be inserted into the Gantt store.

## Delivery verification and Pay on Delivery

ConsultAI connects engineering delivery evidence to milestone payment
decisions:

1. A GitHub pull-request or push webhook is received at
   [`app/api/github/webhook/route.ts`](./app/api/github/webhook/route.ts).
2. The webhook signature is verified when `GITHUB_WEBHOOK_SECRET` is
   configured.
3. The active milestone and its acceptance criteria are loaded from Neon
   Postgres.
4. GitHub pull-request files and check data are evaluated using deterministic
   checks plus a Groq-backed acceptance evaluator.
5. A trust score is calculated from passed criteria. A score at or above
   `MILESTONE_EVAL_THRESHOLD` can advance the milestone to `submitted`.
6. The webhook writes an audit entry. It does not move money directly.
7. The company approval and delivery workflow can then authorize the PayPal
   payout through the dedicated payment routes.

The PayPal webhook handler
[`app/api/paypal/webhook/route.ts`](./app/api/paypal/webhook/route.ts)
verifies PayPal signatures, records deliveries idempotently, applies
milestone/payment state-machine transitions, and records relevant audit data.
This keeps external payment events authoritative and protects against
duplicate or out-of-order webhook delivery.

## Repository structure

```text
app/
  (company)/planning/       Planning route and server-side prop shaping
  api/ai/planning/          Groq scheduling agent
  api/agent/                Brief, vetting, harness, and payment agents
  api/delivery/             Delivery verification and payout proposals
  api/github/webhook/       Signed GitHub delivery evaluation
  api/paypal/               PayPal orders, payouts, disputes, and webhooks
components/
  bryntum-gantt/            Split planning UI, Gantt, backlog, and chat
  agent/                    General AI chat and agent surfaces
  payments/                 Payment-related UI
lib/
  db/                       Drizzle schema, migrations, and audit helpers
  paypal/                   PayPal client and webhook verification
  delivery/                 Delivery policy and LLM evaluation
  brief/                    Brief schemas and agent tools
  vetting/                  Candidate and GitHub evidence utilities
docs/                       Product, UI, and implementation documentation
.github/skills/             Repository-specific engineering guidance
```

## Local development

### Requirements

- Node.js 20 or newer
- npm
- A Neon Postgres database for persistence-backed features
- Groq credentials for live AI responses
- PayPal sandbox credentials for payment testing
- GitHub credentials and webhook configuration for delivery verification

### Setup

```bash
npm install
cp .env.example .env.local  # if the example file is present in your checkout
npm run dev
```

The development server uses the Webpack Next.js pipeline:

```bash
npm run dev
```

This is required by the Bryntum and Tailwind integration in the current
project configuration.

### Common commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start the local Next.js development server |
| `npm run build` | Create a production build |
| `npm run start` | Start the production server |
| `npm run typecheck` | Run TypeScript without emitting files |
| `npm run lint` | Run ESLint |
| `npm test` | Run the Vitest suite |
| `npm run test:watch` | Run Vitest in watch mode |
| `npm run db:generate` | Generate Drizzle migrations |
| `npm run db:push` | Push the current Drizzle schema |
| `npm run db:studio` | Open Drizzle Studio |

## Configuration

The exact required set depends on the feature being exercised. Common
server-side variables include:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string |
| `GROQ_API_KEY` | Groq API authentication for AI agents |
| `LLM_GROQ_MODEL` | Optional Groq model override |
| `APP_BASE_URL` | Canonical public application URL |
| `GITHUB_TOKEN` / `GITHUB_PAT` | GitHub API access for delivery evidence |
| `GITHUB_WEBHOOK_SECRET` | HMAC secret for GitHub webhook verification |
| `MILESTONE_EVAL_THRESHOLD` | Trust-score threshold for milestone submission |
| `PAYPAL_ENV` | `sandbox` or explicitly enabled `live` mode |
| `PAYPAL_CLIENT_ID` | Server-side PayPal client ID |
| `PAYPAL_CLIENT_SECRET` | Server-side PayPal client secret |
| `PAYPAL_WEBHOOK_ID` | PayPal webhook registration ID |
| `NEXT_PUBLIC_PAYPAL_CLIENT_ID` | Browser-visible PayPal SDK client ID |
| `ROLE_COOKIE_SECRET` | Secret used to sign the demo role cookie |
| `ALLOW_LIVE` | Explicit opt-in required for live PayPal calls |

Never commit secrets. Use local environment files for development and the
deployment platform's secret manager for hosted environments.

## Security and reliability principles

- Validate external request bodies before use.
- Verify GitHub and PayPal webhook authenticity.
- Treat GitHub and pull-request content as untrusted data.
- Keep policy decisions in deterministic server-side code rather than trusting
  model output.
- Use explicit payment state machines and idempotent webhook handling.
- Do not pass DOM nodes, AG Grid row nodes, or internal Bryntum models across
  the planning mutation boundary.
- Fail closed when required credentials or verification data are unavailable.
- Keep audit logging alongside milestone and payment transitions.

## Testing and release checks

Before opening a pull request or deploying:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

For payment and webhook changes, also exercise signature validation,
duplicate-delivery handling, state transitions, and sandbox payment flows.
For planning changes, verify both drag-and-drop and AI scheduling paths:

1. Drag an AG Grid row into the Gantt panel.
2. Confirm the row disappears from the backlog.
3. Confirm the task appears on the Bryntum timeline.
4. Ask the AI Copilot to schedule another available task.
5. Confirm the AI response and the same two-pane state transition.

## License and third-party components

ConsultAI uses third-party components whose licenses and trial terms apply,
including Bryntum Gantt and PayPal services. Review the corresponding vendor
agreements before production distribution or commercial deployment.
