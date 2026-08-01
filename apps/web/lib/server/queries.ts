import "server-only";
import type { ActorType, ApprovalInboxRow, EventRow } from "@rooshni/db";
import {
  clampPage,
  clampPageSize,
  computeLightPerformance,
  DEFAULT_LIST_WINDOW,
  evaluateAiBudget,
  pageRange,
  MONTH_SPEND_ROW_BOUND,
  monthWindowUtc,
  plainTextOfBody,
  pricedAmountGbp,
  readGmailEnv,
  readGraphEnv,
  renderEmailHtml,
  resolveAiBudget,
  resolveConversionsConfig,
  resolveEmailIdentity,
  resolveMailProvider,
  resolveSignOffBody,
  resolveSignOffMode,
  resolveSignOffText,
  weekWindowUtc,
  type LightPerformance,
} from "@rooshni/db";
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
  /** WS5d/5e: the stage's TRUE size (count aggregate); cards is a window. */
  total: number;
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

  // WS5d (Session 22): each stage column reads a WINDOW (oldest wait first)
  // and its TOTAL comes from a COUNT aggregate (5e) — the demo-era read
  // fetched every engagement plus the entire approval_inbox on every render.
  const stageList = stages ?? [];
  const perStage = await Promise.all(
    stageList.map((stage) =>
      Promise.all([
        db
          .from("engagements")
          .select("id, title, stage_id, stage_entered_at, attributes, attribution")
          .eq("business_id", business.id)
          .eq("stage_id", stage.id)
          .is("archived_at", null)
          .order("stage_entered_at", { ascending: true })
          .limit(DEFAULT_LIST_WINDOW),
        db
          .from("engagements")
          .select("id", { count: "exact", head: true })
          .eq("business_id", business.id)
          .eq("stage_id", stage.id)
          .is("archived_at", null),
      ])
    )
  );
  const engagements = perStage.flatMap(([rows], i) => {
    if (rows.error) throw new Error(`engagements query (${stageList[i]!.key}) failed: ${rows.error.message}`);
    return rows.data ?? [];
  });
  const totalByStage = new Map(
    stageList.map((stage, i) => {
      const [, countResult] = perStage[i]!;
      if (countResult.error) {
        throw new Error(`engagement count (${stage.key}) failed: ${countResult.error.message}`);
      }
      return [stage.id, countResult.count ?? 0];
    })
  );

  const engagementIds = engagements.map((e) => e.id);

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
    // Slim and scoped: only the VISIBLE cards' pending items, id columns only.
    engagementIds.length
      ? db
          .from("approval_inbox")
          .select("engagement_id, item_type, channel")
          .eq("business_id", business.id)
          .in("engagement_id", engagementIds)
      : Promise.resolve({ data: [], error: null }),
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

  type SlimInboxRow = { engagement_id: string | null; item_type: string; channel: string | null };
  const inboxByEngagement = new Map<string, SlimInboxRow[]>();
  for (const row of (inboxRows.data ?? []) as SlimInboxRow[]) {
    if (!row.engagement_id) continue;
    const list = inboxByEngagement.get(row.engagement_id) ?? [];
    list.push(row);
    inboxByEngagement.set(row.engagement_id, list);
  }

  return stageList.map((stage) => ({
    id: stage.id,
    key: stage.key,
    label: stage.label,
    isTerminal: stage.is_terminal,
    total: totalByStage.get(stage.id) ?? 0,
    cards: engagements
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

/**
 * Session 22 (WS5a) — the Approval Inbox reads a WINDOW: server-side
 * pagination, oldest-wait-first (awaiting_since keys to submitted_at, D134),
 * default 20, selector 10/20/50. The total is a COUNT aggregate (5e) so the
 * page never fetches rows to count them.
 */
export interface InboxPage {
  rows: ApprovalInboxRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
  /** Pending COMMUNICATIONS in the full filtered set — the bulk-reject
   * scope's honest denominator (count aggregate). */
  pendingCommunications: number;
}

export async function getInboxPage(input: { page?: number; pageSize?: number } = {}): Promise<InboxPage> {
  const { db, business } = await getAppContext();
  const pageSize = clampPageSize(input.pageSize);
  const page = clampPage(input.page);
  const range = pageRange(page, pageSize);

  const [rowsResult, totalResult, commResult] = await Promise.all([
    db
      .from("approval_inbox")
      .select("*")
      .eq("business_id", business.id)
      .order("awaiting_since", { ascending: true })
      .range(range.from, range.to),
    db
      .from("approval_inbox")
      .select("*", { count: "exact", head: true })
      .eq("business_id", business.id),
    db
      .from("approval_inbox")
      .select("*", { count: "exact", head: true })
      .eq("business_id", business.id)
      .eq("item_type", "communication"),
  ]);
  if (rowsResult.error) throw new Error(`approval_inbox query failed: ${rowsResult.error.message}`);
  if (totalResult.error) throw new Error(`approval_inbox count failed: ${totalResult.error.message}`);
  if (commResult.error) throw new Error(`approval_inbox comm count failed: ${commResult.error.message}`);
  const total = totalResult.count ?? 0;
  return {
    rows: (rowsResult.data ?? []) as ApprovalInboxRow[],
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    pendingCommunications: commResult.count ?? 0,
  };
}

/**
 * WS5e — the dashboard's stamps-owed tile from COUNT aggregates only: the
 * total, the per-type breakdown (one head count per known type) and the
 * single oldest row for the waiting line. Never a full fetch to count.
 */
export interface InboxSummary {
  total: number;
  byType: { type: string; count: number }[];
  oldestAwaitingSince: string | null;
}

const INBOX_ITEM_TYPES = ["communication", "content", "task", "workflow_definition"];

export async function getInboxSummary(): Promise<InboxSummary> {
  const { db, business } = await getAppContext();
  const [totalResult, oldestResult, ...typeResults] = await Promise.all([
    db.from("approval_inbox").select("*", { count: "exact", head: true }).eq("business_id", business.id),
    db
      .from("approval_inbox")
      .select("awaiting_since")
      .eq("business_id", business.id)
      .order("awaiting_since", { ascending: true })
      .limit(1),
    ...INBOX_ITEM_TYPES.map((type) =>
      db
        .from("approval_inbox")
        .select("*", { count: "exact", head: true })
        .eq("business_id", business.id)
        .eq("item_type", type)
    ),
  ]);
  if (totalResult.error) throw new Error(`inbox summary count failed: ${totalResult.error.message}`);
  if (oldestResult.error) throw new Error(`inbox summary oldest failed: ${oldestResult.error.message}`);
  const byType = INBOX_ITEM_TYPES.flatMap((type, i) => {
    const result = typeResults[i]!;
    if (result.error) throw new Error(`inbox summary ${type} count failed: ${result.error.message}`);
    const count = result.count ?? 0;
    return count > 0 ? [{ type, count }] : [];
  });
  return {
    total: totalResult.count ?? 0,
    byType,
    oldestAwaitingSince: (oldestResult.data?.[0]?.awaiting_since as string | undefined) ?? null,
  };
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

export interface CommunicationContext {
  engagementId: string | null;
  engagementTitle: string | null;
  stageLabel: string | null;
  /** Whitelisted engagement attributes, labelled via field_definitions. */
  answers: { label: string; value: string }[];
  source: string | null;
  formId: string | null;
  channels: { channel: string; value: string; consented: boolean }[];
}

/** Session 15 — the credit line (PR-3): the founder's visibility into
 * Light's spend and sources at the moment of stamping. */
export interface CommunicationCreditLine {
  tier: string;
  model: string;
  reason: string;
  contextTokens: number;
  budgetTokens: number;
  attempts: number;
  packEntries: { id: string; title: string }[];
  /** Session 16 (PR-E) — cache read/written tokens from the provider's usage
   * fields; the fallback reason is recorded when caching was refused. */
  cache: { readTokens: number; writtenTokens: number; fallbackReason: string | null } | null;
}

export interface CommunicationDetail {
  id: string;
  body: string;
  channel: string;
  subject: string | null;
  contactName: string | null;
  scheduledFor: string | null;
  /** Session 11 — context-in-card: what the database holds about the lead,
   * so the founder can glance and stamp without leaving the inbox. */
  context: CommunicationContext | null;
  /** Session 15 — present only on generated drafts (PR-3). */
  creditLine: CommunicationCreditLine | null;
  /** Session 15 — whether the 0026 compliance gate binds this row. */
  complianceRequired: boolean;
  /** Session 15 fix round — the latest human edit of this pending body,
   * read from draft_feedback (no new store). A fact, not a stamp act. */
  editedBy: { name: string; at: string } | null;
  /** Session 16 (PR-B, decision 133a) — this draft replaces an earlier
   * pending draft; the card says so, with how many client messages arrived
   * since that draft was written. */
  supersedes: { communicationId: string; newMessagesSince: number } | null;
  /** Session 16 (PR-F, decision 133e) — approver sign-off mode. When the
   * viewer holds stamp authority, `body` is ALREADY the render-resolved form
   * (their name where the stamp will write it — WYSIWYS) and resolvedTo
   * names them; a viewer without stamp authority sees the firm form with
   * resolvedTo null. */
  signOff: { mode: "approver"; resolvedTo: string | null } | null;
  /** PR-iii (Session 19) — the HTML the client will receive, rendered by the
   * SAME deterministic function dispatch uses, over the same resolved body
   * (WYSIWYS: the stamp view shows what sends). Email drafts only. */
  emailHtmlPreview: string | null;
  /** PR-i (Session 19) — the declared attachments the pre-flight verifies
   * and the dispatch will carry. */
  attachments: { filename: string; sizeBytes: number }[];
}

/** Full draft for the inbox detail panel — the view carries only a preview. */
export async function getCommunicationDetail(
  id: string
): Promise<CommunicationDetail | null> {
  const { db, business } = await getAppContext();
  const { data, error } = await db
    .from("communications")
    .select(
      "id, body, channel, scheduled_for, engagement_id, contact_id, attributes, compliance_required, comm_threads(subject, contact_id), contacts(display_name)"
    )
    .eq("id", id)
    .eq("business_id", business.id)
    .maybeSingle();
  if (error) throw new Error(`communication lookup failed: ${error.message}`);
  if (!data) return null;
  const thread = data.comm_threads as unknown as {
    subject: string | null;
    contact_id: string | null;
  } | null;
  const contact = data.contacts as unknown as { display_name: string } | null;

  const contactId = data.contact_id ?? thread?.contact_id ?? null;
  let context: CommunicationContext | null = null;
  if (data.engagement_id || contactId) {
    const [engagementRes, channelsRes] = await Promise.all([
      data.engagement_id
        ? db
            .from("engagements")
            .select("id, title, attributes, attribution, stage_definitions(label)")
            .eq("id", data.engagement_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      contactId
        ? db
            .from("contact_channels")
            .select("channel, value, consent")
            .eq("contact_id", contactId)
            .is("archived_at", null)
        : Promise.resolve({ data: [], error: null }),
    ]);
    const engagement = engagementRes.data as unknown as {
      id: string;
      title: string;
      attributes: Record<string, unknown> | null;
      attribution: Record<string, unknown> | null;
      stage_definitions: { label: string } | { label: string }[] | null;
    } | null;

    // Attribute labels come from the template's field_definitions — the
    // whitelist is the vocabulary (§2.3).
    let answers: { label: string; value: string }[] = [];
    const attrs = (engagement?.attributes ?? {}) as Record<string, unknown>;
    const attrKeys = Object.keys(attrs).filter((k) => typeof attrs[k] === "string");
    if (attrKeys.length) {
      const { data: fields } = await db
        .from("field_definitions")
        .select("key, label")
        .eq("entity", "engagement")
        .in("key", attrKeys);
      const labelByKey = new Map((fields ?? []).map((f) => [f.key, f.label]));
      answers = attrKeys.map((k) => ({
        label: labelByKey.get(k) ?? k.replace(/_/g, " "),
        value: String(attrs[k]),
      }));
    }
    // Session 15 (PR-2): the FULL Meta form answers — each answer its own
    // labelled row, Meta's labels as stored at ingest, order preserved.
    const formAnswers = attrs.form_answers;
    if (Array.isArray(formAnswers)) {
      for (const answer of formAnswers) {
        if (answer && typeof answer === "object" && "value" in answer) {
          const a = answer as { label?: unknown; name?: unknown; value: unknown };
          const value = String(a.value ?? "").trim();
          if (value) {
            answers.push({ label: String(a.label ?? a.name ?? "Answer"), value });
          }
        }
      }
    }
    const attribution = (engagement?.attribution ?? {}) as Record<string, unknown>;
    const stageRel = engagement?.stage_definitions;
    context = {
      engagementId: engagement?.id ?? null,
      engagementTitle: engagement?.title ?? null,
      stageLabel: Array.isArray(stageRel) ? (stageRel[0]?.label ?? null) : (stageRel?.label ?? null),
      answers,
      source: typeof attribution.source === "string" ? attribution.source : null,
      formId: typeof attribution.form_id === "string" ? attribution.form_id : null,
      channels: ((channelsRes.data ?? []) as {
        channel: string;
        value: string;
        consent: Record<string, unknown> | null;
      }[]).map((c) => ({
        channel: c.channel,
        value: c.value,
        consented: Boolean(c.consent && (c.consent.transactional || c.consent.marketing)),
      })),
    };
  }

  // Session 15 (PR-3): the credit line rides the row's attributes; pack
  // entry titles resolve from content_items so the founder can see the
  // sources by name at the moment of stamping.
  let creditLine: CommunicationCreditLine | null = null;
  const commAttrs = (data.attributes ?? {}) as Record<string, unknown>;
  const rawCredit = commAttrs.credit_line as
    | {
        tier?: unknown;
        model?: unknown;
        reason?: unknown;
        context_tokens?: unknown;
        budget_tokens?: unknown;
        attempts?: unknown;
        knowledge_entry_ids?: unknown;
      }
    | undefined;
  if (rawCredit && typeof rawCredit === "object") {
    const entryIds = Array.isArray(rawCredit.knowledge_entry_ids)
      ? rawCredit.knowledge_entry_ids.filter((v): v is string => typeof v === "string")
      : [];
    let packEntries: { id: string; title: string }[] = [];
    if (entryIds.length) {
      const { data: entries } = await db
        .from("content_items")
        .select("id, title")
        .eq("business_id", business.id)
        .in("id", entryIds);
      const titleById = new Map((entries ?? []).map((e) => [e.id as string, e.title as string]));
      packEntries = entryIds.map((entryId) => ({ id: entryId, title: titleById.get(entryId) ?? "entry" }));
    }
    // Session 16 (PR-E): the cache figures ride the credit line.
    const rawCache = (rawCredit as { cache?: unknown }).cache as
      | { read_tokens?: unknown; written_tokens?: unknown; fallback_reason?: unknown }
      | undefined;
    creditLine = {
      tier: String(rawCredit.tier ?? "standard"),
      model: String(rawCredit.model ?? ""),
      reason: String(rawCredit.reason ?? "floor"),
      contextTokens: Number(rawCredit.context_tokens ?? 0),
      budgetTokens: Number(rawCredit.budget_tokens ?? 0),
      attempts: Number(rawCredit.attempts ?? 1),
      packEntries,
      cache:
        rawCache && typeof rawCache === "object"
          ? {
              readTokens: Number(rawCache.read_tokens ?? 0),
              writtenTokens: Number(rawCache.written_tokens ?? 0),
              fallbackReason:
                typeof rawCache.fallback_reason === "string" ? rawCache.fallback_reason : null,
            }
          : null,
    };
  }

  // Session 15 fix round: an edited pending body wears its state — the
  // latest edit signal already lives in draft_feedback (PR-4).
  let editedBy: { name: string; at: string } | null = null;
  const { data: lastEdit } = await db
    .from("draft_feedback")
    .select("created_by, created_at")
    .eq("communication_id", data.id)
    .eq("kind", "edit")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastEdit) {
    const { data: editor } = await db
      .from("actors")
      .select("display_name")
      .eq("id", lastEdit.created_by)
      .maybeSingle();
    editedBy = { name: editor?.display_name ?? "a team member", at: lastEdit.created_at };
  }

  // Session 16 (PR-B): the supersede note the card renders.
  const rawSupersedes = commAttrs.supersedes as
    | { communication_id?: unknown; new_messages_since?: unknown }
    | undefined;
  const supersedes =
    rawSupersedes && typeof rawSupersedes.communication_id === "string"
      ? {
          communicationId: rawSupersedes.communication_id,
          newMessagesSince: Number(rawSupersedes.new_messages_since ?? 0),
        }
      : null;

  // Session 16 (PR-F, decision 133e): approver sign-off mode. Render-resolve
  // for a stamp-authority viewer uses THE SAME deterministic resolver the
  // stamp act uses (sign-off.ts) — what they see is what sends.
  let body: string = data.body;
  let signOff: CommunicationDetail["signOff"] = null;
  const { db: ctxDb, business: ctxBusiness, actor: ctxActor, membershipRole } = await getAppContext();
  const { data: bizRow } = await ctxDb
    .from("businesses")
    .select("settings")
    .eq("id", business.id)
    .maybeSingle();
  const bizSettings = (bizRow?.settings ?? {}) as Record<string, unknown>;
  if (resolveSignOffMode(bizSettings) === "approver" && data.channel === "email") {
    let hasStampAuthority = membershipRole === "owner";
    if (!hasStampAuthority) {
      const { data: grants } = await ctxDb
        .from("grants")
        .select("id")
        .eq("business_id", business.id)
        .eq("grantee_actor_id", ctxActor.id)
        .eq("tool", "approvals.comms")
        .eq("access", "execute")
        .is("revoked_at", null)
        .is("archived_at", null)
        .limit(1);
      hasStampAuthority = Boolean(grants?.length);
    }
    if (hasStampAuthority) {
      const candidates = [
        resolveSignOffText(bizSettings, ctxBusiness.name),
        ctxBusiness.name,
        ...(typeof commAttrs.sign_off_resolved_to === "string" ? [commAttrs.sign_off_resolved_to] : []),
      ];
      const resolved = resolveSignOffBody(data.body, candidates, ctxActor.display_name);
      body = resolved ?? data.body;
      signOff = { mode: "approver", resolvedTo: ctxActor.display_name };
    } else {
      signOff = { mode: "approver", resolvedTo: null };
    }
  }

  return {
    id: data.id,
    body,
    channel: data.channel,
    subject: thread?.subject ?? null,
    contactName: contact?.display_name ?? null,
    scheduledFor: data.scheduled_for,
    context,
    creditLine,
    complianceRequired: Boolean(data.compliance_required),
    editedBy,
    supersedes,
    signOff,
    // PR-iii: rendered over the RESOLVED body — the exact transformation the
    // dispatcher will apply to the exact words the stamp approves.
    emailHtmlPreview:
      data.channel === "email"
        ? renderEmailHtml(body, resolveEmailIdentity(ctxBusiness.name, bizSettings))
        : null,
    // PR-i: what will ride the send, named on the card.
    attachments: Array.isArray(commAttrs.attachments)
      ? (commAttrs.attachments as Array<{ filename?: unknown; size_bytes?: unknown }>).map((a) => ({
          filename: String(a.filename ?? "document"),
          sizeBytes: Number(a.size_bytes ?? 0),
        }))
      : [],
  };
}

export interface InboxHistoryRow {
  eventId: string;
  /** Session 16: superseded joins the decided states — terminal, evented,
   * never deletable (decision 133a); rendered in neutral chrome.
   * Session 21: withdrawn joins them — the owner's terminal exit for a
   * pending workflow definition (0034); neutral chrome likewise. */
  action: "approved" | "rejected" | "superseded" | "withdrawn";
  occurredAt: string;
  actorName: string | null;
  reason: string | null;
  communicationId: string;
  channel: string | null;
  preview: string | null;
  contactName: string | null;
  threadId: string | null;
  engagementId: string | null;
}

const HISTORY_ACTIONS = [
  "communication.approved",
  "communication.rejected",
  "communication.superseded",
  "workflow.definition_withdrawn",
];

export interface InboxHistoryPage {
  rows: InboxHistoryRow[];
  total: number;
  page: number;
  pageCount: number;
}

/** Session 11 — the inbox History tab: stamped and refused decisions read
 * from The Record (the events ARE the history; the default view stays
 * stamps-owed-only). Session 22 (WS5d): windowed server-side, default 20,
 * the total a COUNT aggregate. */
export async function getInboxHistory(days: 7 | 30, page = 1): Promise<InboxHistoryPage> {
  const { db, business } = await getAppContext();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const range = pageRange(page, DEFAULT_LIST_WINDOW);

  const [{ data: events, error }, countResult] = await Promise.all([
    db
      .from("events")
      .select("id, action, occurred_at, entity_id, payload, actors(display_name)")
      .eq("business_id", business.id)
      // Session 21: a withdrawn workflow definition is a decided item too —
      // it lands here from The Record like every other decision.
      .in("action", HISTORY_ACTIONS)
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      .range(range.from, range.to),
    db
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("business_id", business.id)
      .in("action", HISTORY_ACTIONS)
      .gte("occurred_at", since),
  ]);
  if (error) throw new Error(`inbox history query failed: ${error.message}`);
  if (countResult.error) throw new Error(`inbox history count failed: ${countResult.error.message}`);
  const total = countResult.count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / DEFAULT_LIST_WINDOW));
  const emptyPage = { total, page: clampPage(page), pageCount };
  if (!events?.length) return { rows: [], ...emptyPage };

  const commIds = [
    ...new Set(
      events
        .filter((e) => e.action !== "workflow.definition_withdrawn")
        .map((e) => e.entity_id)
        .filter(Boolean)
    ),
  ] as string[];
  const { data: comms, error: commError } = commIds.length
    ? await db
        .from("communications")
        .select(
          "id, channel, body, body_format, plain_body:attributes->>plain_body, thread_id, engagement_id, contact_id, comm_threads(contact_id), contacts(display_name)"
        )
        .in("id", commIds)
    : { data: [], error: null };
  if (commError) throw new Error(`history communications query failed: ${commError.message}`);
  const commById = new Map((comms ?? []).map((c) => [c.id, c]));

  const rows: InboxHistoryRow[] = events.flatMap((e): InboxHistoryRow[] => {
    if (!e.entity_id) return [];
    if (e.action === "workflow.definition_withdrawn") {
      // Session 21: the payload carries the definition's key/version and the
      // reason, so History renders without a second lookup.
      const actorRel = e.actors as unknown as
        | { display_name: string }
        | { display_name: string }[]
        | null;
      const payload = (e.payload ?? {}) as Record<string, unknown>;
      const key = typeof payload.definition_key === "string" ? payload.definition_key : null;
      const version = typeof payload.definition_version === "number" ? payload.definition_version : null;
      return [
        {
          eventId: e.id,
          action: "withdrawn" as const,
          occurredAt: e.occurred_at,
          actorName: Array.isArray(actorRel)
            ? (actorRel[0]?.display_name ?? null)
            : (actorRel?.display_name ?? null),
          reason: typeof payload.reason === "string" ? payload.reason : null,
          communicationId: e.entity_id,
          channel: null,
          preview: key ? `${key}${version != null ? ` v${version}` : ""}` : "workflow definition",
          contactName: null,
          threadId: null,
          engagementId: null,
        },
      ];
    }
    const comm = commById.get(e.entity_id) as
      | {
          id: string;
          channel: string;
          body: string;
          body_format: string;
          plain_body: string | null;
          thread_id: string | null;
          engagement_id: string | null;
          contacts: { display_name: string } | { display_name: string }[] | null;
        }
      | undefined;
    const actorRel = e.actors as unknown as
      | { display_name: string }
      | { display_name: string }[]
      | null;
    const contactRel = comm?.contacts;
    const payload = (e.payload ?? {}) as Record<string, unknown>;
    return [
      {
        eventId: e.id,
        action:
          e.action === "communication.approved"
            ? ("approved" as const)
            : e.action === "communication.superseded"
              ? ("superseded" as const)
              : ("rejected" as const),
        occurredAt: e.occurred_at,
        actorName: Array.isArray(actorRel)
          ? (actorRel[0]?.display_name ?? null)
          : (actorRel?.display_name ?? null),
        reason: typeof payload.reason === "string" ? payload.reason : null,
        communicationId: e.entity_id,
        channel: comm?.channel ?? null,
        // PR-iii: previews are always the WORDS, never markup.
        preview: comm?.body
          ? (comm.body_format === "html" ? (comm.plain_body ?? plainTextOfBody(comm.body, "html")) : comm.body).slice(0, 140)
          : null,
        contactName: Array.isArray(contactRel)
          ? (contactRel[0]?.display_name ?? null)
          : (contactRel?.display_name ?? null),
        threadId: comm?.thread_id ?? null,
        engagementId: comm?.engagement_id ?? null,
      },
    ];
  });
  return { rows, ...emptyPage };
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
  /** Priced metered cost on the ledger this month, GBP (WS2: the tile reads
   * the same truth as Billing & usage). */
  meteredCostGbpThisMonth: number;
  meteredEventsThisMonth: number;
  /** Pre-s22 cost lines with no priced amount — counted, never invented. */
  unpricedEventsThisMonth: number;
  /** WS2: the cap banner's live truth (computed here so the dashboard needs
   * no second read of the month's cost rows). */
  budget: {
    softCapGbp: number | null;
    hardCapGbp: number | null;
    softCrossed: boolean;
    hardCrossed: boolean;
  };
}

export async function getDashboard(): Promise<DashboardData> {
  const { db, business } = await getAppContext();

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const endOfToday = new Date(startOfToday);
  endOfToday.setDate(endOfToday.getDate() + 1);
  const startOfMonth = new Date(startOfToday);
  startOfMonth.setDate(1);

  const [newRows, taskRows, slaRows, costRows, bizSettingsRow] = await Promise.all([
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
      .not("cost", "is", null)
      .limit(MONTH_SPEND_ROW_BOUND),
    db.from("businesses").select("settings").eq("id", business.id).maybeSingle(),
  ]);
  for (const [label, result] of [
    ["engagements (new today)", newRows],
    ["tasks (today)", taskRows],
    ["engagements (stage SLA)", slaRows],
    ["events (cost)", costRows],
    ["businesses (settings)", bizSettingsRow],
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

  // WS2: the tile reads the same priced truth as Billing & usage — GBP from
  // the cost block's amount; pre-pricing lines counted, never invented.
  let meteredCost = 0;
  let metered = 0;
  let unpriced = 0;
  for (const row of costRows.data ?? []) {
    const amount = pricedAmountGbp(row.cost as Record<string, unknown> | null);
    metered += 1;
    if (amount === null) unpriced += 1;
    else meteredCost += amount;
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
    meteredCostGbpThisMonth: meteredCost,
    meteredEventsThisMonth: metered,
    unpricedEventsThisMonth: unpriced,
    budget: (() => {
      const budget = resolveAiBudget((bizSettingsRow.data?.settings ?? {}) as Record<string, unknown>);
      const assessment = evaluateAiBudget(meteredCost, budget);
      return {
        softCapGbp: budget.soft_cap_gbp,
        hardCapGbp: budget.hard_cap_gbp,
        softCrossed: assessment.soft_crossed,
        hardCrossed: assessment.hard_crossed,
      };
    })(),
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
  /** PR-iii (Session 19): a dispatched email's exact sent HTML document, when
   * the row stores one (body_format html) — the "as sent" view. `body` is
   * always the plain words. */
  sentHtml: string | null;
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
  /** Session 16 (PR-C/D): the drafting preferences and settle state, straight
   * off the thread row — durable server-side truth, never client state. */
  autoDraftPaused: boolean;
  settleOverrideSeconds: number | null;
  settleDueAt: string | null;
  /** Session 16 (PR-A): Meta's 24h service window as recorded on the thread. */
  waServiceWindowExpiresAt: string | null;
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
      .select(
        "id, subject, channel, contact_id, engagement_id, auto_draft_paused, settle_override_seconds, draft_settle_due_at, wa_service_window_expires_at"
      )
      .eq("business_id", business.id)
      .is("archived_at", null),
    db
      .from("communications")
      .select(
        "id, thread_id, channel, direction, status, body, body_format, plain_body:attributes->>plain_body, scheduled_for, occurred_at, duration_seconds, drafted_by_actor_id, approved_by_actor_id"
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
      // PR-iii (Session 19): a dispatched email row stores its sent HTML —
      // the bubble reads the WORDS (the preserved plain source, else the
      // deterministic extraction), and the exact document rides along for
      // the "as sent" view.
      const isHtml = (c as { body_format?: string }).body_format === "html";
      const plainBody = (c as { plain_body?: string | null }).plain_body;
      return {
        id: c.id,
        channel: c.channel,
        direction: c.direction as ThreadMessage["direction"],
        status: c.status,
        body: isHtml ? (plainBody ?? plainTextOfBody(c.body, "html")) : c.body,
        subject: null,
        occurredAt: c.occurred_at,
        scheduledFor: c.scheduled_for,
        durationSeconds: c.duration_seconds,
        draftedByLight: draftedBy?.type === "agent",
        stampedByName: approvedBy?.name ?? null,
        isPendingDraft: c.direction === "outbound" && c.status === "pending_approval",
        sentHtml: isHtml ? c.body : null,
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
        autoDraftPaused: Boolean(t.auto_draft_paused),
        settleOverrideSeconds:
          typeof t.settle_override_seconds === "number" ? t.settle_override_seconds : null,
        settleDueAt: t.draft_settle_due_at ?? null,
        waServiceWindowExpiresAt: t.wa_service_window_expires_at ?? null,
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

// --- Settings → General ---------------------------------------------------------------

export interface BusinessConfig {
  name: string;
  timezone: string;
  locale: string;
  /** businesses.settings — free-form config; keys may simply not exist yet. */
  settings: Record<string, unknown>;
  template: { vertical: string; version: number; noGoRules: number } | null;
}

export async function getBusinessConfig(): Promise<BusinessConfig> {
  const { db, business } = await getAppContext();
  const { data: row, error } = await db
    .from("businesses")
    .select("name, timezone, default_locale, settings, template_id")
    .eq("id", business.id)
    .maybeSingle();
  if (error) throw new Error(`businesses query failed: ${error.message}`);
  if (!row) throw new Error("The signed-in business is not visible.");

  const { data: template, error: tError } = row.template_id
    ? await db
        .from("templates")
        .select("vertical, version, no_go_rules")
        .eq("id", row.template_id)
        .maybeSingle()
    : { data: null, error: null };
  if (tError) throw new Error(`templates query failed: ${tError.message}`);

  return {
    name: row.name,
    timezone: row.timezone,
    locale: row.default_locale,
    settings: (row.settings ?? {}) as Record<string, unknown>,
    template: template
      ? {
          vertical: template.vertical,
          version: template.version,
          noGoRules: Array.isArray(template.no_go_rules) ? template.no_go_rules.length : 0,
        }
      : null,
  };
}

// --- Team & Access -------------------------------------------------------------------

export interface TeamMember {
  actorId: string;
  name: string;
  kind: "human" | "agent";
  role: string | null;
  grantCount: number;
  /** "tool · access" chips, as the mockup's team rows wear them. */
  grantChips: string[];
}

export async function getTeam(): Promise<TeamMember[]> {
  const { db, business } = await getAppContext();

  const [members, actors, grants] = await Promise.all([
    db
      .from("memberships")
      .select("user_id, role")
      .eq("business_id", business.id)
      .is("archived_at", null),
    db
      .from("actors")
      .select("id, display_name, actor_type, user_id")
      .is("archived_at", null)
      .in("actor_type", ["human", "agent"]),
    db
      .from("grants")
      .select("grantee_actor_id, tool, access")
      .eq("business_id", business.id)
      .is("archived_at", null)
      .is("revoked_at", null),
  ]);
  for (const [label, result] of [
    ["memberships", members],
    ["actors", actors],
    ["grants", grants],
  ] as const) {
    if (result.error) throw new Error(`${label} query failed: ${result.error.message}`);
  }

  const grantCounts = new Map<string, number>();
  const chipsByActor = new Map<string, string[]>();
  for (const g of grants.data ?? []) {
    grantCounts.set(g.grantee_actor_id, (grantCounts.get(g.grantee_actor_id) ?? 0) + 1);
    const chips = chipsByActor.get(g.grantee_actor_id) ?? [];
    chips.push(`${g.tool} · ${g.access}`);
    chipsByActor.set(g.grantee_actor_id, chips);
  }
  const roleByUser = new Map((members.data ?? []).map((m) => [m.user_id, m.role as string]));

  return (actors.data ?? [])
    .filter((a) => a.actor_type === "agent" || (a.user_id && roleByUser.has(a.user_id)))
    .map((a) => ({
      actorId: a.id,
      name: a.display_name,
      kind: a.actor_type as "human" | "agent",
      role: a.user_id ? (roleByUser.get(a.user_id) ?? null) : null,
      grantCount: grantCounts.get(a.id) ?? 0,
      grantChips: (chipsByActor.get(a.id) ?? []).sort(),
    }));
}

export interface GrantRow {
  tool: string;
  access: "view" | "draft" | "execute";
  scopeLevel: string;
  duration: string;
  via: string;
}

export interface MemberDetail {
  actorId: string;
  name: string;
  kind: "human" | "agent";
  role: string | null;
  grants: GrantRow[];
  tools: { key: string; label: string; category: string }[];
}

export async function getMemberDetail(actorId: string): Promise<MemberDetail | null> {
  if (!isUuid(actorId)) return null;
  const { db, business } = await getAppContext();

  const { data: actor, error: actorError } = await db
    .from("actors")
    .select("id, display_name, actor_type, user_id")
    .eq("id", actorId)
    .is("archived_at", null)
    .maybeSingle();
  if (actorError) throw new Error(`actor lookup failed: ${actorError.message}`);
  if (!actor || (actor.actor_type !== "human" && actor.actor_type !== "agent")) return null;

  const [grants, tools, membership] = await Promise.all([
    db
      .from("grants")
      .select("tool, access, scope, duration, via")
      .eq("business_id", business.id)
      .eq("grantee_actor_id", actorId)
      .is("archived_at", null)
      .is("revoked_at", null),
    db.from("tools").select("key, label, category").is("archived_at", null).order("key"),
    actor.user_id
      ? db
          .from("memberships")
          .select("role")
          .eq("business_id", business.id)
          .eq("user_id", actor.user_id)
          .is("archived_at", null)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (grants.error) throw new Error(`grants query failed: ${grants.error.message}`);
  if (tools.error) throw new Error(`tools query failed: ${tools.error.message}`);

  return {
    actorId: actor.id,
    name: actor.display_name,
    kind: actor.actor_type as "human" | "agent",
    role: (membership.data?.role as string | undefined) ?? null,
    grants: (grants.data ?? []).map((g) => {
      const scope = (g.scope ?? {}) as Record<string, unknown>;
      return {
        tool: g.tool,
        access: g.access as GrantRow["access"],
        scopeLevel: typeof scope.level === "string" ? scope.level : "business",
        duration: g.duration,
        via: g.via,
      };
    }),
    tools: (tools.data ?? []).map((t) => ({
      key: t.key,
      label: t.label,
      category: t.category,
    })),
  };
}

// --- Billing & usage ---------------------------------------------------------------

export interface MeteredUsage {
  /** Priced metered cost this UTC month, GBP (ruling 2a: our recorded cost,
   * no margin — labelled "metered cost" honestly). */
  totalGbp: number;
  pricedLines: number;
  /** Cost lines recorded before the s22 pricing landed — shown as token
   * counts, never retro-priced. */
  unpricedLines: number;
  unpricedTokens: number;
  byDay: { day: string; gbp: number; lines: number }[];
  byAction: { action: string; lines: number; gbp: number; tokens: number }[];
  budget: {
    softCapGbp: number | null;
    hardCapGbp: number | null;
    softCrossed: boolean;
    hardCrossed: boolean;
  };
  isOwner: boolean;
}

/**
 * Session 22 (WS2, ruling 2a) — the meter reads events.cost, the s15
 * producer's truth: this month's spend by day and by action kind, priced
 * lines summed in GBP, pre-pricing lines counted honestly as tokens.
 * Bounded read (law 5e's spirit — never unbounded rows).
 */
export async function getMeteredUsage(): Promise<MeteredUsage> {
  const { db, business, membershipRole } = await getAppContext();
  const now = new Date();
  const window = monthWindowUtc(now);

  const [{ data, error }, { data: bizRow, error: bizError }] = await Promise.all([
    db
      .from("events")
      .select("action, occurred_at, cost")
      .eq("business_id", business.id)
      .not("cost", "is", null)
      .gte("occurred_at", window.start)
      .lt("occurred_at", window.end)
      .limit(MONTH_SPEND_ROW_BOUND),
    db.from("businesses").select("settings").eq("id", business.id).maybeSingle(),
  ]);
  if (error) throw new Error(`metered usage query failed: ${error.message}`);
  if (bizError) throw new Error(`budget settings query failed: ${bizError.message}`);

  let totalGbp = 0;
  let pricedLines = 0;
  let unpricedLines = 0;
  let unpricedTokens = 0;
  const byDay = new Map<string, { gbp: number; lines: number }>();
  const byAction = new Map<string, { lines: number; gbp: number; tokens: number }>();
  for (const row of data ?? []) {
    const cost = row.cost as Record<string, unknown> | null;
    const amount = pricedAmountGbp(cost);
    const tokens = typeof cost?.tokens === "number" ? (cost.tokens as number) : 0;
    const day = String(row.occurred_at).slice(0, 10);
    const dayEntry = byDay.get(day) ?? { gbp: 0, lines: 0 };
    const actionEntry = byAction.get(row.action) ?? { lines: 0, gbp: 0, tokens: 0 };
    dayEntry.lines += 1;
    actionEntry.lines += 1;
    actionEntry.tokens += tokens;
    if (amount === null) {
      unpricedLines += 1;
      unpricedTokens += tokens;
    } else {
      totalGbp += amount;
      pricedLines += 1;
      dayEntry.gbp += amount;
      actionEntry.gbp += amount;
    }
    byDay.set(day, dayEntry);
    byAction.set(row.action, actionEntry);
  }

  const budget = resolveAiBudget((bizRow?.settings ?? {}) as Record<string, unknown>);
  const assessment = evaluateAiBudget(totalGbp, budget);
  return {
    totalGbp,
    pricedLines,
    unpricedLines,
    unpricedTokens,
    byDay: [...byDay.entries()]
      .map(([day, v]) => ({ day, ...v }))
      .sort((a, b) => b.day.localeCompare(a.day)),
    byAction: [...byAction.entries()]
      .map(([action, v]) => ({ action, ...v }))
      .sort((a, b) => b.gbp - a.gbp || b.lines - a.lines),
    budget: {
      softCapGbp: budget.soft_cap_gbp,
      hardCapGbp: budget.hard_cap_gbp,
      softCrossed: assessment.soft_crossed,
      hardCrossed: assessment.hard_crossed,
    },
    isOwner: membershipRole === "owner",
  };
}

/**
 * Session 22 (WS3) — the Light performance tile's truth: existing rows only
 * (events + draft_feedback + communication statuses), counts from COUNT
 * aggregates (law 5e), the week's cost blocks as one bounded read, and the
 * arithmetic in the pure computeLightPerformance the harness proves.
 */
export async function getLightPerformance(): Promise<LightPerformance> {
  const { db, business } = await getAppContext();
  const week = weekWindowUtc(new Date());
  const countEvents = (action: string) =>
    db
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("business_id", business.id)
      .eq("action", action)
      .gte("occurred_at", week.start)
      .lt("occurred_at", week.end);

  const [drafts, stamped, rejected, edits, breaches, costRows] = await Promise.all([
    countEvents("light.draft_generated"),
    countEvents("communication.approved"),
    countEvents("communication.rejected"),
    db
      .from("draft_feedback")
      .select("id", { count: "exact", head: true })
      .eq("business_id", business.id)
      .eq("kind", "edit")
      .gte("created_at", week.start)
      .lt("created_at", week.end),
    db
      .from("events")
      .select("id", { count: "exact", head: true })
      .eq("business_id", business.id)
      .eq("action", "communication.compliance_checked")
      .eq("payload->>result", "breach")
      .gte("occurred_at", week.start)
      .lt("occurred_at", week.end),
    db
      .from("events")
      .select("cost")
      .eq("business_id", business.id)
      .eq("action", "light.draft_generated")
      .gte("occurred_at", week.start)
      .lt("occurred_at", week.end)
      .limit(MONTH_SPEND_ROW_BOUND),
  ]);
  for (const [label, result] of [
    ["drafts generated", drafts],
    ["stamps", stamped],
    ["rejections", rejected],
    ["edit signals", edits],
    ["compliance refusals", breaches],
    ["cost blocks", costRows],
  ] as const) {
    if (result.error) throw new Error(`performance ${label} query failed: ${result.error.message}`);
  }

  return computeLightPerformance({
    drafts_generated: drafts.count ?? 0,
    stamped: stamped.count ?? 0,
    rejected: rejected.count ?? 0,
    edit_signals: edits.count ?? 0,
    compliance_refusals: breaches.count ?? 0,
    cost_blocks: (costRows.data ?? []).map((r) => r.cost as Record<string, unknown> | null),
  });
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
        "id, channel, direction, status, body, body_format, plain_body:attributes->>plain_body, occurred_at, scheduled_for, drafted_by_actor_id, approved_by_actor_id, created_by, comm_threads(subject)"
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
      // PR-iii: a dispatched email row stores its sent HTML — the timeline
      // reads the words (preserved plain source, else the deterministic
      // extraction).
      const isHtml = (c as { body_format?: string }).body_format === "html";
      const plainBody = (c as { plain_body?: string | null }).plain_body;
      return {
        id: c.id,
        channel: c.channel,
        direction: c.direction,
        status: c.status,
        body: isHtml ? (plainBody ?? plainTextOfBody(c.body, "html")) : c.body,
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

export interface ContactsPage {
  rows: ContactListRow[];
  total: number;
  page: number;
  pageCount: number;
}

/**
 * Session 22 (WS5d): the contacts list reads a WINDOW — server-side
 * pagination (default 20), hydration scoped to the PAGE's contact ids, the
 * total a COUNT aggregate. The demo-era read fetched every contact, every
 * channel, every relationship and EVERY communication row on each render.
 */
export async function getContacts(page = 1): Promise<ContactsPage> {
  const { db, business } = await getAppContext();
  const range = pageRange(page, DEFAULT_LIST_WINDOW);

  const [contacts, totalResult] = await Promise.all([
    db
      .from("contacts")
      .select("id, display_name, type, status, locale, first_touch")
      .eq("business_id", business.id)
      .is("archived_at", null)
      .order("display_name", { ascending: true })
      .range(range.from, range.to),
    db
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("business_id", business.id)
      .is("archived_at", null),
  ]);
  if (contacts.error) throw new Error(`contacts query failed: ${contacts.error.message}`);
  if (totalResult.error) throw new Error(`contacts count failed: ${totalResult.error.message}`);
  const total = totalResult.count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / DEFAULT_LIST_WINDOW));
  const pageIds = (contacts.data ?? []).map((c) => c.id as string);
  if (pageIds.length === 0) {
    return { rows: [], total, page: clampPage(page), pageCount };
  }
  const idList = pageIds.join(",");

  const [channels, relationships, participants, lastCommRows] = await Promise.all([
    db
      .from("contact_channels")
      .select("contact_id, channel, value, is_primary, consent")
      .eq("business_id", business.id)
      .in("contact_id", pageIds)
      .is("archived_at", null),
    db
      .from("contact_relationships")
      .select("from_contact_id, to_contact_id, relationship")
      .eq("business_id", business.id)
      .or(`from_contact_id.in.(${idList}),to_contact_id.in.(${idList})`)
      .is("archived_at", null),
    db
      .from("engagement_participants")
      .select(
        "contact_id, engagements(id, archived_at, outcome, title, stage_entered_at, attributes, stage_definitions(key, label, is_terminal, terminal_outcome))"
      )
      .eq("business_id", business.id)
      .in("contact_id", pageIds)
      .is("archived_at", null),
    // Last activity per PAGE contact: one single-row read each — exact and
    // bounded, never the whole communications table.
    Promise.all(
      pageIds.map((id) =>
        db
          .from("communications")
          .select("contact_id, occurred_at")
          .eq("business_id", business.id)
          .eq("contact_id", id)
          .is("archived_at", null)
          .order("occurred_at", { ascending: false })
          .limit(1)
      )
    ),
  ]);
  for (const [label, result] of [
    ["contact_channels", channels],
    ["contact_relationships", relationships],
    ["engagement_participants", participants],
  ] as const) {
    if (result.error) throw new Error(`${label} query failed: ${result.error.message}`);
  }
  const lastComms = {
    data: lastCommRows.flatMap((r) => {
      if (r.error) throw new Error(`last activity query failed: ${r.error.message}`);
      return r.data ?? [];
    }),
  };

  // Names for relationship rendering: the page's own names plus any related
  // contacts that sit off-page — one bounded lookup.
  const nameById = new Map((contacts.data ?? []).map((c) => [c.id, c.display_name as string]));
  const offPageIds = [
    ...new Set(
      (relationships.data ?? [])
        .flatMap((r) => [r.from_contact_id, r.to_contact_id])
        .filter((id) => !nameById.has(id))
    ),
  ];
  if (offPageIds.length > 0) {
    const { data: extraNames, error: extraError } = await db
      .from("contacts")
      .select("id, display_name")
      .eq("business_id", business.id)
      .in("id", offPageIds);
    if (extraError) throw new Error(`related contact names query failed: ${extraError.message}`);
    for (const c of extraNames ?? []) nameById.set(c.id, c.display_name as string);
  }

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

  const rows = (contacts.data ?? []).map((c) => {
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
  return { rows, total, page: clampPage(page), pageCount };
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

// --- Session 11: First Light + template content --------------------------------------

export interface FirstLightRowView {
  predicateKey: string;
  title: string;
  description: string;
  optional: boolean;
  satisfiedAt: string | null;
  taskStatus: string;
  /** Non-null when the earning machinery does not exist yet — "arrives with…". */
  pendingArrival: string | null;
}

export interface FirstLightState {
  rows: FirstLightRowView[];
  doneCount: number;
  totalCount: number;
  /** True when every row is earned or (optional) skipped — the pill retires. */
  retired: boolean;
  /** True for businesses that predate First Light (no predicate rows at all). */
  absent: boolean;
}

const PENDING_ARRIVALS: Record<string, string> = {
  memory_tray_reviewed: "arrives with the crawler session",
  sending_domain_verified: "arrives with the domain-verification session",
  walkthrough_booked: "arrives with the booking-link session",
};

export async function getFirstLight(): Promise<FirstLightState> {
  const { db, business } = await getAppContext();
  const { data: predicates, error } = await db
    .from("first_light_predicates")
    .select("predicate_key, optional, satisfied_at, task_id")
    .eq("business_id", business.id)
    .is("archived_at", null);
  if (error) throw new Error(`first_light query failed: ${error.message}`);
  if (!predicates?.length) {
    return { rows: [], doneCount: 0, totalCount: 0, retired: true, absent: true };
  }

  const { data: tasks, error: taskError } = await db
    .from("tasks")
    .select("id, title, description, status")
    .in("id", predicates.map((p) => p.task_id));
  if (taskError) throw new Error(`first_light task query failed: ${taskError.message}`);
  const taskById = new Map((tasks ?? []).map((t) => [t.id, t]));

  const rows: FirstLightRowView[] = predicates.map((p) => {
    const task = taskById.get(p.task_id);
    return {
      predicateKey: p.predicate_key,
      title: task?.title ?? p.predicate_key,
      description: task?.description ?? "",
      optional: p.optional,
      satisfiedAt: p.satisfied_at,
      taskStatus: task?.status ?? "open",
      pendingArrival: p.satisfied_at ? null : (PENDING_ARRIVALS[p.predicate_key] ?? null),
    };
  });
  // Stable panel order: the definition's install order is the tasks' creation
  // order; predicates arrive unordered, so sort by the canonical key list.
  const order = [
    "basics_confirmed", "email_calendar_connected", "whatsapp_connected",
    "meta_lead_forms_connected", "memory_tray_reviewed", "nogo_rules_acknowledged",
    "sending_domain_verified", "walkthrough_booked",
  ];
  rows.sort((a, b) => order.indexOf(a.predicateKey) - order.indexOf(b.predicateKey));

  const doneCount = rows.filter((r) => r.satisfiedAt).length;
  const retired = rows.every(
    (r) => r.satisfiedAt || (r.optional && r.taskStatus === "cancelled")
  );
  return { rows, doneCount, totalCount: rows.length, retired, absent: false };
}

export interface TemplateContent {
  key: string;
  version: number;
  displayName: string;
  signupFooter: string;
  regulatedStatusOptions: string[];
  standardKeys: string[];
  quietHoursDefault: { start: string; end: string };
  noGoRules: string[];
  knowledgePackCategories: string[];
}

/** The signed-in business's installed template content, read from the
 * definition store (one truth — installs point at it by key + version). */
export async function getTemplateContent(): Promise<TemplateContent | null> {
  const { db, business } = await getAppContext();
  const { data: biz, error } = await db
    .from("businesses")
    .select("template_id, templates!businesses_template_id_fkey(vertical, version)")
    .eq("id", business.id)
    .maybeSingle();
  if (error) throw new Error(`template pointer query failed: ${error.message}`);
  const install = (Array.isArray(biz?.templates) ? biz?.templates[0] : biz?.templates) as
    | { vertical: string; version: number }
    | null
    | undefined;
  if (!install) return null;

  const { data: def, error: defError } = await db
    .from("template_definitions")
    .select("key, version, display_name, definition")
    .eq("key", install.vertical)
    .eq("version", install.version)
    .maybeSingle();
  if (defError) throw new Error(`template definition query failed: ${defError.message}`);
  if (!def) return null;

  const d = (def.definition ?? {}) as {
    signup_footer?: string;
    business_identity?: {
      standard_keys?: string[];
      regulated_status_options?: string[];
      defaults?: { quiet_hours?: { start: string; end: string } };
    };
    no_go_rules?: string[];
    knowledge_pack_categories?: string[];
  };
  return {
    key: def.key,
    version: def.version,
    displayName: def.display_name,
    signupFooter: d.signup_footer ?? "",
    regulatedStatusOptions: d.business_identity?.regulated_status_options ?? [],
    standardKeys: d.business_identity?.standard_keys ?? [],
    quietHoursDefault: d.business_identity?.defaults?.quiet_hours ?? { start: "20:00", end: "08:00" },
    noGoRules: d.no_go_rules ?? [],
    knowledgePackCategories: d.knowledge_pack_categories ?? [],
  };
}

// ---------------------------------------------------------------------------
// Session 15 (PR-1) — the knowledge pack. Entries are content_items rows of
// content_type `knowledge_entry`; the category and route VOCABULARIES render
// from the installed declarations (0024 field_definitions.validation.allowed)
// — never from hardcoded chrome.
// ---------------------------------------------------------------------------

export interface KnowledgeVocabOption {
  key: string;
  label: string;
}

export interface KnowledgeVocab {
  categories: KnowledgeVocabOption[];
  routes: KnowledgeVocabOption[];
}

export async function getKnowledgeVocab(): Promise<KnowledgeVocab | null> {
  const { db, business } = await getAppContext();
  const { data: biz } = await db
    .from("businesses")
    .select("template_id")
    .eq("id", business.id)
    .maybeSingle();
  if (!biz?.template_id) return null;

  const { data: fields, error } = await db
    .from("field_definitions")
    .select("key, validation")
    .eq("template_id", biz.template_id)
    .eq("entity", "content")
    .in("key", ["knowledge_category", "visa_route"])
    .is("archived_at", null);
  if (error) throw new Error(`knowledge vocab query failed: ${error.message}`);

  const allowed = (key: string): KnowledgeVocabOption[] => {
    const row = (fields ?? []).find((f) => f.key === key);
    const list = (row?.validation as { allowed?: unknown } | null)?.allowed;
    if (!Array.isArray(list)) return [];
    return list
      .filter((o): o is { key: string; label: string } => Boolean(o && typeof o === "object" && "key" in o))
      .map((o) => ({ key: String(o.key), label: String(o.label) }));
  };

  const categories = allowed("knowledge_category");
  if (!categories.length) return null;
  return { categories, routes: allowed("visa_route") };
}

export interface KnowledgeEntryRow {
  id: string;
  title: string;
  category: string;
  visaRoute: string | null;
  state: "draft" | "published";
  version: number;
  updatedAt: string;
  bodyText: string;
  /** PR-i (Session 19): a route_guide entry's live linked document —
   * "documents are entries with a file". Null on text entries and on a
   * guide whose file was never uploaded (a visibly incomplete guide). */
  file: { filename: string; sizeBytes: number } | null;
}

/** Every live pack entry, for the Settings → Knowledge editor (the one door). */
export async function getKnowledgeEntries(): Promise<KnowledgeEntryRow[]> {
  const { db, business } = await getAppContext();
  const { data, error } = await db
    .from("content_items")
    .select("id, title, state, version, updated_at, body, attributes")
    .eq("business_id", business.id)
    .eq("content_type", "knowledge_entry")
    .is("archived_at", null)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`knowledge entries query failed: ${error.message}`);

  // PR-i: resolve each entry's newest live linked file in one pass.
  const entryIds = (data ?? []).map((r) => r.id as string);
  const fileByEntry = new Map<string, { filename: string; sizeBytes: number }>();
  if (entryIds.length) {
    const { data: links } = await db
      .from("file_links")
      .select("entity_id, file_id, created_at")
      .eq("entity_type", "content_item")
      .eq("role", "attachment")
      .in("entity_id", entryIds)
      .order("created_at", { ascending: false });
    const fileIds = [...new Set((links ?? []).map((l) => l.file_id as string))];
    if (fileIds.length) {
      const { data: files } = await db
        .from("files")
        .select("id, filename, size_bytes")
        .in("id", fileIds)
        .is("archived_at", null);
      const liveFiles = new Map((files ?? []).map((f) => [f.id as string, f]));
      for (const link of links ?? []) {
        if (fileByEntry.has(link.entity_id as string)) continue; // newest live wins
        const file = liveFiles.get(link.file_id as string);
        if (file) {
          fileByEntry.set(link.entity_id as string, {
            filename: file.filename as string,
            sizeBytes: Number(file.size_bytes),
          });
        }
      }
    }
  }

  return (data ?? []).map((row) => {
    const attrs = (row.attributes ?? {}) as Record<string, unknown>;
    const body = row.body;
    const bodyText = Array.isArray(body)
      ? body
          .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text ?? "") : ""))
          .filter((t) => t.trim() !== "")
          .join("\n")
      : "";
    return {
      id: row.id,
      title: row.title,
      category: String(attrs.knowledge_category ?? ""),
      visaRoute: attrs.visa_route ? String(attrs.visa_route) : null,
      state: row.state === "published" ? "published" : "draft",
      version: row.version ?? 1,
      updatedAt: row.updated_at,
      bodyText,
      file: fileByEntry.get(row.id as string) ?? null,
    };
  });
}

export interface IntegrationState {
  key: "mail" | "whatsapp" | "meta" | "calendar" | "stripe";
  connected: boolean;
  detail: string | null;
}

export interface MailPipeState {
  /** The selected carrier — graph unless settings say gmail (Session 20). */
  provider: "graph" | "gmail";
  isOwner: boolean;
  graph: { carrierConfigured: boolean; mailbox: string | null };
  gmail: { carrierConfigured: boolean; mailbox: string | null };
}

/**
 * Session 20 — which pipe carries the firm's tenant email, and how far each
 * pipe's wiring has actually got: carrier env present (a boolean, never a
 * value) and the inbound mailbox binding from businesses.settings. Honest
 * state only — nothing here invents a connection.
 */
export async function getMailPipeState(): Promise<MailPipeState> {
  const { db, business, membershipRole } = await getAppContext();
  const { data: bizRow, error } = await db
    .from("businesses")
    .select("settings")
    .eq("id", business.id)
    .maybeSingle();
  if (error) throw new Error(`mail pipe settings query failed: ${error.message}`);
  const settings = (bizRow?.settings ?? {}) as Record<string, unknown>;
  const graphSettings = (settings.graph ?? {}) as Record<string, unknown>;
  const gmailSettings = (settings.gmail ?? {}) as Record<string, unknown>;
  return {
    provider: resolveMailProvider(settings),
    isOwner: membershipRole === "owner",
    graph: {
      carrierConfigured: readGraphEnv() !== null,
      mailbox: typeof graphSettings.mailbox === "string" ? graphSettings.mailbox : null,
    },
    gmail: {
      carrierConfigured: readGmailEnv() !== null,
      mailbox: typeof gmailSettings.mailbox === "string" ? gmailSettings.mailbox : null,
    },
  };
}

export interface ConversionsRowState {
  isOwner: boolean;
  enabled: boolean;
  datasetId: string | null;
  testEventCode: string | null;
  /** Env presence as a boolean, never a value (the s20 wiring-state law). */
  tokenPresent: boolean;
  /** Is the Lead Ads page binding in place (settings.meta.page_id)? */
  pageBound: boolean;
}

/**
 * Session 22 (WS1, ruling 1d) — the Conversions row's state, honestly read:
 * the toggle, the dataset id and test event code as stored, token presence
 * as a boolean, and whether the Session 10 page binding exists. Nothing here
 * invents a connection.
 */
export async function getConversionsState(): Promise<ConversionsRowState> {
  const { db, business, membershipRole } = await getAppContext();
  const { data: bizRow, error } = await db
    .from("businesses")
    .select("settings")
    .eq("id", business.id)
    .maybeSingle();
  if (error) throw new Error(`conversions settings query failed: ${error.message}`);
  const settings = (bizRow?.settings ?? {}) as Record<string, unknown>;
  const config = resolveConversionsConfig(settings);
  const meta = (settings.meta ?? {}) as Record<string, unknown>;
  return {
    isOwner: membershipRole === "owner",
    enabled: config.enabled,
    datasetId: config.dataset_id,
    testEventCode: config.test_event_code,
    tokenPresent: !!process.env.META_ACCESS_TOKEN,
    pageBound: typeof meta.page_id === "string" && meta.page_id !== "",
  };
}

/** Connection state, read the way the predicates read it: a live grant to an
 * INTEGRATION actor is a connection (decision 82); the Stripe actor exists
 * from signup. Never a fabricated state. */
export async function getIntegrationStates(): Promise<IntegrationState[]> {
  const { db, business } = await getAppContext();

  const { data: biz } = await db
    .from("businesses")
    .select("account_id")
    .eq("id", business.id)
    .maybeSingle();
  const { data: actors, error: actorError } = await db
    .from("actors")
    .select("id, display_name")
    .eq("account_id", biz?.account_id ?? "")
    .eq("actor_type", "integration")
    .is("archived_at", null);
  if (actorError) throw new Error(`integration actors query failed: ${actorError.message}`);
  const integrationIds = (actors ?? []).map((a) => a.id);

  const { data: grants, error: grantError } = integrationIds.length
    ? await db
        .from("grants")
        .select("tool, grantee_actor_id, expires_at")
        .eq("business_id", business.id)
        .in("grantee_actor_id", integrationIds)
        .is("revoked_at", null)
        .is("archived_at", null)
    : { data: [], error: null };
  if (grantError) throw new Error(`integration grants query failed: ${grantError.message}`);
  const liveTools = new Set(
    (grants ?? [])
      .filter((g) => !g.expires_at || new Date(g.expires_at) > new Date())
      .map((g) => g.tool)
  );
  const hasStripeActor = (actors ?? []).some((a) => a.display_name === "Stripe");

  return [
    { key: "mail", connected: liveTools.has("comms.email"), detail: null },
    { key: "whatsapp", connected: liveTools.has("comms.whatsapp"), detail: null },
    {
      key: "meta",
      connected: liveTools.has("enquiries"),
      detail: liveTools.has("enquiries") ? "lead forms map to contacts + enquiries" : null,
    },
    { key: "calendar", connected: false, detail: null },
    {
      key: "stripe",
      connected: hasStripeActor,
      detail: hasStripeActor ? "connected at signup — your plan payment created this actor" : null,
    },
  ];
}
