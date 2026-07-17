import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe over plain REST — no SDK dependency. The API version is PINNED here
 * (external-integrations rule: version strings live in config, never
 * scattered); a bump is a deliberate change.
 *
 * Pinned to 2026-06-24.dahlia — the dashboard's offered version, confirmed
 * by Mudassir at wiring (17 July 2026), replacing the close report's
 * flagged placeholder pin.
 */
export const STRIPE_API_VERSION = "2026-06-24.dahlia";
const STRIPE_API_BASE = "https://api.stripe.com";

/** Webhook signature tolerance — Stripe's documented default. This is
 * infrastructure clock-skew allowance, not a workflow timer (the decision 44
 * class), so TIME_SCALE does not apply. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

export interface StripeSignatureResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verify a `Stripe-Signature` header against the RAW request body.
 * Scheme: header carries `t=<unix>,v1=<hex hmac>[,v1=…]`; the signed payload
 * is `${t}.${body}` HMAC-SHA256 with the endpoint's signing secret.
 * An unverified body is untrusted input — callers must not parse it first.
 */
export function verifyStripeSignature(input: {
  payload: string;
  header: string | null;
  secret: string;
  toleranceSeconds?: number;
  nowMs?: number;
}): StripeSignatureResult {
  const { payload, header, secret } = input;
  const tolerance = input.toleranceSeconds ?? STRIPE_SIGNATURE_TOLERANCE_SECONDS;
  if (!header) return { ok: false, reason: "missing Stripe-Signature header" };

  let timestamp: number | null = null;
  const candidates: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2).map((s) => s?.trim());
    if (!key || !value) continue;
    if (key === "t") timestamp = Number(value);
    if (key === "v1") candidates.push(value);
  }
  if (!timestamp || !Number.isFinite(timestamp)) {
    return { ok: false, reason: "malformed signature header: no timestamp" };
  }
  if (candidates.length === 0) {
    return { ok: false, reason: "malformed signature header: no v1 signature" };
  }

  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSeconds - timestamp) > tolerance) {
    return { ok: false, reason: "timestamp outside tolerance (possible replay)" };
  }

  const expected = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  const expectedBuf = Buffer.from(expected);
  for (const candidate of candidates) {
    const candidateBuf = Buffer.from(candidate);
    if (candidateBuf.length === expectedBuf.length && timingSafeEqual(candidateBuf, expectedBuf)) {
      return { ok: true };
    }
  }
  return { ok: false, reason: "signature mismatch" };
}

/** The webhook envelope fields this codebase reads. */
export interface StripeEventEnvelope {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export interface StripeCheckoutSession {
  id: string;
  mode?: string;
  client_reference_id?: string | null;
  customer?: string | null;
  subscription?: string | null;
  amount_total?: number | null;
  currency?: string | null;
  payment_status?: string | null;
}

async function stripeRequest<T>(
  secretKey: string,
  path: string,
  form: Record<string, string>
): Promise<T> {
  const response = await fetch(`${STRIPE_API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": STRIPE_API_VERSION,
    },
    body: new URLSearchParams(form).toString(),
    // External calls fail; fail visibly and promptly rather than hanging a
    // serverless invocation (external-integrations: explicit timeouts).
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) {
    throw new Error(`Stripe ${path} failed (${response.status}): ${body.error?.message ?? "unknown error"}`);
  }
  return body;
}

/**
 * Create a subscription Checkout Session for the pilot plan. The pre-active
 * account id travels as client_reference_id — the webhook activates exactly
 * that account, whatever email the payer typed into Stripe.
 */
export async function createCheckoutSession(params: {
  secretKey: string;
  priceId: string;
  accountId: string;
  customerEmail: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ id: string; url: string }> {
  const session = await stripeRequest<{ id: string; url: string }>(
    params.secretKey,
    "/v1/checkout/sessions",
    {
      mode: "subscription",
      "line_items[0][price]": params.priceId,
      "line_items[0][quantity]": "1",
      client_reference_id: params.accountId,
      customer_email: params.customerEmail,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
    }
  );
  return { id: session.id, url: session.url };
}
