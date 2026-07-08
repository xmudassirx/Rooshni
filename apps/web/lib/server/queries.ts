import "server-only";
import type { ApprovalInboxRow } from "@rooshni/db";
import { getAppContext } from "./context";

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
