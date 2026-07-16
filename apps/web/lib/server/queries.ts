import "server-only";
import type { ActorType, ApprovalInboxRow, EventRow } from "@rooshni/db";
import { scaleDurationMs } from "@rooshni/config";
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

/** Open tasks for the sidebar badge — an earned count or nothing. */
export async function getOpenTaskCount(): Promise<number> {
  const { db, business } = await getAppContext();
  const { count, error } = await db
    .from("tasks")
    .select("*", { count: "exact", head: true })
    .eq("business_id", business.id)
    .eq("status", "open")
    .is("archived_at", null);
  if (error) throw new Error(`tasks count failed: ${error.message}`);
  return count ?? 0;
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

// --- Dashboard ---------------------------------------------------------------

const HOUR_MS = 3_600_000; // unit conversion only — SLAs themselves are data

export interface StuckEnquiry {
  id: string;
  title: string;
  stageLabel: string;
  stageEnteredAt: string;
  slaHours: number;
}

export interface TodayItem {
  id: string;
  title: string;
  dueAt: string | null;
  /** Assigned to an agent actor — rendered on Light's channel. */
  byLight: boolean;
}

export interface DashboardData {
  /** Engagements created since local midnight. */
  newToday: number;
  todaySchedule: TodayItem[];
  /**
   * Stage-SLA breaches (stage_definitions.sla_hours, scaled by TIME_SCALE —
   * timers are data). `null` means TIME_SCALE is unset in this environment
   * and the monitor honestly cannot run.
   */
  stuck: StuckEnquiry[] | null;
  /** Metered credits on the ledger this calendar month. */
  creditsThisMonth: number;
  meteredEventsThisMonth: number;
}

export async function getDashboard(): Promise<DashboardData> {
  const { db, business } = await getAppContext();

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(startOfToday);
  endOfToday.setDate(endOfToday.getDate() + 1);
  const startOfMonth = new Date(startOfToday);
  startOfMonth.setDate(1);

  const [newRows, taskRows, slaRows, costRows] = await Promise.all([
    db
      .from("engagements")
      .select("*", { count: "exact", head: true })
      .eq("business_id", business.id)
      .is("archived_at", null)
      .gte("created_at", startOfToday.toISOString()),
    db
      .from("tasks")
      .select("id, title, due_at, actors!tasks_assignee_actor_id_fkey(actor_type)")
      .eq("business_id", business.id)
      .eq("status", "open")
      .is("archived_at", null)
      .lt("due_at", endOfToday.toISOString())
      .order("due_at", { ascending: true })
      .limit(6),
    db
      .from("engagements")
      .select("id, title, stage_entered_at, stage_definitions!inner(label, sla_hours, is_terminal)")
      .eq("business_id", business.id)
      .is("archived_at", null)
      .not("stage_definitions.sla_hours", "is", null),
    db
      .from("events")
      .select("cost")
      .eq("business_id", business.id)
      .gte("occurred_at", startOfMonth.toISOString())
      .not("cost", "is", null),
  ]);
  for (const [label, result] of [
    ["engagements (new today)", newRows],
    ["tasks (today)", taskRows],
    ["engagements (stage SLA)", slaRows],
    ["events (cost)", costRows],
  ] as const) {
    if (result.error) throw new Error(`${label} query failed: ${result.error.message}`);
  }

  // The stage-SLA monitor only runs when TIME_SCALE exists — timers are data
  // multiplied by TIME_SCALE, and the law forbids guessing a value.
  let stuck: StuckEnquiry[] | null = null;
  try {
    const now = Date.now();
    stuck = (slaRows.data ?? []).flatMap((row) => {
      const stage = row.stage_definitions as unknown as {
        label: string;
        sla_hours: number | null;
        is_terminal: boolean;
      } | null;
      if (!stage || stage.is_terminal || stage.sla_hours === null) return [];
      const deadline =
        new Date(row.stage_entered_at).getTime() +
        scaleDurationMs(Number(stage.sla_hours) * HOUR_MS);
      if (now <= deadline) return [];
      return [
        {
          id: row.id,
          title: row.title,
          stageLabel: stage.label,
          stageEnteredAt: row.stage_entered_at,
          slaHours: Number(stage.sla_hours),
        },
      ];
    });
  } catch {
    stuck = null;
  }

  let credits = 0;
  let metered = 0;
  for (const row of costRows.data ?? []) {
    const cost = row.cost as EventRow["cost"];
    if (typeof cost?.credits === "number") {
      credits += cost.credits;
      metered += 1;
    } else if (cost) {
      metered += 1;
    }
  }

  return {
    newToday: newRows.count ?? 0,
    todaySchedule: (taskRows.data ?? []).map((t) => {
      const assignee = t.actors as unknown as { actor_type: ActorType } | null;
      return {
        id: t.id,
        title: t.title,
        dueAt: t.due_at,
        byLight: assignee?.actor_type === "agent",
      };
    }),
    stuck,
    creditsThisMonth: credits,
    meteredEventsThisMonth: metered,
  };
}

// --- Light (the front door) ---------------------------------------------------

export interface LightAccessRow {
  name: string;
  role: string;
}

/** Humans who can talk to Light — memberships joined to their human actors. */
export async function getLightAccess(): Promise<LightAccessRow[]> {
  const { db, business } = await getAppContext();
  const [members, humans] = await Promise.all([
    db
      .from("memberships")
      .select("user_id, role")
      .eq("business_id", business.id)
      .is("archived_at", null),
    db
      .from("actors")
      .select("user_id, display_name")
      .eq("actor_type", "human")
      .is("archived_at", null)
      .not("user_id", "is", null),
  ]);
  if (members.error) throw new Error(`memberships query failed: ${members.error.message}`);
  if (humans.error) throw new Error(`actors query failed: ${humans.error.message}`);
  const nameByUser = new Map(
    (humans.data ?? []).map((a) => [a.user_id as string, a.display_name as string])
  );
  return (members.data ?? []).map((m) => ({
    name: nameByUser.get(m.user_id) ?? "Unnamed member",
    role: m.role,
  }));
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

// --- Conversations -----------------------------------------------------------

export interface ThreadMessage {
  id: string;
  channel: string;
  direction: "inbound" | "outbound" | "internal";
  status: string;
  body: string;
  subject: string | null;
  occurredAt: string;
  scheduledFor: string | null;
  durationSeconds: number | null;
  draftedByLight: boolean;
  stampedByName: string | null;
  /** An outbound draft still waiting for its stamp — gold, dashed, unsent. */
  isPendingDraft: boolean;
}

export interface ThreadConsent {
  channel: string;
  ok: boolean;
  note: string;
}

export interface ConversationThread {
  id: string;
  contactId: string;
  contactName: string;
  channel: string;
  subject: string | null;
  lastAt: string;
  snippet: string;
  /** Derived, never invented: pending draft > Light handling > awaiting you > stage. */
  state: { tone: "gold" | "you" | "done"; label: string };
  lightHandling: boolean;
  awaitingYou: boolean;
  hasPendingDraft: boolean;
  enquiry: { id: string; title: string; stageLabel: string | null } | null;
  contact: {
    type: "person" | "organisation";
    status: string;
    isClient: boolean;
    phone: string | null;
    email: string | null;
    source: string | null;
    consents: ThreadConsent[];
  };
  messages: ThreadMessage[];
}

function consentNote(consent: Record<string, unknown>): { ok: boolean; note: string } {
  const kinds = ["transactional", "marketing"].filter((k) => consent[k] === true);
  if (!kinds.length) return { ok: false, note: "no consent recorded" };
  const source = typeof consent.source === "string" ? ` · ${consent.source}` : "";
  return { ok: true, note: kinds.join(" · ") + source };
}

export async function getConversations(): Promise<ConversationThread[]> {
  const { db, business } = await getAppContext();

  const [threads, comms] = await Promise.all([
    db
      .from("comm_threads")
      .select("id, subject, channel, contact_id, engagement_id")
      .eq("business_id", business.id)
      .is("archived_at", null),
    db
      .from("communications")
      .select(
        "id, thread_id, channel, direction, status, body, scheduled_for, occurred_at, duration_seconds, drafted_by_actor_id, approved_by_actor_id"
      )
      .eq("business_id", business.id)
      .is("archived_at", null)
      .order("occurred_at", { ascending: true }),
  ]);
  if (threads.error) throw new Error(`comm_threads query failed: ${threads.error.message}`);
  if (comms.error) throw new Error(`communications query failed: ${comms.error.message}`);

  const contactIds = [...new Set((threads.data ?? []).map((t) => t.contact_id))];
  const engagementIds = [
    ...new Set((threads.data ?? []).flatMap((t) => (t.engagement_id ? [t.engagement_id] : []))),
  ];
  const actorIds = [
    ...new Set(
      (comms.data ?? []).flatMap((c) => [
        ...(c.drafted_by_actor_id ? [c.drafted_by_actor_id] : []),
        ...(c.approved_by_actor_id ? [c.approved_by_actor_id] : []),
      ])
    ),
  ];

  const [contacts, channels, engagements, runs, actors] = await Promise.all([
    contactIds.length
      ? db
          .from("contacts")
          .select("id, display_name, type, status, first_touch")
          .in("id", contactIds)
      : Promise.resolve({ data: [], error: null }),
    contactIds.length
      ? db
          .from("contact_channels")
          .select("contact_id, channel, value, is_primary, consent")
          .in("contact_id", contactIds)
          .is("archived_at", null)
      : Promise.resolve({ data: [], error: null }),
    engagementIds.length
      ? db
          .from("engagements")
          .select("id, title, outcome, stage_definitions(label)")
          .in("id", engagementIds)
      : Promise.resolve({ data: [], error: null }),
    engagementIds.length
      ? db
          .from("workflow_runs")
          .select("engagement_id, status")
          .in("engagement_id", engagementIds)
          .in("status", ["running", "waiting", "blocked"])
      : Promise.resolve({ data: [], error: null }),
    actorIds.length
      ? db.from("actors").select("id, display_name, actor_type").in("id", actorIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const [label, result] of [
    ["contacts", contacts],
    ["contact_channels", channels],
    ["engagements", engagements],
    ["workflow_runs", runs],
    ["actors", actors],
  ] as const) {
    if (result.error) throw new Error(`${label} query failed: ${result.error.message}`);
  }

  const contactById = new Map((contacts.data ?? []).map((c) => [c.id, c]));
  const channelsByContact = new Map<string, typeof channels.data>();
  for (const ch of channels.data ?? []) {
    const list = channelsByContact.get(ch.contact_id) ?? [];
    list!.push(ch);
    channelsByContact.set(ch.contact_id, list!);
  }
  const engagementById = new Map((engagements.data ?? []).map((e) => [e.id, e]));
  const liveRunEngagements = new Set((runs.data ?? []).map((r) => r.engagement_id));
  const actorById = new Map(
    (actors.data ?? []).map((a) => [
      a.id,
      { name: a.display_name as string, type: a.actor_type as ActorType },
    ])
  );

  const commsByThread = new Map<string, NonNullable<typeof comms.data>>();
  for (const c of comms.data ?? []) {
    const list = commsByThread.get(c.thread_id) ?? [];
    list.push(c);
    commsByThread.set(c.thread_id, list);
  }

  const result: ConversationThread[] = (threads.data ?? []).flatMap((t) => {
    const contact = contactById.get(t.contact_id);
    if (!contact) return [];
    const list = commsByThread.get(t.id) ?? [];
    if (!list.length) return [];

    const messages: ThreadMessage[] = list.map((c) => {
      const draftedBy = c.drafted_by_actor_id ? actorById.get(c.drafted_by_actor_id) : null;
      const approvedBy = c.approved_by_actor_id ? actorById.get(c.approved_by_actor_id) : null;
      return {
        id: c.id,
        channel: c.channel,
        direction: c.direction as ThreadMessage["direction"],
        status: c.status,
        body: c.body,
        subject: null,
        occurredAt: c.occurred_at,
        scheduledFor: c.scheduled_for,
        durationSeconds: c.duration_seconds,
        draftedByLight: draftedBy?.type === "agent",
        stampedByName: approvedBy?.name ?? null,
        isPendingDraft: c.direction === "outbound" && c.status === "pending_approval",
      };
    });

    const last = messages[messages.length - 1];
    if (!last) return [];
    const hasPendingDraft = messages.some((m) => m.isPendingDraft);
    const engagement = t.engagement_id ? engagementById.get(t.engagement_id) : null;
    const stage = engagement?.stage_definitions as unknown as { label: string } | null;
    const lightHandling = t.engagement_id ? liveRunEngagements.has(t.engagement_id) : false;
    const awaitingYou = !hasPendingDraft && last.direction === "inbound";

    const state: ConversationThread["state"] = hasPendingDraft
      ? { tone: "gold", label: "✦ draft awaiting stamp" }
      : lightHandling
        ? { tone: "gold", label: "Light handling" }
        : awaitingYou
          ? { tone: "you", label: "awaiting you" }
          : { tone: "done", label: stage?.label.toLowerCase() ?? "up to date" };

    const contactChannels = channelsByContact.get(t.contact_id) ?? [];
    const primary = (kind: string) =>
      contactChannels.find((c) => c.channel === kind && c.is_primary) ??
      contactChannels.find((c) => c.channel === kind);
    const firstTouch = (contact.first_touch ?? {}) as Record<string, unknown>;

    return [
      {
        id: t.id,
        contactId: t.contact_id,
        contactName: contact.display_name,
        channel: t.channel,
        subject: t.subject,
        lastAt: last.occurredAt,
        snippet: hasPendingDraft
          ? "✦ Light's draft — awaiting your stamp"
          : last.body.length > 80
            ? `${last.body.slice(0, 80)}…`
            : last.body,
        state,
        lightHandling,
        awaitingYou,
        hasPendingDraft,
        enquiry: engagement
          ? {
              id: engagement.id,
              title: engagement.title,
              stageLabel: stage?.label ?? null,
            }
          : null,
        contact: {
          type: contact.type as "person" | "organisation",
          status: contact.status,
          isClient: engagement?.outcome === "won",
          phone: primary("phone")?.value ?? primary("whatsapp")?.value ?? null,
          email: primary("email")?.value ?? null,
          source: typeof firstTouch.source === "string" ? firstTouch.source : null,
          consents: contactChannels.map((c) => {
            const { ok, note } = consentNote((c.consent ?? {}) as Record<string, unknown>);
            return { channel: c.channel, ok, note };
          }),
        },
        messages,
      },
    ];
  });

  return result.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

// --- Tasks ---------------------------------------------------------------------

export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  dueAt: string | null;
  /** attributes.all_day — an untimed task; syncs as all-day when sync lands. */
  allDay: boolean;
  priority: string;
  assigneeName: string | null;
  assigneeIsAgent: boolean;
  createdByAgent: boolean;
  enquiry: { id: string; title: string } | null;
}

export interface EnquiryOption {
  id: string;
  title: string;
  stageLabel: string | null;
}

export async function getTasks(): Promise<TaskRow[]> {
  const { db, business } = await getAppContext();
  const { data, error } = await db
    .from("tasks")
    .select(
      "id, title, description, status, due_at, priority, attributes, assignee_actor_id, created_by, engagements(id, title)"
    )
    .eq("business_id", business.id)
    .is("archived_at", null)
    .order("due_at", { ascending: true, nullsFirst: false });
  if (error) throw new Error(`tasks query failed: ${error.message}`);

  const actorIds = [
    ...new Set(
      (data ?? []).flatMap((t) => [
        ...(t.assignee_actor_id ? [t.assignee_actor_id] : []),
        ...(t.created_by ? [t.created_by] : []),
      ])
    ),
  ];
  const { data: actorRows, error: actorsError } = actorIds.length
    ? await db.from("actors").select("id, display_name, actor_type").in("id", actorIds)
    : { data: [], error: null };
  if (actorsError) throw new Error(`actors query failed: ${actorsError.message}`);
  const actorById = new Map(
    (actorRows ?? []).map((a) => [
      a.id,
      { name: a.display_name as string, type: a.actor_type as ActorType },
    ])
  );

  return (data ?? []).map((t) => {
    const engagement = t.engagements as unknown as { id: string; title: string } | null;
    const assignee = t.assignee_actor_id ? actorById.get(t.assignee_actor_id) : null;
    const creator = t.created_by ? actorById.get(t.created_by) : null;
    const attributes = (t.attributes ?? {}) as Record<string, unknown>;
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      dueAt: t.due_at,
      allDay: attributes.all_day === true,
      priority: t.priority,
      assigneeName: assignee?.name ?? null,
      assigneeIsAgent: assignee?.type === "agent",
      createdByAgent: creator?.type === "agent",
      enquiry: engagement ? { id: engagement.id, title: engagement.title } : null,
    };
  });
}

/** Open (non-terminal) enquiries for the task modal's link search. */
export async function getEnquiryOptions(): Promise<EnquiryOption[]> {
  const { db, business } = await getAppContext();
  const { data, error } = await db
    .from("engagements")
    .select("id, title, stage_definitions(label, is_terminal)")
    .eq("business_id", business.id)
    .is("archived_at", null)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`engagements query failed: ${error.message}`);
  return (data ?? []).map((e) => {
    const stage = e.stage_definitions as unknown as {
      label: string;
      is_terminal: boolean;
    } | null;
    return { id: e.id, title: e.title, stageLabel: stage?.label ?? null };
  });
}

/** Light's actor — the agent tasks are handed to. Null when no agent exists. */
export async function getAgentActor(): Promise<{ id: string; name: string } | null> {
  const { db } = await getAppContext();
  const { data, error } = await db
    .from("actors")
    .select("id, display_name")
    .eq("actor_type", "agent")
    .is("archived_at", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`agent actor query failed: ${error.message}`);
  return data ? { id: data.id, name: data.display_name } : null;
}

// --- Billing & usage ---------------------------------------------------------------

export interface CreditUsage {
  totalCredits: number;
  /** Metered actions this calendar month, grouped by ledger action. */
  byAction: { action: string; count: number; credits: number }[];
}

export async function getCreditUsage(): Promise<CreditUsage> {
  const { db, business } = await getAppContext();
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const { data, error } = await db
    .from("events")
    .select("action, cost")
    .eq("business_id", business.id)
    .gte("occurred_at", startOfMonth.toISOString())
    .not("cost", "is", null);
  if (error) throw new Error(`events query failed: ${error.message}`);

  const byAction = new Map<string, { count: number; credits: number }>();
  let total = 0;
  for (const row of data ?? []) {
    const cost = row.cost as EventRow["cost"];
    const credits = typeof cost?.credits === "number" ? cost.credits : 0;
    total += credits;
    const entry = byAction.get(row.action) ?? { count: 0, credits: 0 };
    entry.count += 1;
    entry.credits += credits;
    byAction.set(row.action, entry);
  }
  return {
    totalCredits: total,
    byAction: [...byAction.entries()]
      .map(([action, v]) => ({ action, ...v }))
      .sort((a, b) => b.credits - a.credits),
  };
}

// --- Website ---------------------------------------------------------------------

export interface WebsitePageRow {
  id: string;
  title: string;
  slug: string;
  contentType: string;
  state: string;
  version: number;
  updatedAt: string;
  draftedByLight: boolean;
}

/** Everything published or teachable that is NOT a note — the site's pages. */
export async function getWebsitePages(): Promise<WebsitePageRow[]> {
  const { db, business } = await getAppContext();
  const { data, error } = await db
    .from("content_items")
    .select("id, title, slug, content_type, state, version, updated_at, created_by, actors!content_items_created_by_fkey(actor_type)")
    .eq("business_id", business.id)
    .neq("content_type", "note")
    .is("archived_at", null)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`content_items query failed: ${error.message}`);
  return (data ?? []).map((r) => {
    const creator = r.actors as unknown as { actor_type: ActorType } | null;
    return {
      id: r.id,
      title: r.title,
      slug: r.slug,
      contentType: r.content_type,
      state: r.state,
      version: r.version,
      updatedAt: r.updated_at,
      draftedByLight: creator?.actor_type === "agent",
    };
  });
}

export interface WebsitePageDetail extends WebsitePageRow {
  blocks: NoteBlock[];
  visibility: string;
  publishedAt: string | null;
  publishedByName: string | null;
}

export async function getWebsitePageDetail(id: string): Promise<WebsitePageDetail | null> {
  if (!isUuid(id)) return null;
  const { db, business } = await getAppContext();
  const { data: r, error } = await db
    .from("content_items")
    .select(
      "id, title, slug, content_type, state, version, updated_at, visibility, body, published_at, published_by_actor_id, created_by, actors!content_items_created_by_fkey(actor_type)"
    )
    .eq("id", id)
    .eq("business_id", business.id)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error(`content_items lookup failed: ${error.message}`);
  if (!r) return null;

  const { data: publisher } = r.published_by_actor_id
    ? await db.from("actors").select("display_name").eq("id", r.published_by_actor_id).maybeSingle()
    : { data: null };

  const creator = r.actors as unknown as { actor_type: ActorType } | null;
  const raw = Array.isArray(r.body) ? (r.body as unknown[]) : [];
  return {
    id: r.id,
    title: r.title,
    slug: r.slug,
    contentType: r.content_type,
    state: r.state,
    version: r.version,
    updatedAt: r.updated_at,
    visibility: r.visibility,
    publishedAt: r.published_at,
    publishedByName: (publisher?.display_name as string | undefined) ?? null,
    draftedByLight: creator?.actor_type === "agent",
    blocks: raw.flatMap((b): NoteBlock[] => {
      const block = b as Record<string, unknown>;
      if (typeof block.text === "string") return [{ type: "paragraph", text: block.text }];
      return [];
    }),
  };
}

export interface DomainRow {
  hostname: string;
  surface: string;
  verificationStatus: string;
  sslStatus: string;
}

export async function getDomains(): Promise<DomainRow[]> {
  const { db, business } = await getAppContext();
  const { data, error } = await db
    .from("domains")
    .select("hostname, surface, verification_status, ssl_status")
    .eq("business_id", business.id)
    .is("archived_at", null);
  if (error) throw new Error(`domains query failed: ${error.message}`);
  return (data ?? []).map((d) => ({
    hostname: d.hostname,
    surface: d.surface,
    verificationStatus: d.verification_status,
    sslStatus: d.ssl_status,
  }));
}

// --- Automation ------------------------------------------------------------------

export interface WorkflowStepRow {
  id: string;
  key: string;
  sortOrder: number;
  kind: string;
  gateLevel: number | null;
  config: Record<string, unknown>;
}

export interface WorkflowListItem {
  id: string;
  key: string;
  version: number;
  status: string;
  description: string;
  activeRuns: number;
  steps: WorkflowStepRow[];
}

export async function getWorkflows(): Promise<WorkflowListItem[]> {
  const { db, business } = await getAppContext();

  const [defs, steps, runs] = await Promise.all([
    db
      .from("workflow_definitions")
      .select("id, key, version, status, description_plain")
      .eq("business_id", business.id)
      .is("archived_at", null)
      .order("created_at", { ascending: true }),
    db
      .from("workflow_steps")
      .select("id, definition_id, key, sort_order, kind, gate_level, config")
      .eq("business_id", business.id)
      .is("archived_at", null)
      .order("sort_order", { ascending: true }),
    db
      .from("workflow_runs")
      .select("definition_id, status")
      .eq("business_id", business.id)
      .in("status", ["running", "waiting", "blocked"]),
  ]);
  for (const [label, result] of [
    ["workflow_definitions", defs],
    ["workflow_steps", steps],
    ["workflow_runs", runs],
  ] as const) {
    if (result.error) throw new Error(`${label} query failed: ${result.error.message}`);
  }

  const stepsByDef = new Map<string, WorkflowStepRow[]>();
  for (const s of steps.data ?? []) {
    const list = stepsByDef.get(s.definition_id) ?? [];
    list.push({
      id: s.id,
      key: s.key,
      sortOrder: s.sort_order,
      kind: s.kind,
      gateLevel: s.gate_level,
      config: (s.config ?? {}) as Record<string, unknown>,
    });
    stepsByDef.set(s.definition_id, list);
  }
  const runCount = new Map<string, number>();
  for (const r of runs.data ?? []) {
    runCount.set(r.definition_id, (runCount.get(r.definition_id) ?? 0) + 1);
  }

  return (defs.data ?? []).map((d) => ({
    id: d.id,
    key: d.key,
    version: d.version,
    status: d.status,
    description: d.description_plain,
    activeRuns: runCount.get(d.id) ?? 0,
    steps: stepsByDef.get(d.id) ?? [],
  }));
}

export interface WorkflowRunRow {
  id: string;
  status: string;
  startedAt: string;
  engagementId: string;
  engagementTitle: string;
  currentStepKey: string | null;
}

export interface StepRunRow {
  id: string;
  stepKey: string;
  status: string;
  scheduledFor: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface WorkflowDetail extends WorkflowListItem {
  trigger: Record<string, unknown>;
  runs: WorkflowRunRow[];
  stepRuns: StepRunRow[];
}

export async function getWorkflowDetail(id: string): Promise<WorkflowDetail | null> {
  if (!isUuid(id)) return null;
  const { db, business } = await getAppContext();

  const { data: def, error: defError } = await db
    .from("workflow_definitions")
    .select("id, key, version, status, description_plain, trigger")
    .eq("id", id)
    .eq("business_id", business.id)
    .is("archived_at", null)
    .maybeSingle();
  if (defError) throw new Error(`workflow definition lookup failed: ${defError.message}`);
  if (!def) return null;

  const [steps, runs] = await Promise.all([
    db
      .from("workflow_steps")
      .select("id, key, sort_order, kind, gate_level, config")
      .eq("definition_id", id)
      .is("archived_at", null)
      .order("sort_order", { ascending: true }),
    db
      .from("workflow_runs")
      .select("id, status, started_at, engagement_id, current_step, engagements(title)")
      .eq("definition_id", id)
      .order("started_at", { ascending: false })
      .limit(100),
  ]);
  if (steps.error) throw new Error(`workflow_steps query failed: ${steps.error.message}`);
  if (runs.error) throw new Error(`workflow_runs query failed: ${runs.error.message}`);

  const stepKeyById = new Map((steps.data ?? []).map((s) => [s.id, s.key as string]));
  const runIds = (runs.data ?? []).map((r) => r.id);
  const { data: stepRunRows, error: srError } = runIds.length
    ? await db
        .from("step_runs")
        .select("id, run_id, step_id, status, scheduled_for, started_at, finished_at")
        .in("run_id", runIds)
        .order("scheduled_for", { ascending: false })
        .limit(100)
    : { data: [], error: null };
  if (srError) throw new Error(`step_runs query failed: ${srError.message}`);

  const activeStatuses = new Set(["running", "waiting", "blocked"]);

  return {
    id: def.id,
    key: def.key,
    version: def.version,
    status: def.status,
    description: def.description_plain,
    trigger: (def.trigger ?? {}) as Record<string, unknown>,
    activeRuns: (runs.data ?? []).filter((r) => activeStatuses.has(r.status)).length,
    steps: (steps.data ?? []).map((s) => ({
      id: s.id,
      key: s.key,
      sortOrder: s.sort_order,
      kind: s.kind,
      gateLevel: s.gate_level,
      config: (s.config ?? {}) as Record<string, unknown>,
    })),
    runs: (runs.data ?? []).map((r) => {
      const engagement = r.engagements as unknown as { title: string } | null;
      return {
        id: r.id,
        status: r.status,
        startedAt: r.started_at,
        engagementId: r.engagement_id,
        engagementTitle: engagement?.title ?? "an enquiry",
        currentStepKey: r.current_step ? (stepKeyById.get(r.current_step) ?? null) : null,
      };
    }),
    stepRuns: (stepRunRows ?? []).map((sr) => ({
      id: sr.id,
      stepKey: stepKeyById.get(sr.step_id) ?? "step",
      status: sr.status,
      scheduledFor: sr.scheduled_for,
      startedAt: sr.started_at,
      finishedAt: sr.finished_at,
    })),
  };
}

// --- Notes ---------------------------------------------------------------------

/*
 * Notes are content_items of type `note` plus entity_links — no new
 * primitive, no manual folders (master context 3.10). The rail's engagement
 * groups are GENERATED from confirmed links; the Inbox is simply the notes
 * with no links at all.
 *
 * JUDGMENT: content_items.body is "structured blocks, never raw HTML" with
 * no block vocabulary specced yet — notes use [{type:"paragraph",text}] and
 * [{type:"check",text,done}], additive and portable (Session 8, Lane B).
 */

export interface NoteBlock {
  type: "paragraph" | "check";
  text: string;
  done?: boolean;
}

export interface NoteLink {
  id: string;
  toType: string;
  toId: string;
  label: string;
  proposedByLight: boolean;
  confirmed: boolean;
}

export interface NoteItem {
  id: string;
  title: string;
  blocks: NoteBlock[];
  visibility: "private" | "team";
  createdAt: string;
  updatedAt: string;
  links: NoteLink[];
}

export interface NoteGroup {
  key: string;
  label: string;
  noteIds: string[];
}

export interface NotesData {
  notes: NoteItem[];
  /** Generated purely from confirmed entity_links to engagements. */
  groups: NoteGroup[];
}

export async function getNotes(): Promise<NotesData> {
  const { db, business } = await getAppContext();

  const { data: rows, error } = await db
    .from("content_items")
    .select("id, title, body, visibility, created_at, updated_at")
    .eq("business_id", business.id)
    .eq("content_type", "note")
    .is("archived_at", null)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`content_items query failed: ${error.message}`);

  const noteIds = (rows ?? []).map((r) => r.id);
  const { data: linkRows, error: linkError } = noteIds.length
    ? await db
        .from("entity_links")
        .select("id, from_entity_id, to_entity_type, to_entity_id, proposed_by_actor_id, confirmed_at")
        .eq("from_entity_type", "content_item")
        .in("from_entity_id", noteIds)
        .is("archived_at", null)
    : { data: [], error: null };
  if (linkError) throw new Error(`entity_links query failed: ${linkError.message}`);

  const engagementIds = [
    ...new Set(
      (linkRows ?? [])
        .filter((l) => l.to_entity_type === "engagement")
        .map((l) => l.to_entity_id)
    ),
  ];
  const contactIds = [
    ...new Set(
      (linkRows ?? [])
        .filter((l) => l.to_entity_type === "contact")
        .map((l) => l.to_entity_id)
    ),
  ];
  const proposerIds = [
    ...new Set(
      (linkRows ?? []).flatMap((l) => (l.proposed_by_actor_id ? [l.proposed_by_actor_id] : []))
    ),
  ];

  const [engagements, linkContacts, proposers] = await Promise.all([
    engagementIds.length
      ? db.from("engagements").select("id, title").in("id", engagementIds)
      : Promise.resolve({ data: [], error: null }),
    contactIds.length
      ? db.from("contacts").select("id, display_name").in("id", contactIds)
      : Promise.resolve({ data: [], error: null }),
    proposerIds.length
      ? db.from("actors").select("id, actor_type").in("id", proposerIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  for (const [label, result] of [
    ["engagements", engagements],
    ["contacts", linkContacts],
    ["actors", proposers],
  ] as const) {
    if (result.error) throw new Error(`${label} query failed: ${result.error.message}`);
  }

  const engagementTitles = new Map((engagements.data ?? []).map((e) => [e.id, e.title as string]));
  const contactNames = new Map((linkContacts.data ?? []).map((c) => [c.id, c.display_name as string]));
  const agentProposers = new Set(
    (proposers.data ?? []).filter((a) => a.actor_type === "agent").map((a) => a.id)
  );

  const linksByNote = new Map<string, NoteLink[]>();
  for (const l of linkRows ?? []) {
    const label =
      l.to_entity_type === "engagement"
        ? (engagementTitles.get(l.to_entity_id) ?? "an enquiry")
        : l.to_entity_type === "contact"
          ? (contactNames.get(l.to_entity_id) ?? "a contact")
          : l.to_entity_type;
    const list = linksByNote.get(l.from_entity_id) ?? [];
    list.push({
      id: l.id,
      toType: l.to_entity_type,
      toId: l.to_entity_id,
      label,
      proposedByLight: l.proposed_by_actor_id ? agentProposers.has(l.proposed_by_actor_id) : false,
      confirmed: l.confirmed_at !== null,
    });
    linksByNote.set(l.from_entity_id, list);
  }

  const notes: NoteItem[] = (rows ?? []).map((r) => {
    const raw = Array.isArray(r.body) ? (r.body as unknown[]) : [];
    const blocks: NoteBlock[] = raw.flatMap((b): NoteBlock[] => {
      const block = b as Record<string, unknown>;
      if (block.type === "check" && typeof block.text === "string") {
        return [{ type: "check", text: block.text, done: block.done === true }];
      }
      if (typeof block.text === "string") {
        return [{ type: "paragraph", text: block.text }];
      }
      return [];
    });
    return {
      id: r.id,
      title: r.title,
      blocks,
      visibility: r.visibility as "private" | "team",
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      links: linksByNote.get(r.id) ?? [],
    };
  });

  const groups = new Map<string, NoteGroup>();
  for (const note of notes) {
    for (const link of note.links) {
      if (link.toType !== "engagement" || !link.confirmed) continue;
      const group = groups.get(link.toId) ?? { key: link.toId, label: link.label, noteIds: [] };
      group.noteIds.push(note.id);
      groups.set(link.toId, group);
    }
  }

  return { notes, groups: [...groups.values()] };
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
  /** Won at least one engagement — the book's LEAD/CLIENT split. */
  isClient: boolean;
  phone: string | null;
  email: string | null;
  /** Most recent communication on their threads, if any. */
  lastActivityAt: string | null;
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

  const [contacts, channels, relationships, participants, lastComms] = await Promise.all([
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
    db
      .from("communications")
      .select("contact_id, occurred_at")
      .eq("business_id", business.id)
      .is("archived_at", null)
      .not("contact_id", "is", null)
      .order("occurred_at", { ascending: false }),
  ]);
  for (const [label, result] of [
    ["contacts", contacts],
    ["contact_channels", channels],
    ["contact_relationships", relationships],
    ["engagement_participants", participants],
    ["communications", lastComms],
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
  const wonByContact = new Set<string>();
  for (const p of participants.data ?? []) {
    const engagement = p.engagements as unknown as EngagementEmbed | null;
    if (!engagement || engagement.archived_at) continue;
    if (engagement.outcome === "won" || engagement.stage_definitions?.terminal_outcome === "won") {
      wonByContact.add(p.contact_id);
    }
    if (engagement.stage_definitions?.is_terminal) continue;
    openByContact.set(p.contact_id, (openByContact.get(p.contact_id) ?? 0) + 1);
  }

  const lastByContact = new Map<string, string>();
  for (const c of lastComms.data ?? []) {
    if (c.contact_id && !lastByContact.has(c.contact_id)) {
      lastByContact.set(c.contact_id, c.occurred_at);
    }
  }

  return (contacts.data ?? []).map((c) => {
    const firstTouch = (c.first_touch ?? {}) as Record<string, unknown>;
    const myChannels = channelsByContact.get(c.id) ?? [];
    const primary = (kind: string) =>
      myChannels.find((ch) => ch.channel === kind && ch.isPrimary) ??
      myChannels.find((ch) => ch.channel === kind);
    return {
      id: c.id,
      name: c.display_name,
      type: c.type,
      status: c.status,
      locale: c.locale,
      source: typeof firstTouch.source === "string" ? firstTouch.source : null,
      channels: myChannels,
      openEnquiries: openByContact.get(c.id) ?? 0,
      relationships: relationshipsByContact.get(c.id) ?? [],
      isClient: wonByContact.has(c.id),
      phone: primary("phone")?.value ?? primary("whatsapp")?.value ?? null,
      email: primary("email")?.value ?? null,
      lastActivityAt: lastByContact.get(c.id) ?? null,
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
