/**
 * Session 9 — Stripe webhook fixtures (the contract-session pattern: the
 * Session 1 Meta Lead Ads payloads are the precedent). Shapes match Stripe's
 * documented event envelope EXACTLY (an `event` object wrapping a
 * `checkout.session`, API version pinned in src/stripe.ts), so the wiring
 * verification checks against something true. Ids are Stripe-format test
 * ids; no live data, no secrets.
 *
 * The `client_reference_id` carries the pre-active account id — set when the
 * Checkout Session is created (src/stripe.ts createCheckoutSession); the
 * webhook activates exactly that record.
 */

export interface StripeCheckoutCompletedFixture {
  id: string;
  object: "event";
  api_version: string;
  created: number;
  livemode: boolean;
  pending_webhooks: number;
  request: { id: string | null; idempotency_key: string | null };
  type: "checkout.session.completed";
  data: {
    object: {
      id: string;
      object: "checkout.session";
      amount_subtotal: number;
      amount_total: number;
      client_reference_id: string | null;
      currency: string;
      customer: string | null;
      customer_details: { email: string | null; name: string | null } | null;
      customer_email: string | null;
      livemode: boolean;
      mode: "payment" | "setup" | "subscription";
      payment_status: "paid" | "unpaid" | "no_payment_required";
      status: "complete" | "expired" | "open";
      subscription: string | null;
      success_url: string;
      url: string | null;
    };
  };
}

/** The activation event: a paid subscription-mode Checkout Session. */
export const checkoutSessionCompleted: StripeCheckoutCompletedFixture = {
  id: "evt_1RfixtureCheckoutDone01",
  object: "event",
  api_version: "2024-09-30.acacia",
  created: 1752750000,
  livemode: false,
  pending_webhooks: 1,
  request: { id: null, idempotency_key: null },
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_test_a1FixtureSession0000000000000001",
      object: "checkout.session",
      amount_subtotal: 14900,
      amount_total: 14900,
      client_reference_id: "REPLACED_WITH_PRE_ACTIVE_ACCOUNT_ID",
      currency: "gbp",
      customer: "cus_TFixtureCustomer001",
      customer_details: { email: "aisha@jurists.test", name: "Aisha Test" },
      customer_email: "aisha@jurists.test",
      livemode: false,
      mode: "subscription",
      payment_status: "paid",
      status: "complete",
      subscription: "sub_1TFixtureSubscription01",
      success_url: "https://example.test/signup/success?session_id={CHECKOUT_SESSION_ID}",
      url: null,
    },
  },
};

/** The non-activation case: an unpaid (expired/abandoned) session — the
 * webhook records it and touches nothing (DoD ②'s webhook half). */
export const checkoutSessionUnpaid: StripeCheckoutCompletedFixture = {
  ...checkoutSessionCompleted,
  id: "evt_1RfixtureCheckoutUnpaid1",
  data: {
    object: {
      ...checkoutSessionCompleted.data.object,
      id: "cs_test_a1FixtureSession0000000000000002",
      payment_status: "unpaid",
      status: "expired",
    },
  },
};
