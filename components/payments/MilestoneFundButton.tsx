"use client";

/**
 * PayPal SDK v6 — Fund Milestone button
 *
 * SDK v6 flow (verified Spike 1b):
 *   1. Load script: https://www.{sandbox.}paypal.com/web-sdk/v6/core
 *   2. createInstance({ clientId, components: ["paypal-payments"] })
 *   3. createPayPalOneTimePaymentSession({ onApprove, onCancel, onError })
 *   4. paymentSession.start({ presentationMode: "auto" }, createOrderPromise())
 *      - createOrderPromise resolves to { orderId: string } (NOT a bare string like v5)
 *
 * Docs:
 *   SDK v6 setup:        https://developer.paypal.com/sdk/js/set-up/
 *   createInstance:      https://developer.paypal.com/sdk/js/reference/#createinstance
 *   createPayPalOneTimePaymentSession:
 *                        https://developer.paypal.com/sdk/js/reference/#sdkinstancecreatepaypalonetimepaymentsessionoptions
 *   paymentSession.start: https://developer.paypal.com/sdk/js/reference/#paymentsessionstartoptions-orderpromise
 */

import Script from "next/script";
import { useRef, useState, useCallback } from "react";
import { toast } from "sonner";

// ── PayPal v6 SDK types (from docs) ──────────────────────────────────────────

declare global {
  interface Window {
    paypal: {
      createInstance: (opts: {
        clientId: string;
        components?: string[];
        pageType?: string;
      }) => Promise<PayPalSdkInstance>;
    };
  }
}

interface PayPalSdkInstance {
  createPayPalOneTimePaymentSession: (opts: {
    onApprove:  (data: { orderId: string; payerId: string }) => Promise<void>;
    onCancel?:  (data: { orderId?: string }) => void;
    onError?:   (err:  { code: string; message: string }) => void;
  }) => PaymentSession;
}

interface PaymentSession {
  start: (
    opts:         { presentationMode: "auto" | "popup" | "modal" | "redirect" },
    orderPromise: Promise<{ orderId: string }>
  ) => Promise<void>;
}

// ── Component props ───────────────────────────────────────────────────────────

interface Props {
  milestoneId:   string;
  milestoneTitle: string;
  budgetUsd:     string;
  /** ISO 4217 — always USD for sandbox */
  currency?:     string;
  onFunded:      (result: FundResult) => void;
}

export interface FundResult {
  orderId:    string;
  captureId:  string;
  grossUsd:   string | null;
  feeUsd:     string | null;
  netUsd:     string | null;
  paymentId:  string;
}

// ── SDK script URL — depends on PAYPAL_ENV ───────────────────────────────────
// Doc: https://developer.paypal.com/sdk/js/set-up/
//   sandbox: https://www.sandbox.paypal.com/web-sdk/v6/core
//   live:    https://www.paypal.com/web-sdk/v6/core
// Controlled by NEXT_PUBLIC_PAYPAL_ENV (set alongside NEXT_PUBLIC_PAYPAL_CLIENT_ID)

const paypalEnv    = process.env.NEXT_PUBLIC_PAYPAL_ENV ?? "sandbox";
const SDK_SCRIPT   = paypalEnv === "live"
  ? "https://www.paypal.com/web-sdk/v6/core"
  : "https://www.sandbox.paypal.com/web-sdk/v6/core";

// ── Component ─────────────────────────────────────────────────────────────────

export function MilestoneFundButton({
  milestoneId,
  milestoneTitle,
  budgetUsd,
  onFunded,
}: Props) {
  const clientId = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID;

  const [sdkReady, setSdkReady]     = useState(false);
  const [loading, setLoading]       = useState(false);
  const [sdkError, setSdkError]     = useState<string | null>(null);
  const [displayAmount, setDisplayAmount] = useState<string | null>(null);
  const [feeEstimate, setFeeEstimate]     = useState<string | null>(null);

  const sdkInstanceRef = useRef<PayPalSdkInstance | null>(null);

  // ── SDK load ──────────────────────────────────────────────────────────────
  const onSdkLoad = useCallback(async () => {
    if (!clientId) {
      setSdkError("NEXT_PUBLIC_PAYPAL_CLIENT_ID is not set");
      return;
    }
    if (!window.paypal?.createInstance) {
      setSdkError("PayPal v6 SDK not available — wrong script or loading issue");
      return;
    }
    try {
      const instance = await window.paypal.createInstance({
        clientId,
        components: ["paypal-payments"],
        pageType:   "checkout",
      });
      sdkInstanceRef.current = instance;
      setSdkReady(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSdkError("SDK init failed: " + msg);
    }
  }, [clientId]);

  // ── Pay handler ───────────────────────────────────────────────────────────
  const handlePay = useCallback(async () => {
    const instance = sdkInstanceRef.current;
    if (!instance || loading) return;

    setLoading(true);
    setSdkError(null);

    try {
      const session = instance.createPayPalOneTimePaymentSession({
        onApprove: async ({ orderId }) => {
          toast.loading("Capturing payment…", { id: "capture" });
          try {
            // We stored paymentId on the window during createOrderPromise below
            const paymentId = (window as unknown as Record<string, unknown>)[
              `_consultai_pid_${milestoneId}`
            ] as string | undefined;

            const res = await fetch("/api/paypal/capture-order", {
              method:  "POST",
              headers: { "Content-Type": "application/json" },
              body:    JSON.stringify({ orderID: orderId, paymentId }),
            });

            const data = await res.json() as Record<string, unknown>;

            if (!res.ok) {
              toast.error("Capture failed — check dashboard", { id: "capture" });
              setSdkError("Capture failed: " + JSON.stringify(data.error));
              return;
            }

            toast.success("Payment captured — milestone held!", { id: "capture", duration: 5000 });

            onFunded({
              orderId:   orderId,
              captureId: data.captureId as string,
              grossUsd:  data.grossUsd  as string | null,
              feeUsd:    data.feeUsd    as string | null,
              netUsd:    data.netUsd    as string | null,
              paymentId: data.paymentId as string,
            });
          } catch (e) {
            toast.error("Capture error", { id: "capture" });
            setSdkError(e instanceof Error ? e.message : String(e));
          } finally {
            setLoading(false);
          }
        },

        onCancel: () => {
          toast.info("Payment cancelled");
          setLoading(false);
        },

        onError: ({ code, message }) => {
          toast.error(`PayPal error ${code}: ${message}`);
          setSdkError(`PayPal error ${code}: ${message}`);
          setLoading(false);
        },
      });

      // createOrderPromise — calls server, returns { orderId }
      // Doc: must resolve to { orderId: string } — NOT a bare string (v5 vs v6 difference)
      const createOrderPromise = async (): Promise<{ orderId: string }> => {
        const res = await fetch("/api/paypal/create-order", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ milestoneId }),
        });
        const data = await res.json() as Record<string, unknown>;
        if (!res.ok || !data.id) {
          throw new Error("create-order failed: " + JSON.stringify(data));
        }
        // Stash paymentId on window for capture callback (SDK v6 doesn't pass it back)
        (window as unknown as Record<string, unknown>)[
          `_consultai_pid_${milestoneId}`
        ] = data.paymentId;

        // Show fee information to user before they approve
        setDisplayAmount(data.displayAmount as string);
        setFeeEstimate(data.feeEstimate as string);

        return { orderId: data.id as string };
      };

      await session.start({ presentationMode: "auto" }, createOrderPromise());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSdkError(msg);
      setLoading(false);
    }
  }, [loading, milestoneId, onFunded]);

  if (!clientId) {
    return (
      <p className="text-destructive text-xs">
        NEXT_PUBLIC_PAYPAL_CLIENT_ID not set.
      </p>
    );
  }

  return (
    <>
      {/* v6 SDK script — NOT the legacy sdk/js?client-id=... URL */}
      <Script
        src={SDK_SCRIPT}
        strategy="afterInteractive"
        onLoad={() => { void onSdkLoad(); }}
        onError={() => setSdkError("Failed to load PayPal SDK")}
      />

      <div className="space-y-2 mt-3">
        {displayAmount && feeEstimate && (
          <p className="text-xs text-muted-foreground">
            You will be charged{" "}
            <strong className="text-foreground">${displayAmount}</strong>
            {" "}(includes estimated PayPal fee ~${feeEstimate})
          </p>
        )}

        <button
          onClick={() => { void handlePay(); }}
          disabled={!sdkReady || loading}
          className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium
            bg-[#0070ba] text-white hover:bg-[#005ea6] disabled:opacity-50
            disabled:cursor-not-allowed transition-colors"
        >
          {loading ? (
            <>
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
              Processing…
            </>
          ) : !sdkReady ? (
            "Loading PayPal…"
          ) : (
            <>
              <PayPalIcon />
              Fund ${Number(budgetUsd).toLocaleString()} — {milestoneTitle.slice(0, 24)}
            </>
          )}
        </button>

        {sdkError && (
          <p className="text-destructive text-xs">{sdkError}</p>
        )}

        {/* Sandbox badge — always visible */}
        {paypalEnv === "sandbox" && (
          <span className="inline-flex items-center rounded-full border border-amber-400 bg-amber-50 dark:bg-amber-950/30 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
            Sandbox mode
          </span>
        )}
      </div>
    </>
  );
}

function PayPalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <path d="M7.144 19.532l1.049-6.551-.067.387H12.6c3.73 0 6.23-1.752 7.04-5.055C20.583 5.02 18.5 3 15.165 3H7.5a1 1 0 0 0-.988.853L4.142 19.532z" opacity=".3"/>
      <path d="M20.64 8.313c-.944 4.01-3.96 5.868-8.04 5.868H10.3l-1.295 8.083h3.164a.87.87 0 0 0 .86-.734l.036-.183.682-4.327.044-.24a.87.87 0 0 1 .86-.734h.541c3.507 0 6.253-1.424 7.056-5.545.334-1.713.161-3.142-.608-4.188z"/>
    </svg>
  );
}
