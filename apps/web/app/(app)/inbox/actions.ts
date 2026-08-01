"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  approveCommunication,
  canWithdrawWorkflowDefinition,
  createServiceClient,
  emitEvent,
  rejectCommunication,
  withdrawWorkflowDefinition,
  DRAFTING_EVENT_KINDS,
} from "@rooshni/db";

import { getAppContext } from "@/lib/server/context";
import { dispatchAfterApproval } from "@/lib/server/outbound";
import { isUuid } from "@/lib/server/queries";
import { resolveSignOffAtStamp } from "@/lib/server/sign-off";

/**
 * Session 15 (PR-4) — the refine loop's capture: an edit-before-stamp or a
 * rejection reason is a training signal that lands in the append-only
 * draft_feedback table, evented. The signal is captured for AGENT-drafted
 * rows (Light's training loop); a hand-written draft's rejection carries no
 * drafter to train.
 */
async function recordRejectionFeedback(
  db: SupabaseClient,
  businessId: string,
  actorId: string,
  communicationIds: string[],
  reason: string
): Promise<void> {
  if (communicationIds.length === 0) return;
  try {
    const { data: comms } = await db
      .from("communications")
      .select("id, body, attributes, drafted_by_actor_id, created_by")
      .eq("business_id", businessId)
      .in("id", communicationIds);
    if (!comms?.length) return;

    const drafterIds = [...new Set(comms.map((c) => c.drafted_by_actor_id ?? c.created_by).filter(Boolean))];
    const { data: actors } = await db
      .from("actors")
      .select("id, actor_type")
      .in("id", drafterIds as string[]);
    const agentActors = new Set((actors ?? []).filter((a) => a.actor_type === "agent").map((a) => a.id));

    const { data: biz } = await db
      .from("businesses")
      .select("template_id")
      .eq("id", businessId)
      .maybeSingle();

    for (const comm of comms) {
      if (!agentActors.has(comm.drafted_by_actor_id ?? comm.created_by)) continue;
      const credit = ((comm.attributes ?? {}) as Record<string, unknown>).credit_line as
        | { knowledge_entry_ids?: unknown }
        | undefined;
      const packIds = Array.isArray(credit?.knowledge_entry_ids) ? credit.knowledge_entry_ids : [];
      const { data: feedback, error } = await db
        .from("draft_feedback")
        .insert({
          business_id: businessId,
          created_by: actorId,
          communication_id: comm.id,
          template_id: biz?.template_id ?? null,
          kind: "rejection",
          body_before: comm.body,
          reason,
          pack_entry_ids: packIds,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      await emitEvent(db, {
        business_id: businessId,
        actor_id: actorId,
        action: DRAFTING_EVENT_KINDS.draftFeedbackRecorded,
        entity_type: "draft_feedback",
        entity_id: feedback.id,
        payload: { kind: "rejection", communication_id: comm.id, reason },
      });
    }
  } catch (err) {
    // The rejection itself already landed and is evented — a feedback
    // hiccup must not unwind or mask it. Loud in the server log, honest
    // in the books.
    console.error("draft_feedback capture failed:", err instanceof Error ? err.message : err);
  }
}

export interface DecisionState {
  error: string | null;
  /** Session 11: the stamp landed — the card shows its transient
   * "✓ Stamped — on The Record" state before leaving the view. */
  stamped?: boolean;
}

/**
 * The stamp. approve_communication enforces everything structural inside the
 * database — human approver, approvals.comms authority, readiness pre-flight —
 * and the helper puts communication.approved on the ledger via emitEvent.
 */
export async function approveAction(
  _prev: DecisionState,
  formData: FormData
): Promise<DecisionState> {
  const communicationId = String(formData.get("communicationId") ?? "");
  if (!communicationId) return { error: "No communication was selected." };

  const { db, business, actor } = await getAppContext();
  // Session 16 (PR-F, decision 133e): approver-mode sign-off resolves on the
  // STORED body — the same deterministic transformation the card rendered —
  // with a fresh recorded compliance check on the exact resolved words,
  // before the stamp. A resolution failure withholds the stamp (fail
  // closed): the body that sends is always the body that was seen.
  const resolution = await resolveSignOffAtStamp(db, business, actor, communicationId);
  if (resolution.error) return { error: resolution.error };
  try {
    await approveCommunication(db, {
      business_id: business.id,
      communication_id: communicationId,
      approver_actor_id: actor.id,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Approval failed." };
  }
  // Session 10: the stamp is given — carry the message now (best-effort;
  // quiet hours hold it, and any transient failure leaves it approved for
  // the tick sweep). APPROVED ≠ SENT: a carriage problem never unwinds the
  // approval.
  await dispatchAfterApproval(communicationId);
  // Session 11 (founder-ruled at the Session 10 close): no redirect — the
  // card shows "✓ Stamped — on The Record" briefly, then the client
  // refreshes and the row leaves the stamps-owed view for History.
  return { error: null, stamped: true };
}

/**
 * The refusal. The database refuses a rejection without a reason; the UI
 * demands one first so the refusal reads as guidance, not an error.
 */
export async function rejectAction(
  _prev: DecisionState,
  formData: FormData
): Promise<DecisionState> {
  const communicationId = String(formData.get("communicationId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!communicationId) return { error: "No communication was selected." };
  if (!reason) {
    return {
      error: "A reason is required — it is recorded for the drafter and the ledger.",
    };
  }

  const { db, business, actor } = await getAppContext();
  // PR-4: capture the signal BEFORE the pipeline call — the body as it stood
  // when refused (rejection does not change it, but the read is honest).
  try {
    await rejectCommunication(db, {
      business_id: business.id,
      communication_id: communicationId,
      rejected_by_actor_id: actor.id,
      reason,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Rejection failed." };
  }
  await recordRejectionFeedback(db, business.id, actor.id, [communicationId], reason);
  revalidatePath("/", "layout");
  redirect("/inbox");
}

export interface BulkRejectState {
  error: string | null;
  /** How many refusals landed — each one its own event on The Record. */
  rejected?: number;
  failed?: number;
}

/**
 * Session 12: the bulk refusal. One shared reason, applied to every selected
 * draft — but there is no bulk act in the database. This loops the SAME
 * single-rejection pipeline per draft, so each refusal is its own
 * reject_communication call and its own communication.rejected event, with
 * the reason on its row and The Record, identical to rejecting one by hand.
 * Bulk APPROVAL deliberately does not exist — approvals are individual
 * stamps by constitution, and no action here may ever grow one.
 */
export async function bulkRejectAction(
  _prev: BulkRejectState,
  formData: FormData
): Promise<BulkRejectState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(formData.get("communicationIds") ?? "[]"));
  } catch {
    return { error: "The selection could not be read — please reselect and try again." };
  }
  const ids = Array.isArray(parsed)
    ? [...new Set(parsed.filter((id): id is string => typeof id === "string" && isUuid(id)))]
    : [];
  const reason = String(formData.get("reason") ?? "").trim();
  if (ids.length === 0) return { error: "No drafts were selected." };
  if (!reason) {
    return {
      error: "A shared reason is required — it is recorded on every draft and the ledger.",
    };
  }

  const { db, business, actor } = await getAppContext();

  // JUDGMENT: builder's call per the session prompt — no batch RPC, no
  // migration. The loop runs in small concurrent chunks so ~78 refusals fit
  // comfortably inside one server action; a failure in one draft (e.g. it
  // stopped being pending meanwhile) never stops the rest.
  const CHUNK = 8;
  let rejected = 0;
  const rejectedIds: string[] = [];
  const failures: string[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const results = await Promise.allSettled(
      chunk.map((communicationId) =>
        rejectCommunication(db, {
          business_id: business.id,
          communication_id: communicationId,
          rejected_by_actor_id: actor.id,
          reason,
        })
      )
    );
    results.forEach((r, idx) => {
      if (r.status === "fulfilled") {
        rejected += 1;
        rejectedIds.push(chunk[idx]!);
      } else {
        failures.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
      }
    });
  }

  // PR-4: every landed refusal is a training signal — the shared reason on
  // each agent-drafted row, one draft_feedback row per refusal.
  await recordRejectionFeedback(db, business.id, actor.id, rejectedIds, reason);

  revalidatePath("/", "layout");
  if (failures.length > 0) {
    return {
      error: failures[0] ?? "Some rejections failed.",
      rejected,
      failed: failures.length,
    };
  }
  return { error: null, rejected, failed: 0 };
}

export interface WithdrawDefinitionState {
  error: string | null;
  /** The withdrawal landed — the card shows its transient
   * "Withdrawn — on The Record" state before leaving the view. */
  withdrawn?: boolean;
}

/**
 * Session 21 (founder-ruled) — the stuck-definition escape hatch. An OWNER
 * withdraws a pending_approval workflow definition with a required reason:
 * terminal, frozen, evented, visible in History. The 0034 pipeline function
 * is the real gate (owner + pending + reason, enforced in the database);
 * this action is the face, and the wrapper puts the act on The Record.
 * Approve stays absent — the definition-approval pipeline is its own later
 * session (decision 116: no control that cannot act).
 */
export async function withdrawDefinitionAction(
  _prev: WithdrawDefinitionState,
  formData: FormData
): Promise<WithdrawDefinitionState> {
  const definitionId = String(formData.get("definitionId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!isUuid(definitionId)) return { error: "No definition was selected." };
  if (!reason) {
    return { error: "A reason is required. It is recorded on the row and the ledger." };
  }

  const { db, business, actor, membershipRole } = await getAppContext();
  if (membershipRole !== "owner") {
    return { error: "Withdrawing a pending definition is the owner's act." };
  }

  const { data: def, error: lookupError } = await db
    .from("workflow_definitions")
    .select("id, key, version, status")
    .eq("id", definitionId)
    .eq("business_id", business.id)
    .maybeSingle();
  if (lookupError) return { error: `Definition lookup failed: ${lookupError.message}` };
  if (!def) return { error: "That definition no longer exists." };
  if (!canWithdrawWorkflowDefinition({ status: def.status, isOwner: true })) {
    return { error: `Only a stamp-awaiting definition can be withdrawn. This one is "${def.status}".` };
  }

  try {
    await withdrawWorkflowDefinition(db, {
      business_id: business.id,
      definition_id: definitionId,
      actor_id: actor.id,
      reason,
      definition_key: def.key,
      definition_version: def.version,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Withdrawal failed." };
  }

  revalidatePath("/", "layout");
  return { error: null, withdrawn: true };
}

export interface EditDraftState {
  error: string | null;
  saved?: boolean;
}

/**
 * Session 15 (WS5, signed amendment 2) — edit-before-stamp. The edit lands
 * on the row, the pre-flight re-runs (the compliance heuristics re-screen
 * EXACTLY the edited words — WYSIWYS: the stamp approves these words and no
 * others), and the signal lands in draft_feedback with before/after.
 * Editing is a stamp-authority act: owner, or approvals.comms at execute.
 */
export async function editDraftAction(
  _prev: EditDraftState,
  formData: FormData
): Promise<EditDraftState> {
  const communicationId = String(formData.get("communicationId") ?? "");
  const newBody = String(formData.get("body") ?? "").trim();
  if (!isUuid(communicationId)) return { error: "No communication was selected." };
  if (!newBody) return { error: "A draft cannot be edited to nothing — reject it instead, with a reason." };

  const { db, business, actor, membershipRole } = await getAppContext();

  // Stamp authority: refusing, editing and approving are the same authority
  // (the decision 18 principle applied to the edit).
  if (membershipRole !== "owner") {
    const { data: grants } = await db
      .from("grants")
      .select("id")
      .eq("business_id", business.id)
      .eq("grantee_actor_id", actor.id)
      .eq("tool", "approvals.comms")
      .eq("access", "execute")
      .is("revoked_at", null)
      .is("archived_at", null)
      .limit(1);
    if (!grants?.length) {
      return { error: "Editing a draft before stamping is a stamp-authority act — approvals.comms is required." };
    }
  }

  const { data: comm, error: lookupError } = await db
    .from("communications")
    .select("id, body, status, attributes, compliance_required")
    .eq("id", communicationId)
    .eq("business_id", business.id)
    .maybeSingle();
  if (lookupError) return { error: `Draft lookup failed: ${lookupError.message}` };
  if (!comm) return { error: "That draft no longer exists." };
  if (comm.status !== "pending_approval") {
    return { error: `Only a stamp-awaiting draft can be edited — this one is "${comm.status}".` };
  }
  const bodyBefore = comm.body as string;
  if (newBody === bodyBefore.trim()) return { error: "Nothing changed." };

  const { error: updateError } = await db
    .from("communications")
    .update({ body: newBody })
    .eq("id", communicationId)
    .eq("business_id", business.id);
  if (updateError) return { error: `Edit failed: ${updateError.message}` };

  await emitEvent(db, {
    business_id: business.id,
    actor_id: actor.id,
    action: DRAFTING_EVENT_KINDS.draftEdited,
    entity_type: "communication",
    entity_id: communicationId,
    payload: { body_before: bodyBefore, body_after: newBody },
  });

  // The compliance check re-runs on the exact edited words (0026 — the old
  // check is stale by construction). The generation-time attestation carries
  // forward: the heuristics re-screen the words; the attestation attests the
  // generation. Server-only door, so the service client carries the call —
  // the caller was authenticated under RLS above (the first-light pattern).
  if (comm.compliance_required) {
    const service = createServiceClient();
    const { data: lastCheck } = await service
      .from("communication_compliance_checks")
      .select("attestation")
      .eq("communication_id", communicationId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const { error: checkError } = await service.rpc("run_compliance_check", {
      p_comm: communicationId,
      p_actor: actor.id,
      p_attestation: lastCheck?.attestation ?? null,
    });
    if (checkError) {
      // Fail closed and honest: the edit stands, the chip reads stale, the
      // stamp stays refused until a check lands.
      return { error: `The edit saved, but the compliance re-check failed: ${checkError.message}` };
    }
  }

  // PR-4: the edit is the refine signal.
  try {
    const credit = ((comm.attributes ?? {}) as Record<string, unknown>).credit_line as
      | { knowledge_entry_ids?: unknown }
      | undefined;
    const packIds = Array.isArray(credit?.knowledge_entry_ids) ? credit.knowledge_entry_ids : [];
    const { data: biz } = await db
      .from("businesses")
      .select("template_id")
      .eq("id", business.id)
      .maybeSingle();
    const { data: feedback, error: feedbackError } = await db
      .from("draft_feedback")
      .insert({
        business_id: business.id,
        created_by: actor.id,
        communication_id: communicationId,
        template_id: biz?.template_id ?? null,
        kind: "edit",
        body_before: bodyBefore,
        body_after: newBody,
        pack_entry_ids: packIds,
      })
      .select("id")
      .single();
    if (feedbackError) throw new Error(feedbackError.message);
    await emitEvent(db, {
      business_id: business.id,
      actor_id: actor.id,
      action: DRAFTING_EVENT_KINDS.draftFeedbackRecorded,
      entity_type: "draft_feedback",
      entity_id: feedback.id,
      payload: { kind: "edit", communication_id: communicationId },
    });
  } catch (err) {
    console.error("draft_feedback capture failed:", err instanceof Error ? err.message : err);
  }

  revalidatePath("/", "layout");
  return { error: null, saved: true };
}
