import { loadEnv } from "./env";
import { createServiceClient } from "../src/client";
import { cancelWorkflowRun } from "../src/workflow";

/**
 * Session 23 (WS6) — the founder-run live step after 0038: retire the
 * still-live runs the v3 replay spawned (the 116-burst). A replay run is a
 * LIVE run whose (business, workflow key, trigger event) claim — backfilled
 * keep-earliest by 0038 — belongs to an EARLIER run: the event was already
 * consumed when this run started.
 *
 *   npm run chore:cancel-replay-runs --workspace=@rooshni/db [-- --dry-run]
 *
 * Decision 55 shape exactly: cancellation through the gated
 * cancel_workflow_run pipeline, attributed to the business's workflow actor,
 * every act evented (workflow.run_cancelled with the stated reason), nothing
 * deleted — the run rows remain history.
 */

const REASON =
  "replay of an already-consumed trigger (the s22 116-burst; retired by the s23 WS6 consumption fix)";

const LIVE_STATUSES = ["running", "waiting", "blocked", "paused"];

async function main() {
  loadEnv();
  const dryRun = process.argv.includes("--dry-run");
  const db = createServiceClient();

  const { data: runs, error: runsError } = await db
    .from("workflow_runs")
    .select("id, business_id, definition_id, status, created_at, trigger_event_id:context->>trigger_event_id")
    .in("status", LIVE_STATUSES)
    .is("archived_at", null)
    .not("context->trigger_event_id", "is", null);
  if (runsError) throw new Error(`live run scan failed: ${runsError.message}`);
  if (!runs?.length) {
    console.log("No live triggered runs at all — nothing to inspect.");
    return;
  }

  const definitionIds = [...new Set(runs.map((r) => r.definition_id as string))];
  const { data: defs, error: defsError } = await db
    .from("workflow_definitions")
    .select("id, key")
    .in("id", definitionIds);
  if (defsError) throw new Error(`definition lookup failed: ${defsError.message}`);
  const keyByDefinition = new Map((defs ?? []).map((d) => [d.id as string, d.key as string]));

  const businessIds = [...new Set(runs.map((r) => r.business_id as string))];
  const { data: claims, error: claimsError } = await db
    .from("workflow_trigger_consumptions")
    .select("business_id, workflow_key, trigger_event_id, run_id")
    .in("business_id", businessIds);
  if (claimsError) throw new Error(`claims lookup failed: ${claimsError.message}`);
  const claimOwner = new Map(
    (claims ?? []).map((c) => [`${c.business_id}|${c.workflow_key}|${c.trigger_event_id}`, c.run_id as string])
  );

  // The workflow actor per business — the D93 attribution, one per account.
  const actorByBusiness = new Map<string, string>();
  for (const businessId of businessIds) {
    const { data: biz } = await db.from("businesses").select("account_id").eq("id", businessId).maybeSingle();
    if (!biz) continue;
    const { data: actors } = await db
      .from("actors")
      .select("id")
      .eq("account_id", biz.account_id)
      .eq("actor_type", "workflow")
      .is("archived_at", null);
    if (actors?.length === 1) actorByBusiness.set(businessId, actors[0]!.id as string);
  }

  let cancelled = 0;
  let kept = 0;
  const failures: string[] = [];
  for (const run of runs) {
    const key = keyByDefinition.get(run.definition_id as string);
    const eventId = run.trigger_event_id as string | null;
    if (!key || !eventId) {
      kept += 1;
      continue;
    }
    const owner = claimOwner.get(`${run.business_id}|${key}|${eventId}`);
    if (!owner || owner === run.id) {
      kept += 1;
      continue; // this run IS the consumption — it stands.
    }
    const actor = actorByBusiness.get(run.business_id as string);
    if (!actor) {
      failures.push(`${run.id}: no unique workflow actor for business ${run.business_id}`);
      continue;
    }
    if (dryRun) {
      console.log(`DRY RUN — would cancel ${run.id} (${key}, event ${eventId}, claim held by ${owner})`);
      cancelled += 1;
      continue;
    }
    try {
      await cancelWorkflowRun(db, {
        business_id: run.business_id as string,
        run_id: run.id as string,
        actor_id: actor,
        reason: REASON,
      });
      cancelled += 1;
      console.log(`Cancelled replay run ${run.id} (${key}) — evented, reason stated.`);
    } catch (err) {
      failures.push(`${run.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(
    `${dryRun ? "DRY RUN: " : ""}${cancelled} replay run(s) ${dryRun ? "would be " : ""}cancelled · ` +
      `${kept} legitimate live run(s) untouched · ${failures.length} failure(s).`
  );
  for (const f of failures) console.error(`  ERROR ${f}`);
  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
