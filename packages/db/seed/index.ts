import type { SupabaseClient } from "@supabase/supabase-js";
import { loadEnv } from "../scripts/env";
import {
  approveCommunication,
  rejectCommunication,
  submitCommunication,
} from "../src/approvals";
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
  // JUDGMENT (Session 6): the engine acts as its own actor (actor_type
  // "workflow", a Spec 1 type unused until now) so ledger attribution reads
  // honestly — Light drafts, the workflow engine schedules/moves/closes.
  actorWorkflow: "01980000-0000-7000-8000-000000000014",
  membershipMudassir: "01980000-0000-7000-8000-000000000021",
  allowedEmailMudassir: "01980000-0000-7000-8000-000000000031",
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
  // Session 6: the workflow engine creates tasks and moves stages — Level 2
  // acts under the same grant system as everyone else (Spec 4 §2.3).
  { id: "01980000-0000-7000-8000-000000000405", grantee: IDS.actorWorkflow, tool: "enquiries", access: "execute" },
] as const;

const OWNER_EMAIL = "xmudassirx@gmail.com";

// Session 3 — the Approval Inbox demo. Deterministic ids; on the go-live
// purge list (docs/GO-LIVE.md) with the rest of the fixture data.
const INBOX_DEMO = {
  threadLead1: "01980000-0000-7000-8000-000000000501",
  commPending: "01980000-0000-7000-8000-000000000502",
  threadLead2: "01980000-0000-7000-8000-000000000503",
  commApproved: "01980000-0000-7000-8000-000000000504",
  commRejected: "01980000-0000-7000-8000-000000000505",
  // Session 8 fix round 4 addendum: one client-authored inbound reply, so the
  // author-side alignment law (decision 78) is falsifiable by click.
  // JUDGMENT: 507–520 are left clear — the Session 6 live rehearsals minted
  // 506 by hand, so sequential "next" ids are not safe assumptions; 521
  // verified free in live before use.
  commInboundReply: "01980000-0000-7000-8000-000000000521",
} as const;

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
  await upsert(db, "actors", {
    id: IDS.actorWorkflow,
    account_id: IDS.account,
    actor_type: "workflow",
    display_name: "Workflow engine",
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

  // Session 5 — the sign-in allowlist. Only these emails get past sign-in;
  // Mudassir maps to his existing owner actor through actors.user_id.
  await upsert(
    db,
    "allowed_emails",
    {
      id: IDS.allowedEmailMudassir,
      email: OWNER_EMAIL.toLowerCase(),
      note: "Founder — owner actor, X Law",
    },
    "email"
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
    const granteeName =
      grant.grantee === IDS.actorLight ? "Light"
      : grant.grantee === IDS.actorWorkflow ? "Workflow engine"
      : "Meta lead sync";
    console.log(`Grant issued: ${grant.tool} (${grant.access}) → ${granteeName}.`);
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

  // JUDGMENT (Session 6): the Session 1 stand-in call task is gone — the
  // workflow engine's step 2 (create_task) now owns it, spawned by the run
  // with workflow_run_id set. Existing seeded tasks on live are untouched
  // (they sit on the GO-LIVE purge list with the rest of the fixture data).
  console.log(`Lead ingested: ${fullName} (${phone}) → enquiry at "New lead".`);
}

async function findLeadEngagement(
  db: SupabaseClient,
  leadId: string
): Promise<{ engagementId: string; contactId: string }> {
  const { data: engagement, error } = await db
    .from("engagements")
    .select("id")
    .contains("external_refs", JSON.stringify([{ system: "meta", external_id: leadId }]))
    .limit(1);
  if (error) throw new Error(`engagement lookup failed: ${error.message}`);
  if (!engagement || engagement.length === 0) {
    throw new Error(`No engagement found for Meta lead ${leadId} — run the lead ingestion first.`);
  }
  const { data: participant, error: participantError } = await db
    .from("engagement_participants")
    .select("contact_id")
    .eq("engagement_id", engagement[0]!.id)
    .eq("role", "client")
    .limit(1);
  if (participantError) throw new Error(`participant lookup failed: ${participantError.message}`);
  if (!participant || participant.length === 0) {
    throw new Error(`Engagement for lead ${leadId} has no client participant.`);
  }
  return { engagementId: engagement[0]!.id, contactId: participant[0]!.contact_id };
}

/**
 * Light drafts an outbound email and submits it through the real pipeline:
 * insert at draft (comms.email grant consumed), communication.drafted on the
 * ledger, then submit_communication → pending_approval + communication.submitted.
 * Returns false when the fixed id already exists (idempotent re-runs).
 */
async function seedLightDraft(
  db: SupabaseClient,
  input: { threadId: string; commId: string; leadId: string; subject: string; body: string }
): Promise<boolean> {
  const { data: existing, error: lookupError } = await db
    .from("communications")
    .select("id")
    .eq("id", input.commId)
    .maybeSingle();
  if (lookupError) throw new Error(`communication lookup failed: ${lookupError.message}`);
  if (existing) return false;

  const lead = await findLeadEngagement(db, input.leadId);

  await upsert(db, "comm_threads", {
    id: input.threadId,
    business_id: IDS.business,
    created_by: IDS.actorLight,
    contact_id: lead.contactId,
    engagement_id: lead.engagementId,
    channel: "email",
    subject: input.subject,
  });

  const { error } = await db.from("communications").insert({
    id: input.commId,
    business_id: IDS.business,
    created_by: IDS.actorLight,
    thread_id: input.threadId,
    contact_id: lead.contactId,
    engagement_id: lead.engagementId,
    channel: "email",
    direction: "outbound",
    status: "draft",
    body: input.body,
    body_format: "plain",
    drafted_by_actor_id: IDS.actorLight,
  });
  if (error) throw new Error(`communication insert failed: ${error.message}`);

  await emitEvent(db, {
    business_id: IDS.business,
    actor_id: IDS.actorLight,
    action: "communication.drafted",
    entity_type: "communication",
    entity_id: input.commId,
    payload: { channel: "email", engagement_id: lead.engagementId },
  });

  await submitCommunication(db, {
    business_id: IDS.business,
    communication_id: input.commId,
    actor_id: IDS.actorLight,
  });
  return true;
}

/**
 * Session 3 — the Approval Inbox in action. Lead 1's intro draft stays
 * pending (the inbox demo); lead 2 carries the dev-only demonstration of the
 * full trail: one draft approved by Mudassir, one rejected with a reason and
 * returned to Light's queue. Nothing is sent — the send pipeline does not
 * exist yet, and approved ≠ sent.
 */
async function seedApprovalInboxDemo(db: SupabaseClient): Promise<void> {
  const lead1 = metaLeadFixtures[0]!.lead.id;
  const lead2 = metaLeadFixtures[1]!.lead.id;

  // Spec 4 §4 step 1: the instant acknowledgement (intro_v1 standard: ~80
  // words, no advice, no fee promises) → the Approval Inbox.
  const pendingCreated = await seedLightDraft(db, {
    threadId: INBOX_DEMO.threadLead1,
    commId: INBOX_DEMO.commPending,
    leadId: lead1,
    subject: "Your enquiry with X Law",
    body:
      "Assalamu alaikum Mudassir, thank you for your enquiry with X Law. " +
      "Mudassir will call you within the next two business hours to talk through your situation and how the process works. " +
      "If another time suits you better, simply reply to this email and we will arrange the call around you. " +
      "There is nothing you need to prepare — any dates or paperwork you have to hand will help, but none of it is essential. Speak soon.",
  });
  if (pendingCreated) {
    console.log("Light's intro draft awaits the stamp in the Approval Inbox (lead 1).");
  } else {
    console.log("Inbox demo draft already seeded — skipped.");
  }

  const approvedCreated = await seedLightDraft(db, {
    threadId: INBOX_DEMO.threadLead2,
    commId: INBOX_DEMO.commApproved,
    leadId: lead2,
    subject: "Your enquiry with X Law",
    body:
      "Assalamu alaikum BarakahX, thank you for getting in touch with X Law about your immigration matter. " +
      "Mudassir will call you within the next two business hours to hear the details and explain the next steps. " +
      "If you would rather pick a time, reply to this email and we will fit around you. " +
      "No preparation is needed — the call is simply to understand your situation properly. Speak soon.",
  });
  if (approvedCreated) {
    await approveCommunication(db, {
      business_id: IDS.business,
      communication_id: INBOX_DEMO.commApproved,
      approver_actor_id: IDS.actorMudassir,
    });
    console.log("Demo approval: Mudassir stamped Light's draft — communication.approved on the ledger.");
  }

  const rejectedCreated = await seedLightDraft(db, {
    threadId: INBOX_DEMO.threadLead2,
    commId: INBOX_DEMO.commRejected,
    leadId: lead2,
    subject: "Your enquiry with X Law",
    body:
      "Dear BarakahX, further to your recent enquiry, X Law confirms receipt and will revert in due course " +
      "regarding the applicable process and requirements. Kindly await further contact.",
  });
  if (rejectedCreated) {
    await rejectCommunication(db, {
      business_id: IDS.business,
      communication_id: INBOX_DEMO.commRejected,
      rejected_by_actor_id: IDS.actorMudassir,
      reason: "Too formal for a first touch — warm it up and lead with the call we owe them.",
    });
    console.log("Demo rejection: reason recorded, draft returned to Light's queue.");
  }
}

/**
 * Session 8 (fix round 4 addendum) — ONE client-authored inbound reply on
 * lead 2's thread, so a two-sided chat exists and the author-side alignment
 * law can be verified by click. Timestamped between the thread's second and
 * third outbound touches where three exist (the live rehearsal nudges);
 * otherwise a minute after the last outbound. Ingested by the Meta
 * integration actor — authorship is the DIRECTION plus the contact, as with
 * every inbound. Seed data: purges at go-live with the rest.
 */
async function seedInboundReply(db: SupabaseClient): Promise<void> {
  const { data: existing, error: lookupError } = await db
    .from("communications")
    .select("id")
    .eq("id", INBOX_DEMO.commInboundReply)
    .maybeSingle();
  if (lookupError) throw new Error(`inbound reply lookup failed: ${lookupError.message}`);
  if (existing) {
    console.log("Inbound reply already seeded — skipped.");
    return;
  }

  const lead2 = metaLeadFixtures[1]!.lead.id;
  const lead = await findLeadEngagement(db, lead2);

  const { data: outbound, error: outboundError } = await db
    .from("communications")
    .select("id, occurred_at")
    .eq("thread_id", INBOX_DEMO.threadLead2)
    .eq("direction", "outbound")
    .order("occurred_at", { ascending: true });
  if (outboundError) throw new Error(`outbound lookup failed: ${outboundError.message}`);
  if (!outbound?.length) {
    throw new Error("Lead 2's thread has no outbound messages — seed order broken.");
  }

  // The nudges are the run-produced touches (uuidv7 ids from the Session 6
  // rehearsals), not the fixed-id inbox demo comms. Land between the second
  // and third nudge; fall back to a minute after the last outbound.
  const nudges = outbound.filter((c) => !String(c.id).startsWith("01980000-"));
  const second = nudges[1];
  const third = nudges[2];
  const occurredAt =
    second && third
      ? new Date(
          (new Date(second.occurred_at).getTime() + new Date(third.occurred_at).getTime()) / 2
        )
      : new Date(new Date(outbound[outbound.length - 1]!.occurred_at).getTime() + 60_000);

  const { error } = await db.from("communications").insert({
    id: INBOX_DEMO.commInboundReply,
    business_id: IDS.business,
    created_by: IDS.actorMeta,
    thread_id: INBOX_DEMO.threadLead2,
    contact_id: lead.contactId,
    engagement_id: lead.engagementId,
    channel: "email",
    direction: "inbound",
    status: "received",
    body: "Wa alaikum assalam, yes — tomorrow after 2pm works",
    body_format: "plain",
    occurred_at: occurredAt.toISOString(),
  });
  if (error) throw new Error(`inbound reply insert failed: ${error.message}`);

  await emitEvent(db, {
    business_id: IDS.business,
    actor_id: IDS.actorMeta,
    action: "communication.received",
    entity_type: "communication",
    entity_id: INBOX_DEMO.commInboundReply,
    payload: { channel: "email", engagement_id: lead.engagementId, direction: "inbound" },
  });
  console.log("Inbound reply seeded on lead 2's thread — the chat now has two sides.");
}

// ---------------------------------------------------------------------------
// Session 6 — Spec 4 §4: the MVP lead workflow, defined entirely as DATA.
// ---------------------------------------------------------------------------

// The nurture and acknowledgement messages, each referencing a template (§3).
// British English; the intro follows the 80-word standard; no advice, no fee
// promises. Every draft rendered from these is still stamped individually.
const TEMPLATES = [
  {
    id: "01980000-0000-7000-8000-000000000601",
    key: "intro_v1",
    channel: "email",
    subject: "Your enquiry with {{business_name}}",
    // Founder-ruled (Session 10 close pass): the greeting is NEUTRAL by
    // default — behaviour-driven warmth personalisation waits for the
    // memory era, and demographic inference is never used
    // (LIGHT-OPERATING-DOCTRINE). Live carries this copy as version 2.
    body:
      "Hello {{first_name}}, thank you for your enquiry with {{business_name}}. " +
      "{{owner_name}} will call you within the next two business hours to talk through your situation and how the process works. " +
      "If another time suits you better, simply reply to this email and we will arrange the call around you. " +
      "There is nothing you need to prepare — any dates or paperwork you have to hand will help, but none of it is essential. Speak soon.",
  },
  {
    id: "01980000-0000-7000-8000-000000000602",
    key: "missed_call_v1",
    channel: "email",
    subject: "Sorry we missed you — {{business_name}}",
    body:
      "Assalamu alaikum {{first_name}}, we tried to call you today about your enquiry but could not get through. " +
      "No trouble at all — reply to this email with a time that suits you, or call us back whenever you are free, " +
      "and {{owner_name}} will pick things up from there.",
  },
  {
    id: "01980000-0000-7000-8000-000000000603",
    key: "nurture_t2_v1",
    channel: "whatsapp",
    subject: null,
    body:
      "Assalamu alaikum {{first_name}}, just a gentle nudge about your enquiry with {{business_name}}. " +
      "{{owner_name}} would still be glad to talk it through with you — reply here, or tell us a time that suits and we will call you.",
  },
  {
    id: "01980000-0000-7000-8000-000000000604",
    key: "nurture_t5_v1",
    channel: "email",
    subject: "What the financial requirement actually means",
    body:
      "Assalamu alaikum {{first_name}}, while your enquiry is open, here is the question we are asked most often: the financial requirement. " +
      "In short, the Home Office asks the sponsor to show a minimum income or savings above a set threshold, evidenced in a very specific format — " +
      "and many refusals happen on the format, not the money. If you would like us to look at your situation with you, " +
      "reply to this email and {{owner_name}} will call you.",
  },
  {
    id: "01980000-0000-7000-8000-000000000605",
    key: "nurture_t9_v1",
    channel: "email",
    subject: "Shall we close your file?",
    body:
      "Assalamu alaikum {{first_name}}, we have tried to reach you a few times about your enquiry with {{business_name}} and have not heard back — " +
      "no problem at all if the timing is not right. Unless we hear from you in the next few days we will close your file for now. " +
      "If you would like to pick things up again, simply reply to this email or give us a call and we will reopen it straight away.",
  },
] as const;

const WORKFLOW = {
  definition: "01980000-0000-7000-8000-000000000701",
  stepBase: "01980000-0000-7000-8000-0000000007",
} as const;

function workflowStepId(index: number): string {
  return `${WORKFLOW.stepBase}${String(10 + index).padStart(2, "0")}`;
}

// Spec 4 §4 steps 1–10 as rows. Timers are REAL durations in config, scaled
// only via timeScale() at scheduling time. Steps whose observers do not exist
// yet carry a `when` condition; unobservable conditions skip ON THE LEDGER —
// the definition holds the full sequence, the Phase 1 machinery runs what
// exists.
const MVP_STEPS = [
  // 1 — instant acknowledgement: Light drafts, the run BLOCKS for the stamp.
  { key: "intro_ack", kind: "draft_comm", gate: 3,
    config: { template: "intro_v1", channel: "email", await_approval: true, sla: { seconds: 60 } } },
  // 2 — call task for the owner. JUDGMENT: "2 business hours" runs as plain
  // hours in Phase 1 (no business-hours calendar exists; §4 timers are
  // provisional against the lead log anyway).
  { key: "call_task", kind: "create_task", gate: 2,
    config: { title: "Call {{first_name}} — enquiry", assignee: "owner", priority: "high", due: { hours: 2 },
              description: "New Meta lead. Call {{full_name}} to make first contact and talk through their situation." } },
  // 3 — missed-call retry (+4h): observable once call outcomes exist.
  { key: "call_retry", kind: "create_task", gate: 2,
    config: { when: "first_call_no_answer", title: "Second call attempt — {{first_name}}", assignee: "owner",
              priority: "high", due: { hours: 4 } } },
  // 4 — both calls failed → sorry-we-missed-you (email; WhatsApp if consented).
  { key: "missed_call_message", kind: "draft_comm", gate: 3,
    config: { when: "both_calls_failed", template: "missed_call_v1", channel: "email" } },
  // 5 — reply handling: Light parses and qualifies — Phase 2 machinery.
  { key: "reply_handling", kind: "branch", gate: 2,
    config: { when: "inbound_reply_received", note: "Light qualification against template criteria — Phase 2." } },
  // 6 — booking link once qualified (calendar session to come).
  { key: "booking", kind: "draft_comm", gate: 3,
    config: { when: "qualified", template: "booking_v1", channel: "email" } },
  // 7 — consultation reminders at fixed offsets (calendar session to come).
  { key: "reminder", kind: "notify", gate: 1,
    config: { when: "consultation_booked", offsets: [{ hours: 24 }, { hours: 2 }] } },
  // 8 — the nurture loop: T+2d WhatsApp, T+5d email, T+9d final notice.
  // JUDGMENT: waits anchor sequentially after the intro is stamped (2/3/4-day
  // gaps produce the spec's T+2/5/9); a reply cancels remaining touches.
  { key: "nurture_wait_t2", kind: "wait", gate: 0, config: { wait: { days: 2 }, cancel_on_reply: true } },
  { key: "nurture_t2", kind: "draft_comm", gate: 3,
    // JUDGMENT: WhatsApp nudge falls back to email when no consented WhatsApp
    // channel is on file (§4 step 4's "(if consented)" applied to step 8).
    config: { template: "nurture_t2_v1", channel: "whatsapp", fallback_channel: "email", cancel_on_reply: true } },
  { key: "nurture_wait_t5", kind: "wait", gate: 0, config: { wait: { days: 3 }, cancel_on_reply: true } },
  { key: "nurture_t5", kind: "draft_comm", gate: 3,
    config: { template: "nurture_t5_v1", channel: "email", cancel_on_reply: true } },
  { key: "nurture_wait_t9", kind: "wait", gate: 0, config: { wait: { days: 4 }, cancel_on_reply: true } },
  { key: "nurture_t9", kind: "draft_comm", gate: 3,
    config: { template: "nurture_t9_v1", channel: "email", cancel_on_reply: true } },
  // 9 — auto-close after final touch + 3 days of silence (≈ T+12d).
  { key: "close_wait", kind: "wait", gate: 0, config: { wait: { days: 3 }, cancel_on_reply: true } },
  { key: "auto_close", kind: "close", gate: 2, config: { stage: "unresponsive" } },
  // 10 — outcome feedback to Meta (STUB executor logs the would-be signal;
  // the real Conversions wiring is its own session — docs/GO-LIVE.md).
  { key: "outcome_feedback", kind: "fire_conversion", gate: 2,
    config: { signal: "outcome_feedback", cooling: { hours: 24 } } },
] as const;

const MVP_DESCRIPTION =
  "When a new Meta lead arrives: draft an instant acknowledgement email for approval; create a call task for the owner, " +
  "due within two hours; if both calls fail, draft a sorry-we-missed-you message; watch for replies and, once qualified, " +
  "send a booking link with consultation reminders (later phase); if there is no response, nudge on day two (WhatsApp), " +
  "day five (email) and day nine (final notice); after three further days of silence, close the enquiry as Unresponsive " +
  "and log the outcome signal for Meta. Every outgoing message waits for a human stamp before anything is sent.";

/**
 * Templates, then the MVP definition through the REAL pipeline: insert at
 * draft → steps → submit → approve (Mudassir's stamp), every move evented.
 * Idempotent: fixed ids; the whole block is skipped once the definition
 * exists (an active definition is immutable — re-seeding must not touch it).
 */
async function seedWorkflow(db: SupabaseClient): Promise<void> {
  for (const template of TEMPLATES) {
    const { data: existing, error: lookupError } = await db
      .from("message_templates")
      .select("id")
      .eq("id", template.id)
      .maybeSingle();
    if (lookupError) throw new Error(`template lookup failed: ${lookupError.message}`);
    if (existing) continue;
    const { error } = await db.from("message_templates").insert({
      id: template.id,
      business_id: IDS.business,
      created_by: IDS.actorMudassir,
      key: template.key,
      channel: template.channel,
      subject: template.subject,
      body: template.body,
      locale: "en-GB",
      version: 1,
    });
    if (error) throw new Error(`template insert (${template.key}) failed: ${error.message}`);
    await emitEvent(db, {
      business_id: IDS.business,
      actor_id: IDS.actorMudassir,
      action: "message_template.created",
      entity_type: "message_template",
      entity_id: template.id,
      payload: { key: template.key, channel: template.channel, version: 1 },
    });
    console.log(`Message template seeded: ${template.key} (${template.channel}).`);
  }

  const { data: existingDef, error: defLookupError } = await db
    .from("workflow_definitions")
    .select("id, status")
    .eq("id", WORKFLOW.definition)
    .maybeSingle();
  if (defLookupError) throw new Error(`definition lookup failed: ${defLookupError.message}`);
  if (existingDef) {
    console.log(`MVP workflow definition already seeded (${existingDef.status}) — skipped.`);
    return;
  }

  const { error: defError } = await db.from("workflow_definitions").insert({
    id: WORKFLOW.definition,
    business_id: IDS.business,
    created_by: IDS.actorMudassir,
    key: "meta_lead_to_consultation",
    version: 1,
    template_id: IDS.template,
    trigger: { action: "engagement.created", source: "meta" },
    status: "draft",
    description_plain: MVP_DESCRIPTION,
  });
  if (defError) throw new Error(`workflow definition insert failed: ${defError.message}`);
  await emitEvent(db, {
    business_id: IDS.business,
    actor_id: IDS.actorMudassir,
    action: "workflow_definition.created",
    entity_type: "workflow_definition",
    entity_id: WORKFLOW.definition,
    payload: { key: "meta_lead_to_consultation", version: 1, trigger: { action: "engagement.created", source: "meta" } },
  });

  for (const [i, step] of MVP_STEPS.entries()) {
    const { error } = await db.from("workflow_steps").insert({
      id: workflowStepId(i + 1),
      business_id: IDS.business,
      created_by: IDS.actorMudassir,
      definition_id: WORKFLOW.definition,
      key: step.key,
      sort_order: i + 1,
      kind: step.kind,
      config: step.config,
      gate_level: step.gate,
    });
    if (error) throw new Error(`workflow step insert (${step.key}) failed: ${error.message}`);
  }

  const { error: submitError } = await db.rpc("submit_workflow_definition", {
    p_def: WORKFLOW.definition,
    p_actor: IDS.actorMudassir,
  });
  if (submitError) throw new Error(`submit_workflow_definition failed: ${submitError.message}`);
  await emitEvent(db, {
    business_id: IDS.business,
    actor_id: IDS.actorMudassir,
    action: "workflow_definition.submitted",
    entity_type: "workflow_definition",
    entity_id: WORKFLOW.definition,
  });

  const { error: approveError } = await db.rpc("approve_workflow_definition", {
    p_def: WORKFLOW.definition,
    p_approver: IDS.actorMudassir,
  });
  if (approveError) throw new Error(`approve_workflow_definition failed: ${approveError.message}`);
  await emitEvent(db, {
    business_id: IDS.business,
    actor_id: IDS.actorMudassir,
    action: "workflow_definition.approved",
    entity_type: "workflow_definition",
    entity_id: WORKFLOW.definition,
    approval: { level: 3, approved_by: IDS.actorMudassir, decided_at: new Date().toISOString() },
    payload: { key: "meta_lead_to_consultation", version: 1, steps: MVP_STEPS.length },
  });

  console.log(`MVP workflow seeded and activated: meta_lead_to_consultation v1 (${MVP_STEPS.length} steps as data).`);
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

  await seedApprovalInboxDemo(db);
  await seedInboundReply(db);
  await seedWorkflow(db);

  console.log("\nSeed complete. Run `npm run verify --workspace=@rooshni/db` to inspect the ledger.");
}

main().catch((err) => {
  console.error("Seed failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
