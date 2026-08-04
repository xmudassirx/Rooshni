"use server";

import { revalidatePath } from "next/cache";
import { setEngagementRoute } from "@rooshni/db";
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
