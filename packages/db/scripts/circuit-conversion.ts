import { loadEnv } from "./env";
import { createServiceClient } from "../src/client";
import { emitEvent } from "../src/events";
import { resolveConversionsConfig, sweepConversions } from "../src/conversions";

/**
 * DoD circuit helper (Session 22, WS1): stage the founder's witnessing step
 * for DoD (1) — move a TEST enquiry to consultation_booked through the gated
 * stage pipeline (as the owner's own actor), then run the real conversions
 * sweep once so the Schedule event leaves for Meta immediately instead of
 * waiting for the next cron tick.
 *
 *   npm run circuit:conversion --workspace=@rooshni/db -- --engagement <id>
 *
 * Pre-conditions it CHECKS and reports honestly (it never force-fixes):
 * the business's Conversions toggle is ON, a dataset id is set, and
 * META_ACCESS_TOKEN exists. Set a test_event_code first so the event lands
 * in Events Manager's TEST stream and pollutes nothing.
 *
 * Nothing here approves, publishes or sends a communication; the only write
 * outside the sweep's own evented sends is one gated stage move, evented.
 */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  loadEnv();
  const db = createServiceClient();

  const engagementId = arg("engagement");
  if (!engagementId) {
    console.error("Usage: npm run circuit:conversion --workspace=@rooshni/db -- --engagement <id>");
    process.exit(1);
  }

  const { data: engagements, error: engError } = await db
    .from("engagements")
    .select("id, business_id, template_type_id, stage_id, title, attribution")
    .eq("id", engagementId)
    .limit(1);
  if (engError) throw new Error(`engagement lookup failed: ${engError.message}`);
  const engagement = engagements?.[0];
  if (!engagement) throw new Error(`Engagement ${engagementId} not found.`);
  if ((engagement.attribution as Record<string, unknown> | null)?.source !== "meta") {
    throw new Error("This enquiry is not Meta-sourced — the ruled isolation (1e) means no conversion would fire.");
  }

  const { data: biz } = await db
    .from("businesses")
    .select("id, account_id, settings")
    .eq("id", engagement.business_id)
    .maybeSingle();
  if (!biz) throw new Error("Business not found.");
  const config = resolveConversionsConfig(biz.settings as Record<string, unknown>);
  console.log(
    `Pre-check: toggle ${config.enabled ? "ON" : "OFF"} · dataset ${config.dataset_id ?? "NOT SET"} · ` +
      `test code ${config.test_event_code ?? "not set"} · token ${process.env.META_ACCESS_TOKEN ? "present" : "MISSING"}`
  );
  if (!config.enabled) {
    console.error("The Conversions toggle is OFF (Settings → Integrations) — flip it first; nothing will fire.");
    process.exit(1);
  }

  // The owner's own human actor makes the move — the founder running this
  // chore IS the human (the install-multitouch-intro precedent).
  const { data: account } = await db.from("accounts").select("owner_user_id").eq("id", biz.account_id).maybeSingle();
  const { data: owners } = await db
    .from("actors")
    .select("id")
    .eq("account_id", biz.account_id)
    .eq("actor_type", "human")
    .eq("user_id", account?.owner_user_id ?? "")
    .is("archived_at", null)
    .limit(1);
  const ownerActor = owners?.[0]?.id;
  if (!ownerActor) throw new Error("No owner actor found for this business.");

  // Session 23 (priority fix, founder-ordered): stage_definitions is scoped
  // by ENGAGEMENT_TYPE_ID (no business_id exists on the table) — resolve via
  // the engagement's own type, the shape the v3 installer actually writes.
  const { data: stages, error: stageError } = await db
    .from("stage_definitions")
    .select("id, key, label")
    .eq("engagement_type_id", engagement.template_type_id)
    .eq("key", "consultation_booked")
    .is("archived_at", null)
    .limit(1);
  if (stageError || !stages?.[0]) {
    throw new Error(
      `No consultation_booked stage for this enquiry's engagement type (${engagement.template_type_id}).`
    );
  }

  if (engagement.stage_id === stages[0].id) {
    console.log("The enquiry already sits at Consultation booked — skipping the move; the sweep will still fire anything owed.");
  } else {
    const { error: moveError } = await db.rpc("move_engagement_stage", {
      p_engagement: engagement.id,
      p_to_stage: stages[0].id,
      p_moved_by: ownerActor,
    });
    if (moveError) throw new Error(`move_engagement_stage refused: ${moveError.message}`);
    await emitEvent(db, {
      business_id: engagement.business_id,
      actor_id: ownerActor,
      action: "engagement.stage_changed",
      entity_type: "engagement",
      entity_id: engagement.id,
      payload: { to_stage: "consultation_booked", circuit: "conversion_dod" },
    });
    console.log(`Moved "${engagement.title}" → ${stages[0].label} (gated pipeline, evented).`);
  }

  const report = await sweepConversions(db);
  console.log(
    `Sweep: ${report.conversions_sent} sent, ${report.conversions_failed} failed` +
      (report.skipped.length ? `; skipped: ${report.skipped.join(" | ")}` : "")
  );
  for (const err of report.errors) console.error(`  ERROR ${err}`);
  console.log(
    "Now check Meta Events Manager → your dataset → Test events (with the test code set) and The Record " +
      "(meta.conversion_sent) — the hashed payload as sent is on the event."
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
