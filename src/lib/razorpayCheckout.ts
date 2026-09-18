/**
 * Razorpay checkout, for the browser.
 *
 * This lives in one place for two reasons.
 *
 * The first is correctness. The checkout script was previously appended to
 * `document.body` in an effect and then simply hoped to be ready by the time the
 * user pressed pay — `if (!window.Razorpay)` with a "the payment window could not
 * load, refresh the page" message was the fallback for losing that race. On a
 * slow connection that is not an edge case, and the application has already been
 * filed by then, so the user is told to refresh at the exact moment they are
 * least willing to. `loadCheckout()` returns a promise for the script's `load`
 * event and caches it, so pressing pay waits for the script rather than racing
 * it.
 *
 * The second is that the `Window.Razorpay` augmentation can only be declared
 * once. Two pages each declaring it with their own structurally identical
 * `RazorpayOptions` is a TypeScript error (TS2717), which is a small warning
 * about a larger problem: two copies of a payment flow drift apart, and the copy
 * that drifts is the one that credits money.
 *
 * No Node imports here — this module is imported by `'use client'` components.
 */

export interface RazorpayResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

export interface RazorpayOptions {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  handler: (response: RazorpayResponse) => void;
  modal?: { ondismiss?: () => void };
  theme?: { color?: string };
  prefill?: { name?: string; email?: string; contact?: string };
}

export interface RazorpayInstance {
  open: () => void;
  on: (event: string, handler: (response: { error?: { description?: string } }) => void) => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

const SCRIPT_ID = 'razorpay-checkout-script';
const SCRIPT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

let pending: Promise<boolean> | null = null;

/**
 * Ensures the checkout script is loaded, resolving `false` if it cannot be.
 *
 * Safe to call as often as you like: the promise is cached, and an existing tag
 * left by another page is adopted rather than duplicated.
 */
export function loadCheckout(): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);
  if (pending) return pending;

  pending = new Promise<boolean>((resolve) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing ?? document.createElement('script');

    const settle = (loaded: boolean) => {
      // A failed load is not cached: the user may simply have been offline for a
      // moment, and a retry should be allowed to succeed.
      if (!loaded) pending = null;
      resolve(loaded);
    };

    script.addEventListener('load', () => settle(Boolean(window.Razorpay)), { once: true });
    script.addEventListener('error', () => settle(false), { once: true });

    if (!existing) {
      script.id = SCRIPT_ID;
      script.src = SCRIPT_SRC;
      script.async = true;
      document.body.appendChild(script);
    }
  });

  return pending;
}

/** Kicks off the download without waiting — call it on mount to warm the cache. */
export function prefetchCheckout(): void {
  void loadCheckout();
}

export type FeePaymentResult =
  | { status: 'paid'; message?: string; feeStatus?: string; feePaid?: number }
  | { status: 'dismissed' }
  | { status: 'failed'; message: string };

interface PayFeeArgs {
  applicationId: string;
  applicationNo: string;
  prefill?: { name?: string; email?: string; contact?: string };
}

/**
 * Runs the whole fee payment: open an order, take the payment, verify it.
 *
 * Resolves rather than throws, because every outcome here needs to be *said* to
 * the user — a dismissed modal, a gateway that would not open and a payment
 * whose confirmation failed are three different messages, and the last one must
 * never read like "try again".
 */
export async function payApplicationFee({
  applicationId,
  applicationNo,
  prefill,
}: PayFeeArgs): Promise<FeePaymentResult> {
  let order: { id: string; amount: number; currency: string };
  let keyId: string | undefined;

  try {
    const res = await fetch('/api/payments/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ applicationId }),
    });
    const data = (await res.json()) as {
      success: boolean;
      error?: string;
      keyId?: string;
      order?: { id: string; amount: number; currency: string };
    };

    if (!data.success || !data.order) {
      return {
        status: 'failed',
        message: data.error || 'The payment gateway is unavailable. Try again shortly.',
      };
    }
    order = data.order;
    keyId = data.keyId;
  } catch {
    return {
      status: 'failed',
      message: 'Could not reach the server to start a payment. Check your connection.',
    };
  }

  if (!keyId) {
    // Worth naming precisely: this is a deployment problem, not something the
    // user can fix by trying again.
    return {
      status: 'failed',
      message:
        'Online payment is not configured on this deployment. Contact the Legal Metrology office to pay the fee.',
    };
  }

  if (!(await loadCheckout())) {
    return {
      status: 'failed',
      message:
        'The payment window could not load. Check your connection — the fee stays outstanding until it is paid.',
    };
  }

  return new Promise<FeePaymentResult>((resolve) => {
    // `settled` guards against Razorpay firing both `handler` and `ondismiss`,
    // which would otherwise resolve the promise twice and, worse, let a caller
    // conclude "dismissed" about a payment that actually went through.
    let settled = false;
    const finish = (result: FeePaymentResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const rzp = new window.Razorpay!({
      key: keyId!,
      amount: order.amount,
      currency: order.currency,
      name: 'VTULA — Legal Metrology',
      description: `Verification fee for ${applicationNo}`,
      order_id: order.id,
      prefill,
      theme: { color: '#E07A5F' },
      handler: (response) => {
        void (async () => {
          try {
            const res = await fetch('/api/payments/verify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                razorpay_order_id: response.razorpay_order_id,
                razorpay_payment_id: response.razorpay_payment_id,
                razorpay_signature: response.razorpay_signature,
              }),
            });
            const data = (await res.json()) as {
              success: boolean;
              error?: string;
              message?: string;
              application?: { feeStatus?: string; feePaid?: number };
            };

            if (data.success) {
              finish({
                status: 'paid',
                message: data.message,
                feeStatus: data.application?.feeStatus,
                feePaid: data.application?.feePaid,
              });
            } else {
              finish({
                status: 'failed',
                message:
                  data.error ||
                  `The payment could not be verified. If your bank shows a debit, quote payment id ${response.razorpay_payment_id} to the Legal Metrology office — do not pay again.`,
              });
            }
          } catch {
            finish({
              status: 'failed',
              message: `The payment went through but confirmation failed. Reload this page to check the fee status before paying again — payment id ${response.razorpay_payment_id}.`,
            });
          }
        })();
      },
      modal: { ondismiss: () => finish({ status: 'dismissed' }) },
    });

    rzp.on('payment.failed', (event) => {
      finish({
        status: 'failed',
        message: event.error?.description || 'The payment was declined. Nothing has been charged.',
      });
    });

    rzp.open();
  });
}
