"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { approveCommunication, rejectCommunication } from "@rooshni/db";

import { getAppContext } from "@/lib/server/context";
import { dispatchAfterApproval } from "@/lib/server/outbound";
import { isUuid } from "@/lib/server/queries";

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
  const failures: string[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const results = await Promise.allSettled(
      ids.slice(i, i + CHUNK).map((communicationId) =>
        rejectCommunication(db, {
          business_id: business.id,
          communication_id: communicationId,
          rejected_by_actor_id: actor.id,
          reason,
        })
      )
    );
    for (const r of results) {
      if (r.status === "fulfilled") rejected += 1;
      else failures.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
    }
  }

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
