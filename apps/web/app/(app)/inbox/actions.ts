"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { approveCommunication, rejectCommunication } from "@rooshni/db";

import { getAppContext } from "@/lib/server/context";

export interface DecisionState {
  error: string | null;
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
  try {
    await approveCommunication(db, {
      business_id: business.id,
      communication_id: communicationId,
      approver_actor_id: actor.id,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Approval failed." };
  }
  revalidatePath("/", "layout");
  redirect("/inbox");
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
  revalidatePath("/", "layout");
  redirect("/inbox");
}
