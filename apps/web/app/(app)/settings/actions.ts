"use server";

import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import {
  createServiceClient,
  emitEvent,
  ATTACHMENT_MAX_BYTES,
  DRAFTING_EVENT_KINDS,
  FILES_BUCKET,
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
  // Session 19 (PR-iv): the firm's own booking page — blank unsets it;
  // anything set must be an absolute http(s) URL, never a half-link.
  const bookingUrl = String(formData.get("booking_url") ?? "").trim();

  if (mode !== "firm_name" && mode !== "approver") return { error: "Unknown sign-off mode." };
  if (!(SETTLE_WINDOW_MINUTES_OPTIONS as readonly number[]).includes(settleMinutes)) {
    return { error: "The settle window must be instant, 1, 3 or 5 minutes." };
  }
  if (bookingUrl && !/^https?:\/\/\S+$/i.test(bookingUrl)) {
    return { error: "The booking link must be a full web address (https://…)." };
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
  if (bookingUrl) settings.booking_url = bookingUrl;
  else delete settings.booking_url; // absent = no booking link is offered (PR-iv)

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
      keys: ["email_sign_off", "email_sign_off_mode", "draft_settle_minutes", "booking_url"],
      email_sign_off_mode: mode,
      draft_settle_minutes: settleMinutes,
      email_sign_off_set: Boolean(signOffText),
      booking_url_set: Boolean(bookingUrl),
    },
  });

  revalidatePath("/settings");
  return { error: null, saved: true };
}

/**
 * Session 20 — Settings → Integrations: which pipe carries the firm's
 * tenant email. Owner-gated like every business-level policy; one settings
 * merge, one settings.updated line on The Record. Selection is config, not
 * connection — the carrier's credentials and the inbound mailbox binding
 * remain founder wiring (env + wire-inbound), and the tab renders that
 * state honestly.
 */
export interface MailProviderActionState {
  error: string | null;
  saved?: boolean;
}

export async function setMailProviderAction(
  _prev: MailProviderActionState,
  formData: FormData
): Promise<MailProviderActionState> {
  const provider = String(formData.get("mail_provider") ?? "");
  if (provider !== "graph" && provider !== "gmail") {
    return { error: "Unknown mail provider." };
  }

  const { db, business, actor, membershipRole } = await getAppContext();
  if (membershipRole !== "owner") {
    return { error: "The mail pipe is the owner's pen — ask the owner to change it." };
  }

  const { data: bizRow, error: readError } = await db
    .from("businesses")
    .select("settings")
    .eq("id", business.id)
    .maybeSingle();
  if (readError || !bizRow) return { error: `Settings read failed: ${readError?.message ?? "no row"}` };

  const settings = { ...((bizRow.settings as Record<string, unknown>) ?? {}) };
  if (provider === "gmail") settings.mail_provider = "gmail";
  else delete settings.mail_provider; // absent = the Graph default, one truth

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
    payload: { keys: ["mail_provider"], mail_provider: provider },
  });

  revalidatePath("/settings");
  return { error: null, saved: true };
}

export interface ConversionsActionState {
  error: string | null;
  saved?: boolean;
}

/**
 * Session 22 (WS1, ruling 1d) — the Conversions row's ONE door: toggle
 * (default OFF until the founder flips it), dataset id (JUDGMENT: the CAPI
 * destination — the pre-ruled surface named toggle + test code only; the
 * destination id is the minimal additive fill on the same row) and Meta's
 * test_event_code passthrough. Owner-gated server-side; one settings merge;
 * everything evented (settings.updated with the keys and stored values —
 * none of these three is a credential).
 */
export async function setConversionsAction(
  _prev: ConversionsActionState,
  formData: FormData
): Promise<ConversionsActionState> {
  const enabled = formData.get("conversions_enabled") === "on";
  const datasetId = String(formData.get("dataset_id") ?? "").trim();
  const testEventCode = String(formData.get("test_event_code") ?? "").trim();
  if (datasetId !== "" && !/^\d{5,20}$/.test(datasetId)) {
    return { error: "The dataset id is the numeric id from Events Manager (digits only)." };
  }

  const { db, business, actor, membershipRole } = await getAppContext();
  if (membershipRole !== "owner") {
    return { error: "The Conversions switch is the owner's pen — ask the owner to change it." };
  }

  const { data: bizRow, error: readError } = await db
    .from("businesses")
    .select("settings")
    .eq("id", business.id)
    .maybeSingle();
  if (readError || !bizRow) return { error: `Settings read failed: ${readError?.message ?? "no row"}` };

  const settings = { ...((bizRow.settings as Record<string, unknown>) ?? {}) };
  const meta = { ...((settings.meta as Record<string, unknown>) ?? {}) };
  meta.conversions = {
    ...(enabled ? { enabled: true } : {}),
    ...(datasetId !== "" ? { dataset_id: datasetId } : {}),
    ...(testEventCode !== "" ? { test_event_code: testEventCode } : {}),
  };
  settings.meta = meta;

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
      keys: ["meta.conversions"],
      conversions_enabled: enabled,
      dataset_id: datasetId || null,
      test_event_code: testEventCode || null,
    },
  });

  revalidatePath("/settings");
  return { error: null, saved: true };
}

/**
 * PR-i (Session 19): store a route guide's document — bytes to the private
 * Supabase Storage bucket (service client; files.storage_key has always
 * pointed at a storage backend), the files row + file_links row under the
 * caller's own RLS, any previously linked file archived (soft — the resolver
 * reads the newest LIVE file), and the act evented. Returns an error string
 * or null.
 */
async function attachGuideFile(
  db: Awaited<ReturnType<typeof getAppContext>>["db"],
  businessId: string,
  actorId: string,
  entryId: string,
  guideFile: File
): Promise<string | null> {
  const service = createServiceClient();
  // Idempotent bucket door: create if absent, ignore "already exists".
  const { error: bucketError } = await service.storage.createBucket(FILES_BUCKET, { public: false });
  if (bucketError && !/exist/i.test(bucketError.message)) {
    return `Storage bucket unavailable: ${bucketError.message}`;
  }

  const bytes = Buffer.from(await guideFile.arrayBuffer());
  const storageKey = `route-guides/${businessId}/${randomUUID()}.pdf`;
  const { error: uploadError } = await service.storage
    .from(FILES_BUCKET)
    .upload(storageKey, bytes, { contentType: "application/pdf" });
  if (uploadError) return `Upload failed: ${uploadError.message}`;

  const { data: fileRow, error: fileError } = await db
    .from("files")
    .insert({
      business_id: businessId,
      storage_key: storageKey,
      filename: guideFile.name,
      mime_type: "application/pdf",
      size_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      uploaded_by: actorId,
    })
    .select("id")
    .single();
  if (fileError) return `File record failed: ${fileError.message}`;

  // A replacement retires the previous document SOFTLY — archived, never
  // deleted; the guide resolver and the entry list read the newest live file.
  const { data: oldLinks } = await db
    .from("file_links")
    .select("file_id")
    .eq("entity_type", "content_item")
    .eq("entity_id", entryId)
    .eq("role", "attachment");
  const oldFileIds = (oldLinks ?? []).map((l) => l.file_id).filter((f) => f !== fileRow.id);
  if (oldFileIds.length) {
    await db.from("files").update({ archived_at: new Date().toISOString() }).in("id", oldFileIds);
  }

  const { error: linkError } = await db.from("file_links").insert({
    business_id: businessId,
    file_id: fileRow.id,
    entity_type: "content_item",
    entity_id: entryId,
    role: "attachment",
  });
  if (linkError) return `File link failed: ${linkError.message}`;

  await emitEvent(db, {
    business_id: businessId,
    actor_id: actorId,
    action: DRAFTING_EVENT_KINDS.knowledgeEntryUpdated,
    entity_type: "content_item",
    entity_id: entryId,
    payload: {
      file_id: fileRow.id,
      filename: guideFile.name,
      size_bytes: bytes.length,
      note: "route guide document uploaded",
      ...(oldFileIds.length ? { replaced_file_ids: oldFileIds } : {}),
    },
  });
  return null;
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
  // PR-i (Session 19): a route guide is a DOCUMENT — an entry with a file.
  // JUDGMENT: guides are PDF-only this session (the ruling's own example;
  // one honest format beats a half-tested many), and a guide entry's BODY
  // is optional (the document is the content; the text field is a team
  // note the drafter never reads). Both awaiting sign-off at close.
  const rawFile = formData.get("file");
  const guideFile = rawFile instanceof File && rawFile.size > 0 ? rawFile : null;

  if (!title) return { error: "A title is required." };
  if (!body && category !== "route_guide") {
    return { error: "A body is required — Light drafts from what you put here." };
  }
  if (id && !isUuid(id)) return { error: "Malformed entry id." };

  const { db, business, actor } = await getAppContext();

  // The values must come from the DECLARED vocabulary (§2.3) — the installed
  // template's field declarations, never free text.
  const vocab = await allowedVocab(db, business.id);
  if (!vocab) return { error: "No installed template declares the knowledge vocabulary yet." };
  if (!vocab.categories.has(category)) return { error: "Unknown category — pick one the template declares." };
  if ((category === "service_description" || category === "route_guide") && !visaRoute) {
    return {
      error:
        category === "route_guide"
          ? "A route guide is route-scoped — pick the visa route it covers."
          : "A service description is route-scoped — pick its visa route.",
    };
  }
  if (visaRoute && !vocab.routes.has(visaRoute)) {
    return { error: "Unknown visa route — pick one the template declares." };
  }
  // Founder ruling (1 Aug 2026, recorded this hotfix): a guide document may
  // ride ANY route-scoped entry — one Spouse entry carrying text AND the PDF
  // is the preferred curation shape; a separate route_guide row remains
  // valid but optional. The door therefore offers the file wherever a route
  // can be declared; route_guide still REQUIRES its document (that category
  // is nothing without one), while a service description's document is
  // optional.
  const routeScoped = category === "service_description" || category === "route_guide";
  if (category === "route_guide" && !id && !guideFile) {
    return { error: "A route guide is a document — attach its PDF (up to 8MB)." };
  }
  if (guideFile) {
    if (!routeScoped) {
      return { error: "A document attaches to a route-scoped entry — pick a route category." };
    }
    if (guideFile.size > ATTACHMENT_MAX_BYTES) {
      return { error: "The guide is over the 8MB limit — upload a smaller file." };
    }
    const isPdf =
      guideFile.type === "application/pdf" || guideFile.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) return { error: "Guide documents are PDFs — upload a .pdf file." };
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

    // PR-i: the guide's document rides in with the entry.
    if (guideFile) {
      const fileErr = await attachGuideFile(db, business.id, actor.id, inserted.id, guideFile);
      if (fileErr) return { error: `The entry saved, but its document did not: ${fileErr}` };
    }
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

    // PR-i: a new document replaces the old one softly (archived, evented).
    if (guideFile) {
      const fileErr = await attachGuideFile(db, business.id, actor.id, id, guideFile);
      if (fileErr) return { error: `The entry saved, but its document did not: ${fileErr}` };
    }
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
