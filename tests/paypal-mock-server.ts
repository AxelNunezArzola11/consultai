/**
 * tests/paypal-mock-server.ts
 *
 * A lightweight HTTP server that stubs PayPal REST endpoints.
 * Runs in-process during Playwright global-setup and global-teardown.
 *
 * Endpoints stubbed:
 *   POST /v1/oauth2/token          → returns a fake access_token
 *   POST /v1/payments/payouts      → returns a fake 201 batch response
 *
 * The server listens on PAYPAL_MOCK_PORT (default 18080).
 * Set PAYPAL_BASE_URL=http://localhost:18080 in the test env so that
 * lib/paypal/client.ts routes all calls here instead of the real API.
 */

import * as http from "http";

export const PAYPAL_MOCK_PORT = Number(process.env.PAYPAL_MOCK_PORT ?? 18080);

// Track call counts so tests can assert "called exactly once"
export const callCounts: Record<string, number> = {};

function resetCounts() {
  for (const key of Object.keys(callCounts)) delete callCounts[key];
}

function record(path: string) {
  callCounts[path] = (callCounts[path] ?? 0) + 1;
}

let server: http.Server | null = null;

export function startPaypalMockServer(): Promise<void> {
  resetCounts();
  server = http.createServer((req, res) => {
    const path = req.url ?? "/";
    record(path);

    // Collect body (needed to parse idempotency key on payouts)
    let rawBody = "";
    req.on("data", (chunk: Buffer) => { rawBody += chunk.toString(); });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");

      // ── OAuth token ────────────────────────────────────────────────────────
      if (path === "/v1/oauth2/token" && req.method === "POST") {
        res.writeHead(200);
        res.end(JSON.stringify({
          access_token: "mock-access-token",
          token_type: "Bearer",
          expires_in: 32400,
        }));
        return;
      }

      // ── Payouts batch ──────────────────────────────────────────────────────
      if (path === "/v1/payments/payouts" && req.method === "POST") {
        res.writeHead(201);
        res.end(JSON.stringify({
          batch_header: {
            payout_batch_id: "MOCK_BATCH_001",
            batch_status: "PENDING",
            sender_batch_header: { sender_batch_id: "MOCK_SENDER_BATCH" },
          },
          links: [{ rel: "self", href: `http://localhost:${PAYPAL_MOCK_PORT}/v1/payments/payouts/MOCK_BATCH_001` }],
        }));
        return;
      }

      // ── Fallback 404 ───────────────────────────────────────────────────────
      res.writeHead(404);
      res.end(JSON.stringify({ error: "mock: not found", path, method: req.method }));
    });
  });

  return new Promise((resolve, reject) => {
    server!.listen(PAYPAL_MOCK_PORT, "127.0.0.1", () => resolve());
    server!.on("error", reject);
  });
}

export function stopPaypalMockServer(): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server!.close((err) => {
      server = null;
      if (err) reject(err); else resolve();
    });
  });
}
