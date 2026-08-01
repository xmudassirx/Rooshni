"use server";

import { revalidatePath } from "next/cache";
import {
  emitEvent,
  DRAFTING_EVENT_KINDS,
  FIRST_LIGHT_EVENT_KINDS,
  SETTLE_WINDOW_MINUTES_OPTIONS,
} from "@rooshni/db";
import { getAppContext } from "@/lib/server/context";

/**
 * Session 15 (PR-1) — the knowledge pack's ONLY door. Entries are
 * content_items rows (content_type `knowledge_entry`); edits create
 * content_versions; every change lands on The Record via emitEvent().
 * Publishing is the gated act (0009 human-publisher + 0015 approvals.content,
 * owner implicit) — the database decides, this file merely asks.
 */

export interface KnowledgeActionState {
  error: string | null;
  saved?: boolean;
}

const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  // Entries are internal content — a short unique suffix sidesteps the
  // per-surface slug uniqueness without a retry loop.
  return `${base || "entry"}-${crypto.randomUUID().slice(0, 8)}`;
}

function bodyBlocks(text: string): Array<{ type: "paragraph"; text: string }> {
  // Decision 73's canonical block vocabulary — plain paragraphs this session.
  return text
    .split(/\r?\n\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) => ({ type: "paragraph" as const, text: p }));
}

async function allowedVocab(
  db: Awaited<ReturnType<typeof getAppContext>>["db"],
  businessId: string
): Promise<{ categories: Set<string>; routes: Set<string> } | null> {
  const { data: biz } = await db.from("businesses").select("template_id").eq("id", businessId).maybeSingle();
  if (!biz?.template_id) return null;
  const { data: fields } = await db
    .from("field_definitions")
    .select("key, validation")
    .eq("template_id", biz.template_id)
    .eq("entity", "content")
    .in("key", ["knowledge_category", "visa_route"]);
  const keysOf = (key: string) => {
    const list = ((fields ?? []).find((f) => f.key === key)?.validation as { allowed?: unknown } | null)?.allowed;
    return new Set(
      Array.isArray(list) ? list.map((o) => String((o as { key?: unknown }).key ?? "")).filter(Boolean) : []
    );
  };
  return { categories: keysOf("knowledge_category"), routes: keysOf("visa_route") };
}

export interface DraftingSettingsState {
  error: string | null;
  saved?: boolean;
}

/**
 * Session 16 — Settings → General: the drafting policy trio (PR-C sign-off
 * text redeems the Session 15 JUDGMENT mark; PR-F mode; PR-C settle window).
 * Business-level policy is the owner's pen; each save is one settings merge
 * and one settings.updated line on The Record.
 */
export async function updateDraftingSettingsAction(
  _prev: DraftingSettingsState,
  formData: FormData
): Promise<DraftingSettingsState> {
  const signOffText = String(formData.get("email_sign_off") ?? "").trim();
  const mode = String(formData.get("email_sign_off_mode") ?? "firm_name");
  const settleRaw = String(formData.get("draft_settle_minutes") ?? "3");
  const settleMinutes = Number(settleRaw);

  if (mode !== "firm_name" && mode !== "approver") return { error: "Unknown sign-off mode." };
  if (!(SETTLE_WINDOW_MINUTES_OPTIONS as readonly number[]).includes(settleMinutes)) {
    return { error: "The settle window must be instant, 1, 3 or 5 minutes." };
  }

  const { db, business, actor, membershipRole } = await getAppContext();
  if (membershipRole !== "owner") {
    return { error: "Drafting policy is the owner's pen — ask the owner to change it." };
  }

  const { data: bizRow, error: readError } = await db
    .from("businesses")
    .select("settings")
    .eq("id", business.id)
    .maybeSingle();
  if (readError) return { error: `Settings read failed: ${readError.message}` };
  const settings = { ...((bizRow?.settings ?? {}) as Record<string, unknown>) };

  if (signOffText) settings.email_sign_off = signOffText;
  else delete settings.email_sign_off; // absent = the firm display name, the only shipped default
  settings.email_sign_off_mode = mode;
  settings.draft_settle_minutes = settleMinutes;

  const { error: writeError } = await db
    .from("businesses")
    .update({ settings })
    .eq("id", business.id);
  if (writeError) return { error: `Save failed: ${writeError.message}` };

  await emitEvent(db, {
    business_id: business.id,
    actor_id: actor.id,
    action: FIRST_LIGHT_EVENT_KINDS.settingsUpdated,
    entity_type: "business",
    entity_id: business.id,
    payload: {
      keys: ["email_sign_off", "email_sign_off_mode", "draft_settle_minutes"],
      email_sign_off_mode: mode,
      draft_settle_minutes: settleMinutes,
      email_sign_off_set: Boolean(signOffText),
    },
  });

  revalidatePath("/settings");
  return { error: null, saved: true };
}

export async function saveKnowledgeEntryAction(
  _prev: KnowledgeActionState,
  formData: FormData
): Promise<KnowledgeActionState> {
  const id = String(formData.get("id") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const category = String(formData.get("category") ?? "").trim();
  const visaRoute = String(formData.get("visa_route") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();

  if (!title) return { error: "A title is required." };
  if (!body) return { error: "A body is required — Light drafts from what you put here." };
  if (id && !isUuid(id)) return { error: "Malformed entry id." };

  const { db, business, actor } = await getAppContext();

  // The values must come from the DECLARED vocabulary (§2.3) — the installed
  // template's field declarations, never free text.
  const vocab = await allowedVocab(db, business.id);
  if (!vocab) return { error: "No installed template declares the knowledge vocabulary yet." };
  if (!vocab.categories.has(category)) return { error: "Unknown category — pick one the template declares." };
  if (category === "service_description" && !visaRoute) {
    return { error: "A service description is route-scoped — pick its visa route." };
  }
  if (visaRoute && !vocab.routes.has(visaRoute)) {
    return { error: "Unknown visa route — pick one the template declares." };
  }

  const attributes: Record<string, string> = { knowledge_category: category };
  if (visaRoute) attributes.visa_route = visaRoute;
  const blocks = bodyBlocks(body);

  if (!id) {
    const { data: inserted, error } = await db
      .from("content_items")
      .insert({
        business_id: business.id,
        created_by: actor.id,
        content_type: "knowledge_entry",
        title,
        slug: slugify(title),
        body: blocks,
        visibility: "team",
        state: "draft",
        attributes,
      })
      .select("id, version")
      .single();
    if (error) return { error: `Create failed: ${error.message}` };

    const { error: versionError } = await db.from("content_versions").insert({
      business_id: business.id,
      content_id: inserted.id,
      version: inserted.version ?? 1,
      body: blocks,
    });
    if (versionError) return { error: `Version record failed: ${versionError.message}` };

    await emitEvent(db, {
      business_id: business.id,
      actor_id: actor.id,
      action: DRAFTING_EVENT_KINDS.knowledgeEntryCreated,
      entity_type: "content_item",
      entity_id: inserted.id,
      payload: { title, category, ...(visaRoute ? { visa_route: visaRoute } : {}) },
    });
  } else {
    const { data: current, error: lookupError } = await db
      .from("content_items")
      .select("id, version, state")
      .eq("id", id)
      .eq("business_id", business.id)
      .eq("content_type", "knowledge_entry")
      .is("archived_at", null)
      .maybeSingle();
    if (lookupError) return { error: `Lookup failed: ${lookupError.message}` };
    if (!current) return { error: "That entry no longer exists." };

    const nextVersion = (current.version ?? 1) + 1;
    const { error: updateError } = await db
      .from("content_items")
      .update({ title, body: blocks, attributes, version: nextVersion })
      .eq("id", id)
      .eq("business_id", business.id);
    if (updateError) return { error: `Save failed: ${updateError.message}` };

    const { error: versionError } = await db.from("content_versions").insert({
      business_id: business.id,
      content_id: id,
      version: nextVersion,
      body: blocks,
    });
    if (versionError) return { error: `Version record failed: ${versionError.message}` };

    await emitEvent(db, {
      business_id: business.id,
      actor_id: actor.id,
      action: DRAFTING_EVENT_KINDS.knowledgeEntryUpdated,
      entity_type: "content_item",
      entity_id: id,
      payload: { title, category, version: nextVersion, ...(visaRoute ? { visa_route: visaRoute } : {}) },
    });
  }

  revalidatePath("/settings");
  return { error: null, saved: true };
}

export async function publishKnowledgeEntryAction(
  _prev: KnowledgeActionState,
  formData: FormData
): Promise<KnowledgeActionState> {
  const id = String(formData.get("id") ?? "").trim();
  if (!isUuid(id)) return { error: "Malformed entry id." };
  const { db, business, actor } = await getAppContext();

  // The database holds the gate: publishing requires a HUMAN publisher (0009)
  // holding approvals.content, owner implicit (0015). A refusal surfaces.
  const { error } = await db
    .from("content_items")
    .update({
      state: "published",
      published_by_actor_id: actor.id,
      published_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("business_id", business.id)
    .eq("content_type", "knowledge_entry");
  if (error) return { error: `Publish refused: ${error.message}` };

  await emitEvent(db, {
    business_id: business.id,
    actor_id: actor.id,
    action: DRAFTING_EVENT_KINDS.knowledgeEntryPublished,
    entity_type: "content_item",
    entity_id: id,
  });
  revalidatePath("/settings");
  return { error: null, saved: true };
}

export async function archiveKnowledgeEntryAction(
  _prev: KnowledgeActionState,
  formData: FormData
): Promise<KnowledgeActionState> {
  const id = String(formData.get("id") ?? "").trim();
  if (!isUuid(id)) return { error: "Malformed entry id." };
  const { db, business, actor } = await getAppContext();

  const { error } = await db
    .from("content_items")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id)
    .eq("business_id", business.id)
    .eq("content_type", "knowledge_entry");
  if (error) return { error: `Archive failed: ${error.message}` };

  await emitEvent(db, {
    business_id: business.id,
    actor_id: actor.id,
    action: DRAFTING_EVENT_KINDS.knowledgeEntryArchived,
    entity_type: "content_item",
    entity_id: id,
  });
  revalidatePath("/settings");
  return { error: null, saved: true };
}
