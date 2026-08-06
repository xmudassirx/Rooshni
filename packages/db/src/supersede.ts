import type { SupabaseClient } from "@supabase/supabase-js";
import { scaleDurationMs } from "@rooshni/config";
import { emitEvent } from "./events";
import { DRAFTING_EVENT_KINDS, INBOUND_EVENT_KINDS, RETURNING_MARKER_KIND } from "./event-kinds";
import { contactReceivedAnyAttachment } from "./route-guides";
import { resolveEngagementRoute } from "./routes";
import {
  composeReplyDraft,
  composeWithRegisterRetry,
  isTransientProviderError,
  retrieveKnowledgeEntries,
  type ClassifyFn,
  type ComposeDraftResult,
  type ComposeReplyInput,
  type GenerateFn,
  type ThreadMessage,
} from "./drafting";
import type { FormAnswer } from "./meta";
import { assessAiBudget, guardGenerationBudget, maybeEmitSoftCapCrossed } from "./ai-budget";
import { priceGeneration } from "./model-router";
import { loadMemoryContext, resolveBookingUrlWithMemory, resolveSignOffWithMemory } from "./memory";
import { plainTextOfBody } from "./email-html";

/**
 * The settle window and the supersede engine, app side (Session 16, PR-B/C/D;
 * decision 133). The database (0030) holds the laws — one pending per
 * engagement per channel, superseded is terminal, the clock inherits through
 * the service-only pipeline; this module is the cron-evaluated behaviour:
 * arm the settle timer on each inbound (restarting per message in a burst),
 * and when a thread settles, produce ONE reply draft against the full thread
 * context — superseding the old pending draft when one exists.
 *
 * Settle windows are product timers: durations only via timeScale() (law
 * 11). The WhatsApp 24h service window is provider law and is NOT here.
 */

/** The lawful business-level settle options, in minutes (decision 133b). */
export const SETTLE_WINDOW_MINUTES_OPTIONS = [0, 1, 3, 5] as const;
export const SETTLE_WINDOW_DEFAULT_MINUTES = 3;

/** The business setting (businesses.settings.draft_settle_minutes) resolved
 * against the lawful options — an unlawful or absent value is the default. */
export function resolveSettleMinutes(settings: Record<string, unknown> | null | undefined): number {
  const raw = settings?.draft_settle_minutes;
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return (SETTLE_WINDOW_MINUTES_OPTIONS as readonly number[]).includes(n) ? n : SETTLE_WINDOW_DEFAULT_MINUTES;
}

/** The effective settle duration for a thread, REAL milliseconds before
 * scaling: the per-conversation override wins when set (0 = instant). */
export function resolveSettleRealMs(
  businessSettings: Record<string, unknown> | null | undefined,
  threadOverrideSeconds: number | null | undefined
): number {
  if (typeof threadOverrideSeconds === "number" && threadOverrideSeconds >= 0) {
    return threadOverrideSeconds * 1000;
  }
  return resolveSettleMinutes(businessSettings) * 60 * 1000;
}

/**
 * The settle clock RESTARTS on every inbound in a burst (decision 133b):
 * whatever was pending, the new due moment is now + the window. Pure — the
 * smoke tests prove the restart without a database.
 */
export function nextSettleDueAt(now: Date, settleRealMs: number): string {
  return new Date(now.getTime() + scaleDurationMs(settleRealMs)).toISOString();
}

/** Arm (or restart) the settle timer on a thread after an inbound landed.
 * Durable server-side state — the cron evaluates it; nothing client-side. */
export async function armSettleTimer(
  db: SupabaseClient,
  threadId: string,
  now: Date = new Date()
): Promise<string | null> {
  const { data: threads, error } = await db
    .from("comm_threads")
    .select("id, business_id, settle_override_seconds")
    .eq("id", threadId)
    .limit(1);
  if (error) throw new Error(`settle arm: thread lookup failed: ${error.message}`);
  const thread = threads?.[0];
  if (!thread) return null;
  const { data: businesses, error: bizError } = await db
    .from("businesses")
    .select("settings")
    .eq("id", thread.business_id)
    .limit(1);
  if (bizError) throw new Error(`settle arm: business lookup failed: ${bizError.message}`);
  const dueAt = nextSettleDueAt(now, resolveSettleRealMs(businesses?.[0]?.settings ?? {}, thread.settle_override_seconds));
  const { error: updError } = await db.from("comm_threads").update({ draft_settle_due_at: dueAt }).eq("id", threadId);
  if (updError) throw new Error(`settle arm failed: ${updError.message}`);
  return dueAt;
}

/** "Ask Light to draft" (decision 133d): the manual trigger bypasses the
 * remaining settle wait by pulling the due moment to NOW; the caller then
 * runs the sweep for this thread inline. */
export async function requestThreadDraftNow(db: SupabaseClient, threadId: string): Promise<void> {
  const { error } = await db
    .from("comm_threads")
    .update({ draft_settle_due_at: new Date().toISOString() })
    .eq("id", threadId);
  if (error) throw new Error(`draft-now request failed: ${error.message}`);
}

export interface SettleSweepReport {
  threads_evaluated: number;
  drafts_created: number;
  superseded: number;
  markers_evented: number;
  skipped: number;
  errors: string[];
}

async function q<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return (data ?? ([] as unknown)) as T;
}

interface ThreadFacts {
  id: string;
  business_id: string;
  contact_id: string;
  engagement_id: string | null;
  channel: string;
  subject: string | null;
  auto_draft_paused: boolean;
  last_inbound_at: string | null;
}

/** The business's Light agent actor — the drafter for thread-born drafts
 * (workflow drafts carry theirs in run context; Conversations drafting has
 * no run). Exactly one agent actor per account, the integration/workflow
 * actor precedent: ambiguity is a loud failure. */
async function resolveLightActor(db: SupabaseClient, businessId: string): Promise<string> {
  const businesses = await q<{ account_id: string }[]>(
    db.from("businesses").select("account_id").eq("id", businessId).limit(1),
    "business lookup"
  );
  if (!businesses[0]) throw new Error(`Business ${businessId} not found`);
  const agents = await q<{ id: string }[]>(
    db
      .from("actors")
      .select("id")
      .eq("account_id", businesses[0].account_id)
      .eq("actor_type", "agent")
      .is("archived_at", null),
    "agent actor lookup"
  );
  if (agents.length !== 1) {
    throw new Error(`Business ${businessId} holds ${agents.length} agent actors — exactly one Light is required`);
  }
  return agents[0]!.id;
}

/**
 * Put unevented supersede transitions on The Record (law 11: SQL never
 * writes the ledger — the 0030 trigger and migration normalisation leave a
 * needs_event marker; every path that can see one events it and clears the
 * flag). Attribution: the superseding communication's author when known
 * (the human who replied), else the drafter of the superseded row.
 */
export async function sweepUneventedSupersedes(
  db: SupabaseClient,
  options: { threadId?: string } = {}
): Promise<{ evented: number; errors: string[] }> {
  const out = { evented: 0, errors: [] as string[] };
  let query = db
    .from("communications")
    .select("id, business_id, thread_id, created_by, drafted_by_actor_id, attributes")
    .eq("status", "superseded")
    .eq("attributes->superseded->>needs_event", "true");
  if (options.threadId) query = query.eq("thread_id", options.threadId);
  const rows = await q<
    { id: string; business_id: string; thread_id: string; created_by: string; drafted_by_actor_id: string | null; attributes: Record<string, unknown> }[]
  >(query, "unevented supersede lookup");

  for (const row of rows) {
    try {
      const marker = (row.attributes?.superseded ?? {}) as Record<string, unknown>;
      const byCommId = typeof marker.superseded_by_communication_id === "string" ? marker.superseded_by_communication_id : null;
      let actorId = row.drafted_by_actor_id ?? row.created_by;
      if (byCommId) {
        const winners = await q<{ created_by: string }[]>(
          db.from("communications").select("created_by").eq("id", byCommId).limit(1),
          "superseding communication lookup"
        );
        if (winners[0]) actorId = winners[0].created_by;
      }
      await emitEvent(db, {
        business_id: row.business_id,
        actor_id: actorId,
        action: INBOUND_EVENT_KINDS.communicationSuperseded,
        entity_type: "communication",
        entity_id: row.id,
        payload: {
          reason: String(marker.reason ?? "unknown"),
          thread_id: row.thread_id,
          ...(byCommId ? { superseded_by_communication_id: byCommId } : {}),
          ...(typeof marker.successor_id === "string" ? { successor_id: marker.successor_id } : {}),
        },
      });
      const { error } = await db
        .from("communications")
        .update({
          attributes: { ...row.attributes, superseded: { ...marker, needs_event: false } },
        })
        .eq("id", row.id);
      if (error) throw new Error(`marker clear failed: ${error.message}`);
      out.evented += 1;
    } catch (err) {
      out.errors.push(`supersede event for ${row.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return out;
}

/** The thread's conversation as the client experienced it: inbound rows and
 * genuinely dispatched outbound only.
 * JUDGMENT: "full thread context" (133a) reads as the CONVERSATION — drafts,
 * pendings, superseded and failed rows never reached the client and would
 * teach the model to answer messages the client never saw; the newest
 * complete picture is what was said, both directions. */
async function loadThreadMessages(db: SupabaseClient, threadId: string): Promise<ThreadMessage[]> {
  const rows = await q<
    { direction: string; status: string; body: string; body_format: string; occurred_at: string; channel: string }[]
  >(
    db
      .from("communications")
      .select("direction, status, body, body_format, occurred_at, channel")
      .eq("thread_id", threadId)
      .is("archived_at", null)
      .order("occurred_at", { ascending: true }),
    "thread transcript lookup"
  );
  return rows
    .filter(
      (r) =>
        (r.direction === "inbound" && r.status === "received") ||
        (r.direction === "outbound" && ["sent", "delivered", "read"].includes(r.status))
    )
    .map((r) => ({
      role: r.direction === "inbound" ? ("client" as const) : ("firm" as const),
      // PR-iii: dispatched emails store the sent HTML — the model reads the
      // WORDS, never markup.
      body: plainTextOfBody(r.body, r.body_format),
      at: r.occurred_at,
      channel: r.channel,
    }));
}

interface ProcessThreadDeps {
  generator: GenerateFn | null;
  /** Session 31 (D179c): the pre-compose route reader — null leaves the
   * 0042 ladder standing as it is (a missing read is recoverable). */
  classifier?: ClassifyFn | null;
  now: Date;
}

/** Record a compliance check through the 0026 server-only door, evented —
 * the workflow.ts pattern, shared shape. */
async function recordReplyCompliance(
  db: SupabaseClient,
  businessId: string,
  communicationId: string,
  actorId: string,
  attestation: ComposeDraftResult["attestation"]
): Promise<{ result: string; rule_matched: string | null }> {
  const { data, error } = await db.rpc("run_compliance_check", {
    p_comm: communicationId,
    p_actor: actorId,
    p_attestation: attestation,
  });
  if (error) throw new Error(`run_compliance_check failed: ${error.message}`);
  const out = data as { result: string; rule_matched: string | null };
  await emitEvent(db, {
    business_id: businessId,
    actor_id: actorId,
    action: DRAFTING_EVENT_KINDS.complianceChecked,
    entity_type: "communication",
    entity_id: communicationId,
    payload: { result: out.result, ...(out.rule_matched ? { rule_matched: out.rule_matched } : {}) },
  });
  return out;
}

/**
 * One settled thread → one reply draft (decision 133d: Conversations is a
 * drafting surface). Supersedes the pending draft when one exists (the
 * successor inherits the client's clock through the 0030 pipeline), and the
 * new card carries what it replaced and how many messages arrived since.
 */
async function processSettledThread(
  db: SupabaseClient,
  thread: ThreadFacts,
  deps: ProcessThreadDeps,
  report: SettleSweepReport
): Promise<void> {
  const messages = await loadThreadMessages(db, thread.id);
  const lastFirmAt = [...messages].reverse().find((m) => m.role === "firm")?.at ?? null;
  const unanswered = messages.filter((m) => m.role === "client" && (!lastFirmAt || m.at > lastFirmAt));

  // Session 27 (D158c): a returning-lead marker newer than the last firm
  // message is a settled burst of its own — the resubmission needs answering
  // even though the marker (direction internal) never enters the transcript.
  const markerRows = await q<{ id: string; occurred_at: string; attributes: Record<string, unknown> }[]>(
    db
      .from("communications")
      .select("id, occurred_at, attributes")
      .eq("thread_id", thread.id)
      .eq("direction", "internal")
      .eq("attributes->>kind", RETURNING_MARKER_KIND)
      .is("archived_at", null)
      .order("occurred_at", { ascending: false })
      .limit(1),
    "returning marker lookup"
  );
  const marker = markerRows[0] ?? null;
  const markerActive = Boolean(marker && (!lastFirmAt || marker.occurred_at > lastFirmAt));

  if (unanswered.length === 0 && !markerActive) {
    report.skipped += 1;
    return;
  }

  // The pending draft this regeneration would supersede, under the 0030
  // guard's own key: engagement+channel, or thread+channel when
  // engagement-less.
  let pendingQuery = db
    .from("communications")
    .select("id, created_at, submitted_at")
    .eq("channel", thread.channel)
    .eq("direction", "outbound")
    .eq("status", "pending_approval")
    .is("archived_at", null);
  pendingQuery = thread.engagement_id
    ? pendingQuery.eq("engagement_id", thread.engagement_id)
    : pendingQuery.eq("thread_id", thread.id).is("engagement_id", null);
  const pendings = await q<{ id: string; created_at: string; submitted_at: string | null }[]>(
    pendingQuery.limit(1),
    "pending draft lookup"
  );
  const oldDraft = pendings[0] ?? null;

  // A pending draft created AFTER the last inbound already answers the
  // burst — nothing to regenerate.
  if (oldDraft && thread.last_inbound_at && oldDraft.created_at > thread.last_inbound_at) {
    report.skipped += 1;
    return;
  }

  const drafter = await resolveLightActor(db, thread.business_id);

  if (!deps.generator) {
    // Failure honesty (Session 15 law): no provider is a VISIBLE failure
    // with its reason on The Record — never a silent skip.
    await emitEvent(db, {
      business_id: thread.business_id,
      actor_id: drafter,
      action: DRAFTING_EVENT_KINDS.draftGenerationFailed,
      entity_type: "comm_thread",
      entity_id: thread.id,
      payload: {
        transient: false,
        reason: "ANTHROPIC_API_KEY is not configured — Light cannot compose the reply",
      },
    });
    report.errors.push(`thread ${thread.id}: ANTHROPIC_API_KEY is not configured`);
    return;
  }

  // Assemble: engagement facts + form answers + business identity + pack.
  const businesses = await q<{ name: string; settings: Record<string, unknown> | null; template_id: string | null }[]>(
    db.from("businesses").select("name, settings, template_id").eq("id", thread.business_id).limit(1),
    "business lookup"
  );
  const businessName = businesses[0]?.name ?? "";
  const settings = businesses[0]?.settings ?? {};
  // PR-F: the PENDING body always carries the configured sign-off (firm
  // display name by default) — approver mode resolves at render+stamp, never
  // at generation.
  // Session 32 (D181, Q1 option A): the memory fact is the home for the
  // sign-off and booking-link values; settings is the transitional fallback.
  const memory = await loadMemoryContext(db, thread.business_id);
  const signOff = resolveSignOffWithMemory(memory, settings, businessName);

  const contacts = await q<{ display_name: string; given_name: string | null }[]>(
    db.from("contacts").select("display_name, given_name").eq("id", thread.contact_id).limit(1),
    "contact lookup"
  );
  const fullName = contacts[0]?.display_name ?? "";
  const firstName = contacts[0]?.given_name ?? fullName.split(/\s+/)[0] ?? "";

  let enquiryTitle = `${fullName} — conversation`;
  let stageLabel = "";
  let formAnswers: FormAnswer[] = [];
  let engagementRoute: string | null = null;
  let engagementRouteSource: string | null = null;
  if (thread.engagement_id) {
    const engagements = await q<
      { title: string; attributes: Record<string, unknown> | null; stage: { label: string } | { label: string }[] | null }[]
    >(
      db
        .from("engagements")
        .select("title, attributes, stage:stage_definitions!engagements_stage_id_fkey(label)")
        .eq("id", thread.engagement_id)
        .limit(1),
      "engagement lookup"
    );
    if (engagements[0]) {
      enquiryTitle = engagements[0].title;
      const stage = Array.isArray(engagements[0].stage) ? engagements[0].stage[0] : engagements[0].stage;
      stageLabel = stage?.label ?? "";
      const attrs = (engagements[0].attributes ?? {}) as Record<string, unknown>;
      formAnswers = (attrs as { form_answers?: FormAnswer[] }).form_answers ?? [];
      engagementRoute = typeof attrs.visa_route === "string" ? attrs.visa_route : null;
      engagementRouteSource = typeof attrs.visa_route_source === "string" ? attrs.visa_route_source : null;
    }
  }

  const burstText = unanswered.map((m) => m.body).join("\n");
  // Session 27 (D158c): a settled returning marker contributes the new
  // submission's answers to retrieval — with no unanswered client message,
  // the resubmission IS the burst.
  const markerText =
    markerActive && marker
      ? ((marker.attributes?.marker ?? {}) as { answers?: Array<{ label?: string; value?: string }> }).answers
          ?.map((a) => `${a.label ?? ""}: ${a.value ?? ""}`)
          .join("\n") ?? ""
      : "";
  const noGoRules = await (async () => {
    const rows = await q<{ template: { no_go_rules: unknown } | { no_go_rules: unknown }[] | null }[]>(
      db
        .from("businesses")
        .select("template:templates!businesses_template_id_fkey(no_go_rules)")
        .eq("id", thread.business_id)
        .limit(1),
      "no-go register lookup"
    );
    const embedded = rows[0]?.template;
    const template = Array.isArray(embedded) ? (embedded[0] ?? null) : embedded;
    const rules = template?.no_go_rules;
    return Array.isArray(rules) ? rules.map((r) => String(r)) : [];
  })();

  // Session 27 (D158c): the returning register when the marker is what
  // settled — acknowledge prior contact, reference the route, no cold
  // intro, no duplicate booklet (never re-offer a guide they already hold).
  let returning: ComposeReplyInput["returning"] = null;
  if (markerActive && marker) {
    const markerFacts = (marker.attributes?.marker ?? {}) as {
      form_label?: string;
      submitted_at?: string;
      answers?: Array<{ label?: string; value?: string; previous_value?: string | null; changed?: boolean }>;
    };
    const bookletAlreadySent = await contactReceivedAnyAttachment(db, thread.contact_id);
    returning = {
      prior_route: engagementRoute,
      form_label: markerFacts.form_label ?? null,
      resubmitted_at: markerFacts.submitted_at ?? marker.occurred_at,
      changed_lines: (markerFacts.answers ?? [])
        .filter((a) => a.changed)
        .map(
          (a) =>
            `${a.label ?? "Detail"}: ${a.value ?? ""}${a.previous_value != null ? ` (was ${a.previous_value})` : " (new)"}`
        ),
      booklet_already_sent: bookletAlreadySent,
    };
  }

  let composed: ComposeDraftResult;
  let registerRetried = false;
  let budgetBefore: Awaited<ReturnType<typeof assessAiBudget>> | null = null;
  let composeInput: ComposeReplyInput | null = null;
  try {
    // Session 22 (WS2, ruling 2b): the hard cap refuses reply GENERATION
    // here too — the same server-side gate as the workflow drafter, the same
    // visible-failure lane below. Nothing else on the thread is touched.
    budgetBefore = await assessAiBudget(db, thread.business_id, deps.now);
    guardGenerationBudget(budgetBefore.spend_gbp, budgetBefore);

    // Session 31 (D179c): route resolution — the 0042 ladder plus Light's
    // read over an unset or form_default source — completes BEFORE
    // composition; retrieval keys on what it settles, never on
    // text-matching alone. The read is generation: it runs behind the
    // budget guard and takes the same failure lanes as composition.
    let resolvedRoute = engagementRoute;
    if (thread.engagement_id) {
      const resolved = await resolveEngagementRoute(db, {
        business_id: thread.business_id,
        engagement_id: thread.engagement_id,
        current_route: engagementRoute,
        current_source: engagementRouteSource,
        actor_id: drafter,
        classifier: deps.classifier ?? null,
        evidence: {
          enquiry_title: enquiryTitle,
          form_label: returning?.form_label ?? null,
          form_answers: formAnswers,
          client_words: `${burstText}\n${markerText}`.trim() || null,
        },
      });
      resolvedRoute = resolved.route;
    }

    const retrieval = await retrieveKnowledgeEntries(
      db,
      thread.business_id,
      `${burstText}\n${markerText}\n${enquiryTitle}`,
      resolvedRoute
    );

    composeInput = {
      business_name: businessName,
      sign_off: signOff,
      first_name: firstName,
      full_name: fullName,
      channel: thread.channel,
      enquiry_title: enquiryTitle,
      stage_label: stageLabel,
      form_answers: formAnswers,
      no_go_rules: noGoRules,
      retrieval,
      // PR-iv (Session 19): reply drafts carry the same booking-link law.
      booking_url: resolveBookingUrlWithMemory(memory, settings),
      thread_messages: messages,
      new_inbound_count: unanswered.length,
      returning,
      // Session 32 (D181): memory rides the reply path in the cached prefix.
      memory,
    };
    // Session 25 (register retry-once, founder-ordered): a register-screen
    // breach retries exactly ONCE with the violation fed back — evented on
    // The Record, never a loop. A second breach throws past this block into
    // the visible-failure lane below; nothing retries the retry.
    // JUDGMENT: the post-insert compliance-retry path below keeps its
    // best-effort behaviour — a register breach THERE leaves attempt 1's
    // recorded breach standing visibly, already the founder-ruled lane; only
    // the initial composition gets the automatic register retry.
    const generator = deps.generator;
    const budget = budgetBefore;
    const outcome = await composeWithRegisterRetry(
      (inp, opts) => composeReplyDraft(generator, inp, opts),
      composeInput,
      async (breach) => {
        await emitEvent(db, {
          business_id: thread.business_id,
          actor_id: drafter,
          action: DRAFTING_EVENT_KINDS.draftRegisterRetried,
          entity_type: "comm_thread",
          entity_id: thread.id,
          payload: { violation: breach.breach, reason: breach.message },
        });
        // WS2: the retry is generation too — the hard cap binds it.
        guardGenerationBudget(budget.spend_gbp, budget);
      }
    );
    composed = outcome.composed;
    registerRetried = outcome.registerRetried;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const transient = isTransientProviderError(err);
    await emitEvent(db, {
      business_id: thread.business_id,
      actor_id: drafter,
      action: DRAFTING_EVENT_KINDS.draftGenerationFailed,
      entity_type: "comm_thread",
      entity_id: thread.id,
      payload: { transient, reason },
    });
    if (transient) {
      // Re-arm at NOW: the next tick retries the settled burst.
      await db.from("comm_threads").update({ draft_settle_due_at: deps.now.toISOString() }).eq("id", thread.id);
      report.errors.push(`thread ${thread.id}: transient reply generation failure — ${reason}`);
      return;
    }
    report.errors.push(`thread ${thread.id}: reply generation failed — ${reason}`);
    return;
  }

  // Reply subject (decision 98's stability): the message's own client-facing
  // subject — the composed one, else "Re:" the thread's; never an internal
  // label on its own.
  const subject =
    thread.channel === "email"
      ? composed.subject ?? (thread.subject ? (thread.subject.startsWith("Re:") ? thread.subject : `Re: ${thread.subject}`) : null)
      : null;

  const newMessagesSince = oldDraft
    ? messages.filter((m) => m.role === "client" && m.at > oldDraft.created_at).length
    : 0;

  const inserted = await q<{ id: string }[]>(
    db
      .from("communications")
      .insert({
        business_id: thread.business_id,
        created_by: drafter,
        thread_id: thread.id,
        contact_id: thread.contact_id,
        engagement_id: thread.engagement_id,
        channel: thread.channel,
        direction: "outbound",
        status: "draft",
        body: composed.body,
        body_format: "plain",
        drafted_by_actor_id: drafter,
        attributes: {
          reply_to_thread: thread.id,
          ...(subject ? { subject } : {}),
          // Session 25: attempts counts every model call honestly — the
          // register retry-once is attempt 2 when it fired.
          credit_line: { ...composed.credit_line, attempts: registerRetried ? 2 : 1 },
          ...(oldDraft
            ? {
                supersedes: {
                  communication_id: oldDraft.id,
                  new_messages_since: newMessagesSince,
                },
              }
            : {}),
        },
      })
      .select("id"),
    "reply draft insert"
  );
  const commId = inserted[0]!.id;

  // Fresh compliance check on the exact wording, with the doctrine's
  // retry-once at the same tier on a recorded breach.
  let check = await recordReplyCompliance(db, thread.business_id, commId, drafter, composed.attestation);
  if (check.result === "breach" && composeInput) {
    try {
      const retry = await composeReplyDraft(deps.generator, composeInput, {
        escalationOverride: {
          tier: composed.credit_line.tier,
          model: composed.credit_line.model,
          reason: composed.credit_line.reason,
        },
        feedback: check.rule_matched ?? "a no-go rule was breached",
      });
      const mergedCredit = {
        ...retry.credit_line,
        attempts: registerRetried ? 3 : 2,
        retry_reason: check.rule_matched ?? "no-go breach",
      };
      const { error: updError } = await db
        .from("communications")
        .update({
          body: retry.body,
          attributes: {
            reply_to_thread: thread.id,
            ...(subject ? { subject } : {}),
            credit_line: mergedCredit,
            ...(oldDraft
              ? { supersedes: { communication_id: oldDraft.id, new_messages_since: newMessagesSince } }
              : {}),
          },
        })
        .eq("id", commId);
      if (updError) throw new Error(`retry body update failed: ${updError.message}`);
      composed = {
        ...retry,
        credit_line: mergedCredit as ComposeDraftResult["credit_line"],
        usage: {
          input_tokens: composed.usage.input_tokens + retry.usage.input_tokens,
          output_tokens: composed.usage.output_tokens + retry.usage.output_tokens,
        },
      };
      check = await recordReplyCompliance(db, thread.business_id, commId, drafter, retry.attestation);
    } catch (retryErr) {
      report.errors.push(
        `thread ${thread.id}: compliance retry failed — ${retryErr instanceof Error ? retryErr.message : retryErr}`
      );
    }
  }

  await emitEvent(db, {
    business_id: thread.business_id,
    actor_id: drafter,
    action: "communication.drafted",
    entity_type: "communication",
    entity_id: commId,
    payload: {
      channel: thread.channel,
      engagement_id: thread.engagement_id,
      thread_id: thread.id,
      reply_to_inbound_count: unanswered.length,
      ...(oldDraft ? { supersedes_communication_id: oldDraft.id } : {}),
    },
  });
  await emitEvent(db, {
    business_id: thread.business_id,
    actor_id: drafter,
    action: DRAFTING_EVENT_KINDS.draftGenerated,
    entity_type: "communication",
    entity_id: commId,
    payload: {
      tier: composed.credit_line.tier,
      escalation_reason: composed.credit_line.reason,
      context_tokens: composed.credit_line.context_tokens,
      budget_tokens: composed.credit_line.budget_tokens,
      knowledge_entry_ids: composed.credit_line.knowledge_entry_ids,
      // Session 32 (D181): the riding memory entries, by id, on The Record.
      memory_entry_ids: composed.credit_line.memory_entry_ids,
      compliance: check.result,
      task: "reply",
      ...(composed.credit_line.cache
        ? {
            cache_read_tokens: composed.credit_line.cache.read_tokens,
            cache_written_tokens: composed.credit_line.cache.written_tokens,
            ...(composed.credit_line.cache.fallback_reason
              ? { cache_fallback_reason: composed.credit_line.cache.fallback_reason }
              : {}),
          }
        : {}),
    },
    cost: (() => {
      // Session 22 (WS2): the priced cost block — list rates + recorded fx
      // (model-router.ts); our recorded cost, no margin invented (2a).
      const price = priceGeneration({
        model: composed.credit_line.model,
        input_tokens: composed.usage.input_tokens,
        output_tokens: composed.usage.output_tokens,
        cache_read_tokens: composed.credit_line.cache?.read_tokens,
        cache_write_tokens: composed.credit_line.cache?.written_tokens,
      });
      return {
        provider: "anthropic",
        model: composed.credit_line.model,
        tokens: composed.usage.input_tokens + composed.usage.output_tokens,
        input_tokens: composed.usage.input_tokens,
        output_tokens: composed.usage.output_tokens,
        ...(composed.credit_line.cache
          ? {
              cache_read_tokens: composed.credit_line.cache.read_tokens,
              cache_write_tokens: composed.credit_line.cache.written_tokens,
            }
          : {}),
        ...(price ? { amount_gbp: price.amount_gbp, amount_usd: price.amount_usd, fx_rate: price.fx_rate } : {}),
      };
    })(),
  });

  // Session 31 (D179c): Light's route read no longer rides here — route
  // resolution completed BEFORE composition (resolveEngagementRoute), so
  // this reply's retrieval already keyed on it.

  // WS2: a soft-cap crossing lands once per month on The Record — never a block.
  if (budgetBefore) {
    const replyPrice = priceGeneration({
      model: composed.credit_line.model,
      input_tokens: composed.usage.input_tokens,
      output_tokens: composed.usage.output_tokens,
      cache_read_tokens: composed.credit_line.cache?.read_tokens,
      cache_write_tokens: composed.credit_line.cache?.written_tokens,
    });
    if (replyPrice) {
      await maybeEmitSoftCapCrossed(db, {
        business_id: thread.business_id,
        actor_id: drafter,
        before_gbp: budgetBefore.spend_gbp,
        after_gbp: budgetBefore.spend_gbp + replyPrice.amount_gbp,
        budget: budgetBefore,
        now: deps.now,
      });
    }
  }

  if (oldDraft) {
    // The 0030 pipeline: retire the old draft, submit the successor through
    // the 0017 door, hand the client's clock across — one transaction.
    const { error: supError } = await db.rpc("supersede_communication", {
      p_comm: oldDraft.id,
      p_reason: "new_inbound",
      p_successor: commId,
      p_drafter: drafter,
    });
    if (supError) throw new Error(`supersede_communication failed: ${supError.message}`);
    report.superseded += 1;
    await emitEvent(db, {
      business_id: thread.business_id,
      actor_id: drafter,
      action: INBOUND_EVENT_KINDS.communicationSuperseded,
      entity_type: "communication",
      entity_id: oldDraft.id,
      payload: {
        reason: "new_inbound",
        successor_id: commId,
        thread_id: thread.id,
        new_messages_since: newMessagesSince,
      },
    });
    await emitEvent(db, {
      business_id: thread.business_id,
      actor_id: drafter,
      action: "communication.submitted",
      entity_type: "communication",
      entity_id: commId,
      payload: { supersedes_communication_id: oldDraft.id },
    });
  } else {
    const { error: subError } = await db.rpc("submit_communication", { p_comm: commId, p_actor: drafter });
    if (subError) throw new Error(`submit_communication failed: ${subError.message}`);
    await emitEvent(db, {
      business_id: thread.business_id,
      actor_id: drafter,
      action: "communication.submitted",
      entity_type: "communication",
      entity_id: commId,
    });
  }
  report.drafts_created += 1;
}

/**
 * The cron sweep (decision 133b/d): evaluate due settle timers, produce one
 * reply draft per settled thread, and put any unevented supersede markers on
 * The Record. Claims are optimistic (the due stamp is cleared only if it
 * still holds its read value) so overlapping ticks re-do nothing.
 */
export async function sweepSettleAndSupersede(
  db: SupabaseClient,
  options: {
    generator: GenerateFn | null;
    /** Session 31 (D179c): the pre-compose route reader; when omitted the
     * ladder stands as it is. */
    classifier?: ClassifyFn | null;
    now?: Date;
    onlyThreadId?: string;
    /** "Ask Light to draft" (133d): the manual trigger works on a PAUSED
     * thread too — pausing stops the automatic drafting, not the human's
     * explicit ask. Only honoured together with onlyThreadId. */
    ignorePause?: boolean;
  }
): Promise<SettleSweepReport> {
  const report: SettleSweepReport = {
    threads_evaluated: 0,
    drafts_created: 0,
    superseded: 0,
    markers_evented: 0,
    skipped: 0,
    errors: [],
  };
  const now = options.now ?? new Date();

  const markers = await sweepUneventedSupersedes(db, { threadId: options.onlyThreadId });
  report.markers_evented = markers.evented;
  report.errors.push(...markers.errors);

  let dueQuery = db
    .from("comm_threads")
    .select("id, business_id, contact_id, engagement_id, channel, subject, auto_draft_paused, last_inbound_at, draft_settle_due_at")
    .lte("draft_settle_due_at", now.toISOString())
    .is("archived_at", null);
  if (options.onlyThreadId) dueQuery = dueQuery.eq("id", options.onlyThreadId);
  const due = await q<
    (ThreadFacts & { draft_settle_due_at: string })[]
  >(dueQuery, "settled thread lookup");

  for (const thread of due) {
    report.threads_evaluated += 1;
    try {
      // Optimistic claim: clear the due stamp only if it still holds the
      // value we read — an overlapping tick loses the race and moves on.
      const claimed = await q<{ id: string }[]>(
        db
          .from("comm_threads")
          .update({ draft_settle_due_at: null })
          .eq("id", thread.id)
          .eq("draft_settle_due_at", thread.draft_settle_due_at)
          .select("id"),
        "settle claim"
      );
      if (claimed.length === 0) {
        report.skipped += 1;
        continue;
      }
      if (thread.auto_draft_paused && !(options.ignorePause && options.onlyThreadId === thread.id)) {
        // PR-D: the toggle PAUSES auto-draft — the settled burst is noted
        // and dropped; "Ask Light to draft" remains the manual door.
        report.skipped += 1;
        continue;
      }
      await processSettledThread(db, thread, { generator: options.generator, classifier: options.classifier ?? null, now }, report);
    } catch (err) {
      report.errors.push(`thread ${thread.id}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return report;
}
