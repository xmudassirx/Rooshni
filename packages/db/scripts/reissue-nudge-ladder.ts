import { loadEnv } from "./env";
import { createServiceClient } from "../src/client";
import { emitEvent } from "../src/events";
import {
  chooseReissueAction,
  reissueNudgeLadderSteps,
  ruledLadderDescription,
  type LadderStep,
} from "../src/nudge-ladder";

/**
 * Session 26 (C4, founder-ruled 3 August 2026) — re-issue
 * meta_lead_to_consultation with the ruled nudge ladder as a NEW definition
 * version through the pipeline (decisions 40/102: a definition is immutable
 * once live; a change of behaviour is a new version, the install pointer
 * upgraded in place — re-issue, never rewrite).
 *
 *   npm run chore:reissue-nudge-ladder --workspace=@rooshni/db
 *   npm run chore:reissue-nudge-ladder --workspace=@rooshni/db -- --approve-as-owner
 *
 * The ladder (waits sequential after the intro stamp, all cancel-on-reply):
 * nudge 1 T+1d WhatsApp (fallback email) → nudge 2 T+3d email → nudge 3
 * T+6d final email → close wait 3d → auto-close ≈T+9d. The decision 96
 * refusal is config-independent and untouched. Default mode stops at
 * pending_approval — the stamp is the founder's; --approve-as-owner stamps
 * as the owner's own actor (the install-multitouch-intro precedent — the
 * founder running this IS the human in the loop) and pauses the superseded
 * version so exactly one version consumes triggers. Idempotent: a business
 * whose active version already carries the ruled ladder is skipped.
 *
 * Session 30 (WS B3, decision 169's v4/v5 incident): a re-run FINDS its own
 * earlier staging — a draft or pending_approval version already carrying the
 * ruled ladder is STAMPED (submitted first if still draft), never duplicated.
 * The issue-vs-stamp decision lives in chooseReissueAction (src/nudge-ladder)
 * so the harness proves the same logic. The resolved mode is logged before
 * any work, so a swallowed flag is visible immediately.
 */

async function main() {
  loadEnv();
  const approveAsOwner = process.argv.includes("--approve-as-owner");
  console.log(
    approveAsOwner
      ? "mode: --approve-as-owner — staging is stamped and the superseded version paused."
      : "mode: stage only (no --approve-as-owner) — the run stops at pending_approval."
  );
  const db = createServiceClient();

  const { data: defs, error: defsError } = await db
    .from("workflow_definitions")
    .select("id, business_id, key, version, template_id, trigger, status")
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
    console.log("No meta_lead_to_consultation definitions found — nothing to re-issue.");
    return;
  }

  for (const [businessId, versions] of byBusiness) {
    // Steps for every version the decision may consult: the active one (the
    // idempotency check) and any live staging (draft / pending_approval).
    const stepsByDefinitionId = new Map<string, LadderStep[]>();
    for (const def of versions) {
      if (!["active", "draft", "pending_approval"].includes(def.status)) continue;
      const { data: steps, error: stepsError } = await db
        .from("workflow_steps")
        .select("key, sort_order, kind, config, gate_level")
        .eq("definition_id", def.id)
        .is("archived_at", null)
        .order("sort_order");
      if (stepsError) throw new Error(`steps lookup failed: ${stepsError.message}`);
      stepsByDefinitionId.set(def.id, (steps ?? []) as LadderStep[]);
    }

    const decision = chooseReissueAction(versions, stepsByDefinitionId);
    if (decision.action === "skip") {
      console.log(`business ${businessId}: ${decision.reason} — skipped.`);
      continue;
    }
    const active = decision.active;
    const currentSteps = stepsByDefinitionId.get(active.id) ?? [];

    // The owner's own human actor — creator, submitter and (with the flag)
    // the stamp (the install-multitouch-intro precedent).
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

    // The stamp target: an existing staging found by the decision, or a
    // freshly issued version. Either way exactly one row ends up stamped.
    let targetId: string;
    let targetVersion: number;

    if (decision.action === "stamp") {
      const staged = decision.target;
      if (staged.status === "draft") {
        // A staging stranded at draft (a failed earlier run) — submit it
        // first. submit_workflow_definition requires the submitter be
        // created_by; a foreign draft fails here, visibly.
        const { error: submitError } = await db.rpc("submit_workflow_definition", {
          p_def: staged.id,
          p_actor: ownerActor,
        });
        if (submitError) throw new Error(`submit of staged v${staged.version} failed: ${submitError.message}`);
        await emitEvent(db, {
          business_id: businessId,
          actor_id: ownerActor,
          action: "workflow_definition.submitted",
          entity_type: "workflow_definition",
          entity_id: staged.id,
        });
      }
      if (!approveAsOwner) {
        console.log(
          `business ${businessId}: v${staged.version} is already staged at pending_approval — ` +
            `no new version issued; re-run with --approve-as-owner to stamp it and pause v${active.version}.`
        );
        continue;
      }
      console.log(
        `business ${businessId}: found own staging v${staged.version} — stamping it, not re-issuing.`
      );
      targetId = staged.id;
      targetVersion = staged.version;
    } else {
      const newVersion = decision.version;
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
          description_plain: ruledLadderDescription(),
        })
        .select("id")
        .single();
      if (createError) throw new Error(`v${newVersion} insert failed: ${createError.message}`);

      for (const step of reissueNudgeLadderSteps(currentSteps)) {
        const { error: stepError } = await db.from("workflow_steps").insert({
          business_id: businessId,
          created_by: ownerActor,
          definition_id: created.id,
          key: step.key,
          sort_order: step.sort_order,
          kind: step.kind,
          config: step.config,
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
        payload: {
          key: active.key,
          version: newVersion,
          note: "ruled nudge ladder T+1/T+3/T+6, close ≈T+9 (Session 26, C4, founder-ruled) — re-issue of the active version",
        },
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
      targetId = created.id;
      targetVersion = newVersion;
    }

    const { error: approveError } = await db.rpc("approve_workflow_definition", {
      p_def: targetId,
      p_approver: ownerActor,
    });
    if (approveError) throw new Error(`approve failed: ${approveError.message}`);
    await emitEvent(db, {
      business_id: businessId,
      actor_id: ownerActor,
      action: "workflow_definition.approved",
      entity_type: "workflow_definition",
      entity_id: targetId,
      approval: { level: 3, approved_by: ownerActor, decided_at: new Date().toISOString() },
      payload: { key: active.key, version: targetVersion },
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
      payload: { reason: `superseded by v${targetVersion} (ruled nudge ladder, Session 26)` },
    });

    console.log(`business ${businessId}: v${targetVersion} ACTIVE (owner stamp), v${active.version} paused.`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
