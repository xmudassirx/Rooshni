import type { SupabaseClient } from "@supabase/supabase-js";
import { scaleDurationMs } from "@rooshni/config";
import { emitEvent } from "./events";
import { submitCommunication } from "./approvals";
import type {
  EventRow,
  RealDuration,
  StepRunRow,
  TickReport,
  WorkflowDefinitionRow,
  WorkflowRunRow,
  WorkflowStepRow,
} from "./types";

/**
 * The workflow runner, app side (Spec 4 §2–3; Session 6).
 *
 * Workflows are data: definitions and steps are rows, timers are real-world
 * durations in step config multiplied through timeScale() at scheduling time,
 * and every run/step state move happens inside the 0019 engine functions —
 * this file orchestrates, the database enforces. Every step execution lands
 * on the ledger via emitEvent(), the single write path.
 *
 * The tick (runWorkflowTick) is cron-safe and idempotent: claims are atomic
 * (claim_due_step_runs), run starts are keyed on the triggering event and on
 * one-live-run-per-engagement, and step effects are keyed on the step_run id,
 * so overlapping or repeated ticks re-do nothing.
 *
 * THE SEND BOUNDARY (Spec 4 §4 step 1; decision 16): this runner NEVER marks
 * a communication `sent`. The send pipeline does not exist yet and its door
 * is locked (0017). When a stamped draft would be dispatched, the STUB
 * executor logs `communication.send_stubbed` on the ledger and moves on —
 * clearly marked, and listed on docs/GO-LIVE.md.
 */

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

export function realDurationMs(d: RealDuration | undefined): number {
  if (!d) return 0;
  return (
    (d.days ?? 0) * 24 * 60 * 60 * 1000 +
    (d.hours ?? 0) * 60 * 60 * 1000 +
    (d.minutes ?? 0) * 60 * 1000 +
    (d.seconds ?? 0) * 1000
  );
}

/** Real-world duration from data → the scaled instant it lands. */
function scheduledInstant(from: Date, d: RealDuration | undefined): string {
  return new Date(from.getTime() + scaleDurationMs(realDurationMs(d))).toISOString();
}

// ---------------------------------------------------------------------------
// Template rendering — {{variable}} substitution. A draft leaving here with
// unresolved braces would sit unstampable in the inbox (pre-flight refuses),
// so rendering fails fast instead.
// ---------------------------------------------------------------------------

export function renderTemplate(text: string, vars: Record<string, string | null | undefined>): string {
  const rendered = text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, key: string) => {
    const value = vars[key];
    return value == null || value === "" ? whole : value;
  });
  if (/\{\{|\}\}/.test(rendered)) {
    const missing = [...rendered.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]);
    throw new Error(`Template variables unresolved: ${missing.join(", ") || "malformed braces"}`);
  }
  return rendered;
}

// ---------------------------------------------------------------------------
// Gated acts — pause / resume / cancel a run. The database function is the
// gate (enquiries execute, or the owner); the wrapper puts the act on the
// ledger. Same shape for the definition pipeline.
// ---------------------------------------------------------------------------

export interface RunActInput {
  business_id: string;
  run_id: string;
  actor_id: string;
  reason?: string;
}

export async function pauseWorkflowRun(db: SupabaseClient, input: RunActInput): Promise<EventRow> {
  const { error } = await db.rpc("pause_workflow_run", { p_run: input.run_id, p_actor: input.actor_id });
  if (error) throw new Error(`pause_workflow_run failed: ${error.message}`);
  return emitEvent(db, {
    business_id: input.business_id,
    actor_id: input.actor_id,
    action: "workflow.run_paused",
    entity_type: "workflow_run",
    entity_id: input.run_id,
  });
}

export async function resumeWorkflowRun(db: SupabaseClient, input: RunActInput): Promise<EventRow> {
  const { error } = await db.rpc("resume_workflow_run", { p_run: input.run_id, p_actor: input.actor_id });
  if (error) throw new Error(`resume_workflow_run failed: ${error.message}`);
  return emitEvent(db, {
    business_id: input.business_id,
    actor_id: input.actor_id,
    action: "workflow.run_resumed",
    entity_type: "workflow_run",
    entity_id: input.run_id,
  });
}

export async function cancelWorkflowRun(db: SupabaseClient, input: RunActInput): Promise<EventRow> {
  const { error } = await db.rpc("cancel_workflow_run", {
    p_run: input.run_id,
    p_actor: input.actor_id,
    p_reason: input.reason ?? null,
  });
  if (error) throw new Error(`cancel_workflow_run failed: ${error.message}`);
  return emitEvent(db, {
    business_id: input.business_id,
    actor_id: input.actor_id,
    action: "workflow.run_cancelled",
    entity_type: "workflow_run",
    entity_id: input.run_id,
    payload: input.reason ? { reason: input.reason } : {},
  });
}

// ---------------------------------------------------------------------------
// Starting a run (server code; the engine function refuses signed-in callers)
// ---------------------------------------------------------------------------

export interface StartRunInput {
  business_id: string;
  definition_id: string;
  definition_key?: string;
  engagement_id: string;
  /** The engine's own actor (actor_type "workflow") — created_by on the run. */
  engine_actor_id: string;
  /** The drafting agent (Light) the run's draft_comm steps act as. */
  drafter_actor_id: string;
  trigger_event_id?: string;
  context?: Record<string, unknown>;
}

export async function startWorkflowRun(db: SupabaseClient, input: StartRunInput): Promise<string> {
  const { data, error } = await db.rpc("start_workflow_run", {
    p_definition: input.definition_id,
    p_engagement: input.engagement_id,
    p_actor: input.engine_actor_id,
    p_trigger_event: input.trigger_event_id ?? null,
    p_context: {
      ...(input.context ?? {}),
      engine_actor_id: input.engine_actor_id,
      drafter_actor_id: input.drafter_actor_id,
    },
  });
  if (error) throw new Error(`start_workflow_run failed: ${error.message}`);
  const runId = data as string;
  await emitEvent(db, {
    business_id: input.business_id,
    actor_id: input.engine_actor_id,
    action: "workflow.run_started",
    entity_type: "workflow_run",
    entity_id: runId,
    payload: {
      definition_id: input.definition_id,
      ...(input.definition_key ? { definition_key: input.definition_key } : {}),
      engagement_id: input.engagement_id,
      ...(input.trigger_event_id ? { trigger_event_id: input.trigger_event_id } : {}),
    },
  });
  return runId;
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

interface RunBundle {
  run: WorkflowRunRow;
  definition: WorkflowDefinitionRow;
  steps: WorkflowStepRow[];
}

async function q<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return (data ?? ([] as unknown)) as T;
}

/** JUDGMENT: Phase 1 actor binding — the business's account holds exactly one
 * workflow-type actor (the engine) and one agent (Light); ambiguity is a loud
 * failure, not a guess. Bindings are frozen into run.context at start. */
async function resolveBusinessActors(
  db: SupabaseClient,
  businessId: string
): Promise<{ engine_actor_id: string; drafter_actor_id: string }> {
  const business = await q<{ account_id: string }[]>(
    db.from("businesses").select("account_id").eq("id", businessId).limit(1),
    "business lookup"
  );
  if (!business[0]) throw new Error(`Business ${businessId} not found`);
  const actors = await q<{ id: string; actor_type: string }[]>(
    db
      .from("actors")
      .select("id, actor_type")
      .eq("account_id", business[0].account_id)
      .in("actor_type", ["workflow", "agent"])
      .is("archived_at", null),
    "actor lookup"
  );
  const engines = actors.filter((a) => a.actor_type === "workflow");
  const agents = actors.filter((a) => a.actor_type === "agent");
  if (engines.length !== 1 || agents.length !== 1) {
    throw new Error(
      `Business ${businessId} needs exactly one workflow actor and one agent actor (saw ${engines.length}/${agents.length})`
    );
  }
  return { engine_actor_id: engines[0]!.id, drafter_actor_id: agents[0]!.id };
}

/** Phase 1 condition evaluator. Conditions the machinery cannot observe yet
 * resolve FALSE and the step is skipped on the ledger — never silently, and
 * a run never hangs on a step this phase cannot execute. */
async function evaluateCondition(
  db: SupabaseClient,
  key: string,
  run: WorkflowRunRow
): Promise<{ pass: boolean; reason: string }> {
  if (key === "inbound_reply_received") {
    const replies = await q<{ id: string }[]>(
      db
        .from("communications")
        .select("id")
        .eq("engagement_id", run.engagement_id)
        .eq("direction", "inbound")
        .gte("occurred_at", run.started_at)
        .is("archived_at", null)
        .limit(1),
      "inbound reply lookup"
    );
    return replies.length > 0
      ? { pass: true, reason: "an inbound reply exists on this enquiry" }
      : { pass: false, reason: "no inbound reply has arrived" };
  }
  // task_no_answer, both_calls_failed, qualified, consultation_booked … —
  // their observers arrive with later sessions (call outcomes, reply
  // handling, booking). Defined in data now; unobservable resolves false.
  return { pass: false, reason: `condition "${key}" is not observable in Phase 1` };
}

async function loadRunBundle(db: SupabaseClient, runId: string, cache: Map<string, RunBundle>): Promise<RunBundle> {
  const cached = cache.get(runId);
  if (cached) return cached;
  const runs = await q<WorkflowRunRow[]>(db.from("workflow_runs").select("*").eq("id", runId).limit(1), "run lookup");
  if (!runs[0]) throw new Error(`Workflow run ${runId} not found`);
  const definitions = await q<WorkflowDefinitionRow[]>(
    db.from("workflow_definitions").select("*").eq("id", runs[0].definition_id).limit(1),
    "definition lookup"
  );
  if (!definitions[0]) throw new Error(`Definition ${runs[0].definition_id} not found`);
  const steps = await q<WorkflowStepRow[]>(
    db
      .from("workflow_steps")
      .select("*")
      .eq("definition_id", runs[0].definition_id)
      .is("archived_at", null)
      .order("sort_order"),
    "steps lookup"
  );
  const bundle = { run: runs[0], definition: definitions[0], steps };
  cache.set(runId, bundle);
  return bundle;
}

function nextStepAfter(steps: WorkflowStepRow[], stepId: string): WorkflowStepRow | null {
  const index = steps.findIndex((s) => s.id === stepId);
  return index >= 0 && index + 1 < steps.length ? steps[index + 1]! : null;
}

/** Advance parameters for complete_step_run: the next step and its moment.
 * Wait steps sleep as data says, scaled through timeScale(). */
function advanceArgs(steps: WorkflowStepRow[], currentStepId: string, now: Date) {
  const next = nextStepAfter(steps, currentStepId);
  if (!next) return { p_next_step: null, p_next_scheduled_for: null };
  return {
    p_next_step: next.id,
    p_next_scheduled_for: next.kind === "wait" ? scheduledInstant(now, next.config.wait) : now.toISOString(),
  };
}

async function completeStep(
  db: SupabaseClient,
  bundle: RunBundle,
  stepRun: StepRunRow,
  status: "completed" | "skipped" | "failed",
  outcome: Record<string, unknown>,
  advance: { p_next_step: string | null; p_next_scheduled_for: string | null },
  report: TickReport
): Promise<void> {
  const { error } = await db.rpc("complete_step_run", {
    p_step_run: stepRun.id,
    p_status: status,
    p_outcome: outcome,
    ...advance,
  });
  if (error) throw new Error(`complete_step_run failed: ${error.message}`);

  const step = bundle.steps.find((s) => s.id === stepRun.step_id);
  const engineActor = (bundle.run.context.engine_actor_id as string) ?? bundle.run.created_by;
  await emitEvent(db, {
    business_id: bundle.run.business_id,
    actor_id: engineActor,
    action: status === "completed" ? "workflow.step_completed" : status === "skipped" ? "workflow.step_skipped" : "workflow.step_failed",
    entity_type: "workflow_run",
    entity_id: bundle.run.id,
    payload: {
      step_run_id: stepRun.id,
      step_key: step?.key,
      step_kind: step?.kind,
      engagement_id: bundle.run.engagement_id,
      ...outcome,
    },
  });
  if (status === "completed") report.steps_completed += 1;
  if (status === "skipped") report.steps_skipped += 1;
  if (status === "failed") report.steps_failed += 1;

  if (status !== "failed" && advance.p_next_step === null) {
    report.runs_completed += 1;
    await emitEvent(db, {
      business_id: bundle.run.business_id,
      actor_id: engineActor,
      action: "workflow.run_completed",
      entity_type: "workflow_run",
      entity_id: bundle.run.id,
      payload: {
        definition_key: bundle.definition.key,
        engagement_id: bundle.run.engagement_id,
        last_step_key: step?.key,
        ...(outcome.run_completed_reason ? { reason: outcome.run_completed_reason } : {}),
      },
    });
  }
}

/** The STUB send boundary. Spec 4 places the send pipeline exactly after the
 * stamp; it is not built yet and its door is locked (decision 16), so the
 * would-be dispatch is logged on the ledger instead. Listed on GO-LIVE.md. */
async function stubSend(
  db: SupabaseClient,
  businessId: string,
  actorId: string,
  comm: { id: string; channel: string; contact_id: string | null },
  runId: string,
  report: TickReport
): Promise<string> {
  const event = await emitEvent(db, {
    business_id: businessId,
    actor_id: actorId,
    action: "communication.send_stubbed",
    entity_type: "communication",
    entity_id: comm.id,
    payload: {
      stub: true,
      note: "STUB — the send pipeline is a later session; this stamped message would have been dispatched here. See docs/GO-LIVE.md.",
      channel: comm.channel,
      contact_id: comm.contact_id,
      workflow_run_id: runId,
    },
  });
  report.sends_stubbed += 1;
  return event.id;
}

// ---------------------------------------------------------------------------
// Step executors
// ---------------------------------------------------------------------------

interface EngagementFacts {
  id: string;
  business_id: string;
  title: string;
  owner_actor_id: string;
  template_type_id: string;
  contact: { id: string; display_name: string; given_name: string | null } | null;
}

async function loadEngagementFacts(db: SupabaseClient, engagementId: string): Promise<EngagementFacts> {
  const engagements = await q<
    { id: string; business_id: string; title: string; owner_actor_id: string; template_type_id: string }[]
  >(
    db
      .from("engagements")
      .select("id, business_id, title, owner_actor_id, template_type_id")
      .eq("id", engagementId)
      .limit(1),
    "engagement lookup"
  );
  if (!engagements[0]) throw new Error(`Engagement ${engagementId} not found`);
  const participants = await q<{ contact_id: string }[]>(
    db
      .from("engagement_participants")
      .select("contact_id")
      .eq("engagement_id", engagementId)
      .eq("role", "client")
      .is("archived_at", null)
      .limit(1),
    "participant lookup"
  );
  let contact: EngagementFacts["contact"] = null;
  if (participants[0]) {
    const contacts = await q<{ id: string; display_name: string; given_name: string | null }[]>(
      db.from("contacts").select("id, display_name, given_name").eq("id", participants[0].contact_id).limit(1),
      "contact lookup"
    );
    contact = contacts[0] ?? null;
  }
  return { ...engagements[0], contact };
}

async function templateVars(db: SupabaseClient, facts: EngagementFacts): Promise<Record<string, string>> {
  const owners = await q<{ display_name: string }[]>(
    db.from("actors").select("display_name").eq("id", facts.owner_actor_id).limit(1),
    "owner lookup"
  );
  const businesses = await q<{ name: string }[]>(
    db.from("businesses").select("name").eq("id", facts.business_id).limit(1),
    "business lookup"
  );
  const fullName = facts.contact?.display_name ?? "";
  return {
    first_name: facts.contact?.given_name ?? fullName.split(/\s+/)[0] ?? "",
    full_name: fullName,
    owner_name: owners[0]?.display_name ?? "",
    business_name: businesses[0]?.name ?? "",
  };
}

/** Consent lives per channel (Spec 1 §4.1). Picks the configured channel when
 * the contact holds a live consented channel of that type; otherwise the
 * configured fallback (Spec 4 §4 step 4: WhatsApp "(if consented)"). */
async function pickChannel(
  db: SupabaseClient,
  contactId: string | null,
  intended: string,
  fallback: string | undefined
): Promise<{ channel: string; fell_back: boolean }> {
  const consentType: Record<string, string> = { email: "email", whatsapp: "whatsapp", sms: "phone", call: "phone" };
  const needed = consentType[intended];
  if (!needed || !contactId) return { channel: intended, fell_back: false };
  const channels = await q<{ id: string; consent: Record<string, unknown> }[]>(
    db
      .from("contact_channels")
      .select("id, consent")
      .eq("contact_id", contactId)
      .eq("channel", needed)
      .is("archived_at", null),
    "consent lookup"
  );
  const consented = channels.some((c) => c.consent?.transactional === true || c.consent?.marketing === true);
  if (consented || !fallback) return { channel: intended, fell_back: false };
  return { channel: fallback, fell_back: true };
}

async function executeDraftComm(
  db: SupabaseClient,
  bundle: RunBundle,
  step: WorkflowStepRow,
  stepRun: StepRunRow,
  now: Date,
  report: TickReport
): Promise<void> {
  const { run } = bundle;
  const drafter = (run.context.drafter_actor_id as string) ?? run.created_by;
  const engineActor = (run.context.engine_actor_id as string) ?? run.created_by;

  // Idempotency: a crash between insert and completion must not draft twice.
  const existing = await q<{ id: string; channel: string; contact_id: string | null; status: string }[]>(
    db
      .from("communications")
      .select("id, channel, contact_id, status")
      .eq("attributes->>step_run_id", stepRun.id)
      .limit(1),
    "draft idempotency lookup"
  );

  let comm = existing[0] ?? null;
  if (!comm) {
    const facts = await loadEngagementFacts(db, run.engagement_id);
    if (!facts.contact) throw new Error(`Engagement ${run.engagement_id} has no client contact to write to`);
    const templateKey = step.config.template;
    if (!templateKey) throw new Error(`Step ${step.key} has no template configured`);
    const templates = await q<{ id: string; key: string; version: number; channel: string; subject: string | null; body: string }[]>(
      db
        .from("message_templates")
        .select("id, key, version, channel, subject, body")
        .eq("business_id", run.business_id)
        .eq("key", templateKey)
        .is("archived_at", null)
        .order("version", { ascending: false })
        .limit(1),
      "template lookup"
    );
    if (!templates[0]) throw new Error(`Message template "${templateKey}" not found for this business`);

    const vars = await templateVars(db, facts);
    const body = renderTemplate(templates[0].body, vars);
    const subject = templates[0].subject ? renderTemplate(templates[0].subject, vars) : null;
    const intended = (step.config.channel as string) ?? templates[0].channel;
    const picked = await pickChannel(db, facts.contact.id, intended, step.config.fallback_channel);

    const threads = await q<{ id: string }[]>(
      db
        .from("comm_threads")
        .select("id")
        .eq("engagement_id", run.engagement_id)
        .eq("channel", picked.channel)
        .is("archived_at", null)
        .limit(1),
      "thread lookup"
    );
    let threadId = threads[0]?.id;
    if (!threadId) {
      const created = await q<{ id: string }[]>(
        db
          .from("comm_threads")
          .insert({
            business_id: run.business_id,
            created_by: drafter,
            contact_id: facts.contact.id,
            engagement_id: run.engagement_id,
            channel: picked.channel,
            subject,
          })
          .select("id"),
        "thread insert"
      );
      threadId = created[0]!.id;
    }

    const inserted = await q<{ id: string; channel: string; contact_id: string | null; status: string }[]>(
      db
        .from("communications")
        .insert({
          business_id: run.business_id,
          created_by: drafter,
          thread_id: threadId,
          contact_id: facts.contact.id,
          engagement_id: run.engagement_id,
          channel: picked.channel,
          direction: "outbound",
          status: "draft",
          body,
          body_format: "plain",
          drafted_by_actor_id: drafter,
          attributes: {
            workflow_run_id: run.id,
            step_run_id: stepRun.id,
            template_key: templates[0].key,
            template_version: templates[0].version,
            ...(picked.fell_back ? { channel_fallback_from: intended } : {}),
          },
        })
        .select("id, channel, contact_id, status"),
      "communication insert"
    );
    comm = inserted[0]!;

    await emitEvent(db, {
      business_id: run.business_id,
      actor_id: drafter,
      action: "communication.drafted",
      entity_type: "communication",
      entity_id: comm.id,
      payload: {
        channel: comm.channel,
        engagement_id: run.engagement_id,
        workflow_run_id: run.id,
        step_key: step.key,
        template_key: templates[0].key,
        ...(picked.fell_back ? { channel_fallback_from: intended } : {}),
      },
    });
    await submitCommunication(db, {
      business_id: run.business_id,
      communication_id: comm.id,
      actor_id: drafter,
    });
  }

  if (step.config.await_approval) {
    const { error } = await db.rpc("mark_step_awaiting_approval", {
      p_step_run: stepRun.id,
      p_outcome: { communication_id: comm.id },
    });
    if (error) throw new Error(`mark_step_awaiting_approval failed: ${error.message}`);
    report.steps_awaiting_approval += 1;
    await emitEvent(db, {
      business_id: run.business_id,
      actor_id: engineActor,
      action: "workflow.step_awaiting_approval",
      entity_type: "workflow_run",
      entity_id: run.id,
      payload: {
        step_run_id: stepRun.id,
        step_key: step.key,
        communication_id: comm.id,
        engagement_id: run.engagement_id,
        note: "The run is blocked until the draft is stamped in the Approval Inbox.",
      },
    });
    return;
  }

  await completeStep(
    db,
    bundle,
    stepRun,
    "completed",
    { communication_id: comm.id },
    advanceArgs(bundle.steps, step.id, now),
    report
  );
}

async function executeCreateTask(
  db: SupabaseClient,
  bundle: RunBundle,
  step: WorkflowStepRow,
  stepRun: StepRunRow,
  now: Date,
  report: TickReport
): Promise<void> {
  const { run } = bundle;
  const engineActor = (run.context.engine_actor_id as string) ?? run.created_by;

  const existing = await q<{ id: string }[]>(
    db.from("tasks").select("id").eq("attributes->>step_run_id", stepRun.id).limit(1),
    "task idempotency lookup"
  );
  let taskId = existing[0]?.id;
  if (!taskId) {
    const facts = await loadEngagementFacts(db, run.engagement_id);
    const vars = await templateVars(db, facts);
    const assignee = step.config.assignee === "owner" || !step.config.assignee ? facts.owner_actor_id : step.config.assignee;
    const dueAt = step.config.due ? scheduledInstant(now, step.config.due) : null;
    const inserted = await q<{ id: string }[]>(
      db
        .from("tasks")
        .insert({
          business_id: run.business_id,
          created_by: engineActor,
          engagement_id: run.engagement_id,
          title: renderTemplate(step.config.title ?? `Follow up: ${facts.title}`, vars),
          description: step.config.description ? renderTemplate(step.config.description, vars) : null,
          status: "open",
          assignee_actor_id: assignee,
          due_at: dueAt,
          priority: step.config.priority ?? "normal",
          workflow_run_id: run.id,
          attributes: { step_run_id: stepRun.id },
        })
        .select("id"),
      "task insert"
    );
    taskId = inserted[0]!.id;
    await emitEvent(db, {
      business_id: run.business_id,
      actor_id: engineActor,
      action: "task.created",
      entity_type: "task",
      entity_id: taskId,
      payload: {
        engagement_id: run.engagement_id,
        workflow_run_id: run.id,
        step_key: step.key,
        due_at: dueAt,
        assignee_actor_id: assignee,
      },
    });
  }
  await completeStep(db, bundle, stepRun, "completed", { task_id: taskId }, advanceArgs(bundle.steps, step.id, now), report);
}

async function executeMoveStage(
  db: SupabaseClient,
  bundle: RunBundle,
  step: WorkflowStepRow,
  stepRun: StepRunRow,
  now: Date,
  report: TickReport
): Promise<void> {
  const { run } = bundle;
  const engineActor = (run.context.engine_actor_id as string) ?? run.created_by;
  const stageKey = step.config.stage;
  if (!stageKey) throw new Error(`Step ${step.key} has no target stage configured`);

  const engagements = await q<{ template_type_id: string; stage_id: string }[]>(
    db.from("engagements").select("template_type_id, stage_id").eq("id", run.engagement_id).limit(1),
    "engagement lookup"
  );
  if (!engagements[0]) throw new Error(`Engagement ${run.engagement_id} not found`);
  const stages = await q<{ id: string; key: string; is_terminal: boolean; terminal_outcome: string | null }[]>(
    db
      .from("stage_definitions")
      .select("id, key, is_terminal, terminal_outcome")
      .eq("engagement_type_id", engagements[0].template_type_id)
      .eq("key", stageKey)
      .is("archived_at", null)
      .limit(1),
    "stage lookup"
  );
  if (!stages[0]) throw new Error(`Stage "${stageKey}" not found for this engagement type`);

  if (engagements[0].stage_id !== stages[0].id) {
    const { error } = await db.rpc("move_engagement_stage", {
      p_engagement: run.engagement_id,
      p_to_stage: stages[0].id,
      p_moved_by: engineActor,
    });
    if (error) throw new Error(`move_engagement_stage failed: ${error.message}`);
    await emitEvent(db, {
      business_id: run.business_id,
      actor_id: engineActor,
      action: "engagement.stage_changed",
      entity_type: "engagement",
      entity_id: run.engagement_id,
      payload: {
        to_stage: stages[0].key,
        workflow_run_id: run.id,
        step_key: step.key,
        ...(stages[0].is_terminal ? { terminal: true, outcome: stages[0].terminal_outcome } : {}),
      },
    });
  }
  await completeStep(
    db,
    bundle,
    stepRun,
    "completed",
    { stage_key: stages[0].key, terminal: stages[0].is_terminal },
    advanceArgs(bundle.steps, step.id, now),
    report
  );
}

async function executeFireConversion(
  db: SupabaseClient,
  bundle: RunBundle,
  step: WorkflowStepRow,
  stepRun: StepRunRow,
  now: Date,
  report: TickReport
): Promise<void> {
  const { run } = bundle;
  const engineActor = (run.context.engine_actor_id as string) ?? run.created_by;
  const engagements = await q<{ outcome: string | null }[]>(
    db.from("engagements").select("outcome").eq("id", run.engagement_id).limit(1),
    "engagement outcome lookup"
  );
  // STUB — the Meta Conversions/junk-signal wiring is its own contract+wiring
  // session pair. The signal that WOULD fire is logged; nothing leaves.
  const event = await emitEvent(db, {
    business_id: run.business_id,
    actor_id: engineActor,
    action: "meta.signal_stubbed",
    entity_type: "engagement",
    entity_id: run.engagement_id,
    payload: {
      stub: true,
      note: "STUB — Meta outcome-feedback wiring is a later session; this signal would have fired here. See docs/GO-LIVE.md.",
      signal: step.config.signal ?? "outcome_feedback",
      engagement_outcome: engagements[0]?.outcome ?? null,
      cooling: step.config.cooling ?? null,
      workflow_run_id: run.id,
    },
  });
  await completeStep(
    db,
    bundle,
    stepRun,
    "completed",
    { stubbed: true, signal_event_id: event.id },
    advanceArgs(bundle.steps, step.id, now),
    report
  );
}

// ---------------------------------------------------------------------------
// runWorkflowTick — the Vercel-invocable, cron-safe pass.
// ---------------------------------------------------------------------------

export interface TickOptions {
  /** Injectable clock for rehearsals; production omits it. */
  now?: Date;
  /** Safety cap on claim/execute rounds per tick. */
  maxRounds?: number;
}

export async function runWorkflowTick(db: SupabaseClient, options: TickOptions = {}): Promise<TickReport> {
  const report: TickReport = {
    runs_started: 0,
    steps_completed: 0,
    steps_skipped: 0,
    steps_failed: 0,
    steps_awaiting_approval: 0,
    runs_completed: 0,
    sends_stubbed: 0,
    errors: [],
  };
  const bundles = new Map<string, RunBundle>();
  const now = () => options.now ?? new Date();

  // -- Phase 1: trigger matching — active definitions consume unclaimed
  // trigger events (idempotent: one run per event, one live run per lead).
  const definitions = await q<WorkflowDefinitionRow[]>(
    db.from("workflow_definitions").select("*").eq("status", "active").is("archived_at", null),
    "active definitions"
  );
  for (const definition of definitions) {
    const action = definition.trigger?.action;
    if (!action) continue;
    try {
      const events = await q<{ id: string; entity_type: string | null; entity_id: string | null; payload: Record<string, unknown> }[]>(
        db
          .from("events")
          .select("id, entity_type, entity_id, payload")
          .eq("business_id", definition.business_id)
          .eq("action", action)
          .order("occurred_at", { ascending: true })
          .limit(200),
        "trigger event scan"
      );
      if (events.length === 0) continue;
      const consumedRows = await q<{ context: Record<string, unknown> }[]>(
        db.from("workflow_runs").select("context").eq("definition_id", definition.id),
        "consumed trigger lookup"
      );
      const consumed = new Set(consumedRows.map((r) => r.context?.trigger_event_id).filter(Boolean));
      const source = definition.trigger?.source;
      let actors: { engine_actor_id: string; drafter_actor_id: string } | null = null;

      for (const evt of events) {
        if (consumed.has(evt.id)) continue;
        if (evt.entity_type !== "engagement" || !evt.entity_id) continue;
        if (source) {
          const attribution = evt.payload?.attribution as Record<string, unknown> | undefined;
          if (attribution?.source !== source) continue;
        }
        actors ??= await resolveBusinessActors(db, definition.business_id);
        try {
          await startWorkflowRun(db, {
            business_id: definition.business_id,
            definition_id: definition.id,
            definition_key: definition.key,
            engagement_id: evt.entity_id,
            engine_actor_id: actors.engine_actor_id,
            drafter_actor_id: actors.drafter_actor_id,
            trigger_event_id: evt.id,
          });
          report.runs_started += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Another live run already works this lead, or a parallel tick got
          // here first — both are the idempotency keys doing their job.
          if (!/duplicate key|workflow_runs_one_live_uniq|workflow_runs_trigger_event_uniq/.test(message)) {
            report.errors.push(`trigger start (${definition.key} → ${evt.entity_id}): ${message}`);
          }
        }
      }
    } catch (err) {
      report.errors.push(`trigger matching (${definition.key}): ${err instanceof Error ? err.message : err}`);
    }
  }

  // -- Phases 2+3, looped: unblock stamped drafts, then claim and execute due
  // steps; completions may schedule immediately-due successors, so repeat
  // until a round does nothing.
  const maxRounds = options.maxRounds ?? 25;
  for (let round = 0; round < maxRounds; round++) {
    let didWork = false;

    // Phase 2: awaiting-approval steps whose draft got the stamp move on —
    // through the STUB send boundary.
    const awaiting = await q<StepRunRow[]>(
      db.from("step_runs").select("*").eq("status", "awaiting_approval"),
      "awaiting steps"
    );
    for (const stepRun of awaiting) {
      try {
        const bundle = await loadRunBundle(db, stepRun.run_id, bundles);
        if (bundle.run.status !== "blocked") continue;
        const commId = stepRun.outcome.communication_id as string | undefined;
        if (!commId) continue;
        const comms = await q<{ id: string; status: string; channel: string; contact_id: string | null }[]>(
          db.from("communications").select("id, status, channel, contact_id").eq("id", commId).limit(1),
          "awaited communication lookup"
        );
        if (!comms[0] || comms[0].status !== "approved") continue;
        const engineActor = (bundle.run.context.engine_actor_id as string) ?? bundle.run.created_by;
        const stubEventId = await stubSend(db, bundle.run.business_id, engineActor, comms[0], bundle.run.id, report);
        await completeStep(
          db,
          bundle,
          stepRun,
          "completed",
          { communication_id: commId, approved: true, send_stubbed_event_id: stubEventId },
          advanceArgs(bundle.steps, stepRun.step_id, now()),
          report
        );
        bundles.delete(stepRun.run_id);
        didWork = true;
      } catch (err) {
        report.errors.push(`unblock (${stepRun.id}): ${err instanceof Error ? err.message : err}`);
      }
    }

    // Phase 3: claim and execute due steps.
    const claimed = await q<StepRunRow[]>(
      db.rpc("claim_due_step_runs", { p_now: now().toISOString() }),
      "claim_due_step_runs"
    );
    for (const stepRun of claimed) {
      didWork = true;
      let bundle: RunBundle | null = null;
      try {
        bundle = await loadRunBundle(db, stepRun.run_id, bundles);
        const step = bundle.steps.find((s) => s.id === stepRun.step_id);
        if (!step) throw new Error(`Step ${stepRun.step_id} not found in definition`);

        // An inbound reply cancels the remaining queued touches (Spec 4 §4
        // branches, decision 5): the nurture sequence ends, on the record.
        if (step.config.cancel_on_reply) {
          const replied = await evaluateCondition(db, "inbound_reply_received", bundle.run);
          if (replied.pass) {
            const engineActor = (bundle.run.context.engine_actor_id as string) ?? bundle.run.created_by;
            await emitEvent(db, {
              business_id: bundle.run.business_id,
              actor_id: engineActor,
              action: "workflow.touches_cancelled",
              entity_type: "workflow_run",
              entity_id: bundle.run.id,
              payload: { engagement_id: bundle.run.engagement_id, reason: replied.reason, from_step_key: step.key },
            });
            await completeStep(
              db,
              bundle,
              stepRun,
              "skipped",
              { reason: `remaining touches cancelled: ${replied.reason}`, run_completed_reason: "reply_received" },
              { p_next_step: null, p_next_scheduled_for: null },
              report
            );
            bundles.delete(stepRun.run_id);
            continue;
          }
        }

        if (step.config.when) {
          const verdict = await evaluateCondition(db, step.config.when, bundle.run);
          if (!verdict.pass) {
            await completeStep(
              db,
              bundle,
              stepRun,
              "skipped",
              { reason: verdict.reason, condition: step.config.when },
              advanceArgs(bundle.steps, step.id, now()),
              report
            );
            bundles.delete(stepRun.run_id);
            continue;
          }
        }

        switch (step.kind) {
          case "draft_comm":
            await executeDraftComm(db, bundle, step, stepRun, now(), report);
            break;
          case "create_task":
            await executeCreateTask(db, bundle, step, stepRun, now(), report);
            break;
          case "wait":
            // The waiting already happened: scheduled_for was the timer.
            await completeStep(db, bundle, stepRun, "completed", {}, advanceArgs(bundle.steps, step.id, now()), report);
            break;
          case "move_stage":
          case "close":
            await executeMoveStage(db, bundle, step, stepRun, now(), report);
            break;
          case "fire_conversion":
            await executeFireConversion(db, bundle, step, stepRun, now(), report);
            break;
          case "branch":
          case "notify":
            // Their executors arrive with later phases; defined as data now,
            // skipped on the ledger, never a silent hang.
            await completeStep(
              db,
              bundle,
              stepRun,
              "skipped",
              { reason: `no ${step.kind} executor in Phase 1` },
              advanceArgs(bundle.steps, step.id, now()),
              report
            );
            break;
        }
        bundles.delete(stepRun.run_id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        report.errors.push(`step ${stepRun.id}: ${message}`);
        try {
          if (bundle) {
            await completeStep(
              db,
              bundle,
              stepRun,
              "failed",
              { error: message },
              { p_next_step: null, p_next_scheduled_for: null },
              report
            );
            bundles.delete(stepRun.run_id);
          }
        } catch (inner) {
          report.errors.push(`step ${stepRun.id} (failure record): ${inner instanceof Error ? inner.message : inner}`);
        }
      }
    }

    if (!didWork) break;
  }

  // -- Phase 4: the send boundary for NON-blocking workflow drafts (nurture
  // nudges): once stamped, their would-be dispatch is stub-logged exactly
  // once. Keyed on the ledger itself — replays add nothing.
  try {
    const approved = await q<{ id: string; channel: string; contact_id: string | null; business_id: string; attributes: Record<string, unknown> }[]>(
      db
        .from("communications")
        .select("id, channel, contact_id, business_id, attributes")
        .eq("status", "approved")
        .not("attributes->>workflow_run_id", "is", null),
      "approved workflow drafts"
    );
    if (approved.length > 0) {
      const logged = await q<{ entity_id: string }[]>(
        db
          .from("events")
          .select("entity_id")
          .eq("action", "communication.send_stubbed")
          .in("entity_id", approved.map((c) => c.id)),
        "stubbed sends lookup"
      );
      const done = new Set(logged.map((l) => l.entity_id));
      for (const comm of approved) {
        if (done.has(comm.id)) continue;
        const runId = comm.attributes.workflow_run_id as string;
        try {
          const bundle = await loadRunBundle(db, runId, bundles);
          const engineActor = (bundle.run.context.engine_actor_id as string) ?? bundle.run.created_by;
          await stubSend(db, comm.business_id, engineActor, comm, runId, report);
        } catch (err) {
          report.errors.push(`stub send (${comm.id}): ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  } catch (err) {
    report.errors.push(`send boundary sweep: ${err instanceof Error ? err.message : err}`);
  }

  return report;
}
