import { loadEnv } from "./env";
import { createServiceClient } from "../src/client";
import { emitEvent } from "../src/events";

/**
 * Session 19 (PR-ii) — install the multi-touch intro as a NEW workflow
 * definition version (decision 40: an active definition is immutable; a
 * change of behaviour is a new version — re-issue, never rewrite).
 *
 *   npm run chore:install-multitouch-intro --workspace=@rooshni/db
 *   npm run chore:install-multitouch-intro --workspace=@rooshni/db -- --approve-as-owner
 *
 * For every business with an ACTIVE meta_lead_to_consultation definition:
 * copy its steps, add companion_channels ["whatsapp"] to the intro_ack
 * step's config, create version N+1 at draft and SUBMIT it (the definition
 * pipeline; the human stamp is decision 38's approvals.workflows gate).
 *
 * Default mode stops at pending_approval — the stamp is the founder's.
 * --approve-as-owner additionally approves AS THE OWNER'S OWN ACTOR (the
 * Session 6 seed precedent — the founder running this IS the stamp) and
 * pauses the previous version so exactly one version consumes triggers.
 * Idempotent: a business already holding a version with the companion
 * config is skipped.
 */

async function main() {
  loadEnv();
  const approveAsOwner = process.argv.includes("--approve-as-owner");
  const db = createServiceClient();

  const { data: defs, error: defsError } = await db
    .from("workflow_definitions")
    .select("id, business_id, key, version, template_id, trigger, status, description_plain")
    .eq("key", "meta_lead_to_consultation")
    .is("archived_at", null)
    .order("version", { ascending: false });
  if (defsError) throw new Error(`definition scan failed: ${defsError.message}`);

  const byBusiness = new Map<string, NonNullable<typeof defs>>();
  for (const def of defs ?? []) {
    const list = byBusiness.get(def.business_id) ?? [];
    list.push(def);
    byBusiness.set(def.business_id, list);
  }
  if (byBusiness.size === 0) {
    console.log("No meta_lead_to_consultation definitions found — nothing to install.");
    return;
  }

  for (const [businessId, versions] of byBusiness) {
    const active = versions.find((v) => v.status === "active");
    if (!active) {
      console.log(`business ${businessId}: no ACTIVE version — skipped (visible).`);
      continue;
    }

    const { data: steps, error: stepsError } = await db
      .from("workflow_steps")
      .select("key, sort_order, kind, config, gate_level")
      .eq("definition_id", active.id)
      .is("archived_at", null)
      .order("sort_order");
    if (stepsError) throw new Error(`steps lookup failed: ${stepsError.message}`);

    const intro = (steps ?? []).find((s) => s.key === "intro_ack");
    if (!intro) {
      console.log(`business ${businessId}: active version has no intro_ack step — skipped (visible).`);
      continue;
    }
    const introConfig = (intro.config ?? {}) as Record<string, unknown>;
    if (Array.isArray(introConfig.companion_channels) && introConfig.companion_channels.includes("whatsapp")) {
      console.log(`business ${businessId}: active v${active.version} already carries the multi-touch intro — skipped.`);
      continue;
    }

    // The owner's own human actor — creator, submitter and (with the flag)
    // the stamp. The founder running this chore IS the human in the loop.
    const { data: biz, error: bizError } = await db
      .from("businesses")
      .select("account_id")
      .eq("id", businessId)
      .maybeSingle();
    if (bizError || !biz) throw new Error(`business lookup failed: ${bizError?.message ?? "not found"}`);
    const { data: account, error: accError } = await db
      .from("accounts")
      .select("owner_user_id")
      .eq("id", biz.account_id)
      .maybeSingle();
    if (accError || !account?.owner_user_id) {
      console.log(`business ${businessId}: no owner user — skipped (visible).`);
      continue;
    }
    const { data: ownerActors, error: ownerError } = await db
      .from("actors")
      .select("id")
      .eq("account_id", biz.account_id)
      .eq("actor_type", "human")
      .eq("user_id", account.owner_user_id)
      .is("archived_at", null)
      .limit(1);
    if (ownerError || !ownerActors?.length) {
      console.log(`business ${businessId}: no owner actor — skipped (visible).`);
      continue;
    }
    const ownerActor = ownerActors[0]!.id as string;

    const newVersion = Math.max(...versions.map((v) => v.version)) + 1;
    const { data: created, error: createError } = await db
      .from("workflow_definitions")
      .insert({
        business_id: businessId,
        created_by: ownerActor,
        key: active.key,
        version: newVersion,
        template_id: active.template_id,
        trigger: active.trigger,
        status: "draft",
        description_plain:
          `${active.description_plain ?? ""} ` +
          `v${newVersion}: the intro is multi-touch — alongside the email intro, a WhatsApp template ` +
          `intro is drafted where the lead holds WhatsApp consent and the approved template mapping exists; ` +
          `two drafts, two individual stamps; the run still waits on the email stamp alone.`,
      })
      .select("id")
      .single();
    if (createError) throw new Error(`v${newVersion} insert failed: ${createError.message}`);

    for (const step of steps ?? []) {
      const config =
        step.key === "intro_ack"
          ? { ...(step.config as Record<string, unknown>), companion_channels: ["whatsapp"] }
          : step.config;
      const { error: stepError } = await db.from("workflow_steps").insert({
        business_id: businessId,
        created_by: ownerActor,
        definition_id: created.id,
        key: step.key,
        sort_order: step.sort_order,
        kind: step.kind,
        config,
        gate_level: step.gate_level,
      });
      if (stepError) throw new Error(`step copy (${step.key}) failed: ${stepError.message}`);
    }

    await emitEvent(db, {
      business_id: businessId,
      actor_id: ownerActor,
      action: "workflow_definition.created",
      entity_type: "workflow_definition",
      entity_id: created.id,
      payload: { key: active.key, version: newVersion, note: "multi-touch intro (Session 19, PR-ii) — re-issue of the active version" },
    });

    const { error: submitError } = await db.rpc("submit_workflow_definition", {
      p_def: created.id,
      p_actor: ownerActor,
    });
    if (submitError) throw new Error(`submit failed: ${submitError.message}`);
    await emitEvent(db, {
      business_id: businessId,
      actor_id: ownerActor,
      action: "workflow_definition.submitted",
      entity_type: "workflow_definition",
      entity_id: created.id,
    });

    if (!approveAsOwner) {
      console.log(
        `business ${businessId}: v${newVersion} staged at pending_approval — the stamp is yours ` +
          `(re-run with --approve-as-owner to stamp and pause v${active.version}).`
      );
      continue;
    }

    const { error: approveError } = await db.rpc("approve_workflow_definition", {
      p_def: created.id,
      p_approver: ownerActor,
    });
    if (approveError) throw new Error(`approve failed: ${approveError.message}`);
    await emitEvent(db, {
      business_id: businessId,
      actor_id: ownerActor,
      action: "workflow_definition.approved",
      entity_type: "workflow_definition",
      entity_id: created.id,
      approval: { level: 3, approved_by: ownerActor, decided_at: new Date().toISOString() },
      payload: { key: active.key, version: newVersion },
    });

    // Exactly one version consumes triggers: the superseded active version
    // pauses through its own gated pipeline, evented.
    const { error: pauseError } = await db.rpc("pause_workflow_definition", {
      p_def: active.id,
      p_actor: ownerActor,
    });
    if (pauseError) throw new Error(`pause of v${active.version} failed: ${pauseError.message}`);
    await emitEvent(db, {
      business_id: businessId,
      actor_id: ownerActor,
      action: "workflow_definition.paused",
      entity_type: "workflow_definition",
      entity_id: active.id,
      payload: { reason: `superseded by v${newVersion} (multi-touch intro)` },
    });

    console.log(`business ${businessId}: v${newVersion} ACTIVE (owner stamp), v${active.version} paused.`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
