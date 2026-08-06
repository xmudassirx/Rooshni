"use server";

import { createHash, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import {
  createServiceClient,
  deactivateMemoryEntry,
  emitEvent,
  quietHoursFromSendWindow,
  setMemoryFact,
  ATTACHMENT_MAX_BYTES,
  DRAFTING_EVENT_KINDS,
  FILES_BUCKET,
  FIRST_LIGHT_EVENT_KINDS,
  MEMORY_FACT_KEYS,
  SETTLE_WINDOW_MINUTES_OPTIONS,
  storageSlug,
} from "@rooshni/db";
import { getAppContext } from "@/lib/server/context";
import { getAgentActor } from "@/lib/server/queries";

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

  // Session 32 (D181, Q1 option A): the sign-off TEXT and booking URL are
  // client-facing FACTS — Light's Memory is their single home, and this
  // field is a face over the fact: the save writes a superseding entry
  // through the memory door and fires the ripple sweep. Mode and settle
  // window are machinery and stay settings keys.
  const light = await getAgentActor();
  try {
    await setMemoryFact(db, {
      business_id: business.id,
      actor_id: actor.id,
      light_actor_id: light?.id ?? actor.id,
      fact_key: MEMORY_FACT_KEYS.signature,
      title: "Signature",
      value: signOffText || business.name,
      why: "Edited from Settings (the field is a face over the memory fact — D181, Q1)",
    });
    if (bookingUrl) {
      await setMemoryFact(db, {
        business_id: business.id,
        actor_id: actor.id,
        light_actor_id: light?.id ?? actor.id,
        fact_key: MEMORY_FACT_KEYS.bookingLink,
        title: "Booking link",
        value: bookingUrl,
        why: "Edited from Settings (the field is a face over the memory fact — D181, Q1)",
      });
    } else {
      // Blank = no booking link is offered (PR-iv) — the fact retires,
      // history stands.
      const { data: existing } = await db
        .from("memory_entries")
        .select("id")
        .eq("business_id", business.id)
        .eq("kind", "fact")
        .eq("active", true)
        .eq("attributes->>fact_key", MEMORY_FACT_KEYS.bookingLink)
        .maybeSingle();
      if (existing) {
        await deactivateMemoryEntry(db, {
          business_id: business.id,
          actor_id: actor.id,
          entry_id: existing.id,
          reason: "Booking link cleared from Settings — no link is offered",
        });
      }
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "The memory write failed." };
  }

  // JUDGMENT (Session 32): the machinery keys save AFTER the memory writes
  // landed (a failed memory write must never orphan the value), and the
  // legacy settings copies are DELETED on every save — they are only the
  // transitional fallback for a business with no fact rows, and a stale
  // copy would resurface through that fallback (e.g. a cleared booking
  // link falling back to the old URL). Listed at close.
  settings.email_sign_off_mode = mode;
  settings.draft_settle_minutes = settleMinutes;
  delete settings.email_sign_off;
  delete settings.booking_url;

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
      note: "sign-off text and booking URL live in Light's Memory (D181) — this save wrote through the memory door",
    },
  });

  revalidatePath("/settings");
  revalidatePath("/memory");
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

export interface BusinessHoursActionState {
  error: string | null;
  saved?: boolean;
}

/**
 * Defect-trio hotfix (2 Aug 2026, item 3) — business hours go real. The
 * firm sets a simple daily send window (open→close, its own timezone); the
 * stored truth is settings.quiet_hours — the SAME config the dispatch hold
 * has always read, so the "sends [time]" display and the dispatch_at
 * calculation cannot diverge (one source, founder-ruled). The setter also
 * writes the derived settings.business_hours display string (single writer
 * — a presentation of the one truth, never a second store). Owner-gated
 * like every business-level policy; one settings merge; evented.
 *
 * JUDGMENT: the ruling offered "per-day windows or a simple daily window" —
 * the simple daily window ships (it maps 1:1 onto the quiet_hours shape the
 * hold enforces; per-day windows would grow the enforcement config and are
 * their own session if the firm ever needs them).
 */
export async function setBusinessHoursAction(
  _prev: BusinessHoursActionState,
  formData: FormData
): Promise<BusinessHoursActionState> {
  const mode = String(formData.get("mode") ?? "set");
  const open = String(formData.get("open") ?? "").trim();
  const close = String(formData.get("close") ?? "").trim();

  const { db, business, actor, membershipRole } = await getAppContext();
  if (membershipRole !== "owner") {
    return { error: "Business hours are the owner's pen — ask the owner to change them." };
  }

  const { data: bizRow, error: readError } = await db
    .from("businesses")
    .select("settings, timezone")
    .eq("id", business.id)
    .maybeSingle();
  if (readError || !bizRow) return { error: `Settings read failed: ${readError?.message ?? "no row"}` };
  const settings = { ...((bizRow.settings as Record<string, unknown>) ?? {}) };
  const timezone = (bizRow.timezone as string) || "Europe/London";

  if (mode === "disable") {
    // Session 33, D184b — as AMENDED at click-review (founder-ruled
    // 7 Aug 2026): NO QUIET HOURS is a DISPATCH choice only — the D170
    // explicit null turns the hold off while the client-facing
    // opening-hours fact LIVES ON in Light's Memory (a firm may dispatch
    // any hour and still open 9–5; the fact ripples to Google Business
    // Profile and retires only through Memory itself, or the reset).
    settings.quiet_hours = null;
    delete settings.business_hours;
  } else if (mode === "reset") {
    // Back to the honest default — the field reads "default — not yet set
    // by you" again and the hold reads the shipped window. The opening-hours
    // FACT retires here (the shipped default window is dispatch policy, not
    // a client-facing fact).
    delete settings.quiet_hours;
    delete settings.business_hours;
    const { data: existingFact } = await db
      .from("memory_entries")
      .select("id")
      .eq("business_id", business.id)
      .eq("kind", "fact")
      .eq("active", true)
      .eq("attributes->>fact_key", MEMORY_FACT_KEYS.openingHours)
      .maybeSingle();
    if (existingFact) {
      try {
        await deactivateMemoryEntry(db, {
          business_id: business.id,
          actor_id: actor.id,
          entry_id: existingFact.id,
          reason: "Business hours reset to the shipped default window",
        });
      } catch (err) {
        return { error: err instanceof Error ? err.message : "The memory write failed." };
      }
    }
  } else {
    const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!HHMM.test(open) || !HHMM.test(close)) {
      return { error: "Business hours need opening and closing times as HH:MM (24-hour)." };
    }
    if (open === close) {
      return { error: "Opening and closing times cannot be the same — that window holds nothing and sends always." };
    }
    const window = { open, close };
    settings.quiet_hours = quietHoursFromSendWindow(window);
    // Session 32 (D181, Q1 option A): the client-facing OPENING HOURS fact
    // lives in Light's Memory — this field is a face over it; the save
    // writes through the memory door and fires the ripple sweep. The
    // structured quiet_hours window above stays settings (dispatch
    // machinery, per the ruling); the legacy business_hours display string
    // retires (memory is the home, settings only the pre-seed fallback).
    delete settings.business_hours;
    const light = await getAgentActor();
    try {
      await setMemoryFact(db, {
        business_id: business.id,
        actor_id: actor.id,
        light_actor_id: light?.id ?? actor.id,
        fact_key: MEMORY_FACT_KEYS.openingHours,
        title: "Opening hours",
        value: `${open} to ${close} (${timezone})`,
        why: "Edited from Settings (the field is a face over the memory fact — D181, Q1)",
      });
    } catch (err) {
      return { error: err instanceof Error ? err.message : "The memory write failed." };
    }
  }

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
      keys: ["business_hours", "quiet_hours"],
      ...(mode === "disable"
        ? {
            quiet_hours: null,
            note: "No quiet hours — the owner's recorded choice (D184b, dispatch only); stamped mail dispatches immediately, any hour; the opening-hours fact is untouched",
          }
        : mode === "reset"
          ? { business_hours: null, note: "reset to the shipped default window; the opening-hours memory fact retired" }
          : {
              quiet_hours: settings.quiet_hours,
              note: "opening hours live in Light's Memory (D181) — this save wrote through the memory door",
            }),
    },
  });

  revalidatePath("/", "layout");
  revalidatePath("/memory");
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

export interface MetaFormRoutesActionState {
  error: string | null;
  saved?: boolean;
}

/**
 * Session 27 (D161a) — the per-form default route mapping's one door:
 * Settings → Integrations, under the Meta row. A form with no route
 * question ingests its default (source form_default, the ladder's floor).
 * Owner-gated like the Conversions switch; one settings merge; evented
 * (settings.updated — form ids and route keys are configuration, never
 * credentials). An empty route removes the form's mapping.
 */
export async function setMetaFormRouteAction(
  _prev: MetaFormRoutesActionState,
  formData: FormData
): Promise<MetaFormRoutesActionState> {
  const formId = String(formData.get("form_id") ?? "").trim();
  const route = String(formData.get("route") ?? "").trim();
  const label = String(formData.get("form_label") ?? "").trim();
  if (!/^\d{5,20}$/.test(formId)) {
    return { error: "The form id is the numeric id from Meta's form (digits only)." };
  }

  const { db, business, actor, membershipRole } = await getAppContext();
  if (membershipRole !== "owner") {
    return { error: "The form mapping is the owner's pen — ask the owner to change it." };
  }

  const { data: bizRow, error: readError } = await db
    .from("businesses")
    .select("settings")
    .eq("id", business.id)
    .maybeSingle();
  if (readError || !bizRow) return { error: `Settings read failed: ${readError?.message ?? "no row"}` };

  const settings = { ...((bizRow.settings as Record<string, unknown>) ?? {}) };
  const meta = { ...((settings.meta as Record<string, unknown>) ?? {}) };
  const defaults = { ...((meta.form_route_defaults as Record<string, unknown>) ?? {}) };
  if (route === "") {
    delete defaults[formId];
  } else {
    defaults[formId] = { route, ...(label ? { label } : {}) };
  }
  meta.form_route_defaults = defaults;
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
      keys: ["meta.form_route_defaults"],
      form_id: formId,
      route: route || null,
      form_label: label || null,
      ...(route === "" ? { removed: true } : {}),
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
  // WS5c (Session 23): a human slug prefix — collision-proof (uuid) AND
  // eye-findable in the bucket.
  const storageKey = `route-guides/${businessId}/${storageSlug(guideFile.name)}-${randomUUID()}.pdf`;
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

/**
 * Session 23 (WS5b) — the read view's version history: content_versions rows
 * for one entry, newest first, bounded. A read under the caller's own RLS.
 */
export async function knowledgeEntryVersionsAction(
  entryId: string
): Promise<{ versions: { version: number; savedAt: string; preview: string }[]; error: string | null }> {
  if (!isUuid(entryId)) return { versions: [], error: "That entry id is not valid." };
  try {
    const { db, business } = await getAppContext();
    const { data, error } = await db
      .from("content_versions")
      .select("version, saved_at, body")
      .eq("business_id", business.id)
      .eq("content_id", entryId)
      .order("version", { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    return {
      versions: (data ?? []).map((v) => {
        const body = v.body;
        const text = Array.isArray(body)
          ? body
              .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text ?? "") : ""))
              .join(" ")
          : "";
        return {
          version: v.version as number,
          savedAt: v.saved_at as string,
          preview: text.slice(0, 160),
        };
      }),
      error: null,
    };
  } catch (err) {
    return { versions: [], error: err instanceof Error ? err.message : "Version history failed." };
  }
}

/**
 * Session 23 (WS5b) — open/download an entry's attachment: ownership checked
 * under the caller's RLS, then a short-lived signed URL (the bytes stay in
 * the private bucket; the URL is the door, not the address).
 */
export async function knowledgeAttachmentUrlAction(
  fileId: string
): Promise<{ url: string | null; error: string | null }> {
  if (!isUuid(fileId)) return { url: null, error: "That file id is not valid." };
  try {
    const { db, business } = await getAppContext();
    const { data: file, error } = await db
      .from("files")
      .select("id, storage_key")
      .eq("id", fileId)
      .eq("business_id", business.id)
      .is("archived_at", null)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!file) return { url: null, error: "That file no longer exists." };
    const service = createServiceClient();
    const { data: signed, error: signError } = await service.storage
      .from(FILES_BUCKET)
      .createSignedUrl(file.storage_key as string, 600);
    if (signError) throw new Error(signError.message);
    return { url: signed?.signedUrl ?? null, error: signed?.signedUrl ? null : "Signing failed." };
  } catch (err) {
    return { url: null, error: err instanceof Error ? err.message : "The download failed." };
  }
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
