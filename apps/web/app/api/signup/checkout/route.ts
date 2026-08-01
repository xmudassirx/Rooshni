import { NextResponse, type NextRequest } from "next/server";
import { requireEnv } from "@rooshni/config";
import { createCheckoutSession, createServiceClient } from "@rooshni/db";
import { externalOrigin } from "@/lib/server/origin";

export const dynamic = "force-dynamic";

/**
 * Signup step 2 → a Stripe Checkout Session for the pilot plan. The resume
 * token is the pre-active flow's proof of possession (no session exists yet):
 * the account id alone opens nothing. The pre-active account id rides as
 * client_reference_id, so the webhook activates exactly the record that paid.
 */
export async function POST(request: NextRequest) {
  let body: { accountId?: string; resumeToken?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }
  if (!body.accountId || !body.resumeToken) {
    return NextResponse.json({ error: "Missing signup reference." }, { status: 400 });
  }

  const db = createServiceClient();
  const { data: account, error } = await db
    .from("accounts")
    .select("id, signup_email")
    .eq("id", body.accountId)
    .eq("signup_resume_token", body.resumeToken)
    .eq("billing_status", "pre_active")
    .is("activated_at", null)
    .maybeSingle();
  if (error || !account) {
    return NextResponse.json(
      { error: "This signup is no longer open — start again or use your latest email link." },
      { status: 404 }
    );
  }

  // Session 18: the canonical seam — NEXT_PUBLIC_APP_URL when set,
  // request-derived otherwise, so localhost and previews need no
  // configuration and production Stripe returns land on the custom domain.
  const origin = externalOrigin(request);

  try {
    const session = await createCheckoutSession({
      secretKey: requireEnv("STRIPE_SECRET_KEY"),
      priceId: requireEnv("STRIPE_PRICE_ID"),
      accountId: account.id,
      customerEmail: account.signup_email,
      successUrl: `${origin}/signup/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${origin}/signup?resume=${body.resumeToken}`,
    });
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("checkout session failed:", err);
    return NextResponse.json(
      { error: "Could not open the payment page — please try again." },
      { status: 502 }
    );
  }
}
