import "server-only";
import { cache } from "react";
import { createServiceClient, type SupabaseClient } from "@rooshni/db";

/**
 * Session 4 dev context: the UI runs server-side as the business owner's own
 * human actor, through the service client. There is no sign-in surface yet —
 * real authentication is on GO-LIVE.md. Every structural rule (human stamp,
 * grants, readiness pre-flight, RLS-shaped pipelines) is enforced by the
 * database regardless of which client the app holds.
 */

export interface AppContext {
  db: SupabaseClient;
  business: { id: string; name: string };
  /** The signed-in human this UI acts as — the owner, until real auth lands. */
  actor: { id: string; display_name: string };
}

export const getAppContext = cache(async (): Promise<AppContext> => {
  const db = createServiceClient();

  const { data: business, error: bizError } = await db
    .from("businesses")
    .select("id, name, account_id")
    .is("archived_at", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .single();
  if (bizError || !business) {
    throw new Error(
      `No business found — has the seed run? (${bizError?.message ?? "no rows"})`
    );
  }

  const { data: account, error: accError } = await db
    .from("accounts")
    .select("owner_user_id")
    .eq("id", business.account_id)
    .single();
  if (accError || !account) {
    throw new Error(`Account lookup failed: ${accError?.message ?? "no rows"}`);
  }

  const { data: actor, error: actorError } = await db
    .from("actors")
    .select("id, display_name")
    .eq("user_id", account.owner_user_id)
    .eq("actor_type", "human")
    .is("archived_at", null)
    .single();
  if (actorError || !actor) {
    throw new Error(
      `Owner actor lookup failed: ${actorError?.message ?? "no rows"}`
    );
  }

  return {
    db,
    business: { id: business.id, name: business.name },
    actor,
  };
});
