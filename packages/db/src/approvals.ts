import type { SupabaseClient } from "@supabase/supabase-js";
import { emitEvent } from "./events";
import type { EventRow } from "./types";

/**
 * The approval pipeline, app side (Spec 3 §6).
 *
 * Migration 0017 closed communications.status to direct update: the database
 * functions called here are the only paths that can move it. These helpers
 * perform the act, then put it on the ledger through emitEvent() — the single
 * write path for events. Everything structural (human stamp, approvals.comms
 * grant, readiness pre-flight, the rejection-reason requirement) is enforced
 * by the database inside the rpc, not by this file being well-behaved.
 */

export interface SubmitCommunicationInput {
  business_id: string;
  communication_id: string;
  /** The drafter — submission is the drafter's act (Spec 3 §4). */
  actor_id: string;
}

/** Draft → pending_approval: the message joins the Approval Inbox. */
export async function submitCommunication(
  db: SupabaseClient,
  input: SubmitCommunicationInput
): Promise<EventRow> {
  const { error } = await db.rpc("submit_communication", {
    p_comm: input.communication_id,
    p_actor: input.actor_id,
  });
  if (error) {
    throw new Error(`submit_communication failed: ${error.message}`);
  }
  return emitEvent(db, {
    business_id: input.business_id,
    actor_id: input.actor_id,
    action: "communication.submitted",
    entity_type: "communication",
    entity_id: input.communication_id,
  });
}

export interface ApproveCommunicationInput {
  business_id: string;
  communication_id: string;
  /** Must be a human holding approvals.comms execute (or the owner). */
  approver_actor_id: string;
}

/**
 * Pending → approved: the Level 3 stamp. The row is stamped by the database,
 * the act is evented with its approval envelope, and the row is pointed back
 * at its approval event so the trail walks both ways.
 */
export async function approveCommunication(
  db: SupabaseClient,
  input: ApproveCommunicationInput
): Promise<EventRow> {
  const { error } = await db.rpc("approve_communication", {
    p_comm: input.communication_id,
    p_approver: input.approver_actor_id,
  });
  if (error) {
    throw new Error(`approve_communication failed: ${error.message}`);
  }
  const event = await emitEvent(db, {
    business_id: input.business_id,
    actor_id: input.approver_actor_id,
    action: "communication.approved",
    entity_type: "communication",
    entity_id: input.communication_id,
    approval: {
      level: 3,
      approved_by: input.approver_actor_id,
      decided_at: new Date().toISOString(),
    },
  });
  const { error: linkError } = await db
    .from("communications")
    .update({ approval_event_id: event.id })
    .eq("id", input.communication_id);
  if (linkError) {
    throw new Error(`stamping approval_event_id failed: ${linkError.message}`);
  }
  return event;
}

export interface RejectCommunicationInput {
  business_id: string;
  communication_id: string;
  /** Same authority as approving: refusing the stamp is stamp authority. */
  rejected_by_actor_id: string;
  reason: string;
}

/**
 * Pending → draft: back to the drafter's queue, reason recorded on the row
 * (structurally required by the database) and on the ledger.
 */
export async function rejectCommunication(
  db: SupabaseClient,
  input: RejectCommunicationInput
): Promise<EventRow> {
  const reason = input.reason?.trim();
  if (!reason) {
    throw new Error("Rejection requires a reason — it is recorded for the drafter and the ledger.");
  }
  const { error } = await db.rpc("reject_communication", {
    p_comm: input.communication_id,
    p_rejected_by: input.rejected_by_actor_id,
    p_reason: reason,
  });
  if (error) {
    throw new Error(`reject_communication failed: ${error.message}`);
  }
  return emitEvent(db, {
    business_id: input.business_id,
    actor_id: input.rejected_by_actor_id,
    action: "communication.rejected",
    entity_type: "communication",
    entity_id: input.communication_id,
    payload: { reason, returned_to: "draft" },
  });
}
