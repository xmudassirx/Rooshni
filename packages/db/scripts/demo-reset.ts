import type { SupabaseClient } from "@supabase/supabase-js";
import { loadEnv } from "./env";
import { createServiceClient } from "../src/client";
import { emitEvent } from "../src/events";
import { cancelWorkflowRun, startWorkflowRun } from "../src/workflow";
import { metaLeadFixtures } from "../seed/fixtures/meta-leads";

/**
 * Session 6 demo reset — returns the two fixture leads to "New lead" so the
 * founder can watch the MVP workflow run end to end on the compressed clock.
 *
 *   npm run demo:reset --workspace=@rooshni/db
 *
 * Everything here is reversible and on the record: live runs are CANCELLED
 * through the gated pipeline (as Mudassir), stale workflow drafts are soft-
 * ARCHIVED (never deleted), open workflow tasks are cancelled, and the stage
 * move back to New lead goes through move_engagement_stage like every other
 * stage move. Each act is evented. Nothing touches the ledger's history.
 */

const BUSINESS_ID = "01980000-0000-7000-8000-000000000002";
const ACTOR_MUDASSIR = "01980000-0000-7000-8000-000000000011";
const NEW_LEAD_STAGE_KEY = "new_lead";
const DEFINITION_KEY = "meta_lead_to_consultation";

async function findLead(db: SupabaseClient, leadId: string) {
  const { data, error } = await db
    .from("engagements")
    .select("id, title, stage_id, template_type_id")
    .contains("external_refs", JSON.stringify([{ system: "meta", external_id: leadId }]))
    .limit(1);
  if (error) throw new Error(`engagement lookup failed: ${error.message}`);
  if (!data?.[0]) throw new Error(`No engagement for Meta lead ${leadId} — run the seed first.`);
  return data[0];
}

async function main() {
  loadEnv();
  const db = createServiceClient();

  const { data: definitions, error: defError } = await db
    .from("workflow_definitions")
    .select("id, key, status")
    .eq("business_id", BUSINESS_ID)
    .eq("key", DEFINITION_KEY)
    .eq("status", "active")
    .is("archived_at", null)
    .order("version", { ascending: false })
    .limit(1);
  if (defError) throw new Error(`definition lookup failed: ${defError.message}`);
  const definition = definitions?.[0];
  if (!definition) throw new Error(`No active "${DEFINITION_KEY}" definition — run the seed first.`);

  const { data: engineActors, error: actorError } = await db
    .from("actors")
    .select("id")
    .eq("actor_type", "workflow")
    .is("archived_at", null)
    .limit(1);
  if (actorError) throw new Error(`workflow actor lookup failed: ${actorError.message}`);
  const engineActor = engineActors?.[0];
  if (!engineActor) throw new Error("No workflow actor — run the seed first.");
  const { data: agents, error: agentError } = await db
    .from("actors")
    .select("id")
    .eq("actor_type", "agent")
    .is("archived_at", null)
    .limit(1);
  if (agentError) throw new Error(`agent actor lookup failed: ${agentError.message}`);
  const drafter = agents?.[0];
  if (!drafter) throw new Error("No agent (Light) actor — run the seed first.");

  for (const fixture of metaLeadFixtures) {
    const lead = fixture.lead;
    const engagement = await findLead(db, lead.id);
    console.log(`\nResetting: ${engagement.title}`);

    // 1. Cancel any live run (gated pipeline, evented, as Mudassir).
    const { data: liveRuns, error: runsError } = await db
      .from("workflow_runs")
      .select("id, status")
      .eq("engagement_id", engagement.id)
      .not("status", "in", "(completed,cancelled)");
    if (runsError) throw new Error(`run lookup failed: ${runsError.message}`);
    for (const run of liveRuns ?? []) {
      await cancelWorkflowRun(db, {
        business_id: BUSINESS_ID,
        run_id: run.id,
        actor_id: ACTOR_MUDASSIR,
        reason: "Demo reset — restarting the watch from New lead.",
      });
      console.log(`  cancelled live run ${run.id} (was ${run.status})`);
    }

    // 2. Soft-archive stale outbound drafts/pending items so the inbox is
    //    clean for the watch. Archive only — nothing is deleted.
    const { data: staleComms, error: commsError } = await db
      .from("communications")
      .select("id, status")
      .eq("engagement_id", engagement.id)
      .eq("direction", "outbound")
      .in("status", ["draft", "pending_approval"])
      .is("archived_at", null);
    if (commsError) throw new Error(`stale draft lookup failed: ${commsError.message}`);
    for (const comm of staleComms ?? []) {
      const { error } = await db
        .from("communications")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", comm.id);
      if (error) throw new Error(`archiving draft ${comm.id} failed: ${error.message}`);
      await emitEvent(db, {
        business_id: BUSINESS_ID,
        actor_id: ACTOR_MUDASSIR,
        action: "communication.archived",
        entity_type: "communication",
        entity_id: comm.id,
        payload: { reason: "demo_reset", was_status: comm.status },
      });
      console.log(`  archived stale ${comm.status} draft ${comm.id}`);
    }

    // 3. Cancel open workflow-created tasks from earlier runs.
    const { data: staleTasks, error: tasksError } = await db
      .from("tasks")
      .select("id, title")
      .eq("engagement_id", engagement.id)
      .not("workflow_run_id", "is", null)
      .in("status", ["open", "in_progress", "blocked"])
      .is("archived_at", null);
    if (tasksError) throw new Error(`stale task lookup failed: ${tasksError.message}`);
    for (const task of staleTasks ?? []) {
      const { error } = await db.from("tasks").update({ status: "cancelled" }).eq("id", task.id);
      if (error) throw new Error(`cancelling task ${task.id} failed: ${error.message}`);
      await emitEvent(db, {
        business_id: BUSINESS_ID,
        actor_id: ACTOR_MUDASSIR,
        action: "task.cancelled",
        entity_type: "task",
        entity_id: task.id,
        payload: { reason: "demo_reset", title: task.title },
      });
      console.log(`  cancelled workflow task "${task.title}"`);
    }

    // 4. Back to New lead — through the stage door, like every stage move.
    const { data: stages, error: stageError } = await db
      .from("stage_definitions")
      .select("id, key")
      .eq("engagement_type_id", engagement.template_type_id)
      .eq("key", NEW_LEAD_STAGE_KEY)
      .is("archived_at", null)
      .limit(1);
    if (stageError) throw new Error(`stage lookup failed: ${stageError.message}`);
    const newLead = stages?.[0];
    if (!newLead) throw new Error(`No "${NEW_LEAD_STAGE_KEY}" stage — run the seed first.`);
    if (engagement.stage_id !== newLead.id) {
      const { error } = await db.rpc("move_engagement_stage", {
        p_engagement: engagement.id,
        p_to_stage: newLead.id,
        p_moved_by: ACTOR_MUDASSIR,
      });
      if (error) throw new Error(`move_engagement_stage failed: ${error.message}`);
      await emitEvent(db, {
        business_id: BUSINESS_ID,
        actor_id: ACTOR_MUDASSIR,
        action: "engagement.stage_changed",
        entity_type: "engagement",
        entity_id: engagement.id,
        payload: { to_stage: NEW_LEAD_STAGE_KEY, reason: "demo_reset" },
      });
      console.log(`  moved back to New lead`);
    } else {
      console.log(`  already at New lead`);
    }

    // 5. Start the run: if this lead's engagement.created trigger event was
    //    never consumed, the next tick starts the run itself (the production
    //    path); otherwise start one on the record as a manual demo restart.
    const { data: triggerEvents, error: eventError } = await db
      .from("events")
      .select("id")
      .eq("business_id", BUSINESS_ID)
      .eq("action", "engagement.created")
      .eq("entity_id", engagement.id)
      .order("occurred_at", { ascending: true })
      .limit(1);
    if (eventError) throw new Error(`trigger event lookup failed: ${eventError.message}`);
    const triggerEvent = triggerEvents?.[0];

    let consumed = false;
    if (triggerEvent) {
      const { data: consumers, error: consumerError } = await db
        .from("workflow_runs")
        .select("id")
        .eq("definition_id", definition.id)
        .eq("context->>trigger_event_id", triggerEvent.id)
        .limit(1);
      if (consumerError) throw new Error(`consumer lookup failed: ${consumerError.message}`);
      consumed = (consumers ?? []).length > 0;
    }

    if (triggerEvent && !consumed) {
      console.log(`  trigger event unconsumed — the next tick will start this run itself`);
    } else {
      const runId = await startWorkflowRun(db, {
        business_id: BUSINESS_ID,
        definition_id: definition.id,
        definition_key: DEFINITION_KEY,
        engagement_id: engagement.id,
        engine_actor_id: engineActor.id,
        drafter_actor_id: drafter.id,
        context: { manual_start: true, reason: "demo_reset" },
      });
      console.log(`  run started: ${runId}`);
    }
  }

  console.log(
    "\nReset complete. Start the clock with `npm run tick:watch --workspace=@rooshni/db` and watch the inbox."
  );
}

main().catch((err) => {
  console.error("demo reset failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
