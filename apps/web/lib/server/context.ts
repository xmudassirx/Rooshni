import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@rooshni/db";

import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Session 5: the app acts as the signed-in human, through their own
 * user-scoped client — every query runs under RLS as that user, and the
 * pipeline functions see them acting as their own actor. This retires the
 * Session 4 service-client-as-owner arrangement (decision 23).
 *
 * The middleware has already turned away anyone without a session and an
 * allowlist row; the checks here are the belt to that braces — and the
 * database enforces every structural rule regardless.
 */

export interface AppContext {
  db: SupabaseClient;
  business: { id: string; name: string };
  /** The signed-in human's own actor — resolved via actors.user_id. */
  actor: { id: string; display_name: string };
  membershipRole: "owner" | "member";
}

export const getAppContext = cache(async (): Promise<AppContext> => {
  const db = await createSupabaseServerClient();

  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/construction");

  const { data: allowed } = await db.from("allowed_emails").select("id").limit(1);
  if (!allowed?.length) redirect("/construction");

  const [{ data: actor, error: actorError }, { data: membership, error: mError }] =
    await Promise.all([
      db
        .from("actors")
        .select("id, display_name")
        .eq("user_id", user.id)
        .eq("actor_type", "human")
        .is("archived_at", null)
        .maybeSingle(),
      db
        .from("memberships")
        .select("role, business_id, businesses(id, name)")
        .eq("user_id", user.id)
        .is("archived_at", null)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
    ]);
  if (actorError || !actor) {
    throw new Error(
      `No human actor maps to this sign-in (${actorError?.message ?? "no rows"}) — ` +
        "an allowlisted user needs an actors row with their user_id."
    );
  }
  if (mError || !membership) {
    throw new Error(
      `No membership for this sign-in (${mError?.message ?? "no rows"}) — ` +
        "an allowlisted user needs a memberships row for their business."
    );
  }

  const business = membership.businesses as unknown as {
    id: string;
    name: string;
  } | null;
  if (!business) {
    throw new Error("Membership points at a business this user cannot see.");
  }

  return {
    db,
    business: { id: business.id, name: business.name },
    actor,
    membershipRole: membership.role as "owner" | "member",
  };
});
