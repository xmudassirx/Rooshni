import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { emitEvent } from "./events";
import { SEND_EVENT_KINDS } from "./event-kinds";
import { META_GRAPH_API_BASE } from "./whatsapp";

/**
 * Meta Lead Ads — inbound (Session 10). The webhook ping carries ids only;
 * the lead's field data is fetched from the Graph API by leadgen id. The
 * seeded fixtures (seed/fixtures/meta-leads.ts) are the provider-exact
 * contract this module honours; the ingest below is the Session 1 seed path,
 * parameterised for real tenants, plus the Conversations thread the session
 * scope names.
 *
 * Discipline (external-integrations, the stripe_events precedent):
 * signature verified against the RAW body before parsing; idempotent on
 * Meta's leadgen id (meta_webhook_events unique index + the engagement's
 * external_refs guard); everything evented via emitEvent().
 */

const TIMEOUT_MS = 15_000;

export interface MetaSignatureResult {
  ok: boolean;
  reason?: string;
}

/** X-Hub-Signature-256: `sha256=<hex HMAC-SHA256 of the raw body, keyed with
 * the app secret>`. An unverified body is untrusted input — never parse it first. */
export function verifyMetaSignature(input: {
  payload: string;
  header: string | null;
  secret: string;
}): MetaSignatureResult {
  if (!input.header) return { ok: false, reason: "missing X-Hub-Signature-256 header" };
  const [scheme, signature] = input.header.split("=", 2);
  if (scheme !== "sha256" || !signature) {
    return { ok: false, reason: "malformed signature header" };
  }
  const expected = createHmac("sha256", input.secret).update(input.payload, "utf8").digest("hex");
  const expectedBuf = Buffer.from(expected);
  const candidateBuf = Buffer.from(signature);
  if (candidateBuf.length !== expectedBuf.length || !timingSafeEqual(candidateBuf, expectedBuf)) {
    return { ok: false, reason: "signature mismatch" };
  }
  return { ok: true };
}

/** The webhook POST body (ids only — never field data). Matches
 * seed/fixtures/meta-leads.ts exactly; that file is the contract. */
export interface MetaLeadgenChange {
  field: string;
  value: {
    ad_id?: string;
    form_id?: string;
    leadgen_id: string;
    created_time?: number;
    page_id?: string;
    adgroup_id?: string;
  };
}

export interface MetaLeadgenWebhookBody {
  object?: string;
  entry?: Array<{
    id: string;
    time?: number;
    changes?: MetaLeadgenChange[];
  }>;
}

/** What the Graph API returns for a leadgen id (the fixtures' `lead` shape). */
export interface MetaLeadDetail {
  id: string;
  created_time: string;
  ad_id?: string;
  adset_id?: string;
  campaign_id?: string;
  form_id?: string;
  is_organic?: boolean;
  field_data: Array<{ name: string; values: string[] }>;
}

/** Fetch the lead's field data by leadgen id (Graph v25+, pinned in
 * whatsapp.ts). Requires a token holding leads_retrieval for the page. */
export async function fetchMetaLead(leadgenId: string, accessToken: string): Promise<MetaLeadDetail> {
  const fields = "id,created_time,ad_id,adset_id,campaign_id,form_id,is_organic,field_data";
  const response = await fetch(`${META_GRAPH_API_BASE}/${encodeURIComponent(leadgenId)}?fields=${fields}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as MetaLeadDetail & { error?: { message?: string } };
  if (!response.ok || !body.id) {
    throw new Error(`Meta lead fetch failed (${response.status}): ${body.error?.message ?? "unknown error"}`);
  }
  return body;
}

/** 00-prefixed international numbers become E.164 (+…), per Spec 1 §4.1 —
 * the seed's rule, shared. */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (digits.startsWith("+")) return digits;
  return digits;
}

export interface MetaBusinessBinding {
  business_id: string;
  account_id: string;
  integration_actor_id: string;
  owner_actor_id: string;
  template_id: string;
}

/**
 * Which tenant does a page belong to? businesses.settings.meta.page_id is
 * the binding (set at wiring — `npm run db:wire-meta`). Exactly one match is
 * lawful; ambiguity or absence is a loud failure, never a guess.
 */
export async function resolveMetaBusiness(db: SupabaseClient, pageId: string): Promise<MetaBusinessBinding> {
  const { data: businesses, error } = await db
    .from("businesses")
    .select("id, account_id, template_id, settings")
    .eq("settings->meta->>page_id", pageId)
    .is("archived_at", null);
  if (error) throw new Error(`business lookup for page ${pageId} failed: ${error.message}`);
  if (!businesses || businesses.length !== 1) {
    throw new Error(
      `Page ${pageId} maps to ${businesses?.length ?? 0} businesses — settings.meta.page_id must bind exactly one`
    );
  }
  const business = businesses[0]!;

  const { data: integrations, error: actorError } = await db
    .from("actors")
    .select("id")
    .eq("account_id", business.account_id)
    .eq("actor_type", "integration")
    .is("archived_at", null);
  if (actorError) throw new Error(`integration actor lookup failed: ${actorError.message}`);
  if (!integrations || integrations.length !== 1) {
    throw new Error(
      `Account for page ${pageId} holds ${integrations?.length ?? 0} integration actors — exactly one is required`
    );
  }

  const { data: accounts, error: accountError } = await db
    .from("accounts")
    .select("owner_user_id")
    .eq("id", business.account_id)
    .limit(1);
  if (accountError || !accounts?.[0]) {
    throw new Error(`account lookup failed: ${accountError?.message ?? "no account row"}`);
  }
  const { data: owners, error: ownerError } = await db
    .from("actors")
    .select("id")
    .eq("account_id", business.account_id)
    .eq("actor_type", "human")
    .eq("user_id", accounts[0].owner_user_id)
    .is("archived_at", null)
    .limit(1);
  if (ownerError || !owners?.[0]) {
    throw new Error(`owner actor lookup failed: ${ownerError?.message ?? "no owner actor"}`);
  }

  return {
    business_id: business.id,
    account_id: business.account_id,
    integration_actor_id: integrations[0]!.id,
    owner_actor_id: owners[0]!.id,
    template_id: business.template_id,
  };
}

export interface IngestResult {
  created: boolean;
  contact_id: string | null;
  engagement_id: string | null;
  thread_id: string | null;
}

async function q<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return (data ?? ([] as unknown)) as T;
}

/**
 * Spec 1 §7 steps 1–2 for one real lead: contact + per-channel consent
 * (captured at the form), enquiry at the SEMANTIC stage set, participant,
 * stage history, the Conversations thread, and the events the workflow
 * trigger matches on. Idempotent on the Meta lead id (webhook retries create
 * nothing twice).
 *
 * JUDGMENT (stage mapping, LEAD-LOG-BASELINE): the seeded stage_definitions
 * ARE the semantic set — decision 60, one vocabulary; an inbound lead lands
 * at `new_lead` ("New"). Brevo's four timer-costume stages are never created
 * — timers are workflow data, not stages.
 */
export async function ingestMetaLead(
  db: SupabaseClient,
  binding: MetaBusinessBinding,
  lead: MetaLeadDetail
): Promise<IngestResult> {
  // Webhook retries must not duplicate leads: the Meta lead id on the
  // engagement's external_refs is the idempotency key (the seed's guard).
  const existing = await q<{ id: string }[]>(
    db
      .from("engagements")
      .select("id")
      .contains("external_refs", JSON.stringify([{ system: "meta", external_id: lead.id }]))
      .limit(1),
    "lead idempotency lookup"
  );
  if (existing.length > 0) {
    return { created: false, contact_id: null, engagement_id: existing[0]!.id, thread_id: null };
  }

  const fields = new Map(lead.field_data.map((f) => [f.name, f.values[0] ?? ""]));
  // X Law's live forms vary in name shape: full_name on the older forms,
  // first_name + last_name (one uses `surname`) on the active ones, bare
  // `name` on the earliest. Compose in that order — the fixture contract
  // (full_name) remains the first read.
  const composedName = [fields.get("first_name"), fields.get("last_name") ?? fields.get("surname")]
    .filter(Boolean)
    .join(" ");
  const fullName = fields.get("full_name") || composedName || fields.get("name") || "Unknown lead";
  const phone = normalisePhone(fields.get("phone_number") ?? "");
  const email = (fields.get("email") ?? "").toLowerCase();
  const [givenName, ...familyParts] = fullName.split(/\s+/);

  const attribution = {
    source: "meta",
    campaign_id: lead.campaign_id ?? null,
    adset_id: lead.adset_id ?? null,
    ad_id: lead.ad_id ?? null,
    form_id: lead.form_id ?? null,
    lead_id: lead.id,
  };

  // The enquiry type and its "New" stage, resolved by key (semantic set).
  const types = await q<{ id: string }[]>(
    db
      .from("engagement_types")
      .select("id")
      .eq("template_id", binding.template_id)
      .eq("key", "enquiry")
      .is("archived_at", null)
      .limit(1),
    "engagement type lookup"
  );
  if (!types[0]) throw new Error(`No "enquiry" engagement type on template ${binding.template_id}`);
  const stages = await q<{ id: string }[]>(
    db
      .from("stage_definitions")
      .select("id")
      .eq("engagement_type_id", types[0].id)
      .eq("key", "new_lead")
      .is("archived_at", null)
      .limit(1),
    "new_lead stage lookup"
  );
  if (!stages[0]) throw new Error(`No "new_lead" stage on the enquiry type`);

  // 1. Contact + channels — consent captured at the form, per channel.
  const contacts = await q<{ id: string }[]>(
    db
      .from("contacts")
      .insert({
        business_id: binding.business_id,
        created_by: binding.integration_actor_id,
        type: "person",
        display_name: fullName,
        given_name: givenName,
        family_name: familyParts.join(" ") || null,
        status: "active",
        first_touch: {
          source: "meta",
          campaign_id: lead.campaign_id ?? null,
          adset_id: lead.adset_id ?? null,
          ad_id: lead.ad_id ?? null,
          form_id: lead.form_id ?? null,
          occurred_at: lead.created_time,
        },
        locale: "en-GB",
      })
      .select("id"),
    "contact insert"
  );
  const contactId = contacts[0]!.id;

  const consent = {
    marketing: true,
    transactional: true,
    granted_at: lead.created_time,
    source: "meta_lead_form",
  };
  for (const channel of [
    { channel: "phone", value: phone },
    { channel: "email", value: email },
  ]) {
    if (!channel.value) continue;
    await q(
      db.from("contact_channels").insert({
        business_id: binding.business_id,
        created_by: binding.integration_actor_id,
        contact_id: contactId,
        channel: channel.channel,
        value: channel.value,
        is_primary: true,
        consent,
      }).select("id"),
      "contact_channels insert"
    );
  }

  await emitEvent(db, {
    business_id: binding.business_id,
    actor_id: binding.integration_actor_id,
    action: "contact.created",
    entity_type: "contact",
    entity_id: contactId,
    payload: { source: "meta_lead_ads", lead_id: lead.id, display_name: fullName },
  });

  // 2. Engagement at stage "New", attribution on the engagement (§4.2).
  const engagements = await q<{ id: string }[]>(
    db
      .from("engagements")
      .insert({
        business_id: binding.business_id,
        created_by: binding.integration_actor_id,
        template_type_id: types[0].id,
        title: `${fullName} — enquiry`,
        stage_id: stages[0].id,
        stage_entered_at: lead.created_time,
        attribution,
        owner_actor_id: binding.owner_actor_id,
        external_refs: [{ system: "meta", external_id: lead.id, url: null, synced_at: new Date().toISOString() }],
      })
      .select("id"),
    "engagement insert"
  );
  const engagementId = engagements[0]!.id;

  await q(
    db.from("engagement_participants").insert({
      business_id: binding.business_id,
      created_by: binding.integration_actor_id,
      engagement_id: engagementId,
      contact_id: contactId,
      role: "client",
    }).select("id"),
    "participant insert"
  );

  await q(
    db.from("stage_history").insert({
      business_id: binding.business_id,
      engagement_id: engagementId,
      from_stage: null,
      to_stage: stages[0].id,
      moved_at: lead.created_time,
      moved_by: binding.integration_actor_id,
    }).select("id"),
    "stage_history insert"
  );

  // 3. The Conversations thread — the enquiry's door opens with the lead
  // (session scope). Email is the primary channel; the workflow's intro
  // draft lands on this same thread.
  const threads = await q<{ id: string }[]>(
    db
      .from("comm_threads")
      .insert({
        business_id: binding.business_id,
        created_by: binding.integration_actor_id,
        contact_id: contactId,
        engagement_id: engagementId,
        channel: "email",
        subject: `${fullName} — enquiry`,
      })
      .select("id"),
    "thread insert"
  );

  await emitEvent(db, {
    business_id: binding.business_id,
    actor_id: binding.integration_actor_id,
    action: SEND_EVENT_KINDS.metaLeadReceived,
    entity_type: "engagement",
    entity_id: engagementId,
    payload: { lead_id: lead.id, contact_id: contactId, thread_id: threads[0]!.id },
  });
  // The workflow trigger matches on THIS event (attribution.source = meta).
  await emitEvent(db, {
    business_id: binding.business_id,
    actor_id: binding.integration_actor_id,
    action: "engagement.created",
    entity_type: "engagement",
    entity_id: engagementId,
    payload: { stage: "new_lead", attribution },
  });

  return { created: true, contact_id: contactId, engagement_id: engagementId, thread_id: threads[0]!.id };
}
