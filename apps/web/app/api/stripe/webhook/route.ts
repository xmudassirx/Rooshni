import { NextResponse, type NextRequest } from "next/server";
import {
  activateSignup,
  createServiceClient,
  verifyStripeSignature,
  type StripeCheckoutSession,
  type StripeEventEnvelope,
} from "@rooshni/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The Stripe webhook — the ONLY trigger for account activation (decision
 * 80: payment before anything; the crawl hook point exists downstream of
 * here, the crawler actor does not yet).
 *
 * Discipline (external-integrations, the Meta-webhook pattern):
 *   FAIL CLOSED — no configured secret, no processing; signature verified
 *   against the RAW body before the payload is even parsed; idempotent on
 *   Stripe's event id (stripe_events unique) AND on the activation door
 *   itself, so retries and replays re-do nothing. Everything that mutates
 *   is evented via emitEvent() inside activateSignup.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, detail: "STRIPE_WEBHOOK_SECRET is not configured — the webhook is closed." },
      { status: 503 }
    );
  }

  const rawBody = await request.text();
  const verdict = verifyStripeSignature({
    payload: rawBody,
    header: request.headers.get("stripe-signature"),
    secret,
  });

  const db = createServiceClient();

  if (!verdict.ok) {
    // An unverified body is untrusted input: none of it is parsed or stored.
    // The rejection itself is recorded — a probe leaves a mark.
    await db.from("stripe_events").insert({
      stripe_event_id: `sig_rejected_${crypto.randomUUID()}`,
      type: "signature.rejected",
      payload: {},
      processed_at: new Date().toISOString(),
      outcome: `rejected: ${verdict.reason}`,
    });
    return NextResponse.json({ ok: false, detail: "signature verification failed" }, { status: 400 });
  }

  let event: StripeEventEnvelope;
  try {
    event = JSON.parse(rawBody) as StripeEventEnvelope;
  } catch {
    return NextResponse.json({ ok: false, detail: "unparseable body" }, { status: 400 });
  }
  if (!event?.id || !event?.type) {
    return NextResponse.json({ ok: false, detail: "not a Stripe event envelope" }, { status: 400 });
  }

  // Idempotency on the provider's id: the insert claims the event. A replay
  // hits the unique index — then only a SUCCESSFULLY processed event is
  // acknowledged as a duplicate; a claim whose processing failed falls
  // through and is retried (the activation door itself is idempotent, so
  // re-processing is safe).
  const { error: claimError } = await db.from("stripe_events").insert({
    stripe_event_id: event.id,
    type: event.type,
    payload: event as unknown as Record<string, unknown>,
  });
  if (claimError) {
    if (claimError.code !== "23505") {
      console.error("stripe_events claim failed:", claimError.message);
      return NextResponse.json({ ok: false, detail: "could not record event" }, { status: 500 });
    }
    const { data: existing } = await db
      .from("stripe_events")
      .select("processed_at, outcome")
      .eq("stripe_event_id", event.id)
      .maybeSingle();
    if (existing?.processed_at && !existing.outcome?.startsWith("error")) {
      return NextResponse.json({ ok: true, detail: "duplicate event — already processed" });
    }
    // Claimed earlier but never completed — fall through and retry.
  }

  const stamp = async (outcome: string) => {
    await db
      .from("stripe_events")
      .update({ processed_at: new Date().toISOString(), outcome })
      .eq("stripe_event_id", event.id);
  };

  if (event.type !== "checkout.session.completed") {
    await stamp("ignored: not an activation event");
    return NextResponse.json({ ok: true, detail: "recorded" });
  }

  const session = event.data.object as unknown as StripeCheckoutSession;
  if (session.mode !== "subscription" || session.payment_status !== "paid") {
    await stamp(`ignored: mode=${session.mode} payment_status=${session.payment_status}`);
    return NextResponse.json({ ok: true, detail: "recorded" });
  }
  if (!session.client_reference_id) {
    await stamp("error: no client_reference_id — cannot resolve the signup");
    return NextResponse.json({ ok: false, detail: "no client_reference_id" }, { status: 400 });
  }

  try {
    const result = await activateSignup(db, {
      accountId: session.client_reference_id,
      stripeCustomerId: session.customer ?? "",
      stripeSubscriptionId: session.subscription ?? "",
      amountTotal: session.amount_total ?? null,
      currency: session.currency ?? null,
      stripeEventId: event.id,
    });
    await stamp(result.alreadyActive ? "noop: already active" : `activated: business ${result.businessId}`);
    return NextResponse.json({ ok: true, business_id: result.businessId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("activation failed:", message);
    await stamp(`error: ${message}`);
    // 500 → Stripe retries; the door and the event claim are both
    // idempotent, so a retry after a transient failure is safe.
    return NextResponse.json({ ok: false, detail: "activation failed" }, { status: 500 });
  }
}
