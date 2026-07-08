import type { SupabaseClient } from "@supabase/supabase-js";
import { scaleDurationMs } from "@rooshni/config";
import { loadEnv } from "../scripts/env";
import { createServiceClient } from "../src/client";
import { emitEvent } from "../src/events";
import { metaLeadFixtures, type MetaLeadFixture } from "./fixtures/meta-leads";

/**
 * Session 1 seed — actors, the X Law tenant with the Spec 1 §6 stage list,
 * and two test leads ingested exactly as the Meta Lead Ads webhook will
 * ingest real ones (Spec 1 §7 walk-through, steps 1–2).
 *
 * Idempotent: fixed ids upsert; leads are skipped when their Meta lead id is
 * already present on an engagement (Meta retries webhooks — the real handler
 * needs the same guard).
 */

// Deterministic ids so re-running the seed never duplicates configuration.
const IDS = {
  account: "01980000-0000-7000-8000-000000000001",
  business: "01980000-0000-7000-8000-000000000002",
  template: "01980000-0000-7000-8000-000000000003",
  enquiryType: "01980000-0000-7000-8000-000000000004",
  actorMudassir: "01980000-0000-7000-8000-000000000011",
  actorLight: "01980000-0000-7000-8000-000000000012",
  actorMeta: "01980000-0000-7000-8000-000000000013",
  membershipMudassir: "01980000-0000-7000-8000-000000000021",
} as const;

// Spec 3 §7/§9 — Light's Phase 1 bundle (the AI COO cut down to the surfaces
// that exist): enquiries execute for Level 2 work, comms execute to draft and
// submit into the approval queue — never to approve; approvals.* is
// structurally unholdable by non-humans. The Meta integration holds enquiries
// execute because ingesting a lead creates contacts, engagements and stage
// history — Level 2 acts under the same grant system (§2.1).
const GRANTS = [
  { id: "01980000-0000-7000-8000-000000000401", grantee: IDS.actorLight, tool: "enquiries", access: "execute" },
  { id: "01980000-0000-7000-8000-000000000402", grantee: IDS.actorLight, tool: "comms.email", access: "execute" },
  { id: "01980000-0000-7000-8000-000000000403", grantee: IDS.actorLight, tool: "comms.whatsapp", access: "execute" },
  { id: "01980000-0000-7000-8000-000000000404", grantee: IDS.actorMeta, tool: "enquiries", access: "execute" },
] as const;

const OWNER_EMAIL = "xmudassirx@gmail.com";

// Spec 1 §6 — the X Law pipeline (provisional pending the two-week lead log).
const STAGES = [
  { key: "new_lead", label: "New lead" },
  { key: "contact_attempted", label: "Contact attempted" },
  { key: "in_conversation", label: "In conversation" },
  { key: "qualified", label: "Qualified" },
  { key: "consultation_booked", label: "Consultation booked" },
  { key: "consultation_held", label: "Consultation held" },
  { key: "instructed", label: "Instructed", terminal: "won" },
  { key: "closed_lost", label: "Closed-lost", terminal: "lost" },
  { key: "unresponsive", label: "Unresponsive", terminal: "unresponsive" },
  { key: "disqualified", label: "Disqualified", terminal: "disqualified" },
] as const;

// Spec 1 §6 custom fields, declared in field_definitions (§2.3): every key in
// an attributes column must correspond to one of these rows.
const FIELDS = [
  { entity: "contact", key: "nationality", label: "Nationality", data_type: "text" },
  { entity: "contact", key: "current_visa_status", label: "Current visa status", data_type: "text" },
  { entity: "contact", key: "visa_expiry", label: "Visa expiry", data_type: "date" },
  { entity: "engagement", key: "visa_route", label: "Visa route", data_type: "text" },
  { entity: "engagement", key: "urgency", label: "Urgency", data_type: "text" },
] as const;

// Spec 4 §4 step 2: call task due within 2 business hours. This number moves
// into workflow_definitions rows in Session 4 — timers are data — and is
// already TIME_SCALE-multiplied here, never a raw hardcoded wait.
const CALL_TASK_DUE_REAL_MS = 2 * 60 * 60 * 1000;

function stageId(index: number): string {
  return `01980000-0000-7000-8000-0000000001${String(index).padStart(2, "0")}`;
}

function fieldId(index: number): string {
  return `01980000-0000-7000-8000-0000000002${String(index).padStart(2, "0")}`;
}

/** 00-prefixed international numbers become E.164 (+…), per §4.1. */
function normalisePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (digits.startsWith("+")) return digits;
  return digits;
}

async function upsert(
  db: SupabaseClient,
  table: string,
  row: Record<string, unknown>,
  onConflict = "id"
): Promise<void> {
  const { error } = await db.from(table).upsert(row, { onConflict });
  if (error) throw new Error(`upsert into ${table} failed: ${error.message}`);
}

async function ensureOwnerAuthUser(db: SupabaseClient): Promise<string> {
  const { data: created, error } = await db.auth.admin.createUser({
    email: OWNER_EMAIL,
    email_confirm: true,
  });
  if (!error) {
    console.log(`Created auth user for ${OWNER_EMAIL} (sign-in via password reset or magic link).`);
    return created.user.id;
  }

  // Already registered — find the existing user.
  const { data: list, error: listError } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listError) throw new Error(`listUsers failed: ${listError.message}`);
  const existing = list.users.find((u) => u.email?.toLowerCase() === OWNER_EMAIL);
  if (!existing) {
    throw new Error(`createUser failed (${error.message}) and no existing user matches ${OWNER_EMAIL}.`);
  }
  return existing.id;
}

async function seedTenant(db: SupabaseClient, ownerUserId: string): Promise<void> {
  await upsert(db, "accounts", {
    id: IDS.account,
    name: "Mudassir",
    owner_user_id: ownerUserId,
    plan: "solo",
    billing_status: "free_tier",
  });

  await upsert(db, "businesses", {
    id: IDS.business,
    account_id: IDS.account,
    name: "X Law",
    timezone: "Europe/London",
    default_locale: "en-GB",
  });

  await upsert(db, "templates", {
    id: IDS.template,
    business_id: IDS.business,
    vertical: "uk_immigration_law",
    version: 1,
    no_go_rules: [
      "No immigration advice in outbound drafts beyond IAA Level 1 scope.",
      "No fee promises without human approval.",
      "Regulated-advice phrasing blocklist applies to every outbound draft.",
    ],
  });

  // Close the circular reference now the template exists.
  const { error: linkError } = await db
    .from("businesses")
    .update({ template_id: IDS.template })
    .eq("id", IDS.business);
  if (linkError) throw new Error(`linking business to template failed: ${linkError.message}`);

  await upsert(db, "engagement_types", {
    id: IDS.enquiryType,
    template_id: IDS.template,
    key: "enquiry",
    label: "Enquiry",
  });

  for (const [i, stage] of STAGES.entries()) {
    await upsert(db, "stage_definitions", {
      id: stageId(i + 1),
      engagement_type_id: IDS.enquiryType,
      key: stage.key,
      label: stage.label,
      sort_order: i + 1,
      is_terminal: "terminal" in stage,
      terminal_outcome: "terminal" in stage ? stage.terminal : null,
    });
  }

  for (const [i, field] of FIELDS.entries()) {
    await upsert(db, "field_definitions", {
      id: fieldId(i + 1),
      template_id: IDS.template,
      entity: field.entity,
      key: field.key,
      label: field.label,
      data_type: field.data_type,
    });
  }

  // X Law vocabulary (§6): pre-instruction engagements are enquiries.
  await upsert(
    db,
    "vocabulary",
    {
      id: "01980000-0000-7000-8000-000000000301",
      template_id: IDS.template,
      term_key: "engagement",
      label: "enquiry",
    },
    "id"
  );
  await upsert(
    db,
    "vocabulary",
    {
      id: "01980000-0000-7000-8000-000000000302",
      template_id: IDS.template,
      term_key: "engagements",
      label: "enquiries",
    },
    "id"
  );

  // Actors — every row in the system attributes to one of these (§5.1).
  await upsert(db, "actors", {
    id: IDS.actorMudassir,
    account_id: IDS.account,
    actor_type: "human",
    display_name: "Mudassir",
    user_id: ownerUserId,
  });
  await upsert(db, "actors", {
    id: IDS.actorLight,
    account_id: IDS.account,
    actor_type: "agent",
    display_name: "Light",
  });
  await upsert(db, "actors", {
    id: IDS.actorMeta,
    account_id: IDS.account,
    actor_type: "integration",
    display_name: "Meta lead sync",
  });

  await upsert(
    db,
    "memberships",
    {
      id: IDS.membershipMudassir,
      user_id: ownerUserId,
      business_id: IDS.business,
      role: "owner",
    },
    "user_id,business_id"
  );

  console.log("Tenant seeded: account Mudassir → business X Law (uk_immigration_law v1).");
}

/**
 * Spec 3 Phase 1 grants. Insert-only on fixed ids (grant terms are immutable
 * — the 0014 trigger refuses updates), with a grant.issued event on first
 * insert. Granted by Mudassir (the owner), business scope, standing, via chat.
 */
async function seedGrants(db: SupabaseClient): Promise<void> {
  for (const grant of GRANTS) {
    const { data: existing, error: lookupError } = await db
      .from("grants")
      .select("id")
      .eq("id", grant.id)
      .maybeSingle();
    if (lookupError) throw new Error(`grant lookup failed: ${lookupError.message}`);
    if (existing) continue;

    const scope = { level: "business", ref: IDS.business };
    const { error } = await db.from("grants").insert({
      id: grant.id,
      business_id: IDS.business,
      created_by: IDS.actorMudassir,
      grantee_actor_id: grant.grantee,
      tool: grant.tool,
      access: grant.access,
      scope,
      duration: "standing",
      granted_by_actor_id: IDS.actorMudassir,
      via: "chat",
    });
    if (error) throw new Error(`grant insert (${grant.tool}) failed: ${error.message}`);

    await emitEvent(db, {
      business_id: IDS.business,
      actor_id: IDS.actorMudassir,
      action: "grant.issued",
      entity_type: "grant",
      entity_id: grant.id,
      payload: {
        grantee_actor_id: grant.grantee,
        tool: grant.tool,
        access: grant.access,
        scope,
        duration: "standing",
        via: "chat",
      },
    });
    console.log(`Grant issued: ${grant.tool} (${grant.access}) → ${grant.grantee === IDS.actorLight ? "Light" : "Meta lead sync"}.`);
  }
}

/**
 * Spec 1 §7 steps 1–2 for one lead: the integration actor creates the
 * contact, channels, engagement and events; the call task stands in for the
 * workflow engine's step 2 until Spec 4's tables land in Session 4.
 */
async function ingestMetaLead(db: SupabaseClient, fixture: MetaLeadFixture): Promise<void> {
  const lead = fixture.lead;
  const change = fixture.webhook.entry[0]?.changes[0]?.value;
  if (!change) throw new Error(`Fixture for lead ${lead.id} has no leadgen change.`);

  const fields = new Map(lead.field_data.map((f) => [f.name, f.values[0] ?? ""]));
  const fullName = fields.get("full_name") ?? "Unknown lead";
  const phone = normalisePhone(fields.get("phone_number") ?? "");
  const email = (fields.get("email") ?? "").toLowerCase();

  // Webhook retries must not duplicate leads: the Meta lead id on the
  // engagement's external_refs is the idempotency key.
  const { data: existing, error: existsError } = await db
    .from("engagements")
    .select("id")
    .contains("external_refs", JSON.stringify([{ system: "meta", external_id: lead.id }]))
    .limit(1);
  if (existsError) throw new Error(`lead lookup failed: ${existsError.message}`);
  if (existing && existing.length > 0) {
    console.log(`Lead ${lead.id} (${fullName}) already ingested — skipped.`);
    return;
  }

  const [givenName, ...familyParts] = fullName.split(/\s+/);
  const attribution = {
    source: "meta",
    campaign_id: lead.campaign_id,
    adset_id: lead.adset_id,
    ad_id: lead.ad_id,
    form_id: lead.form_id,
    lead_id: lead.id,
  };

  // 1. Contact + channels (consent captured from the lead form, per channel).
  const { data: contact, error: contactError } = await db
    .from("contacts")
    .insert({
      business_id: IDS.business,
      created_by: IDS.actorMeta,
      type: "person",
      display_name: fullName,
      given_name: givenName,
      family_name: familyParts.join(" ") || null,
      status: "active",
      first_touch: {
        source: "meta",
        campaign_id: lead.campaign_id,
        adset_id: lead.adset_id,
        ad_id: lead.ad_id,
        form_id: lead.form_id,
        occurred_at: lead.created_time,
      },
      locale: "en-GB",
    })
    .select("id")
    .single();
  if (contactError) throw new Error(`contact insert failed: ${contactError.message}`);

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
    const { error } = await db.from("contact_channels").insert({
      business_id: IDS.business,
      created_by: IDS.actorMeta,
      contact_id: contact.id,
      channel: channel.channel,
      value: channel.value,
      is_primary: true,
      consent,
    });
    if (error) throw new Error(`contact_channels insert failed: ${error.message}`);
  }

  await emitEvent(db, {
    business_id: IDS.business,
    actor_id: IDS.actorMeta,
    action: "contact.created",
    entity_type: "contact",
    entity_id: contact.id,
    payload: { source: "meta_lead_ads", lead_id: lead.id, display_name: fullName },
  });

  // 2. Engagement at stage New lead, attribution on the engagement (§4.2).
  const newLeadStage = stageId(1);
  const { data: engagement, error: engagementError } = await db
    .from("engagements")
    .insert({
      business_id: IDS.business,
      created_by: IDS.actorMeta,
      template_type_id: IDS.enquiryType,
      title: `${fullName} — enquiry`,
      stage_id: newLeadStage,
      stage_entered_at: lead.created_time,
      attribution,
      owner_actor_id: IDS.actorMudassir,
      external_refs: [{ system: "meta", external_id: lead.id, url: null, synced_at: new Date().toISOString() }],
    })
    .select("id")
    .single();
  if (engagementError) throw new Error(`engagement insert failed: ${engagementError.message}`);

  const { error: participantError } = await db.from("engagement_participants").insert({
    business_id: IDS.business,
    created_by: IDS.actorMeta,
    engagement_id: engagement.id,
    contact_id: contact.id,
    role: "client",
  });
  if (participantError) throw new Error(`participant insert failed: ${participantError.message}`);

  const { error: stageHistoryError } = await db.from("stage_history").insert({
    business_id: IDS.business,
    engagement_id: engagement.id,
    from_stage: null,
    to_stage: newLeadStage,
    moved_at: lead.created_time,
    moved_by: IDS.actorMeta,
  });
  if (stageHistoryError) throw new Error(`stage_history insert failed: ${stageHistoryError.message}`);

  await emitEvent(db, {
    business_id: IDS.business,
    actor_id: IDS.actorMeta,
    action: "engagement.created",
    entity_type: "engagement",
    entity_id: engagement.id,
    payload: { stage: "new_lead", attribution },
  });

  // §7 step 2 stand-in: the call task the workflow engine will spawn once
  // Spec 4's tables exist (workflow_run_id stays null until then).
  const dueAt = new Date(Date.now() + scaleDurationMs(CALL_TASK_DUE_REAL_MS)).toISOString();
  const { data: task, error: taskError } = await db
    .from("tasks")
    .insert({
      business_id: IDS.business,
      created_by: IDS.actorLight,
      engagement_id: engagement.id,
      title: `Call ${fullName} — enquiry`,
      description: `New Meta lead. Phone ${phone}, email ${email}. Call to make first contact.`,
      status: "open",
      assignee_actor_id: IDS.actorMudassir,
      due_at: dueAt,
      priority: "high",
    })
    .select("id")
    .single();
  if (taskError) throw new Error(`task insert failed: ${taskError.message}`);

  await emitEvent(db, {
    business_id: IDS.business,
    actor_id: IDS.actorLight,
    action: "task.created",
    entity_type: "task",
    entity_id: task.id,
    payload: { engagement_id: engagement.id, due_at: dueAt, reason: "new_meta_lead" },
  });

  console.log(`Lead ingested: ${fullName} (${phone}) → enquiry at "New lead" + call task.`);
}

async function main() {
  loadEnv();
  const db = createServiceClient();

  const ownerUserId = await ensureOwnerAuthUser(db);
  await seedTenant(db, ownerUserId);
  // Grants before leads: the Meta integration needs enquiries execute to ingest.
  await seedGrants(db);

  for (const fixture of metaLeadFixtures) {
    await ingestMetaLead(db, fixture);
  }

  console.log("\nSeed complete. Run `npm run verify --workspace=@rooshni/db` to inspect the ledger.");
}

main().catch((err) => {
  console.error("Seed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
