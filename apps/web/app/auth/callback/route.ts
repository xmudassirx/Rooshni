import { NextResponse } from "next/server";
import { emitEvent } from "@rooshni/db";

import { externalOrigin } from "@/lib/server/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * OAuth landing (Session 5; provider-blind since Session 20): the provider
 * sends the browser back to Supabase, and Supabase sends it here with a
 * one-time code. Exchange it for a session, then let the allowlist decide
 * where the visitor goes. An allowlisted sign-in lands on the ledger as
 * auth.signed_in, attributed to the signer's own human actor under their own
 * RLS, with the door it walked through recorded honestly.
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

    // JUDGMENT (Session 20, Lane B): an allowlisted session with no actor or
    // membership meets the holding page, never a broken half-shell. The only
    // lawful way this state arises is the identity-linking fork — a provider
    // presenting an unverified email makes Supabase create a SECOND auth user
    // instead of linking (its pre-account-takeover protection), and that
    // duplicate passes the email-keyed allowlist while holding no membership.
    // Fail closed to the same page every outsider sees; the sign-in door and
    // the tenancy wall (memberships + RLS) are untouched — this is UX over
    // the wall, tightening, not loosening.
    if (!actor || !membership) {
      return NextResponse.redirect(`${origin}/construction`);
    }

    try {
      await emitEvent(supabase, {
        business_id: membership.business_id,
        actor_id: actor.id,
        action: "auth.signed_in",
        payload: {
          email: user.email,
          // The door the sign-in actually walked through — "google" or
          // "azure" — read from the session, never assumed (Session 20).
          provider: user.app_metadata?.provider ?? "unknown",
        },
      });
    } catch (err) {
      // A sign-in that cannot reach the ledger still signs in; the session
      // itself is Supabase's record. Log and carry on.
      console.error("auth.signed_in event failed:", err);
    }
  }

  return NextResponse.redirect(`${origin}/`);
}
