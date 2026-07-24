"use server";

import { revalidatePath } from "next/cache";
import {
  createServiceClient,
  emitEvent,
  evaluateBasicsPredicate,
  evaluateConnectionPredicates,
  FIRST_LIGHT_EVENT_KINDS,
  satisfyFirstLightPredicate,
  skipFirstLightRow,
} from "@rooshni/db";

import { getAppContext } from "@/lib/server/context";
import { getTemplateContent } from "@/lib/server/queries";

/**
 * First Light server actions (Session 11; decisions 82/84). Every flip is
 * server-evaluated: the browser asks, the server checks the deterministic
 * condition and writes through the service client — first_light_predicates
 * has no authenticated write path at all (0020), so these actions are the
 * only door and the database still refuses an uneventful flip.
 *
 * getAppContext() authenticates the caller under RLS and resolves their own
 * business + human actor before any service-client write; every act
 * attributes to that human (or, for observed state, the workflow actor
 * inside the evaluator).
 */

const BASICS_TEXT_KEYS = [
  "regulated_status",
  "address",
  "business_hours",
  "languages",
] as const;

export interface ConfirmBasicsInput {
  key: "business_name" | (typeof BASICS_TEXT_KEYS)[number] | "quiet_hours";
  value: string;
  quietHours?: { start: string; end: string };
}

export async function confirmBasicsRow(input: ConfirmBasicsInput): Promise<{ ok: boolean; error?: string }> {
  const { business, actor } = await getAppContext();
  const template = await getTemplateContent();
  const service = createServiceClient();

  const { data: biz, error: bizError } = await service
    .from("businesses")
    .select("id, name, settings")
    .eq("id", business.id)
    .maybeSingle();
  if (bizError || !biz) return { ok: false, error: bizError?.message ?? "business not found" };

  const settings = (biz.settings ?? {}) as Record<string, unknown>;
  const confirmed = (settings.basics_confirmed ?? {}) as Record<string, unknown>;

  let provenance: string;
  const patch: Record<string, unknown> = {};
  let newName: string | null = null;

  if (input.key === "business_name") {
    const value = input.value.trim();
    if (!value) return { ok: false, error: "The business name cannot be empty." };
    newName = value;
    provenance = "from your signup — already yours";
  } else if (input.key === "quiet_hours") {
    const qh = input.quietHours;
    if (!qh || !/^\d{2}:\d{2}$/.test(qh.start) || !/^\d{2}:\d{2}$/.test(qh.end)) {
      return { ok: false, error: "Quiet hours need start and end as HH:MM." };
    }
    patch.quiet_hours = { start: qh.start, end: qh.end };
    const isDefault =
      qh.start === (template?.quietHoursDefault.start ?? "20:00") &&
      qh.end === (template?.quietHoursDefault.end ?? "08:00");
    provenance = isDefault
      ? "our regulated-firm default — a suggestion, not a reading"
      : "set by you";
  } else if ((BASICS_TEXT_KEYS as readonly string[]).includes(input.key)) {
    const value = input.value.trim();
    if (!value) return { ok: false, error: "This row needs a value before it can be confirmed." };
    if (input.key === "regulated_status" && template?.regulatedStatusOptions.length) {
      const known = template.regulatedStatusOptions.includes(value);
      if (!known) return { ok: false, error: "Pick one of the template's regulated-status options." };
    }
    patch[input.key] = value;
    // Honest provenance: no crawl has run — nothing was "read from your
    // website"; the value is the human's own entry (decision 84).
    provenance = "entered by you — no crawl has read your site yet";
  } else {
    return { ok: false, error: `Unknown basics key "${input.key}"` };
  }

  const nextSettings = {
    ...settings,
    ...patch,
    basics_confirmed: {
      ...confirmed,
      [input.key]: {
        confirmed_at: new Date().toISOString(),
        confirmed_by: actor.id,
        provenance,
      },
    },
  };

  const { error: updateError } = await service
    .from("businesses")
    .update({ settings: nextSettings, ...(newName ? { name: newName } : {}) })
    .eq("id", business.id);
  if (updateError) return { ok: false, error: updateError.message };

  await emitEvent(service, {
    business_id: business.id,
    actor_id: actor.id,
    action: FIRST_LIGHT_EVENT_KINDS.settingsUpdated,
    entity_type: "business",
    entity_id: business.id,
    payload: {
      key: input.key,
      provenance,
      via: "first_light_basics",
      ...(input.key === "quiet_hours" ? { value: patch.quiet_hours } : { value: input.value.trim() }),
    },
  });

  await evaluateBasicsPredicate(service, {
    businessId: business.id,
    requiredKeys: template?.standardKeys ?? [],
    actorId: actor.id,
  });

  revalidatePath("/", "layout");
  return { ok: true };
}

export async function acknowledgeNogoRules(): Promise<{ ok: boolean; error?: string }> {
  const { business, actor } = await getAppContext();
  const template = await getTemplateContent();
  const service = createServiceClient();
  try {
    await satisfyFirstLightPredicate(service, {
      businessId: business.id,
      predicateKey: "nogo_rules_acknowledged",
      actorId: actor.id,
      payload: {
        rules_count: template?.noGoRules.length ?? 0,
        note: "Owner read and acknowledged the vertical's no-go seed (the weakest tick — earned by acknowledgment, ruled acceptable for Phase 2, never precedent).",
      },
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

export async function skipMetaRow(reason: string): Promise<{ ok: boolean; error?: string }> {
  const { business, actor } = await getAppContext();
  if (!reason.trim()) return { ok: false, error: "Skipping needs a stated reason." };
  const service = createServiceClient();
  try {
    await skipFirstLightRow(service, {
      businessId: business.id,
      predicateKey: "meta_lead_forms_connected",
      actorId: actor.id,
      reason: reason.trim(),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  revalidatePath("/", "layout");
  return { ok: true };
}

/** Re-evaluate the connection predicates from live grant state — called when
 * the panel opens, so a connection made through the one door reflects back. */
export async function runFirstLightEvaluation(): Promise<{ ok: boolean }> {
  const { business } = await getAppContext();
  const service = createServiceClient();
  const flipped = await evaluateConnectionPredicates(service, business.id);
  if (flipped.length > 0) revalidatePath("/", "layout");
  return { ok: true };
}
