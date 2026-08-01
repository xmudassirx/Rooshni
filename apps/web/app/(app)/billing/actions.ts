"use server";

import { revalidatePath } from "next/cache";
import { emitEvent, FIRST_LIGHT_EVENT_KINDS } from "@rooshni/db";
import { getAppContext } from "@/lib/server/context";

/**
 * Session 22 (WS2, ruling 2b) — the caps door: businesses.settings.ai_budget
 * gains soft_cap and hard_cap (monthly, GBP, both optional), owner-set from
 * Billing & usage. The setting is data; the ENFORCEMENT is server-side in
 * the drafting path (guardGenerationBudget) — this action only records the
 * owner's choice, evented.
 */

export interface AiBudgetActionState {
  error: string | null;
  saved?: boolean;
}

function parseCap(raw: FormDataEntryValue | null, label: string): number | null | { error: string } {
  const text = String(raw ?? "").trim();
  if (text === "") return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) {
    return { error: `${label} must be a positive amount in pounds (or blank for no cap).` };
  }
  return Math.round(value * 100) / 100;
}

export async function setAiBudgetAction(
  _prev: AiBudgetActionState,
  formData: FormData
): Promise<AiBudgetActionState> {
  const soft = parseCap(formData.get("soft_cap"), "The soft cap");
  if (soft !== null && typeof soft === "object") return soft;
  const hard = parseCap(formData.get("hard_cap"), "The hard cap");
  if (hard !== null && typeof hard === "object") return hard;
  if (soft !== null && hard !== null && hard < soft) {
    return { error: "The hard cap sits at or above the soft cap — warn first, stop second." };
  }

  const { db, business, actor, membershipRole } = await getAppContext();
  if (membershipRole !== "owner") {
    return { error: "The caps are the owner's pen — ask the owner to change them." };
  }

  const { data: bizRow, error: readError } = await db
    .from("businesses")
    .select("settings")
    .eq("id", business.id)
    .maybeSingle();
  if (readError || !bizRow) return { error: `Settings read failed: ${readError?.message ?? "no row"}` };

  const settings = { ...((bizRow.settings as Record<string, unknown>) ?? {}) };
  const budget: Record<string, number> = {};
  if (soft !== null) budget.soft_cap = soft;
  if (hard !== null) budget.hard_cap = hard;
  if (Object.keys(budget).length > 0) settings.ai_budget = budget;
  else delete settings.ai_budget;

  const { error: writeError } = await db.from("businesses").update({ settings }).eq("id", business.id);
  if (writeError) return { error: `Save failed: ${writeError.message}` };

  await emitEvent(db, {
    business_id: business.id,
    actor_id: actor.id,
    action: FIRST_LIGHT_EVENT_KINDS.settingsUpdated,
    entity_type: "business",
    entity_id: business.id,
    payload: { keys: ["ai_budget"], soft_cap_gbp: soft, hard_cap_gbp: hard },
  });

  revalidatePath("/billing");
  revalidatePath("/dashboard");
  return { error: null, saved: true };
}
