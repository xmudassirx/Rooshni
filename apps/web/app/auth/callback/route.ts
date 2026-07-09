import { NextResponse } from "next/server";
import { emitEvent } from "@rooshni/db";

import { externalOrigin } from "@/lib/server/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * OAuth landing (Session 5): Google sends the browser back to Supabase, and
 * Supabase sends it here with a one-time code. Exchange it for a session,
 * then let the allowlist decide where the visitor goes. An allowlisted
 * sign-in lands on the ledger as auth.signed_in, attributed to the signer's
 * own human actor under their own RLS.
 */

export async function GET(request: Request) {
  const origin = externalOrigin(request);
  const code = new URL(request.url).searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(`${origin}/construction`);
  }

  const supabase = await createSupabaseServerClient();
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
  if (exchangeError) {
    return NextResponse.redirect(`${origin}/construction`);
  }

  // The door: one live allowlist row (their own, via RLS) or nothing.
  const { data: allowed } = await supabase
    .from("allowed_emails")
    .select("id")
    .limit(1);
  if (!allowed?.length) {
    return NextResponse.redirect(`${origin}/construction`);
  }

  // The signed-in human maps to their existing actor via actors.user_id.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) {
    const [{ data: actor }, { data: membership }] = await Promise.all([
      supabase
        .from("actors")
        .select("id")
        .eq("user_id", user.id)
        .eq("actor_type", "human")
        .is("archived_at", null)
        .maybeSingle(),
      supabase
        .from("memberships")
        .select("business_id")
        .eq("user_id", user.id)
        .is("archived_at", null)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
    ]);

    if (actor && membership) {
      try {
        await emitEvent(supabase, {
          business_id: membership.business_id,
          actor_id: actor.id,
          action: "auth.signed_in",
          payload: { email: user.email, provider: "google" },
        });
      } catch (err) {
        // A sign-in that cannot reach the ledger still signs in; the session
        // itself is Supabase's record. Log and carry on.
        console.error("auth.signed_in event failed:", err);
      }
    }
  }

  return NextResponse.redirect(`${origin}/`);
}
