"use server";

import { revalidatePath } from "next/cache";
import { moveEngagementStageAsHuman, setEngagementRoute } from "@rooshni/db";
import { getAppContext } from "@/lib/server/context";
import { isUuid } from "@/lib/server/queries";

/*
 * Session 27 (D161c): human reclassification — the route field is editable
 * by any team member with enquiry access (member RLS is the access; the
 * 0042 door asserts the caller acts as their own human actor and writes
 * source 'human', final against machine writes). The change is evented with
 * the optional reason; past drafts are never retro-edited — future
 * retrieval follows the new route.
 */

export interface ReclassifyRouteState {
  error: string | null;
  saved?: boolean;
}

export async function reclassifyRouteAction(
  _prev: ReclassifyRouteState,
  formData: FormData
): Promise<ReclassifyRouteState> {
  const engagementId = String(formData.get("engagement_id") ?? "");
  const route = String(formData.get("route") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  if (!isUuid(engagementId)) return { error: "Unknown enquiry." };
  if (!route) return { error: "Choose a route from the template's list." };

  const { db, business, actor } = await getAppContext();
  try {
    await setEngagementRoute(db, {
      business_id: business.id,
      engagement_id: engagementId,
      route,
      source: "human",
      actor_id: actor.id,
      reason: reason || null,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  revalidatePath(`/enquiries/${engagementId}`);
  revalidatePath("/enquiries");
  return { error: null, saved: true };
}

/*
 * Session 30 (177f + 177d): the human stage move — any team member with
 * enquiry access (the 0015 stage_history grant check refuses everyone else;
 * this action is only the pen). Evented with the optional reason; a move to
 * the disqualified terminal cancels the enquiry's live workflow runs
 * through their own gated door, so drafts stop being generated.
 */

export interface MoveStageState {
  error: string | null;
  saved?: boolean;
  cancelledRuns?: number;
}

export async function moveStageAction(
  _prev: MoveStageState,
  formData: FormData
): Promise<MoveStageState> {
  const engagementId = String(formData.get("engagement_id") ?? "");
  const toStageId = String(formData.get("to_stage_id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!isUuid(engagementId)) return { error: "Unknown enquiry." };
  if (!isUuid(toStageId)) return { error: "Choose a stage from the template's list." };

  const { db, business, actor } = await getAppContext();
  // The enquiry must be this business's own (RLS refuses the read regardless).
  const { data: engagement } = await db
    .from("engagements")
    .select("id")
    .eq("id", engagementId)
    .eq("business_id", business.id)
    .is("archived_at", null)
    .maybeSingle();
  if (!engagement) return { error: "Unknown enquiry." };

  try {
    const moved = await moveEngagementStageAsHuman(db, {
      business_id: business.id,
      engagement_id: engagementId,
      to_stage_id: toStageId,
      actor_id: actor.id,
      reason: reason || undefined,
    });
    revalidatePath(`/enquiries/${engagementId}`);
    revalidatePath("/enquiries");
    revalidatePath("/record");
    return { error: null, saved: true, cancelledRuns: moved.cancelledRunIds.length };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
