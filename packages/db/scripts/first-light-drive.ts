import { loadEnv } from "./env";
import { createServiceClient } from "../src/client";
import { emitEvent } from "../src/events";
import {
  evaluateConnectionPredicates,
  satisfyFirstLightPredicate,
  unearnFirstLightPredicate,
  CONNECTION_PREDICATE_TOOLS,
  FIRST_LIGHT_PENDING_ARRIVALS,
} from "../src/first-light";
import type { FirstLightPredicateKey } from "../src/onboarding";

/**
 * Session 11 — the DoD (2) service-side flip driver, stated honestly:
 * the three connect predicates cannot be earned through the product yet
 * (no OAuth wiring exists), so this script performs the CONNECTION
 * server-side — it creates the integration actor and its grant, exactly the
 * rows a real connect flow will create — and then lets the ordinary
 * evaluator earn the tick from that state. The predicate itself is never
 * written directly; the flip still goes through satisfyFirstLightPredicate
 * with its paired ledger event, and the grant rows remain on The Record.
 *
 *   npm run first-light:drive --workspace=@rooshni/db -- <business_id> <mail|whatsapp|meta>
 *
 * The rows whose machinery does not exist AT ALL yet (memory tray, sending
 * domain, walkthrough) have nothing to connect — for the retirement
 * demonstration ONLY they can be flipped with an explicit demonstration
 * flag, and the flip's ledger event says so in plain words:
 *
 *   npm run first-light:drive --workspace=@rooshni/db -- <business_id> demo-flip <predicate_key>
 *
 * Session 13 fix round: a tick recorded in error can be STRUCK — unearned,
 * with the stated reason on The Record before the row clears; the task
 * reopens. Used for the Jurists correction (decision 84's per-row law).
 *
 *   npm run first-light:drive --workspace=@rooshni/db -- <business_id> unearn <predicate_key> "<reason>"
 */

const PROVIDERS = {
  mail: { tool: "comms.email", actorName: "Microsoft 365 (driven)" },
  whatsapp: { tool: "comms.whatsapp", actorName: "WhatsApp Business (driven)" },
  meta: { tool: "enquiries", actorName: "Meta Lead Forms (driven)" },
} as const;

async function main() {
  loadEnv();
  const [businessId, providerKey, demoKey] = process.argv.slice(2).filter((a) => a !== "--");
  if (!businessId || !providerKey) {
    console.error(
      "Usage: first-light-drive <business_id> <mail|whatsapp|meta>\n" +
        "       first-light-drive <business_id> demo-flip <predicate_key>"
    );
    process.exit(1);
  }

  const db = createServiceClient();

  if (providerKey === "unearn") {
    const args = process.argv.slice(2).filter((a) => a !== "--");
    const key = demoKey as FirstLightPredicateKey;
    const reason = args.slice(3).join(" ").trim();
    if (!key || !reason) {
      console.error('Usage: first-light-drive <business_id> unearn <predicate_key> "<reason>"');
      process.exit(1);
    }
    // JUDGMENT: attribution — the business's workflow actor when it exists
    // (platform automation correcting observed state, the evaluator
    // precedent); a Session-9-era tenant without one attributes to the
    // owner's human actor, named in the event payload either way.
    const { data: biz, error: bizError } = await db
      .from("businesses")
      .select("id, account_id")
      .eq("id", businessId)
      .maybeSingle();
    if (bizError || !biz) throw new Error(`business lookup failed: ${bizError?.message ?? "not found"}`);
    const { data: wfActor } = await db
      .from("actors")
      .select("id")
      .eq("account_id", biz.account_id)
      .eq("actor_type", "workflow")
      .is("archived_at", null)
      .maybeSingle();
    let actorId = wfActor?.id as string | undefined;
    if (!actorId) {
      const { data: ownerMembership } = await db
        .from("memberships")
        .select("user_id")
        .eq("business_id", businessId)
        .eq("role", "owner")
        .is("archived_at", null)
        .limit(1)
        .maybeSingle();
      const { data: ownerActor } = ownerMembership
        ? await db
            .from("actors")
            .select("id")
            .eq("user_id", ownerMembership.user_id)
            .eq("actor_type", "human")
            .is("archived_at", null)
            .maybeSingle()
        : { data: null };
      actorId = ownerActor?.id;
    }
    if (!actorId) throw new Error("No workflow or owner actor to attribute the un-earn to");
    const { unearned } = await unearnFirstLightPredicate(db, {
      businessId,
      predicateKey: key,
      actorId,
      reason,
    });
    console.log(
      unearned
        ? `Unearned ${key} — the strike and its reason are on The Record; the task reopened.`
        : `${key} was not satisfied — nothing to unearn.`
    );
    return;
  }

  if (providerKey === "demo-flip") {
    // Retirement-demonstration flips for rows whose machinery does not exist
    // yet — allowed ONLY for those keys, and the ledger event states it.
    const key = demoKey as FirstLightPredicateKey;
    const arrival = FIRST_LIGHT_PENDING_ARRIVALS[key];
    if (!arrival) {
      console.error(
        `"${demoKey}" is not a pending-arrival row — its tick must be EARNED (use the connect drive or the product).`
      );
      process.exit(1);
    }
    const { data: wf, error: wfError } = await db
      .from("businesses")
      .select("account_id")
      .eq("id", businessId)
      .maybeSingle();
    if (wfError || !wf) throw new Error(`business lookup failed: ${wfError?.message ?? "not found"}`);
    const { data: wfActor } = await db
      .from("actors")
      .select("id")
      .eq("account_id", wf.account_id)
      .eq("actor_type", "workflow")
      .is("archived_at", null)
      .maybeSingle();
    if (!wfActor) throw new Error("No workflow actor to attribute the flip to");
    const { flipped, completedFirstLight } = await satisfyFirstLightPredicate(db, {
      businessId,
      predicateKey: key,
      actorId: wfActor.id,
      payload: {
        demonstration: true,
        note: `Service-side demonstration flip for the Session 11 DoD — the real check ${arrival}; this tick was driven, not earned.`,
      },
    });
    console.log(
      flipped
        ? `Demo-flipped ${key}.${completedFirstLight ? " First Light is COMPLETE — the pill retires on next load." : ""}`
        : `${key} was already satisfied.`
    );
    return;
  }

  const provider = PROVIDERS[providerKey as keyof typeof PROVIDERS];
  if (!provider) {
    console.error("Usage: first-light-drive <business_id> <mail|whatsapp|meta>");
    process.exit(1);
  }

  const { data: business, error: bizError } = await db
    .from("businesses")
    .select("id, name, account_id")
    .eq("id", businessId)
    .maybeSingle();
  if (bizError || !business) throw new Error(`business lookup failed: ${bizError?.message ?? "not found"}`);

  const { data: owner, error: ownerError } = await db
    .from("memberships")
    .select("user_id, role")
    .eq("business_id", businessId)
    .eq("role", "owner")
    .is("archived_at", null)
    .limit(1)
    .maybeSingle();
  if (ownerError || !owner) throw new Error(`owner membership lookup failed: ${ownerError?.message ?? "none"}`);
  const { data: ownerActor, error: actorError } = await db
    .from("actors")
    .select("id")
    .eq("user_id", owner.user_id)
    .eq("actor_type", "human")
    .is("archived_at", null)
    .maybeSingle();
  if (actorError || !ownerActor) throw new Error(`owner actor lookup failed: ${actorError?.message ?? "none"}`);

  // The connection: an integration actor + its grant — the same rows a real
  // connect flow creates. Idempotent on the actor's display name.
  let { data: integration } = await db
    .from("actors")
    .select("id")
    .eq("account_id", business.account_id)
    .eq("actor_type", "integration")
    .eq("display_name", provider.actorName)
    .is("archived_at", null)
    .maybeSingle();
  if (!integration) {
    const { data: created, error } = await db
      .from("actors")
      .insert({
        account_id: business.account_id,
        actor_type: "integration",
        display_name: provider.actorName,
      })
      .select("id")
      .single();
    if (error) throw new Error(`integration actor insert failed: ${error.message}`);
    integration = created;
  }

  const { data: existingGrant } = await db
    .from("grants")
    .select("id")
    .eq("business_id", businessId)
    .eq("grantee_actor_id", integration!.id)
    .eq("tool", provider.tool)
    .is("revoked_at", null)
    .is("archived_at", null)
    .maybeSingle();
  if (!existingGrant) {
    const { data: grant, error } = await db
      .from("grants")
      .insert({
        business_id: businessId,
        created_by: ownerActor.id,
        grantee_actor_id: integration!.id,
        tool: provider.tool,
        access: "execute",
        scope: { level: "business", ref: businessId },
        duration: "standing",
        granted_by_actor_id: ownerActor.id,
        via: "dashboard",
      })
      .select("id")
      .single();
    if (error) throw new Error(`grant insert failed: ${error.message}`);
    await emitEvent(db, {
      business_id: businessId,
      actor_id: ownerActor.id,
      action: "grant.issued",
      entity_type: "grant",
      entity_id: grant.id,
      payload: {
        grantee_actor_id: integration!.id,
        tool: provider.tool,
        access: "execute",
        scope: { level: "business", ref: businessId },
        duration: "standing",
        via: "dashboard",
        note: "service-side connect (first-light-drive) — OAuth wiring arrives with its session",
      },
    });
    console.log(`Grant issued: ${provider.tool} → ${provider.actorName}.`);
  } else {
    console.log(`Grant already live: ${provider.tool} → ${provider.actorName}.`);
  }

  // The ordinary evaluator earns the tick from the grant state it observes.
  const flipped = await evaluateConnectionPredicates(db, businessId);
  const key = Object.entries(CONNECTION_PREDICATE_TOOLS).find(([, t]) => t === provider.tool)?.[0];
  console.log(
    flipped.length
      ? `Predicates earned: ${flipped.join(", ")}.`
      : `No predicate flipped (already satisfied, or "${key}" not present for ${business.name}).`
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
