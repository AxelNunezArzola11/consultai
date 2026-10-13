# ConsultAI

AI-assisted consultant hiring platform with milestone payments.

## Phase 1 — Milestone Payments (PayPal sandbox)

### Quick start

```bash
npm install
npm run dev        # uses --webpack (required for Bryntum/Tailwind v4)
npm test           # unit tests (89 passing, 3 DB integration tests need DATABASE_URL)
npm run build      # next build --webpack
```

---

## Deploy checklist

### 1. Required environment variables

Set ALL of the following in Vercel → Settings → Environment Variables **before** deploying.
None of these have hardcoded defaults — the app will throw a clear error at startup if any are missing.

| Variable | Description |
|---|---|
| `APP_BASE_URL` | Stable production domain, e.g. `https://your-app.vercel.app` — no trailing slash. Used to build webhook callback URLs. Never use `VERCEL_URL` or `window.location`. |
| `DATABASE_URL` | Neon connection string (pooled) |
| `PAYPAL_ENV` | `sandbox` or `live` — controls SDK script URL and API base |
| `NEXT_PUBLIC_PAYPAL_CLIENT_ID` | PayPal Client ID (public — used in browser for SDK v6) |
| `PAYPAL_CLIENT_ID` | PayPal Client ID (server-side duplicate for API auth) |
| `PAYPAL_CLIENT_SECRET` | PayPal Client Secret (**sensitive** — Vercel will not allow read-back) |
| `PAYPAL_WEBHOOK_ID` | Bare 17-char Webhook ID from PayPal Developer Dashboard. **NOT the WH-... event id.** |

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
  -X POST https://your-app.vercel.app/api/paypal/webhook \
  -H "Content-Type: application/json" \
  -d '{}' | head -12
# Expected: HTTP/2 400  +  {"error":"invalid request"}
```

```bash
# Should return 200 with milestone status
curl -s https://your-app.vercel.app/api/milestone-status/milestone-1 | head -c 200
```

### 4. Database schema

Schema is managed by Drizzle ORM. To apply on Neon:

```bash
DATABASE_URL=<your-neon-url> npx drizzle-kit push
```

Migrations are in `lib/db/migrations/`. The `audit_log` table has DB-level triggers that reject UPDATE and DELETE — enforcing append-only at the Postgres level.

### 5. Build notes

- **Compiler**: `next build --webpack` — never remove the `--webpack` flag (required for Bryntum/Tailwind v4).
- **Node version**: 20 required (drizzle-kit fails on Node < 18).
- **Tests**: `npm test` runs Vitest. DB integration tests in `lib/db/audit.test.ts` require `DATABASE_URL` and are skipped without it.

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
