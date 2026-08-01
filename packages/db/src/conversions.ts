import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { emitEvent } from "./events";
import { CONVERSION_EVENT_KINDS } from "./event-kinds";
import { META_GRAPH_API_BASE } from "./whatsapp";

/**
 * The Meta Conversions loop — Session 22, WS1 (founder pre-rulings 1a–1e).
 *
 * Outcome events to Meta via the Conversions API, fired server-side from
 * stage_history writes (a tick-riding sweep plus the fire_conversion step
 * executor going real). The founder-ruled mapping, in one named place:
 *   consultation_booked → "Schedule"
 *   instructed          → "Purchase" (value ONLY when a money row records
 *                          the fee — an amount is never invented)
 *   disqualified/junk   → NOTHING (we do not teach Meta our triage)
 *
 * Isolation (1e): conversions fire only for engagements whose attribution
 * source is meta, and only for businesses whose Conversions toggle is ON
 * (settings.meta.conversions.enabled — default OFF until the founder flips
 * it). A send failure is a recorded, visible, retryable event and never
 * blocks the stage transition — the pipeline's truth outranks the ad
 * platform's feed.
 *
 * PII (1b): SHA-256 of normalised email/phone ONLY. Raw PII never leaves the
 * database; the payload recorded on The Record (meta.conversion_sent)
 * carries the hashed fields exactly as sent.
 */

/** The founder-ruled stage → CAPI event mapping (1a). Junk/disqualified is
 * deliberately ABSENT — nothing fires for triage outcomes. */
export const CONVERSION_STAGE_EVENTS: Record<string, "Schedule" | "Purchase"> = {
  consultation_booked: "Schedule",
  instructed: "Purchase",
};

/**
 * JUDGMENT: CAPI accepts events up to 7 days old — the sweep's lookback and
 * the retry ceiling are PROVIDER law (the decision 44/92 class: real time,
 * never TIME_SCALE data). Three visible failures retire a candidate; the
 * trail stays on The Record.
 */
export const CONVERSION_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_CONVERSION_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Config — one door (Settings → Integrations → Conversions row, 1d).
// ---------------------------------------------------------------------------

export interface ConversionsConfig {
  enabled: boolean;
  /** JUDGMENT (pre-flight flag 2): the CAPI destination — Meta dataset
   * (pixel) id. Config, not a credential; the pre-ruled surface named only
   * the toggle and test code, so the dataset id joins the same row as the
   * minimal additive fill. Absent = fail closed with the reason visible. */
  dataset_id: string | null;
  /** Meta's test_event_code passthrough — Events Manager test stream. */
  test_event_code: string | null;
}

export function resolveConversionsConfig(settings: Record<string, unknown> | null | undefined): ConversionsConfig {
  const meta = (settings?.meta ?? {}) as Record<string, unknown>;
  const conv = (meta.conversions ?? {}) as Record<string, unknown>;
  return {
    enabled: conv.enabled === true,
    dataset_id: typeof conv.dataset_id === "string" && conv.dataset_id.trim() !== "" ? conv.dataset_id.trim() : null,
    test_event_code:
      typeof conv.test_event_code === "string" && conv.test_event_code.trim() !== ""
        ? conv.test_event_code.trim()
        : null,
  };
}

// ---------------------------------------------------------------------------
// PII hashing — pure, per Meta's CAPI normalisation rules (1b).
// ---------------------------------------------------------------------------

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Meta email norm: trimmed, lowercased. */
export function normaliseEmailForHash(email: string): string {
  return email.trim().toLowerCase();
}

/** Meta phone norm: digits only, with country code, no leading zeros or
 * symbols — E.164 minus the plus. */
export function normalisePhoneForHash(phone: string): string {
  return phone.replace(/[^\d]/g, "").replace(/^0+/, "");
}

export interface ConversionUserData {
  /** Meta's leadgen id — the CRM-integration match key (stored on the
   * engagement at ingest; never inferred). */
  lead_id?: number;
  em?: string[];
  ph?: string[];
}

/**
 * Build the user_data block: hashed em/ph only, plus the leadgen id.
 *
 * JUDGMENT: CAPI's lead_id is an int64; JSON numbers are exact only to 2^53.
 * Leadgen ids observed are ~15 digits (safe), but the id is included ONLY
 * when it round-trips exactly through Number — otherwise it is omitted and
 * matching rides the hashed fields alone. Precision loss would silently
 * mis-attribute; omission is honest.
 */
export function buildConversionUserData(input: {
  leadgen_id: string | null;
  email: string | null;
  phone: string | null;
}): ConversionUserData {
  const userData: ConversionUserData = {};
  if (input.leadgen_id && String(Number(input.leadgen_id)) === input.leadgen_id) {
    userData.lead_id = Number(input.leadgen_id);
  }
  if (input.email && input.email.trim() !== "") {
    userData.em = [sha256Hex(normaliseEmailForHash(input.email))];
  }
  if (input.phone && input.phone.trim() !== "") {
    userData.ph = [sha256Hex(normalisePhoneForHash(input.phone))];
  }
  return userData;
}

// ---------------------------------------------------------------------------
// Candidate selection — pure (the harness proves the ruled mapping here).
// ---------------------------------------------------------------------------

export interface StageMoveFact {
  stage_history_id: string;
  engagement_id: string;
  /** The landed stage's KEY (semantic set). */
  to_stage_key: string;
  moved_at: string;
}

export interface EngagementConversionFacts {
  engagement_id: string;
  /** attribution.source — only "meta" engagements convert (1e). */
  source: string | null;
  leadgen_id: string | null;
  email: string | null;
  phone: string | null;
  /** The recorded fee: the engagement's newest live money row, if any. */
  invoice: { total: number; currency: string } | null;
}

export interface ConversionCandidate {
  stage_history_id: string;
  engagement_id: string;
  event_name: "Schedule" | "Purchase";
  event_time_unix: number;
  user_data: ConversionUserData;
  custom_data: Record<string, unknown>;
}

/**
 * Which stage moves owe Meta an event — pure. Everything the rulings exclude
 * is excluded HERE, so the smokes prove the law at one seam:
 *   - only the ruled stage keys (junk/disqualified structurally absent);
 *   - only meta-sourced engagements (1e);
 *   - toggle OFF yields nothing (1e);
 *   - already-sent stage moves never fire twice;
 *   - MAX_CONVERSION_ATTEMPTS visible failures retire a candidate;
 *   - Purchase carries value ONLY when a money row exists (1a).
 */
export function selectConversionCandidates(input: {
  config: ConversionsConfig;
  moves: StageMoveFact[];
  facts: Map<string, EngagementConversionFacts>;
  sentStageHistoryIds: Set<string>;
  failedAttempts: Map<string, number>;
  now: Date;
}): ConversionCandidate[] {
  if (!input.config.enabled) return [];
  const candidates: ConversionCandidate[] = [];
  for (const move of input.moves) {
    const eventName = CONVERSION_STAGE_EVENTS[move.to_stage_key];
    if (!eventName) continue;
    if (input.sentStageHistoryIds.has(move.stage_history_id)) continue;
    if ((input.failedAttempts.get(move.stage_history_id) ?? 0) >= MAX_CONVERSION_ATTEMPTS) continue;
    const movedAt = new Date(move.moved_at).getTime();
    if (Number.isNaN(movedAt) || input.now.getTime() - movedAt > CONVERSION_LOOKBACK_MS) continue;

    const fact = input.facts.get(move.engagement_id);
    if (!fact) continue;
    if (fact.source !== "meta") continue;

    const userData = buildConversionUserData({
      leadgen_id: fact.leadgen_id,
      email: fact.email,
      phone: fact.phone,
    });
    // No match key at all = nothing to send that Meta could attribute.
    if (userData.lead_id === undefined && !userData.em && !userData.ph) continue;

    // Meta's CRM-integration envelope: these two custom_data keys tell Events
    // Manager the event came from a CRM working lead ads.
    const customData: Record<string, unknown> = { event_source: "crm", lead_event_source: "Barakah" };
    if (eventName === "Purchase" && fact.invoice) {
      customData.value = fact.invoice.total;
      customData.currency = fact.invoice.currency;
    }

    candidates.push({
      stage_history_id: move.stage_history_id,
      engagement_id: move.engagement_id,
      event_name: eventName,
      event_time_unix: Math.floor(movedAt / 1000),
      user_data: userData,
      custom_data: customData,
    });
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// The CAPI payload and sender.
// ---------------------------------------------------------------------------

export interface ConversionEventPayload {
  data: Array<{
    event_name: string;
    event_time: number;
    /** The stage_history id — CAPI's dedup key and ours. */
    event_id: string;
    action_source: "system_generated";
    user_data: ConversionUserData;
    custom_data: Record<string, unknown>;
  }>;
  test_event_code?: string;
}

export function buildConversionPayload(
  candidate: ConversionCandidate,
  testEventCode: string | null
): ConversionEventPayload {
  return {
    data: [
      {
        event_name: candidate.event_name,
        event_time: candidate.event_time_unix,
        event_id: candidate.stage_history_id,
        action_source: "system_generated",
        user_data: candidate.user_data,
        custom_data: candidate.custom_data,
      },
    ],
    ...(testEventCode ? { test_event_code: testEventCode } : {}),
  };
}

const TIMEOUT_MS = 15_000;

export type ConversionFetch = (url: string, init: RequestInit) => Promise<Response>;

/** POST one event to the dataset's /events edge. Throws with the provider's
 * reason on refusal — the caller records the visible failure. */
export async function sendConversionEvent(input: {
  datasetId: string;
  accessToken: string;
  payload: ConversionEventPayload;
  fetchFn?: ConversionFetch;
}): Promise<{ events_received: number | null; fbtrace_id: string | null }> {
  const doFetch = input.fetchFn ?? (fetch as ConversionFetch);
  const response = await doFetch(`${META_GRAPH_API_BASE}/${encodeURIComponent(input.datasetId)}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...input.payload, access_token: input.accessToken }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as {
    events_received?: number;
    fbtrace_id?: string;
    error?: { message?: string; type?: string; code?: number };
  };
  if (!response.ok) {
    throw new Error(`Meta Conversions API refused the event (${response.status}): ${body.error?.message ?? "unknown error"}`);
  }
  return { events_received: body.events_received ?? null, fbtrace_id: body.fbtrace_id ?? null };
}

// ---------------------------------------------------------------------------
// The sweep — thin glue over the pure seams; rides the 5-minute tick.
// ---------------------------------------------------------------------------

export interface ConversionsSweepReport {
  businesses_scanned: number;
  conversions_sent: number;
  conversions_failed: number;
  skipped: string[];
  errors: string[];
}

async function q<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return (data ?? ([] as unknown)) as T;
}

interface ConversionBusiness {
  id: string;
  account_id: string;
  config: ConversionsConfig;
  workflow_actor_id: string;
}

/** Businesses with the toggle ON, each with its workflow actor (decision 93:
 * carriage attribution — firing outcome signals is platform automation). */
async function loadConversionBusinesses(db: SupabaseClient, report: { errors: string[] }): Promise<ConversionBusiness[]> {
  const rows = await q<{ id: string; account_id: string; settings: Record<string, unknown> | null }[]>(
    db
      .from("businesses")
      .select("id, account_id, settings")
      .eq("settings->meta->conversions->>enabled", "true")
      .is("archived_at", null),
    "conversions business scan"
  );
  const out: ConversionBusiness[] = [];
  for (const row of rows) {
    const actors = await q<{ id: string }[]>(
      db
        .from("actors")
        .select("id")
        .eq("account_id", row.account_id)
        .eq("actor_type", "workflow")
        .is("archived_at", null),
      "workflow actor lookup"
    );
    if (actors.length !== 1) {
      report.errors.push(`business ${row.id}: expected exactly one workflow actor, saw ${actors.length} — conversions skipped`);
      continue;
    }
    out.push({
      id: row.id,
      account_id: row.account_id,
      config: resolveConversionsConfig(row.settings),
      workflow_actor_id: actors[0]!.id,
    });
  }
  return out;
}

function leadgenIdFromRefs(refs: unknown): string | null {
  if (!Array.isArray(refs)) return null;
  for (const ref of refs) {
    if (ref && typeof ref === "object" && (ref as { system?: string }).system === "meta") {
      const id = (ref as { external_id?: unknown }).external_id;
      if (typeof id === "string" && id !== "") return id;
    }
  }
  return null;
}

/** Gather the per-engagement facts the pure selector needs. Egress-slim:
 * only the columns the payload uses; raw PII stays in process memory and is
 * hashed before anything leaves. */
async function loadEngagementFacts(
  db: SupabaseClient,
  businessId: string,
  engagementIds: string[]
): Promise<Map<string, EngagementConversionFacts>> {
  const facts = new Map<string, EngagementConversionFacts>();
  if (engagementIds.length === 0) return facts;

  const engagements = await q<
    { id: string; attribution: Record<string, unknown> | null; external_refs: unknown }[]
  >(
    db
      .from("engagements")
      .select("id, attribution, external_refs")
      .eq("business_id", businessId)
      .in("id", engagementIds),
    "engagement facts"
  );

  const participants = await q<{ engagement_id: string; contact_id: string }[]>(
    db
      .from("engagement_participants")
      .select("engagement_id, contact_id")
      .eq("business_id", businessId)
      .in("engagement_id", engagementIds)
      .eq("role", "client")
      .is("archived_at", null),
    "participant lookup"
  );
  const contactOf = new Map(participants.map((p) => [p.engagement_id, p.contact_id]));

  const contactIds = [...new Set(participants.map((p) => p.contact_id))];
  const channels = contactIds.length
    ? await q<{ contact_id: string; channel: string; value: string }[]>(
        db
          .from("contact_channels")
          .select("contact_id, channel, value")
          .eq("business_id", businessId)
          .in("contact_id", contactIds)
          .in("channel", ["email", "phone"])
          .is("archived_at", null),
        "channel lookup"
      )
    : [];
  const channelOf = new Map<string, { email: string | null; phone: string | null }>();
  for (const ch of channels) {
    const entry = channelOf.get(ch.contact_id) ?? { email: null, phone: null };
    if (ch.channel === "email" && !entry.email) entry.email = ch.value;
    if (ch.channel === "phone" && !entry.phone) entry.phone = ch.value;
    channelOf.set(ch.contact_id, entry);
  }

  // The recorded fee (1a): the engagement's newest LIVE money row — an
  // invoice actually raised (issued or beyond), never draft musings.
  // JUDGMENT: "the engagement's recorded fee if a money row exists" read as
  // the newest non-draft, non-void invoice's total; value_estimate is NOT a
  // money row and never substitutes.
  const invoices = await q<
    { engagement_id: string; total: number; currency: string; created_at: string; status: string }[]
  >(
    db
      .from("invoices")
      .select("engagement_id, total, currency, created_at, status")
      .eq("business_id", businessId)
      .in("engagement_id", engagementIds)
      .in("status", ["issued", "paid", "partially_paid", "overdue"])
      .is("archived_at", null)
      .order("created_at", { ascending: false }),
    "invoice lookup"
  );
  const invoiceOf = new Map<string, { total: number; currency: string }>();
  for (const inv of invoices) {
    if (!invoiceOf.has(inv.engagement_id)) {
      invoiceOf.set(inv.engagement_id, { total: Number(inv.total), currency: inv.currency });
    }
  }

  for (const e of engagements) {
    const contactId = contactOf.get(e.id);
    const contact = contactId ? channelOf.get(contactId) : undefined;
    facts.set(e.id, {
      engagement_id: e.id,
      source: typeof e.attribution?.source === "string" ? (e.attribution.source as string) : null,
      leadgen_id: leadgenIdFromRefs(e.external_refs),
      email: contact?.email ?? null,
      phone: contact?.phone ?? null,
      invoice: invoiceOf.get(e.id) ?? null,
    });
  }
  return facts;
}

/** Fire everything owed for one business — shared by the sweep and the
 * fire_conversion step executor. Failures are recorded, visible and
 * retryable; nothing here ever throws past a single candidate. */
async function fireOwedConversions(
  db: SupabaseClient,
  business: ConversionBusiness,
  moves: StageMoveFact[],
  options: { fetchFn?: ConversionFetch; env?: NodeJS.ProcessEnv; now?: Date },
  report: ConversionsSweepReport
): Promise<void> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const accessToken = env.META_ACCESS_TOKEN;
  if (!accessToken) {
    report.skipped.push(`business ${business.id}: META_ACCESS_TOKEN is not configured — conversions cannot send`);
    return;
  }
  if (!business.config.dataset_id) {
    report.skipped.push(
      `business ${business.id}: no Meta dataset id configured on the Conversions row — events have no destination`
    );
    return;
  }
  if (moves.length === 0) return;

  const historyIds = moves.map((m) => m.stage_history_id);
  const sentEvents = await q<{ payload: Record<string, unknown> }[]>(
    db
      .from("events")
      .select("payload")
      .eq("business_id", business.id)
      .eq("action", CONVERSION_EVENT_KINDS.conversionSent)
      .in("payload->>stage_history_id", historyIds),
    "sent-conversion dedup lookup"
  );
  const sentIds = new Set(sentEvents.map((e) => String(e.payload?.stage_history_id)));

  const failedEvents = await q<{ payload: Record<string, unknown> }[]>(
    db
      .from("events")
      .select("payload")
      .eq("business_id", business.id)
      .eq("action", CONVERSION_EVENT_KINDS.conversionSendFailed)
      .in("payload->>stage_history_id", historyIds),
    "failed-conversion attempt lookup"
  );
  const failedAttempts = new Map<string, number>();
  for (const e of failedEvents) {
    const id = String(e.payload?.stage_history_id);
    failedAttempts.set(id, (failedAttempts.get(id) ?? 0) + 1);
  }

  const facts = await loadEngagementFacts(db, business.id, [...new Set(moves.map((m) => m.engagement_id))]);
  const candidates = selectConversionCandidates({
    config: business.config,
    moves,
    facts,
    sentStageHistoryIds: sentIds,
    failedAttempts,
    now,
  });

  for (const candidate of candidates) {
    const payload = buildConversionPayload(candidate, business.config.test_event_code);
    try {
      const result = await sendConversionEvent({
        datasetId: business.config.dataset_id,
        accessToken,
        payload,
        fetchFn: options.fetchFn,
      });
      // The Record carries the payload AS SENT — hashed fields, never raw
      // PII (1b). The access token is not part of the recorded payload.
      await emitEvent(db, {
        business_id: business.id,
        actor_id: business.workflow_actor_id,
        action: CONVERSION_EVENT_KINDS.conversionSent,
        entity_type: "engagement",
        entity_id: candidate.engagement_id,
        payload: {
          stage_history_id: candidate.stage_history_id,
          event_name: candidate.event_name,
          payload_sent: payload,
          events_received: result.events_received,
          fbtrace_id: result.fbtrace_id,
          ...(business.config.test_event_code ? { test_event_code: business.config.test_event_code } : {}),
        },
      });
      report.conversions_sent += 1;
    } catch (err) {
      const attempt = (failedAttempts.get(candidate.stage_history_id) ?? 0) + 1;
      await emitEvent(db, {
        business_id: business.id,
        actor_id: business.workflow_actor_id,
        action: CONVERSION_EVENT_KINDS.conversionSendFailed,
        entity_type: "engagement",
        entity_id: candidate.engagement_id,
        payload: {
          stage_history_id: candidate.stage_history_id,
          event_name: candidate.event_name,
          reason: err instanceof Error ? err.message : String(err),
          attempt,
          retryable: attempt < MAX_CONVERSION_ATTEMPTS,
        },
      });
      report.conversions_failed += 1;
    }
  }
}

/**
 * The tick-riding sweep: every stage_history row inside the lookback that
 * landed on a ruled stage, for every toggle-on business. Fires what is owed
 * and not yet sent; retries what visibly failed (under the attempt ceiling).
 * The stage transition itself is long done — nothing here can block it.
 */
export async function sweepConversions(
  db: SupabaseClient,
  options: { fetchFn?: ConversionFetch; env?: NodeJS.ProcessEnv; now?: Date } = {}
): Promise<ConversionsSweepReport> {
  const report: ConversionsSweepReport = {
    businesses_scanned: 0,
    conversions_sent: 0,
    conversions_failed: 0,
    skipped: [],
    errors: [],
  };
  const now = options.now ?? new Date();

  let businesses: ConversionBusiness[];
  try {
    businesses = await loadConversionBusinesses(db, report);
  } catch (err) {
    report.errors.push(err instanceof Error ? err.message : String(err));
    return report;
  }

  for (const business of businesses) {
    report.businesses_scanned += 1;
    try {
      const stages = await q<{ id: string; key: string }[]>(
        db
          .from("stage_definitions")
          .select("id, key")
          .eq("business_id", business.id)
          .in("key", Object.keys(CONVERSION_STAGE_EVENTS))
          .is("archived_at", null),
        "ruled stage lookup"
      );
      if (stages.length === 0) continue;
      const keyOf = new Map(stages.map((s) => [s.id, s.key]));

      const since = new Date(now.getTime() - CONVERSION_LOOKBACK_MS).toISOString();
      const history = await q<{ id: string; engagement_id: string; to_stage: string; moved_at: string }[]>(
        db
          .from("stage_history")
          .select("id, engagement_id, to_stage, moved_at")
          .eq("business_id", business.id)
          .in("to_stage", stages.map((s) => s.id))
          .gte("moved_at", since)
          .order("moved_at", { ascending: true })
          .limit(200),
        "stage history scan"
      );
      const moves: StageMoveFact[] = history.map((h) => ({
        stage_history_id: h.id,
        engagement_id: h.engagement_id,
        to_stage_key: keyOf.get(h.to_stage) ?? "",
        moved_at: h.moved_at,
      }));
      await fireOwedConversions(db, business, moves, options, report);
    } catch (err) {
      report.errors.push(`business ${business.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return report;
}

/**
 * The fire_conversion step's real arm (the Session 6 STUB retires): fire
 * whatever this one engagement is owed, immediately. Provider failures are
 * recorded and retried by the sweep — the run is NEVER blocked by the ad
 * platform (1e). Returns what happened so the step outcome is honest.
 */
export async function fireEngagementConversions(
  db: SupabaseClient,
  input: {
    business_id: string;
    engagement_id: string;
    fetchFn?: ConversionFetch;
    env?: NodeJS.ProcessEnv;
    now?: Date;
  }
): Promise<{ enabled: boolean; sent: number; failed: number; skipped: string[] }> {
  const report: ConversionsSweepReport = {
    businesses_scanned: 0,
    conversions_sent: 0,
    conversions_failed: 0,
    skipped: [],
    errors: [],
  };
  const rows = await q<{ id: string; account_id: string; settings: Record<string, unknown> | null }[]>(
    db.from("businesses").select("id, account_id, settings").eq("id", input.business_id).limit(1),
    "business lookup"
  );
  if (!rows[0]) throw new Error(`Business ${input.business_id} not found`);
  const config = resolveConversionsConfig(rows[0].settings);
  if (!config.enabled) {
    return { enabled: false, sent: 0, failed: 0, skipped: ["conversions are OFF for this business"] };
  }
  const actors = await q<{ id: string }[]>(
    db
      .from("actors")
      .select("id")
      .eq("account_id", rows[0].account_id)
      .eq("actor_type", "workflow")
      .is("archived_at", null),
    "workflow actor lookup"
  );
  if (actors.length !== 1) {
    throw new Error(`Business ${input.business_id} needs exactly one workflow actor (saw ${actors.length})`);
  }
  const business: ConversionBusiness = {
    id: rows[0].id,
    account_id: rows[0].account_id,
    config,
    workflow_actor_id: actors[0]!.id,
  };

  const stages = await q<{ id: string; key: string }[]>(
    db
      .from("stage_definitions")
      .select("id, key")
      .eq("business_id", business.id)
      .in("key", Object.keys(CONVERSION_STAGE_EVENTS))
      .is("archived_at", null),
    "ruled stage lookup"
  );
  const keyOf = new Map(stages.map((s) => [s.id, s.key]));
  const history = stages.length
    ? await q<{ id: string; engagement_id: string; to_stage: string; moved_at: string }[]>(
        db
          .from("stage_history")
          .select("id, engagement_id, to_stage, moved_at")
          .eq("business_id", business.id)
          .eq("engagement_id", input.engagement_id)
          .in("to_stage", stages.map((s) => s.id))
          .order("moved_at", { ascending: true }),
        "stage history lookup"
      )
    : [];
  const moves: StageMoveFact[] = history.map((h) => ({
    stage_history_id: h.id,
    engagement_id: h.engagement_id,
    to_stage_key: keyOf.get(h.to_stage) ?? "",
    moved_at: h.moved_at,
  }));
  await fireOwedConversions(db, business, moves, { fetchFn: input.fetchFn, env: input.env, now: input.now }, report);
  return {
    enabled: true,
    sent: report.conversions_sent,
    failed: report.conversions_failed,
    skipped: report.skipped,
  };
}

// ---------------------------------------------------------------------------
// spend_records' first producer — the daily ad-spend pull (1c).
// ---------------------------------------------------------------------------

/** Classify a Marketing API error: a missing ads_read scope is the ruled
 * fail-closed skip, named. Pure — the harness proves the classification. */
export function classifyMetaSpendError(error: { message?: string; type?: string; code?: number } | undefined): {
  missing_scope: boolean;
  reason: string;
} {
  const message = error?.message ?? "unknown error";
  const missingScope =
    error?.type === "OAuthException" &&
    (/ads_read|ads_management/i.test(message) ||
      error?.code === 200 ||
      error?.code === 10 ||
      error?.code === 272 ||
      error?.code === 294);
  return {
    missing_scope: missingScope,
    reason: missingScope
      ? `META_ACCESS_TOKEN lacks the ads_read scope (Marketing API said: ${message}) — the daily spend pull is skipped; grant ads_read to the system-user token (GO-LIVE)`
      : message,
  };
}

/** The UTC calendar day covering `now - 1 day` — the finalized day the daily
 * pull records. JUDGMENT: pull cadence is infrastructure (UTC-dated, real
 * time), not workflow-timer data. */
export function spendPullWindow(now: Date): { since: string; until: string } {
  const day = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { since: day, until: day };
}

export interface SpendPullReport {
  businesses_scanned: number;
  campaigns_pulled: number;
  rows_inserted: number;
  skipped: string[];
  errors: string[];
}

/**
 * Once per UTC day per toggle-on business: pull yesterday's spend per
 * campaign (the campaign ids the business's own engagements attribute to)
 * and mirror it into spend_records (source meta_ads). Fail-closed: a token
 * without ads_read records ONE visible skip event naming the scope and
 * stands down until tomorrow. Idempotent on (campaign, period).
 *
 * JUDGMENT: the pull is gated by the same Conversions toggle — one switch
 * governs the whole Meta feedback loop, and nothing new runs against Meta
 * until the founder flips it.
 */
export async function pullMetaSpend(
  db: SupabaseClient,
  options: { fetchFn?: ConversionFetch; env?: NodeJS.ProcessEnv; now?: Date } = {}
): Promise<SpendPullReport> {
  const report: SpendPullReport = {
    businesses_scanned: 0,
    campaigns_pulled: 0,
    rows_inserted: 0,
    skipped: [],
    errors: [],
  };
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const doFetch = options.fetchFn ?? (fetch as ConversionFetch);

  let businesses: ConversionBusiness[];
  try {
    businesses = await loadConversionBusinesses(db, report);
  } catch (err) {
    report.errors.push(err instanceof Error ? err.message : String(err));
    return report;
  }
  if (businesses.length === 0) return report;

  const accessToken = env.META_ACCESS_TOKEN;
  const startOfDayUtc = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;

  for (const business of businesses) {
    report.businesses_scanned += 1;
    try {
      // The daily gate: one pull (or one visible skip) per UTC day.
      const today = await q<{ id: string }[]>(
        db
          .from("events")
          .select("id")
          .eq("business_id", business.id)
          .in("action", [CONVERSION_EVENT_KINDS.spendPulled, CONVERSION_EVENT_KINDS.spendPullSkipped])
          .gte("occurred_at", startOfDayUtc)
          .limit(1),
        "daily gate lookup"
      );
      if (today.length > 0) continue;

      if (!accessToken) {
        report.skipped.push(`business ${business.id}: META_ACCESS_TOKEN is not configured — spend pull skipped`);
        continue;
      }

      // The integration actor writes mirrored external data (decision 7's
      // lane: the Meta integration creates Level 2 rows under its grant).
      const integrations = await q<{ id: string }[]>(
        db
          .from("actors")
          .select("id")
          .eq("account_id", business.account_id)
          .eq("actor_type", "integration")
          .is("archived_at", null),
        "integration actor lookup"
      );
      if (integrations.length !== 1) {
        report.errors.push(
          `business ${business.id}: expected exactly one integration actor, saw ${integrations.length} — spend pull skipped`
        );
        continue;
      }
      const integrationActor = integrations[0]!.id;

      const attributed = await q<{ campaign_id: string | null }[]>(
        db
          .from("engagements")
          .select("campaign_id:attribution->>campaign_id")
          .eq("business_id", business.id)
          .eq("attribution->>source", "meta")
          .not("attribution->>campaign_id", "is", null),
        "campaign attribution scan"
      );
      const campaignIds = [...new Set(attributed.map((r) => r.campaign_id).filter((c): c is string => !!c))];
      if (campaignIds.length === 0) {
        await emitEvent(db, {
          business_id: business.id,
          actor_id: integrationActor,
          action: CONVERSION_EVENT_KINDS.spendPulled,
          entity_type: "business",
          entity_id: business.id,
          payload: { campaigns: 0, rows: 0, note: "no meta-attributed campaigns on file yet" },
        });
        continue;
      }

      const window = spendPullWindow(now);
      let scopeSkip: string | null = null;
      let rowsInserted = 0;
      let campaignsPulled = 0;

      for (const campaignId of campaignIds) {
        const url =
          `${META_GRAPH_API_BASE}/${encodeURIComponent(campaignId)}/insights` +
          `?fields=spend,account_currency,date_start,date_stop` +
          `&time_range=${encodeURIComponent(JSON.stringify(window))}` +
          `&access_token=${encodeURIComponent(accessToken)}`;
        const response = await doFetch(url, { method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS) });
        const body = (await response.json().catch(() => ({}))) as {
          data?: Array<{ spend?: string; account_currency?: string; date_start?: string; date_stop?: string }>;
          error?: { message?: string; type?: string; code?: number };
        };
        if (!response.ok || body.error) {
          const classified = classifyMetaSpendError(body.error);
          if (classified.missing_scope) {
            scopeSkip = classified.reason;
            break; // one scope failure covers the token — stop asking.
          }
          report.errors.push(`business ${business.id} campaign ${campaignId}: ${classified.reason}`);
          continue;
        }
        campaignsPulled += 1;
        for (const row of body.data ?? []) {
          if (!row.spend || Number(row.spend) === 0) continue;
          const periodStart = row.date_start ?? window.since;
          const periodEnd = row.date_stop ?? window.until;
          // Idempotency on (campaign, period): the mirrored fact lands once.
          const existing = await q<{ id: string }[]>(
            db
              .from("spend_records")
              .select("id")
              .eq("business_id", business.id)
              .eq("source", "meta_ads")
              .eq("campaign_id", campaignId)
              .eq("period_start", periodStart)
              .eq("period_end", periodEnd)
              .is("archived_at", null)
              .limit(1),
            "spend idempotency lookup"
          );
          if (existing.length > 0) continue;
          await q(
            db
              .from("spend_records")
              .insert({
                business_id: business.id,
                created_by: integrationActor,
                source: "meta_ads",
                campaign_id: campaignId,
                period_start: periodStart,
                period_end: periodEnd,
                amount: Number(row.spend),
                currency: row.account_currency ?? "GBP",
              })
              .select("id"),
            "spend insert"
          );
          rowsInserted += 1;
        }
      }

      if (scopeSkip) {
        await emitEvent(db, {
          business_id: business.id,
          actor_id: integrationActor,
          action: CONVERSION_EVENT_KINDS.spendPullSkipped,
          entity_type: "business",
          entity_id: business.id,
          payload: { reason: scopeSkip, missing_scope: "ads_read" },
        });
        report.skipped.push(`business ${business.id}: ${scopeSkip}`);
        continue;
      }

      await emitEvent(db, {
        business_id: business.id,
        actor_id: integrationActor,
        action: CONVERSION_EVENT_KINDS.spendPulled,
        entity_type: "business",
        entity_id: business.id,
        payload: { campaigns: campaignsPulled, rows: rowsInserted, period: window },
      });
      report.campaigns_pulled += campaignsPulled;
      report.rows_inserted += rowsInserted;
    } catch (err) {
      report.errors.push(`business ${business.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return report;
}
