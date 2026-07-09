import "server-only";
import type { ActorType, ApprovalInboxRow, EventRow } from "@rooshni/db";
import { getAppContext } from "./context";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

// --- Enquiries pipeline (read-only this session) ---------------------------

export interface PipelineCard {
  engagementId: string;
  name: string;
  visaRoute: string | null;
  source: string | null;
  stageEnteredAt: string;
  /** What happens next: Light's pending draft beats the earliest open task. */
  nextAction: { text: string; byLight: boolean } | null;
  pendingApprovals: number;
}

export interface PipelineStage {
  id: string;
  key: string;
  label: string;
  isTerminal: boolean;
  cards: PipelineCard[];
}

export async function getPipeline(): Promise<PipelineStage[]> {
  const { db, business } = await getAppContext();

  const { data: types, error: typesError } = await db
    .from("engagement_types")
    .select("id, templates!inner(business_id)")
    .eq("templates.business_id", business.id);
  if (typesError) throw new Error(`engagement_types query failed: ${typesError.message}`);
  const typeIds = (types ?? []).map((t) => t.id);

  const { data: stages, error: stagesError } = await db
    .from("stage_definitions")
    .select("id, key, label, sort_order, is_terminal")
    .in("engagement_type_id", typeIds)
    .is("archived_at", null)
    .order("sort_order", { ascending: true });
  if (stagesError) throw new Error(`stage_definitions query failed: ${stagesError.message}`);

  const { data: engagements, error: engError } = await db
    .from("engagements")
    .select("id, title, stage_id, stage_entered_at, attributes, attribution")
    .eq("business_id", business.id)
    .is("archived_at", null);
  if (engError) throw new Error(`engagements query failed: ${engError.message}`);

  const engagementIds = (engagements ?? []).map((e) => e.id);

  const [participants, tasks, inboxRows] = await Promise.all([
    engagementIds.length
      ? db
          .from("engagement_participants")
          .select("engagement_id, role, contacts(display_name)")
          .in("engagement_id", engagementIds)
          .eq("role", "client")
      : Promise.resolve({ data: [], error: null }),
    engagementIds.length
      ? db
          .from("tasks")
          .select("engagement_id, title, due_at, status")
          .in("engagement_id", engagementIds)
          .eq("status", "open")
          .is("archived_at", null)
          .order("due_at", { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    db.from("approval_inbox").select("*").eq("business_id", business.id),
  ]);
  if (participants.error) throw new Error(`participants query failed: ${participants.error.message}`);
  if (tasks.error) throw new Error(`tasks query failed: ${tasks.error.message}`);
  if (inboxRows.error) throw new Error(`approval_inbox query failed: ${inboxRows.error.message}`);

  const nameByEngagement = new Map<string, string>();
  for (const p of participants.data ?? []) {
    const contact = p.contacts as unknown as { display_name: string } | null;
    if (contact && !nameByEngagement.has(p.engagement_id)) {
      nameByEngagement.set(p.engagement_id, contact.display_name);
    }
  }

  const firstTaskByEngagement = new Map<string, { title: string; due_at: string | null }>();
  for (const t of tasks.data ?? []) {
    if (t.engagement_id && !firstTaskByEngagement.has(t.engagement_id)) {
      firstTaskByEngagement.set(t.engagement_id, t);
    }
  }

  const inboxByEngagement = new Map<string, ApprovalInboxRow[]>();
  for (const row of (inboxRows.data ?? []) as ApprovalInboxRow[]) {
    if (!row.engagement_id) continue;
    const list = inboxByEngagement.get(row.engagement_id) ?? [];
    list.push(row);
    inboxByEngagement.set(row.engagement_id, list);
  }

  return (stages ?? []).map((stage) => ({
    id: stage.id,
    key: stage.key,
    label: stage.label,
    isTerminal: stage.is_terminal,
    cards: (engagements ?? [])
      .filter((e) => e.stage_id === stage.id)
      .sort((a, b) => a.stage_entered_at.localeCompare(b.stage_entered_at))
      .map((e) => {
        const pending = inboxByEngagement.get(e.id) ?? [];
        const pendingComm = pending.find((r) => r.item_type === "communication");
        const task = firstTaskByEngagement.get(e.id);
        const attributes = (e.attributes ?? {}) as Record<string, unknown>;
        const attribution = (e.attribution ?? {}) as Record<string, unknown>;
        const nextAction = pendingComm
          ? {
              text: `Light: ${pendingComm.channel ?? "message"} draft awaiting your stamp`,
              byLight: true,
            }
          : task
            ? { text: task.title, byLight: false }
            : null;
        return {
          engagementId: e.id,
          name: nameByEngagement.get(e.id) ?? e.title,
          visaRoute: typeof attributes.visa_route === "string" ? attributes.visa_route : null,
          source: typeof attribution.source === "string" ? attribution.source : null,
          stageEnteredAt: e.stage_entered_at,
          nextAction,
          pendingApprovals: pending.length,
        };
      }),
  }));
}

// --- The Approval Inbox -----------------------------------------------------

export async function getInbox(): Promise<ApprovalInboxRow[]> {
  const { db, business } = await getAppContext();
  const { data, error } = await db
    .from("approval_inbox")
    .select("*")
    .eq("business_id", business.id)
    .order("awaiting_since", { ascending: true });
  if (error) throw new Error(`approval_inbox query failed: ${error.message}`);
  return (data ?? []) as ApprovalInboxRow[];
}

export async function getInboxCount(): Promise<number> {
  const { db, business } = await getAppContext();
  const { count, error } = await db
    .from("approval_inbox")
    .select("*", { count: "exact", head: true })
    .eq("business_id", business.id);
  if (error) throw new Error(`approval_inbox count failed: ${error.message}`);
  return count ?? 0;
}

export interface CommunicationDetail {
  id: string;
  body: string;
  channel: string;
  subject: string | null;
  contactName: string | null;
  scheduledFor: string | null;
}

/** Full draft for the inbox detail panel — the view carries only a preview. */
export async function getCommunicationDetail(
  id: string
): Promise<CommunicationDetail | null> {
  const { db, business } = await getAppContext();
  const { data, error } = await db
    .from("communications")
    .select(
      "id, body, channel, scheduled_for, comm_threads(subject), contacts(display_name)"
    )
    .eq("id", id)
    .eq("business_id", business.id)
    .maybeSingle();
  if (error) throw new Error(`communication lookup failed: ${error.message}`);
  if (!data) return null;
  const thread = data.comm_threads as unknown as { subject: string | null } | null;
  const contact = data.contacts as unknown as { display_name: string } | null;
  return {
    id: data.id,
    body: data.body,
    channel: data.channel,
    subject: thread?.subject ?? null,
    contactName: contact?.display_name ?? null,
    scheduledFor: data.scheduled_for,
  };
}

// --- The Record (read-only screen over the events ledger) -------------------

export interface RecordEvent {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  payload: Record<string, unknown>;
  cost: EventRow["cost"];
  occurredAt: string;
  actorName: string;
  actorType: ActorType;
}

/** Entity kinds the Record can be deep-link filtered to. */
export type RecordEntityType = "engagement" | "contact";

interface ActorEmbed {
  display_name: string;
  actor_type: ActorType;
}

/**
 * The most recent slice of the ledger, newest first. When `filter` is given,
 * only entries about that entity — matched on the entity columns or on the
 * payload's `<entity>_id` reference — are returned.
 *
 * JUDGMENT: capped at the most recent 300 entries — search and pagination are
 * their own session; an uncapped query over an append-only table only gets
 * slower forever.
 */
export async function getRecordEvents(filter?: {
  entityType: RecordEntityType;
  entityId: string;
}): Promise<RecordEvent[]> {
  const { db, business } = await getAppContext();

  let query = db
    .from("events")
    .select("id, action, entity_type, entity_id, payload, cost, occurred_at, actors(display_name, actor_type)")
    .eq("business_id", business.id)
    .order("occurred_at", { ascending: false })
    .limit(300);

  if (filter) {
    // isUuid-validated by the caller; belt to those braces before string-building.
    if (!isUuid(filter.entityId)) return [];
    query = query.or(
      `and(entity_type.eq.${filter.entityType},entity_id.eq.${filter.entityId}),` +
        `payload->>${filter.entityType}_id.eq.${filter.entityId}`
    );
  }

  const { data, error } = await query;
  if (error) throw new Error(`events query failed: ${error.message}`);

  return (data ?? []).map((row) => {
    const actor = row.actors as unknown as ActorEmbed | null;
    return {
      id: row.id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      payload: (row.payload ?? {}) as Record<string, unknown>,
      cost: row.cost as EventRow["cost"],
      occurredAt: row.occurred_at,
      actorName: actor?.display_name ?? "Unknown actor",
      actorType: actor?.actor_type ?? "integration",
    };
  });
}

// --- Enquiry detail ----------------------------------------------------------

export interface EnquiryStage {
  id: string;
  key: string;
  label: string;
  sortOrder: number;
  isTerminal: boolean;
  terminalOutcome: string | null;
}

export interface EnquiryStageMove {
  id: string;
  fromStageId: string | null;
  toStageId: string;
  movedAt: string;
  movedByName: string;
  movedByType: ActorType;
}

export interface EnquiryParticipant {
  contactId: string;
  role: string;
  name: string;
  type: "person" | "organisation";
  status: string;
  locale: string;
}

export interface ChannelConsent {
  channel: string;
  value: string;
  isPrimary: boolean;
  consent: Record<string, unknown>;
}

export interface EnquiryComm {
  id: string;
  channel: string;
  direction: "inbound" | "outbound" | "internal";
  status: string;
  body: string;
  subject: string | null;
  occurredAt: string;
  scheduledFor: string | null;
  draftedByName: string | null;
  draftedByType: ActorType | null;
  approvedByName: string | null;
  approvedAt: string | null;
  rejection: { reason: string; at: string; byName: string } | null;
}

export interface EnquiryTask {
  id: string;
  title: string;
  status: string;
  dueAt: string | null;
  assigneeName: string | null;
  assigneeType: ActorType | null;
  createdByType: ActorType | null;
}

export interface EnquiryDetail {
  id: string;
  title: string;
  createdAt: string;
  stageId: string;
  stageEnteredAt: string;
  outcome: string | null;
  valueEstimate: number | null;
  visaRoute: string | null;
  source: Record<string, unknown>;
  ownerName: string | null;
  stages: EnquiryStage[];
  stageHistory: EnquiryStageMove[];
  participants: EnquiryParticipant[];
  clientChannels: ChannelConsent[];
  comms: EnquiryComm[];
  events: RecordEvent[];
  tasks: EnquiryTask[];
}

/**
 * Everything the enquiry detail page shows, from the same rows every other
 * face reads: the engagement, its stage rail and history, participants and
 * their consented channels, communications, engagement-scoped ledger entries,
 * and tasks. Actor names are resolved in one batch at the end.
 */
export async function getEnquiryDetail(id: string): Promise<EnquiryDetail | null> {
  if (!isUuid(id)) return null;
  const { db, business } = await getAppContext();

  const { data: engagement, error: engError } = await db
    .from("engagements")
    .select(
      "id, title, created_at, template_type_id, stage_id, stage_entered_at, outcome, value_estimate, attributes, attribution, owner_actor_id"
    )
    .eq("id", id)
    .eq("business_id", business.id)
    .is("archived_at", null)
    .maybeSingle();
  if (engError) throw new Error(`engagement lookup failed: ${engError.message}`);
  if (!engagement) return null;

  const [stages, history, participants, comms, engagementEvents, tasks] = await Promise.all([
    db
      .from("stage_definitions")
      .select("id, key, label, sort_order, is_terminal, terminal_outcome")
      .eq("engagement_type_id", engagement.template_type_id)
      .is("archived_at", null)
      .order("sort_order", { ascending: true }),
    db
      .from("stage_history")
      .select("id, from_stage, to_stage, moved_at, moved_by")
      .eq("engagement_id", id)
      .order("moved_at", { ascending: true }),
    db
      .from("engagement_participants")
      .select("contact_id, role, contacts(id, display_name, type, status, locale)")
      .eq("engagement_id", id)
      .is("archived_at", null),
    db
      .from("communications")
      .select(
        "id, channel, direction, status, body, occurred_at, scheduled_for, drafted_by_actor_id, approved_by_actor_id, created_by, comm_threads(subject)"
      )
      .eq("engagement_id", id)
      .is("archived_at", null)
      .order("occurred_at", { ascending: true }),
    db
      .from("events")
      .select("id, action, entity_type, entity_id, payload, cost, occurred_at, actors(display_name, actor_type)")
      .eq("business_id", business.id)
      .or(`and(entity_type.eq.engagement,entity_id.eq.${id}),payload->>engagement_id.eq.${id}`)
      .order("occurred_at", { ascending: true }),
    db
      .from("tasks")
      .select("id, title, status, due_at, assignee_actor_id, created_by")
      .eq("engagement_id", id)
      .is("archived_at", null)
      .order("due_at", { ascending: true }),
  ]);
  for (const [label, result] of [
    ["stage_definitions", stages],
    ["stage_history", history],
    ["participants", participants],
    ["communications", comms],
    ["events", engagementEvents],
    ["tasks", tasks],
  ] as const) {
    if (result.error) throw new Error(`${label} query failed: ${result.error.message}`);
  }

  // Approval/rejection detail lives on the communication events.
  const commIds = (comms.data ?? []).map((c) => c.id);
  const { data: commEvents, error: commEventsError } = commIds.length
    ? await db
        .from("events")
        .select("action, entity_id, payload, occurred_at, actors(display_name, actor_type)")
        .eq("business_id", business.id)
        .eq("entity_type", "communication")
        .in("entity_id", commIds)
        .order("occurred_at", { ascending: true })
    : { data: [], error: null };
  if (commEventsError) throw new Error(`communication events query failed: ${commEventsError.message}`);

  // One batch lookup for every actor id the page mentions.
  const actorIds = new Set<string>();
  actorIds.add(engagement.owner_actor_id);
  for (const move of history.data ?? []) actorIds.add(move.moved_by);
  for (const comm of comms.data ?? []) {
    if (comm.drafted_by_actor_id) actorIds.add(comm.drafted_by_actor_id);
    if (comm.approved_by_actor_id) actorIds.add(comm.approved_by_actor_id);
  }
  for (const task of tasks.data ?? []) {
    if (task.assignee_actor_id) actorIds.add(task.assignee_actor_id);
    if (task.created_by) actorIds.add(task.created_by);
  }
  const { data: actorRows, error: actorsError } = await db
    .from("actors")
    .select("id, display_name, actor_type")
    .in("id", [...actorIds]);
  if (actorsError) throw new Error(`actors query failed: ${actorsError.message}`);
  const actors = new Map(
    (actorRows ?? []).map((a) => [a.id, { name: a.display_name as string, type: a.actor_type as ActorType }])
  );

  // Client channels drive the consent panel — consent is per channel, by law.
  const participantRows: EnquiryParticipant[] = (participants.data ?? []).flatMap((p) => {
    const contact = p.contacts as unknown as {
      id: string;
      display_name: string;
      type: "person" | "organisation";
      status: string;
      locale: string;
    } | null;
    if (!contact) return [];
    return [
      {
        contactId: contact.id,
        role: p.role,
        name: contact.display_name,
        type: contact.type,
        status: contact.status,
        locale: contact.locale,
      },
    ];
  });
  const client = participantRows.find((p) => p.role === "client");
  const { data: channelRows, error: channelsError } = client
    ? await db
        .from("contact_channels")
        .select("channel, value, is_primary, consent")
        .eq("contact_id", client.contactId)
        .is("archived_at", null)
    : { data: [], error: null };
  if (channelsError) throw new Error(`contact_channels query failed: ${channelsError.message}`);

  const approvals = new Map<string, { at: string; byName: string }>();
  const rejections = new Map<string, { reason: string; at: string; byName: string }>();
  for (const ev of commEvents ?? []) {
    if (!ev.entity_id) continue;
    const actor = ev.actors as unknown as ActorEmbed | null;
    if (ev.action === "communication.approved") {
      approvals.set(ev.entity_id, { at: ev.occurred_at, byName: actor?.display_name ?? "Unknown" });
    } else if (ev.action === "communication.rejected") {
      const payload = (ev.payload ?? {}) as Record<string, unknown>;
      rejections.set(ev.entity_id, {
        reason: typeof payload.reason === "string" ? payload.reason : "No reason recorded",
        at: ev.occurred_at,
        byName: actor?.display_name ?? "Unknown",
      });
    }
  }

  const attributes = (engagement.attributes ?? {}) as Record<string, unknown>;

  return {
    id: engagement.id,
    title: engagement.title,
    createdAt: engagement.created_at,
    stageId: engagement.stage_id,
    stageEnteredAt: engagement.stage_entered_at,
    outcome: engagement.outcome,
    valueEstimate: engagement.value_estimate === null ? null : Number(engagement.value_estimate),
    visaRoute: typeof attributes.visa_route === "string" ? attributes.visa_route : null,
    source: (engagement.attribution ?? {}) as Record<string, unknown>,
    ownerName: actors.get(engagement.owner_actor_id)?.name ?? null,
    stages: (stages.data ?? []).map((s) => ({
      id: s.id,
      key: s.key,
      label: s.label,
      sortOrder: s.sort_order,
      isTerminal: s.is_terminal,
      terminalOutcome: s.terminal_outcome,
    })),
    stageHistory: (history.data ?? []).map((m) => ({
      id: m.id,
      fromStageId: m.from_stage,
      toStageId: m.to_stage,
      movedAt: m.moved_at,
      movedByName: actors.get(m.moved_by)?.name ?? "Unknown actor",
      movedByType: actors.get(m.moved_by)?.type ?? "integration",
    })),
    participants: participantRows,
    clientChannels: (channelRows ?? []).map((c) => ({
      channel: c.channel,
      value: c.value,
      isPrimary: c.is_primary,
      consent: (c.consent ?? {}) as Record<string, unknown>,
    })),
    comms: (comms.data ?? []).map((c) => {
      const thread = c.comm_threads as unknown as { subject: string | null } | null;
      const draftedBy = c.drafted_by_actor_id ? actors.get(c.drafted_by_actor_id) : undefined;
      const approvedBy = c.approved_by_actor_id ? actors.get(c.approved_by_actor_id) : undefined;
      const approval = approvals.get(c.id);
      return {
        id: c.id,
        channel: c.channel,
        direction: c.direction,
        status: c.status,
        body: c.body,
        subject: thread?.subject ?? null,
        occurredAt: c.occurred_at,
        scheduledFor: c.scheduled_for,
        draftedByName: draftedBy?.name ?? null,
        draftedByType: draftedBy?.type ?? null,
        approvedByName: approvedBy?.name ?? approval?.byName ?? null,
        approvedAt: approval?.at ?? null,
        rejection: rejections.get(c.id) ?? null,
      };
    }),
    events: (engagementEvents.data ?? []).map((row) => {
      const actor = row.actors as unknown as ActorEmbed | null;
      return {
        id: row.id,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        payload: (row.payload ?? {}) as Record<string, unknown>,
        cost: row.cost as EventRow["cost"],
        occurredAt: row.occurred_at,
        actorName: actor?.display_name ?? "Unknown actor",
        actorType: actor?.actor_type ?? "integration",
      };
    }),
    tasks: (tasks.data ?? []).map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      dueAt: t.due_at,
      assigneeName: t.assignee_actor_id ? (actors.get(t.assignee_actor_id)?.name ?? null) : null,
      assigneeType: t.assignee_actor_id ? (actors.get(t.assignee_actor_id)?.type ?? null) : null,
      createdByType: t.created_by ? (actors.get(t.created_by)?.type ?? null) : null,
    })),
  };
}

// --- Contacts ----------------------------------------------------------------

export interface ContactRelationship {
  contactId: string;
  name: string;
  relationship: string;
  /** "out": this contact → other ("spouse of X"); "in": other → this one. */
  direction: "out" | "in";
}

export interface ContactListRow {
  id: string;
  name: string;
  type: "person" | "organisation";
  status: string;
  locale: string;
  source: string | null;
  channels: ChannelConsent[];
  openEnquiries: number;
  relationships: ContactRelationship[];
}

interface EngagementEmbed {
  id: string;
  title: string;
  outcome: string | null;
  archived_at: string | null;
  stage_entered_at: string;
  attributes: Record<string, unknown> | null;
  stage_definitions: {
    key: string;
    label: string;
    is_terminal: boolean;
    terminal_outcome: string | null;
  } | null;
}

export async function getContacts(): Promise<ContactListRow[]> {
  const { db, business } = await getAppContext();

  const [contacts, channels, relationships, participants] = await Promise.all([
    db
      .from("contacts")
      .select("id, display_name, type, status, locale, first_touch")
      .eq("business_id", business.id)
      .is("archived_at", null)
      .order("display_name", { ascending: true }),
    db
      .from("contact_channels")
      .select("contact_id, channel, value, is_primary, consent")
      .eq("business_id", business.id)
      .is("archived_at", null),
    db
      .from("contact_relationships")
      .select("from_contact_id, to_contact_id, relationship")
      .eq("business_id", business.id)
      .is("archived_at", null),
    db
      .from("engagement_participants")
      .select(
        "contact_id, engagements(id, archived_at, outcome, title, stage_entered_at, attributes, stage_definitions(key, label, is_terminal, terminal_outcome))"
      )
      .eq("business_id", business.id)
      .is("archived_at", null),
  ]);
  for (const [label, result] of [
    ["contacts", contacts],
    ["contact_channels", channels],
    ["contact_relationships", relationships],
    ["engagement_participants", participants],
  ] as const) {
    if (result.error) throw new Error(`${label} query failed: ${result.error.message}`);
  }

  const nameById = new Map((contacts.data ?? []).map((c) => [c.id, c.display_name as string]));

  const channelsByContact = new Map<string, ChannelConsent[]>();
  for (const c of channels.data ?? []) {
    const list = channelsByContact.get(c.contact_id) ?? [];
    list.push({
      channel: c.channel,
      value: c.value,
      isPrimary: c.is_primary,
      consent: (c.consent ?? {}) as Record<string, unknown>,
    });
    channelsByContact.set(c.contact_id, list);
  }

  const relationshipsByContact = new Map<string, ContactRelationship[]>();
  for (const r of relationships.data ?? []) {
    const fromName = nameById.get(r.from_contact_id);
    const toName = nameById.get(r.to_contact_id);
    if (toName) {
      const list = relationshipsByContact.get(r.from_contact_id) ?? [];
      list.push({ contactId: r.to_contact_id, name: toName, relationship: r.relationship, direction: "out" });
      relationshipsByContact.set(r.from_contact_id, list);
    }
    if (fromName) {
      const list = relationshipsByContact.get(r.to_contact_id) ?? [];
      list.push({ contactId: r.from_contact_id, name: fromName, relationship: r.relationship, direction: "in" });
      relationshipsByContact.set(r.to_contact_id, list);
    }
  }

  const openByContact = new Map<string, number>();
  for (const p of participants.data ?? []) {
    const engagement = p.engagements as unknown as EngagementEmbed | null;
    if (!engagement || engagement.archived_at) continue;
    if (engagement.stage_definitions?.is_terminal) continue;
    openByContact.set(p.contact_id, (openByContact.get(p.contact_id) ?? 0) + 1);
  }

  return (contacts.data ?? []).map((c) => {
    const firstTouch = (c.first_touch ?? {}) as Record<string, unknown>;
    return {
      id: c.id,
      name: c.display_name,
      type: c.type,
      status: c.status,
      locale: c.locale,
      source: typeof firstTouch.source === "string" ? firstTouch.source : null,
      channels: channelsByContact.get(c.id) ?? [],
      openEnquiries: openByContact.get(c.id) ?? 0,
      relationships: relationshipsByContact.get(c.id) ?? [],
    };
  });
}

export interface ContactEnquiry {
  id: string;
  title: string;
  role: string;
  visaRoute: string | null;
  stageLabel: string | null;
  stageKey: string | null;
  isTerminal: boolean;
  terminalOutcome: string | null;
  outcome: string | null;
  stageEnteredAt: string;
}

export interface ContactDetail {
  id: string;
  name: string;
  givenName: string | null;
  familyName: string | null;
  type: "person" | "organisation";
  status: string;
  locale: string;
  createdAt: string;
  orgId: string | null;
  orgName: string | null;
  firstTouch: Record<string, unknown> | null;
  channels: (ChannelConsent & { verifiedAt: string | null })[];
  enquiries: ContactEnquiry[];
  relationships: ContactRelationship[];
}

export async function getContactDetail(id: string): Promise<ContactDetail | null> {
  if (!isUuid(id)) return null;
  const { db, business } = await getAppContext();

  const { data: contact, error: contactError } = await db
    .from("contacts")
    .select("id, display_name, given_name, family_name, type, status, locale, created_at, org_id, first_touch")
    .eq("id", id)
    .eq("business_id", business.id)
    .is("archived_at", null)
    .maybeSingle();
  if (contactError) throw new Error(`contact lookup failed: ${contactError.message}`);
  if (!contact) return null;

  const [channels, participantRows, relationships] = await Promise.all([
    db
      .from("contact_channels")
      .select("channel, value, is_primary, consent, verified_at")
      .eq("contact_id", id)
      .is("archived_at", null),
    db
      .from("engagement_participants")
      .select(
        "role, engagements(id, archived_at, outcome, title, stage_entered_at, attributes, stage_definitions(key, label, is_terminal, terminal_outcome))"
      )
      .eq("contact_id", id)
      .is("archived_at", null),
    db
      .from("contact_relationships")
      .select("from_contact_id, to_contact_id, relationship")
      .or(`from_contact_id.eq.${id},to_contact_id.eq.${id}`)
      .is("archived_at", null),
  ]);
  for (const [label, result] of [
    ["contact_channels", channels],
    ["engagement_participants", participantRows],
    ["contact_relationships", relationships],
  ] as const) {
    if (result.error) throw new Error(`${label} query failed: ${result.error.message}`);
  }

  // Names for the organisation link and both relationship directions.
  const relatedIds = new Set<string>();
  if (contact.org_id) relatedIds.add(contact.org_id);
  for (const r of relationships.data ?? []) {
    relatedIds.add(r.from_contact_id === id ? r.to_contact_id : r.from_contact_id);
  }
  const { data: relatedRows, error: relatedError } = relatedIds.size
    ? await db.from("contacts").select("id, display_name").in("id", [...relatedIds])
    : { data: [], error: null };
  if (relatedError) throw new Error(`related contacts query failed: ${relatedError.message}`);
  const relatedNames = new Map((relatedRows ?? []).map((c) => [c.id, c.display_name as string]));

  return {
    id: contact.id,
    name: contact.display_name,
    givenName: contact.given_name,
    familyName: contact.family_name,
    type: contact.type,
    status: contact.status,
    locale: contact.locale,
    createdAt: contact.created_at,
    orgId: contact.org_id,
    orgName: contact.org_id ? (relatedNames.get(contact.org_id) ?? null) : null,
    firstTouch: (contact.first_touch as Record<string, unknown> | null) ?? null,
    channels: (channels.data ?? []).map((c) => ({
      channel: c.channel,
      value: c.value,
      isPrimary: c.is_primary,
      consent: (c.consent ?? {}) as Record<string, unknown>,
      verifiedAt: c.verified_at,
    })),
    enquiries: (participantRows.data ?? []).flatMap((p) => {
      const engagement = p.engagements as unknown as EngagementEmbed | null;
      if (!engagement || engagement.archived_at) return [];
      const attributes = (engagement.attributes ?? {}) as Record<string, unknown>;
      return [
        {
          id: engagement.id,
          title: engagement.title,
          role: p.role,
          visaRoute: typeof attributes.visa_route === "string" ? attributes.visa_route : null,
          stageLabel: engagement.stage_definitions?.label ?? null,
          stageKey: engagement.stage_definitions?.key ?? null,
          isTerminal: engagement.stage_definitions?.is_terminal ?? false,
          terminalOutcome: engagement.stage_definitions?.terminal_outcome ?? null,
          outcome: engagement.outcome,
          stageEnteredAt: engagement.stage_entered_at,
        },
      ];
    }),
    relationships: (relationships.data ?? []).flatMap((r) => {
      const otherId = r.from_contact_id === id ? r.to_contact_id : r.from_contact_id;
      const name = relatedNames.get(otherId);
      if (!name) return [];
      return [
        {
          contactId: otherId,
          name,
          relationship: r.relationship,
          direction: (r.from_contact_id === id ? "out" : "in") as "out" | "in",
        },
      ];
    }),
  };
}
