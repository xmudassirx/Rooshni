import { NextResponse } from "next/server";
import { emitEvent } from "@rooshni/db";

import { externalOrigin } from "@/lib/server/origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Sign out (Session 5). The ledger hears about it first — auth.signed_out
 * must be written while the session still exists, because a signed-out
 * client can insert nothing under RLS.
 */
export async function POST(request: Request) {
  const supabase = await createSupabaseServerClient();
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
          action: "auth.signed_out",
          payload: { email: user.email },
        });
      } catch (err) {
        console.error("auth.signed_out event failed:", err);
      }
    }

    // Local scope only: signing out THIS browser must not revoke the user's
    // sessions everywhere else. The supabase-js default is global — during
    // the Session 5 proof circuit that revoked the founder's production
    // session every time any other sign-out happened, which read as
    // "sessions never persist".
    await supabase.auth.signOut({ scope: "local" });
  }

  return NextResponse.redirect(`${externalOrigin(request)}/construction`, {
    status: 303,
  });
}
