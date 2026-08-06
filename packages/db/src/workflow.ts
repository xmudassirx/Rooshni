import type { SupabaseClient } from "@supabase/supabase-js";
import { scaleDurationMs } from "@rooshni/config";
import { emitEvent } from "./events";
import { submitCommunication } from "./approvals";
import { evaluateAutoClose, type NudgeFact } from "./auto-close";
import { DRAFTING_EVENT_KINDS, SEND_EVENT_KINDS, WORKFLOW_EVENT_KINDS } from "./event-kinds";
import {
  composeDraft,
  composeWithRegisterRetry,
  createAnthropicGenerator,
  createAnthropicRouteClassifier,
  isTransientProviderError,
  leadTextFromAnswers,
  retrieveKnowledgeEntries,
  PermanentGenerationError,
  type ComposeDraftResult,
  type DraftAttestation,
  type PriorSend,
} from "./drafting";
import type { FormAnswer } from "./meta";
import { fireEngagementConversions } from "./conversions";
import { assessAiBudget, guardGenerationBudget, maybeEmitSoftCapCrossed } from "./ai-budget";
import { priceGeneration } from "./model-router";
import { substituteBookingLink } from "./booking-link";
import {
  loadMemoryContext,
  resolveBookingUrlWithMemory,
  resolveSignOffWithMemory,
  type MemoryContext,
} from "./memory";
import { contactAlreadyReceivedFile, declareAttachment, findPublishedRouteGuide, type RouteGuide } from "./route-guides";
import { resolveEngagementRoute } from "./routes";
import { resolveFormRouteDefault } from "./returning-leads";
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
 * THE SEND BOUNDARY (Session 10): this runner STILL never marks a
 * communication `sent` — carriage belongs to the send pipeline (send.ts
 * through the 0021 doors), which the tick route runs after this pass. The
 * runner's business with a stamped draft ends at the stamp: it advances the
 * run and leaves the approved row for the dispatcher. The Session 6 STUB is
 * gone.
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

/**
 * Decision 119 — WYSIWYS is per-channel: a template row may carry
 * channel-specific bodies in attributes.bodies ({ [channel]: text }); the
 * body of the channel the draft will DISPATCH on wins over the row's default
 * body column. The WhatsApp entry is the Meta-approved template text
 * verbatim, so the stamped draft shows exactly the words the client will
 * receive. A blank channel entry never blanks a draft — the default holds.
 */
export function resolveTemplateBody(
  template: { body: string; attributes?: Record<string, unknown> | null },
  channel: string
): string {
  const bodies = template.attributes?.bodies as Record<string, unknown> | undefined;
  const specific = bodies?.[channel];
  return typeof specific === "string" && specific.trim() !== "" ? specific : template.body;
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

/** Run statuses a cancellation reaches — everything not already terminal
 * (the chore-cancel-replay-runs set). */
export const LIVE_RUN_STATUSES = ["running", "waiting", "blocked", "paused"] as const;

export interface HumanStageMoveInput {
  business_id: string;
  engagement_id: string;
  /** The target stage_definitions row — the installed template's vocabulary,
   * terminal states included (177f). */
  to_stage_id: string;
  /** The signed-in human's own actor. */
  actor_id: string;
  reason?: string;
}

export interface HumanStageMoveResult {
  stageKey: string;
  terminalOutcome: string | null;
  cancelledRunIds: string[];
}

/**
 * Session 30 (177f + 177d) — the human stage move. The 0016 door is the
 * enforcement (stage_id moves only through move_engagement_stage; the 0015
 * stage_history trigger refuses an actor without enquiry access); this
 * wrapper is the pen: it moves, events the act with the optional reason and
 * source "human", and — when the target is the DISQUALIFIED terminal —
 * CANCELS the enquiry's live workflow runs through their own gated door
 * (177d: drafts stop being GENERATED, not merely blocked at pre-flight;
 * cancel_workflow_run stands the mid-flight step runs down with the run).
 */
export async function moveEngagementStageAsHuman(
  db: SupabaseClient,
  input: HumanStageMoveInput
): Promise<HumanStageMoveResult> {
  const stages = await q<{ key: string; is_terminal: boolean; terminal_outcome: string | null }[]>(
    db
      .from("stage_definitions")
      .select("key, is_terminal, terminal_outcome")
      .eq("id", input.to_stage_id)
      .is("archived_at", null)
      .limit(1),
    "human stage-move stage lookup"
  );
  if (!stages[0]) throw new Error("The target stage does not exist");
  const stage = stages[0];

  const { error } = await db.rpc("move_engagement_stage", {
    p_engagement: input.engagement_id,
    p_to_stage: input.to_stage_id,
    p_moved_by: input.actor_id,
  });
  if (error) throw new Error(`move_engagement_stage failed: ${error.message}`);

  await emitEvent(db, {
    business_id: input.business_id,
    actor_id: input.actor_id,
    action: "engagement.stage_changed",
    entity_type: "engagement",
    entity_id: input.engagement_id,
    payload: {
      to_stage: stage.key,
      source: "human",
      ...(input.reason ? { reason: input.reason } : {}),
      ...(stage.is_terminal ? { terminal: true, outcome: stage.terminal_outcome } : {}),
    },
  });

  const cancelledRunIds: string[] = [];
  if (stage.terminal_outcome === "disqualified") {
    const runs = await q<{ id: string }[]>(
      db
        .from("workflow_runs")
        .select("id")
        .eq("engagement_id", input.engagement_id)
        .in("status", [...LIVE_RUN_STATUSES]),
      "disqualify live-run lookup"
    );
    for (const run of runs) {
      await cancelWorkflowRun(db, {
        business_id: input.business_id,
        run_id: run.id,
        actor_id: input.actor_id,
        reason: input.reason
          ? `enquiry disqualified: ${input.reason}`
          : "enquiry disqualified",
      });
      cancelledRunIds.push(run.id);
    }
  }
  return { stageKey: stage.key, terminalOutcome: stage.terminal_outcome, cancelledRunIds };
}

// ---------------------------------------------------------------------------
// The definition escape hatch (Session 21, founder-ruled): an OWNER may
// withdraw a definition at pending_approval — terminal, reason required,
// evented. The 0034 pipeline function is the gate; this wrapper puts the act
// on The Record (the pause/resume/cancel shape above).
// ---------------------------------------------------------------------------

/**
 * The single truth for whether the Withdraw control may render: only a
 * pending definition, only to the owner (decision 116 — no control that
 * cannot act; the database refuses everyone else regardless). Pure so the
 * harness proves the rendering law the same way the UI applies it.
 */
export function canWithdrawWorkflowDefinition(input: {
  status: string;
  isOwner: boolean;
}): boolean {
  return input.status === "pending_approval" && input.isOwner;
}

export interface WithdrawDefinitionInput {
  business_id: string;
  definition_id: string;
  /** The owner's own actor — the database refuses anyone else. */
  actor_id: string;
  reason: string;
  /** For the ledger payload, so History renders without a second lookup. */
  definition_key?: string;
  definition_version?: number;
}

export async function withdrawWorkflowDefinition(
  db: SupabaseClient,
  input: WithdrawDefinitionInput
): Promise<EventRow> {
  const { error } = await db.rpc("withdraw_workflow_definition", {
    p_def: input.definition_id,
    p_actor: input.actor_id,
    p_reason: input.reason,
  });
  if (error) throw new Error(`withdraw_workflow_definition failed: ${error.message}`);
  return emitEvent(db, {
    business_id: input.business_id,
    actor_id: input.actor_id,
    action: WORKFLOW_EVENT_KINDS.definitionWithdrawn,
    entity_type: "workflow_definition",
    entity_id: input.definition_id,
    payload: {
      reason: input.reason,
      ...(input.definition_key ? { definition_key: input.definition_key } : {}),
      ...(input.definition_version != null ? { definition_version: input.definition_version } : {}),
    },
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

/** EGRESS DIET (egress session): bundles carry only the columns the executors
 * read — the definition's key and the steps' execution fields. Full-row
 * selects on every tick were the top egress source on the free tier. */
type BundleDefinition = Pick<WorkflowDefinitionRow, "id" | "key">;
type BundleStep = Pick<WorkflowStepRow, "id" | "key" | "kind" | "config" | "sort_order">;

interface RunBundle {
  run: WorkflowRunRow;
  definition: BundleDefinition;
  steps: BundleStep[];
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
  const definitions = await q<BundleDefinition[]>(
    db.from("workflow_definitions").select("id, key").eq("id", runs[0].definition_id).limit(1),
    "definition lookup"
  );
  if (!definitions[0]) throw new Error(`Definition ${runs[0].definition_id} not found`);
  const steps = await q<BundleStep[]>(
    db
      .from("workflow_steps")
      .select("id, key, kind, config, sort_order")
      .eq("definition_id", runs[0].definition_id)
      .is("archived_at", null)
      .order("sort_order"),
    "steps lookup"
  );
  const bundle = { run: runs[0], definition: definitions[0], steps };
  cache.set(runId, bundle);
  return bundle;
}

function nextStepAfter(steps: BundleStep[], stepId: string): BundleStep | null {
  const index = steps.findIndex((s) => s.id === stepId);
  return index >= 0 && index + 1 < steps.length ? steps[index + 1]! : null;
}

/** Advance parameters for complete_step_run: the next step and its moment.
 * Wait steps sleep as data says, scaled through timeScale(). */
function advanceArgs(steps: BundleStep[], currentStepId: string, now: Date) {
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
  stepRun: Pick<StepRunRow, "id" | "step_id">,
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

// ---------------------------------------------------------------------------
// Step executors
// ---------------------------------------------------------------------------

interface EngagementFacts {
  id: string;
  business_id: string;
  title: string;
  owner_actor_id: string;
  template_type_id: string;
  attributes: Record<string, unknown>;
  attribution: Record<string, unknown> | null;
  /** Session 27 (D158): set when this enquiry succeeded a closed one for a
   * returning contact — the intro composes with returning context. */
  predecessor_engagement_id: string | null;
  stage: { label: string } | null;
  contact: { id: string; display_name: string; given_name: string | null } | null;
}

async function loadEngagementFacts(db: SupabaseClient, engagementId: string): Promise<EngagementFacts> {
  const engagements = await q<
    {
      id: string;
      business_id: string;
      title: string;
      owner_actor_id: string;
      template_type_id: string;
      attributes: Record<string, unknown>;
      attribution: Record<string, unknown> | null;
      predecessor_engagement_id: string | null;
      stage: { label: string } | { label: string }[] | null;
    }[]
  >(
    db
      .from("engagements")
      // Session 15: attributes carry the lead's form answers (PR-2) — the
      // drafting engine composes against what the lead SAID.
      .select("id, business_id, title, owner_actor_id, template_type_id, attributes, attribution, predecessor_engagement_id, stage:stage_definitions(label)")
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
  const row = engagements[0];
  // Supabase types a to-one embed as an array; normalise either shape.
  const stage = Array.isArray(row.stage) ? (row.stage[0] ?? null) : row.stage;
  return { ...row, stage, contact };
}

/** The installed no-go register (0022: templates.no_go_rules, seeded from
 * the v3 definition). Empty when no template is installed — the generation
 * prompt then carries no rules, and the 0026 heuristics still screen. */
async function loadNoGoRules(db: SupabaseClient, businessId: string): Promise<string[]> {
  const rows = await q<{ template: { no_go_rules: unknown } | { no_go_rules: unknown }[] | null }[]>(
    db
      .from("businesses")
      .select("template:templates!businesses_template_id_fkey(no_go_rules)")
      .eq("id", businessId)
      .limit(1),
    "no-go register lookup"
  );
  const embedded = rows[0]?.template;
  const template = Array.isArray(embedded) ? (embedded[0] ?? null) : embedded;
  const rules = template?.no_go_rules;
  return Array.isArray(rules) ? rules.map((r) => String(r)) : [];
}

/** Record a compliance check through the 0026 server-only door, evented. */
async function recordComplianceCheck(
  db: SupabaseClient,
  businessId: string,
  communicationId: string,
  actorId: string,
  attestation: DraftAttestation
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

async function templateVars(
  db: SupabaseClient,
  facts: EngagementFacts
): Promise<{ vars: Record<string, string>; settings: Record<string, unknown>; memory: MemoryContext }> {
  const owners = await q<{ display_name: string }[]>(
    db.from("actors").select("display_name").eq("id", facts.owner_actor_id).limit(1),
    "owner lookup"
  );
  const businesses = await q<{ name: string; settings: Record<string, unknown> | null }[]>(
    db.from("businesses").select("name, settings").eq("id", facts.business_id).limit(1),
    "business lookup"
  );
  const fullName = facts.contact?.display_name ?? "";
  const businessName = businesses[0]?.name ?? "";
  const settings = businesses[0]?.settings ?? {};
  // Founder-ruled (Session 15 close review): the email sign-off renders from
  // a business-identity field — never the owner's personal name, never
  // hardcoded. Only the firm-name default ships this session.
  // JUDGMENT: the settings key is `email_sign_off` (businesses.settings, the
  // General-tab identity store); the firm display name is the default when
  // the key is unset. Its Settings edit surface shipped with Session 16's
  // drafting-policy trio (decision 140) — the s15 "arrives with its session"
  // deferral is closed (stale clause cleaned at the Session 21 sweep).
  // Session 16 (PR-F): one resolver module (sign-off.ts) is the truth for
  // the text; approver mode resolves at render+stamp, never at generation.
  // Session 32 (D181, Q1 option A): Light's Memory is the single home for
  // the client-facing sign-off value; settings is the TRANSITIONAL fallback
  // until the seed backfill lands (noted at close for retirement).
  const memory = await loadMemoryContext(db, facts.business_id);
  const signOff = resolveSignOffWithMemory(memory, settings, businessName);
  return {
    vars: {
      first_name: facts.contact?.given_name ?? fullName.split(/\s+/)[0] ?? "",
      full_name: fullName,
      owner_name: owners[0]?.display_name ?? "",
      business_name: businessName,
      sign_off: signOff,
    },
    // Session 19 (PR-iv/PR-iii): the executors also need the business's
    // settings (booking URL now; carried alongside the vars so one lookup
    // serves both).
    settings,
    memory,
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

/**
 * PR-ii (Session 19) — the companion WhatsApp touch of a multi-channel
 * intro step. Fires ONLY where the contact holds a live CONSENTED whatsapp
 * channel AND the template carries a Meta-approved wa_template mapping
 * (decisions 118/119: the draft body is the approved template's exact
 * wording, per channel — WYSIWYS). Its own draft, its own individual stamp
 * (decision 113); it NEVER blocks the run — the primary's stamp does. The
 * one-pending-per-engagement-per-channel guard (0029) is pre-checked so an
 * existing pending WhatsApp draft means a silent, correct skip.
 * Returns a short outcome string for the step-run outcome payload.
 *
 * JUDGMENT: with two intro drafts, decision 48's "nurture waits anchor
 * after the intro stamp" reads as the EMAIL (primary) stamp — the run
 * blocks on it alone, and the companion's stamp or refusal never gates the
 * sequence. Awaiting sign-off at close.
 */
async function draftWhatsAppCompanion(
  db: SupabaseClient,
  bundle: RunBundle,
  step: BundleStep,
  stepRun: StepRunRow
): Promise<string> {
  const { run } = bundle;
  const drafter = (run.context.drafter_actor_id as string) ?? run.created_by;

  const facts = await loadEngagementFacts(db, run.engagement_id);
  if (!facts.contact) return "skipped: no client contact";

  // WhatsApp consent — the strict per-channel law (Spec 1 §4.1; the same
  // fact the readiness pre-flight will check at the stamp).
  const channels = await q<{ id: string; consent: Record<string, unknown> | null }[]>(
    db
      .from("contact_channels")
      .select("id, consent")
      .eq("contact_id", facts.contact.id)
      .eq("channel", "whatsapp")
      .is("archived_at", null),
    "companion consent lookup"
  );
  const consented = channels.some(
    (c) => c.consent?.transactional === true || c.consent?.marketing === true
  );
  if (!consented) return "skipped: no consented WhatsApp channel — email-only, silently correct";

  const templateKey = step.config.template;
  if (!templateKey) return "skipped: no template configured";
  const templates = await q<
    { id: string; key: string; version: number; subject: string | null; body: string; attributes: Record<string, unknown> }[]
  >(
    db
      .from("message_templates")
      .select("id, key, version, subject, body, attributes")
      .eq("business_id", run.business_id)
      .eq("key", templateKey)
      .is("archived_at", null)
      .order("version", { ascending: false })
      .limit(1),
    "companion template lookup"
  );
  if (!templates[0]) return "skipped: template not found";
  const raw = templates[0].attributes?.wa_template as
    | { name?: string; language?: string; params?: string[] }
    | undefined;
  if (!raw?.name) return "skipped: no approved WhatsApp template mapping — email-only, silently correct";

  // The 0029 guard: at most ONE pending outbound draft per engagement per
  // channel — an existing pending WhatsApp draft means this touch stands
  // down rather than colliding with the supersede machinery.
  const pending = await q<{ id: string }[]>(
    db
      .from("communications")
      .select("id")
      .eq("engagement_id", run.engagement_id)
      .eq("channel", "whatsapp")
      .eq("direction", "outbound")
      .eq("status", "pending_approval")
      .is("archived_at", null)
      .limit(1),
    "companion pending guard check"
  );
  if (pending.length) return "skipped: a pending WhatsApp draft already exists on this enquiry";

  const { vars } = await templateVars(db, facts);
  // Decision 119: the WhatsApp body is the Meta-approved template text
  // VERBATIM, from attributes.bodies.whatsapp — the stamp shows exactly the
  // words Meta will carry.
  const body = renderTemplate(resolveTemplateBody(templates[0], "whatsapp"), vars);
  const waTemplate = {
    name: raw.name,
    language: raw.language ?? "en_GB",
    ...(raw.params?.length
      ? {
          components: [
            { type: "body", parameters: raw.params.map((p) => ({ type: "text", text: vars[p] ?? "" })) },
          ],
        }
      : {}),
  };

  const threads = await q<{ id: string }[]>(
    db
      .from("comm_threads")
      .select("id")
      .eq("engagement_id", run.engagement_id)
      .eq("channel", "whatsapp")
      .is("archived_at", null)
      .limit(1),
    "companion thread lookup"
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
          channel: "whatsapp",
          subject: null,
        })
        .select("id"),
      "companion thread insert"
    );
    threadId = created[0]!.id;
  }

  const inserted = await q<{ id: string }[]>(
    db
      .from("communications")
      .insert({
        business_id: run.business_id,
        created_by: drafter,
        thread_id: threadId,
        contact_id: facts.contact.id,
        engagement_id: run.engagement_id,
        channel: "whatsapp",
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
          wa_template: waTemplate,
          companion: "whatsapp",
        },
      })
      .select("id"),
    "companion communication insert"
  );
  const commId = inserted[0]!.id;

  // C-2: an agent-drafted row needs its recorded check — the approved
  // template path attests as such (decision 132 rider 6).
  await recordComplianceCheck(db, run.business_id, commId, drafter, {
    attested: true,
    mode: "approved_template",
    statement: "Body is the Meta-approved template wording with variables filled; no generative content.",
  });

  await emitEvent(db, {
    business_id: run.business_id,
    actor_id: drafter,
    action: "communication.drafted",
    entity_type: "communication",
    entity_id: commId,
    payload: {
      channel: "whatsapp",
      engagement_id: run.engagement_id,
      workflow_run_id: run.id,
      step_key: step.key,
      template_key: templates[0].key,
      companion: true,
      note: "multi-touch intro — the WhatsApp companion of the email intro; its own individual stamp",
    },
  });

  await submitCommunication(db, {
    business_id: run.business_id,
    communication_id: commId,
    actor_id: drafter,
  });

  return `drafted: communication ${commId}`;
}

async function executeDraftComm(
  db: SupabaseClient,
  bundle: RunBundle,
  step: BundleStep,
  stepRun: StepRunRow,
  now: Date,
  report: TickReport
): Promise<void> {
  const { run } = bundle;
  const drafter = (run.context.drafter_actor_id as string) ?? run.created_by;
  const engineActor = (run.context.engine_actor_id as string) ?? run.created_by;

  // Idempotency: a crash between insert and completion must not draft twice.
  // PR-ii (Session 19): a step run may now own SEVERAL drafts — the primary
  // plus companion touches (attributes.companion = channel) — so the lookup
  // reads them all and the primary is the row without the companion mark.
  const existing = await q<
    { id: string; channel: string; contact_id: string | null; status: string; attributes: Record<string, unknown> | null }[]
  >(
    db
      .from("communications")
      .select("id, channel, contact_id, status, attributes")
      .eq("attributes->>step_run_id", stepRun.id),
    "draft idempotency lookup"
  );
  const existingCompanionChannels = new Set(
    existing.filter((c) => c.attributes?.companion).map((c) => c.channel)
  );

  let comm: { id: string; channel: string; contact_id: string | null; status: string } | null =
    existing.find((c) => !c.attributes?.companion) ?? null;
  if (!comm) {
    const facts = await loadEngagementFacts(db, run.engagement_id);
    if (!facts.contact) throw new Error(`Engagement ${run.engagement_id} has no client contact to write to`);
    const templateKey = step.config.template;
    if (!templateKey) throw new Error(`Step ${step.key} has no template configured`);
    const templates = await q<
      { id: string; key: string; version: number; channel: string; subject: string | null; body: string; attributes: Record<string, unknown> }[]
    >(
      db
        .from("message_templates")
        .select("id, key, version, channel, subject, body, attributes")
        .eq("business_id", run.business_id)
        .eq("key", templateKey)
        .is("archived_at", null)
        .order("version", { ascending: false })
        .limit(1),
      "template lookup"
    );
    if (!templates[0]) throw new Error(`Message template "${templateKey}" not found for this business`);

    const { vars, settings: businessSettings, memory } = await templateVars(db, facts);
    // PR-iv (Session 19): the firm's booking URL, resolved once — [link] in
    // any client-facing body becomes it; unset means no token may survive.
    // Session 32 (D181, Q1 option A): the memory fact is the home; settings
    // is the transitional fallback.
    const bookingUrl = resolveBookingUrlWithMemory(memory, businessSettings);
    const intended = (step.config.channel as string) ?? templates[0].channel;
    const picked = await pickChannel(db, facts.contact.id, intended, step.config.fallback_channel);

    // Session 15 — the query-aware drafting engine. Decision 119 holds: the
    // channel is picked FIRST, then that channel's body comes into being.
    //   - email lawfully carries free-form: Light COMPOSES against the
    //     lead's form answers + the published knowledge pack;
    //   - WhatsApp keeps the approved-template path VERBATIM (decisions
    //     118/119 — the stamp shows the exact wording Meta will carry);
    //     free-form WhatsApp stays template-rendered and answers to the
    //     session-window pre-flight, as before.
    const generative = picked.channel === "email";
    let body: string;
    let subject: string | null = templates[0].subject ? renderTemplate(templates[0].subject, vars) : null;
    let composed: ComposeDraftResult | null = null;
    let composeInput: Parameters<typeof composeDraft>[1] | null = null;
    let attestation: DraftAttestation;
    let registerRetried = false;
    let guide: RouteGuide | null = null;
    let budgetBefore: Awaited<ReturnType<typeof assessAiBudget>> | null = null;

    if (generative) {
      const generator = createAnthropicGenerator();
      if (!generator) {
        // Failure honesty: no provider is a VISIBLE failure with its reason
        // on The Record — never a silent fallback to the stub body.
        await emitEvent(db, {
          business_id: run.business_id,
          actor_id: drafter,
          action: DRAFTING_EVENT_KINDS.draftGenerationFailed,
          entity_type: "workflow_run",
          entity_id: run.id,
          payload: {
            step_run_id: stepRun.id,
            step_key: step.key,
            transient: false,
            reason: "ANTHROPIC_API_KEY is not configured — Light cannot compose",
          },
        });
        throw new Error("draft generation failed: ANTHROPIC_API_KEY is not configured — Light cannot compose");
      }

      const formAnswers = (facts.attributes?.form_answers as FormAnswer[] | undefined) ?? [];
      const leadText = `${leadTextFromAnswers(formAnswers)}\n${facts.title}`;
      try {
        // Session 22 (WS2, ruling 2b): the hard cap refuses GENERATION here,
        // server-side, before any model call — the s15 permanent-failure lane
        // (the catch below records the visible failure naming the cap and the
        // step fails loudly). The template path and every send continue; the
        // approval gate never sees this check.
        budgetBefore = await assessAiBudget(db, run.business_id);
        guardGenerationBudget(budgetBefore.spend_gbp, budgetBefore);

        // Session 27 (D158c): a successor enquiry for a returning contact
        // composes its intro WITH returning context — acknowledge prior
        // contact, reference the route, no cold introduction.
        const returningAttrs = (facts.attributes?.returning ?? null) as {
          resubmitted_at?: string;
          form_label?: string;
          changed?: Array<{ label?: string; value?: string; previous_value?: string | null }>;
        } | null;
        const isReturning = Boolean(facts.predecessor_engagement_id || returningAttrs);

        // Session 31 (D179c): route resolution — the 0042 ladder plus
        // Light's confident read over an unset or form_default source —
        // completes BEFORE composition; everything downstream (retrieval,
        // booklet, copy) keys on what it settles. The read is generation:
        // it runs behind the same budget guard, and its failure takes the
        // same visible lanes as composition (the catch below).
        const routeSource =
          typeof facts.attributes?.visa_route_source === "string"
            ? (facts.attributes.visa_route_source as string)
            : null;
        const currentRoute =
          typeof facts.attributes?.visa_route === "string" ? (facts.attributes.visa_route as string) : null;
        const formId =
          typeof facts.attribution?.form_id === "string" ? (facts.attribution.form_id as string) : null;
        const resolved = await resolveEngagementRoute(db, {
          business_id: run.business_id,
          engagement_id: run.engagement_id,
          current_route: currentRoute,
          current_source: routeSource,
          actor_id: drafter,
          classifier: createAnthropicRouteClassifier(),
          evidence: {
            enquiry_title: facts.title,
            form_label:
              returningAttrs?.form_label ?? resolveFormRouteDefault(businessSettings, formId)?.label ?? null,
            form_answers: formAnswers,
          },
        });

        const retrieval = await retrieveKnowledgeEntries(db, run.business_id, leadText, resolved.route);
        const noGoRules = await loadNoGoRules(db, run.business_id);

        // PR-i (Session 19) as re-ruled by D179c: the intro email carries
        // the RESOLVED route's PUBLISHED guide — never a text-matched one.
        // No resolved route = no route-specific booklet, ever: a missing
        // booklet is recoverable; a wrong one is not.
        let bookletAlreadySent = false;
        if (templateKey.startsWith("intro") && picked.channel === "email" && resolved.route) {
          guide = await findPublishedRouteGuide(db, run.business_id, [resolved.route]);
          // D158c: no duplicate booklet — the EXACT document this contact
          // already received is never attached (or offered) again; a guide
          // they never received may still ride.
          if (guide && isReturning && facts.contact) {
            bookletAlreadySent = await contactAlreadyReceivedFile(db, facts.contact.id, guide.file.id);
            if (bookletAlreadySent) guide = null;
          }
        }

        // Session 31 (D179b): a nudge composes as a FOLLOW-UP — it receives
        // what the enquiry has already been sent and never re-introduces
        // the firm.
        // JUDGMENT (Session 31): D179b's "what the thread has already been
        // sent" is read ENGAGEMENT-wide, not per comm_thread — the D169
        // ladder crosses channels (nudge 1 WhatsApp, nudges 2-3 email are
        // separate per-channel threads), and the person is one person.
        // Awaiting sign-off at close.
        let priorSends: PriorSend[] | null = null;
        if (!templateKey.startsWith("intro")) {
          const sent = await q<
            { channel: string; body: string; occurred_at: string | null; created_at: string; attributes: Record<string, unknown> | null }[]
          >(
            db
              .from("communications")
              .select("channel, body, occurred_at, created_at, attributes")
              .eq("engagement_id", run.engagement_id)
              .eq("direction", "outbound")
              .in("status", ["sent", "delivered", "read"])
              .is("archived_at", null)
              .order("created_at", { ascending: true })
              .limit(10),
            "prior sends lookup"
          );
          priorSends = sent.map((c) => ({
            at: (c.occurred_at ?? c.created_at).slice(0, 10),
            channel: c.channel,
            summary:
              (typeof c.attributes?.subject === "string" && c.attributes.subject) ||
              `${c.body.slice(0, 120)}${c.body.length > 120 ? "…" : ""}`,
          }));
        }

        composeInput = {
          business_name: vars.business_name ?? "",
          sign_off: vars.sign_off ?? vars.business_name ?? "",
          first_name: vars.first_name ?? "",
          full_name: vars.full_name ?? "",
          channel: picked.channel,
          task: templateKey.startsWith("intro") ? ("intro" as const) : ("nudge" as const),
          enquiry_title: facts.title,
          stage_label: facts.stage?.label ?? "",
          source: String(facts.attribution?.source ?? "unknown"),
          form_answers: formAnswers,
          no_go_rules: noGoRules,
          retrieval,
          booking_url: bookingUrl,
          attachment: guide ? { title: guide.title, filename: guide.file.filename } : null,
          returning: isReturning
            ? {
                prior_route: resolved.route,
                form_label: returningAttrs?.form_label ?? null,
                resubmitted_at: returningAttrs?.resubmitted_at ?? "recently",
                changed_lines: (returningAttrs?.changed ?? []).map(
                  (c) =>
                    `${c.label ?? "Detail"}: ${c.value ?? ""}${c.previous_value != null ? ` (was ${c.previous_value})` : " (new)"}`
                ),
                booklet_already_sent: bookletAlreadySent,
              }
            : null,
          prior_sends: priorSends?.length ? priorSends : null,
          // Session 32 (D181): the firm's memory rides the composition; its
          // entry ids land on the credit line.
          memory,
        };
        // Session 25 (register retry-once, founder-ordered): a register-screen
        // breach retries exactly ONCE with the violation fed back — evented on
        // The Record, never a loop. A second breach throws past this block
        // into the visible-failure lane below; nothing retries the retry.
        // JUDGMENT: the post-insert compliance-retry path below keeps its
        // best-effort behaviour — a register breach THERE leaves attempt 1's
        // recorded breach standing visibly (unapprovable, honest), which is
        // already the founder-ruled lane; only the initial composition gets
        // the automatic register retry.
        const outcome = await composeWithRegisterRetry(
          (inp, opts) => composeDraft(generator, inp, opts),
          composeInput,
          async (breach) => {
            await emitEvent(db, {
              business_id: run.business_id,
              actor_id: drafter,
              action: DRAFTING_EVENT_KINDS.draftRegisterRetried,
              entity_type: "workflow_run",
              entity_id: run.id,
              payload: {
                step_run_id: stepRun.id,
                step_key: step.key,
                violation: breach.breach,
                reason: breach.message,
              },
            });
            // WS2: the retry is generation too — the hard cap binds it.
            if (budgetBefore) guardGenerationBudget(budgetBefore.spend_gbp, budgetBefore);
          }
        );
        composed = outcome.composed;
        registerRetried = outcome.registerRetried;
        body = composed.body;
        subject = subject ?? composed.subject;
        attestation = composed.attestation;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const transient = isTransientProviderError(err);
        await emitEvent(db, {
          business_id: run.business_id,
          actor_id: drafter,
          action: DRAFTING_EVENT_KINDS.draftGenerationFailed,
          entity_type: "workflow_run",
          entity_id: run.id,
          payload: { step_run_id: stepRun.id, step_key: step.key, transient, reason },
        });
        if (transient) {
          // The step stays claimed-but-incomplete: the lease expires and a
          // later tick retries. Dispatch retries are free of model spend
          // only when a draft exists — none does yet, so regeneration IS
          // the retry.
          report.errors.push(`step ${stepRun.id}: transient draft generation failure — ${reason}`);
          return;
        }
        throw new Error(`draft generation failed: ${reason}`);
      }
    } else {
      // PR-iv: [link] resolves in template bodies too — same fail-fast lane
      // as unresolved braces (a token with no configured URL never sends).
      body = substituteBookingLink(renderTemplate(resolveTemplateBody(templates[0], picked.channel), vars), bookingUrl);
      // No generation happened: the body is founder-approved template
      // wording with variables filled — attested as such (C-2 requires an
      // attestation for every agent-drafted row born after 0026).
      attestation = {
        attested: true,
        mode: "approved_template",
        statement: "Body is the approved template wording with variables filled; no generative content.",
      };
    }

    // Session 10: a WhatsApp draft carries its Meta-approved template
    // reference (message_templates.attributes.wa_template: {name, language,
    // params: [var names]}) with the SAME rendered variables — the session
    // window pre-flight passes template messages, and the dispatcher sends
    // exactly what the stamp saw.
    let waTemplate: { name: string; language: string; components?: unknown[] } | null = null;
    if (picked.channel === "whatsapp") {
      const raw = (templates[0] as { attributes?: Record<string, unknown> }).attributes?.wa_template as
        | { name?: string; language?: string; params?: string[] }
        | undefined;
      if (raw?.name) {
        waTemplate = {
          name: raw.name,
          language: raw.language ?? "en_GB",
          ...(raw.params?.length
            ? {
                components: [
                  {
                    type: "body",
                    parameters: raw.params.map((p) => ({ type: "text", text: vars[p] ?? "" })),
                  },
                ],
              }
            : {}),
        };
      }
    }

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
            // The message's own client-facing subject (founder-ruled at the
            // first witnessed send): the dispatch path uses THIS, never the
            // thread's internal label.
            ...(subject ? { subject } : {}),
            ...(picked.fell_back ? { channel_fallback_from: intended } : {}),
            ...(waTemplate ? { wa_template: waTemplate } : {}),
            // PR-i (Session 19): the declared attachment the 0032 pre-flight
            // verifies and the dispatcher carries.
            ...(guide ? { attachments: [declareAttachment(guide)] } : {}),
            // Session 15: the credit line — the founder's visibility into
            // Light's spend and sources at the moment of stamping (PR-3).
            // Session 25: attempts counts every model call honestly — the
            // register retry-once is attempt 2 when it fired.
            ...(composed ? { credit_line: { ...composed.credit_line, attempts: registerRetried ? 2 : 1 } } : {}),
          },
        })
        .select("id, channel, contact_id, status"),
      "communication insert"
    );
    comm = inserted[0]!;

    // PR-i: the guide's file is LINKED to the draft — existence + linkage is
    // exactly what the ATTACHMENTS pre-flight verifies before the stamp.
    if (guide) {
      const { error: linkError } = await db.from("file_links").insert({
        business_id: run.business_id,
        file_id: guide.file.id,
        entity_type: "communication",
        entity_id: comm.id,
        role: "attachment",
      });
      if (linkError) throw new Error(`attachment link insert failed: ${linkError.message}`);
      await emitEvent(db, {
        business_id: run.business_id,
        actor_id: drafter,
        action: "communication.attachment_declared",
        entity_type: "communication",
        entity_id: comm.id,
        payload: {
          file_id: guide.file.id,
          filename: guide.file.filename,
          size_bytes: guide.file.size_bytes,
          content_item_id: guide.content_item_id,
          visa_route: guide.visa_route,
        },
      });
    }

    // The compliance check is recorded at generation (0026): heuristics run
    // server-side against the exact wording, the model's attestation rides
    // along, and the stamp is unreachable without a clean, attested check.
    let check = await recordComplianceCheck(db, run.business_id, comm.id, drafter, attestation);

    // The doctrine's retry rule: a Standard attempt that breaches retries
    // ONCE at the same tier with the specific failure fed back — recorded,
    // never silent (both checks persist on the append-only table). If the
    // retry still breaches, the draft stands with its RED chip: a visible
    // pre-flight failure the stamp refuses.
    if (composed && composeInput && check.result === "breach") {
      try {
        const generator = createAnthropicGenerator();
        if (generator) {
          // WS2: the retry is generation too — the hard cap binds it the
          // same way; a refusal here leaves attempt 1's recorded breach
          // standing (visible, unapprovable, honest).
          if (budgetBefore) guardGenerationBudget(budgetBefore.spend_gbp, budgetBefore);
          const retry = await composeDraft(generator, composeInput, {
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
                workflow_run_id: run.id,
                step_run_id: stepRun.id,
                template_key: templates[0].key,
                template_version: templates[0].version,
                ...(subject ? { subject } : {}),
                ...(picked.fell_back ? { channel_fallback_from: intended } : {}),
                // PR-i: the declared attachment survives the compliance retry.
                ...(guide ? { attachments: [declareAttachment(guide)] } : {}),
                credit_line: mergedCredit,
              },
            })
            .eq("id", comm.id);
          if (updError) throw new Error(`retry body update failed: ${updError.message}`);
          composed = {
            ...retry,
            credit_line: mergedCredit,
            // Both attempts are metered spend — the credit line prices the act.
            usage: {
              input_tokens: composed.usage.input_tokens + retry.usage.input_tokens,
              output_tokens: composed.usage.output_tokens + retry.usage.output_tokens,
            },
          };
          check = await recordComplianceCheck(db, run.business_id, comm.id, drafter, retry.attestation);
        }
      } catch (retryErr) {
        // The retry is best-effort: a failure here leaves attempt 1's
        // recorded breach standing — visible, unapprovable, honest.
        report.errors.push(
          `step ${stepRun.id}: compliance retry failed — ${retryErr instanceof Error ? retryErr.message : retryErr}`
        );
      }
    }

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

    if (composed) {
      // The credit line on The Record (doctrine: no invisible spend — every
      // metered act is a priced line; events.cost feeds the billing surface).
      // Session 22 (WS2): the cost block now carries the token split and the
      // PRICED amount (list rates + recorded fx, model-router.ts) — our
      // recorded cost, no margin invented (ruling 2a).
      const price = priceGeneration({
        model: composed.credit_line.model,
        input_tokens: composed.usage.input_tokens,
        output_tokens: composed.usage.output_tokens,
        cache_read_tokens: composed.credit_line.cache?.read_tokens,
        cache_write_tokens: composed.credit_line.cache?.written_tokens,
      });
      await emitEvent(db, {
        business_id: run.business_id,
        actor_id: drafter,
        action: DRAFTING_EVENT_KINDS.draftGenerated,
        entity_type: "communication",
        entity_id: comm.id,
        payload: {
          tier: composed.credit_line.tier,
          escalation_reason: composed.credit_line.reason,
          context_tokens: composed.credit_line.context_tokens,
          budget_tokens: composed.credit_line.budget_tokens,
          knowledge_entry_ids: composed.credit_line.knowledge_entry_ids,
          compliance: check.result,
          step_key: step.key,
        },
        cost: {
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
        },
      });
      // WS2: a soft-cap crossing lands once per month on The Record; it
      // never blocks — the banner is the pages' live read.
      if (budgetBefore && price) {
        await maybeEmitSoftCapCrossed(db, {
          business_id: run.business_id,
          actor_id: drafter,
          before_gbp: budgetBefore.spend_gbp,
          after_gbp: budgetBefore.spend_gbp + price.amount_gbp,
          budget: budgetBefore,
        });
      }
    }

    // Session 31 (D179c): Light's route read no longer rides here — route
    // resolution completed BEFORE composition (resolveEngagementRoute,
    // routes.ts), so the draft's retrieval and booklet already keyed on it.

    await submitCommunication(db, {
      business_id: run.business_id,
      communication_id: comm.id,
      actor_id: drafter,
    });
  }

  // PR-ii (Session 19): companion touches — config-driven multi-channel.
  // Each companion is its own draft with its own individual stamp; a
  // companion that cannot fire is a silent, correct skip recorded in the
  // step outcome; a companion FAILURE never blocks the primary or the run.
  const companionChannels = Array.isArray(step.config.companion_channels)
    ? step.config.companion_channels
    : [];
  const companions: Record<string, string> = {};
  // JUDGMENT: the WhatsApp companion carries the APPROVED intro template
  // VERBATIM (118/119) — a cold introduction; a returning lead must never
  // receive it, so the companion stands down for successor enquiries,
  // recorded in the step outcome (the D146 precedent: silently correct,
  // stated where the run's books are kept) (Session 27, D158c).
  let returningEngagement = false;
  if (companionChannels.length > 0) {
    const rows = await q<{ predecessor_engagement_id: string | null; attributes: Record<string, unknown> | null }[]>(
      db
        .from("engagements")
        .select("predecessor_engagement_id, attributes")
        .eq("id", run.engagement_id)
        .limit(1),
      "companion returning lookup"
    );
    returningEngagement = Boolean(rows[0]?.predecessor_engagement_id || rows[0]?.attributes?.returning);
  }
  for (const channel of companionChannels) {
    if (channel === comm.channel) {
      companions[channel] = "skipped: the primary draft already covers this channel";
      continue;
    }
    if (returningEngagement) {
      companions[channel] = "skipped: returning lead — the approved intro template is a cold introduction (D158c)";
      continue;
    }
    if (existingCompanionChannels.has(channel)) {
      companions[channel] = "already drafted (idempotent)";
      continue;
    }
    if (channel !== "whatsapp") {
      companions[channel] = "skipped: unsupported companion channel in Phase 2";
      continue;
    }
    try {
      companions[channel] = await draftWhatsAppCompanion(db, bundle, step, stepRun);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      companions[channel] = `error: ${reason}`;
      report.errors.push(`step ${stepRun.id}: whatsapp companion failed (primary unaffected) — ${reason}`);
    }
  }
  const companionOutcome = Object.keys(companions).length ? { companions } : {};

  if (step.config.await_approval) {
    const { error } = await db.rpc("mark_step_awaiting_approval", {
      p_step_run: stepRun.id,
      p_outcome: { communication_id: comm.id, ...companionOutcome },
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
    { communication_id: comm.id, ...companionOutcome },
    advanceArgs(bundle.steps, step.id, now),
    report
  );
}

async function executeCreateTask(
  db: SupabaseClient,
  bundle: RunBundle,
  step: BundleStep,
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
    const { vars } = await templateVars(db, facts);
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
  step: BundleStep,
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

  /*
   * Session 30 (177f), JUDGMENT (Lane B): a human stage move is a recorded
   * fact the workflow respects — when the engagement's stage was LAST moved
   * by a human hand, the machine stands down rather than overwrite it. The
   * comparison is "who spoke last": a stage the machine set (or an enquiry
   * no human ever touched) behaves exactly as before. Enforced here because
   * the rule weighs the machine's intent against the human's recorded act —
   * the 0016 door and the 0015 grant check stay the database truth beneath.
   */
  const lastMoves = await q<{ moved_by: string }[]>(
    db
      .from("stage_history")
      .select("moved_by")
      .eq("engagement_id", run.engagement_id)
      .order("moved_at", { ascending: false })
      .limit(1),
    "last stage-move lookup"
  );
  if (lastMoves[0]) {
    const movers = await q<{ actor_type: string }[]>(
      db.from("actors").select("actor_type").eq("id", lastMoves[0].moved_by).limit(1),
      "last stage-mover lookup"
    );
    if (movers[0]?.actor_type === "human") {
      // The stand-down is recorded on the step run's outcome — the same
      // visibility the decision-15 refusal carries.
      await completeStep(
        db,
        bundle,
        stepRun,
        "skipped",
        {
          reason: "a human stage move stands — a machine move never overwrites it (177f)",
          condition: "human_stage_move_stands",
        },
        advanceArgs(bundle.steps, step.id, now),
        report
      );
      return;
    }
  }

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

/** The run's NUDGES — communications born from draft_comm steps marked
 * cancel_on_reply (the nurture touches), identified by data, not by name. */
async function loadRunNudges(db: SupabaseClient, bundle: RunBundle): Promise<NudgeFact[]> {
  const nudgeStepIds = new Set(
    bundle.steps.filter((s) => s.kind === "draft_comm" && s.config.cancel_on_reply).map((s) => s.id)
  );
  if (nudgeStepIds.size === 0) return [];
  const stepRuns = await q<{ id: string; step_id: string }[]>(
    db.from("step_runs").select("id, step_id").eq("run_id", bundle.run.id),
    "nudge step-run lookup"
  );
  const stepOf = new Map(stepRuns.map((sr) => [sr.id, sr.step_id]));
  const comms = await q<{ id: string; status: string; attributes: Record<string, unknown> }[]>(
    db
      .from("communications")
      .select("id, status, attributes")
      .eq("attributes->>workflow_run_id", bundle.run.id)
      .eq("direction", "outbound")
      .is("archived_at", null),
    "nudge communications lookup"
  );
  return comms
    .filter((c) => {
      const stepRunId = c.attributes?.step_run_id as string | undefined;
      const stepId = stepRunId ? stepOf.get(stepRunId) : undefined;
      return stepId ? nudgeStepIds.has(stepId) : false;
    })
    .map((c) => ({ communication_id: c.id, status: c.status }));
}

/**
 * Decision 15 — the close step distinguishes the two silences on the ledger.
 * Closing as Unresponsive is allowed only when nudges genuinely reached the
 * client; nudges that died unstamped in the inbox NEVER close an enquiry —
 * the step skips with its reason on The Record and the enquiry stays open
 * for a human. Policy constants live in auto-close.ts (PROVISIONAL, tuned
 * from live ledger data post-go-live per LEAD-LOG-BASELINE).
 */
async function executeClose(
  db: SupabaseClient,
  bundle: RunBundle,
  step: BundleStep,
  stepRun: StepRunRow,
  now: Date,
  report: TickReport
): Promise<void> {
  const { run } = bundle;
  const stageKey = step.config.stage;
  const engagements = await q<{ template_type_id: string }[]>(
    db.from("engagements").select("template_type_id").eq("id", run.engagement_id).limit(1),
    "close engagement lookup"
  );
  const stages = await q<{ terminal_outcome: string | null }[]>(
    db
      .from("stage_definitions")
      .select("terminal_outcome")
      .eq("engagement_type_id", engagements[0]?.template_type_id ?? "")
      .eq("key", stageKey ?? "")
      .is("archived_at", null)
      .limit(1),
    "close stage lookup"
  );
  if (stages[0]?.terminal_outcome === "unresponsive") {
    const nudges = await loadRunNudges(db, bundle);
    const verdict = evaluateAutoClose(nudges);
    if (!verdict.close) {
      const engineActor = (run.context.engine_actor_id as string) ?? run.created_by;
      await emitEvent(db, {
        business_id: run.business_id,
        actor_id: engineActor,
        action: SEND_EVENT_KINDS.workflowAutoCloseRefused,
        entity_type: "engagement",
        entity_id: run.engagement_id,
        payload: {
          workflow_run_id: run.id,
          step_key: step.key,
          reason: verdict.reason,
          nudges_drafted: verdict.nudges_drafted,
          nudges_sent: verdict.nudges_sent,
        },
      });
      await completeStep(
        db,
        bundle,
        stepRun,
        "skipped",
        {
          reason: verdict.reason,
          condition: "decision_15_auto_close",
          nudges_drafted: verdict.nudges_drafted,
          nudges_sent: verdict.nudges_sent,
        },
        advanceArgs(bundle.steps, step.id, now),
        report
      );
      return;
    }
  }
  await executeMoveStage(db, bundle, step, stepRun, now, report);
}

async function executeFireConversion(
  db: SupabaseClient,
  bundle: RunBundle,
  step: BundleStep,
  stepRun: StepRunRow,
  now: Date,
  report: TickReport
): Promise<void> {
  const { run } = bundle;
  // Session 22 (WS1): the STUB retires — the ruled conversions (Schedule on
  // consultation_booked, Purchase on instructed; junk teaches Meta NOTHING)
  // fire through the real Conversions layer. Provider failures are recorded,
  // visible and retried by the tick sweep; the run is NEVER blocked by the
  // ad platform (ruling 1e) — the step completes with an honest outcome
  // either way.
  let outcome: Record<string, unknown>;
  let status: "completed" | "skipped" = "completed";
  try {
    const fired = await fireEngagementConversions(db, {
      business_id: run.business_id,
      engagement_id: run.engagement_id,
    });
    if (!fired.enabled) {
      status = "skipped";
      outcome = { reason: "conversions are OFF for this business (Settings → Integrations)", conversions_enabled: false };
    } else {
      outcome = {
        conversions_enabled: true,
        sent: fired.sent,
        failed: fired.failed,
        ...(fired.skipped.length ? { skipped: fired.skipped } : {}),
      };
    }
  } catch (err) {
    // Even a resolver failure never blocks the run — the sweep owns retries.
    status = "skipped";
    outcome = { reason: `conversion layer unavailable: ${err instanceof Error ? err.message : String(err)}` };
  }
  await completeStep(db, bundle, stepRun, status, outcome, advanceArgs(bundle.steps, step.id, now), report);
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
    errors: [],
  };
  const bundles = new Map<string, RunBundle>();
  const now = () => options.now ?? new Date();

  // -- Phase 1: trigger matching — active definitions consume unclaimed
  // trigger events (idempotent: one run per event, one live run per lead).
  // EGRESS DIET: the scan reads only the id and the attribution source — a
  // full-payload select re-transferred every Meta lead's field_data on every
  // tick, forever, and was a top egress source. Non-engagement events are
  // excluded by indexed predicate (events_entity_idx) instead of read-then-
  // skipped; consumed lookups carry only the trigger_event_id.
  // WS6 (Session 23, founder-ruled after the 116-burst): consumption is
  // per workflow KEY (workflow_trigger_consumptions — a re-issue inherits
  // its predecessors' consumed history), and an activated re-issue starts
  // runs only for arrivals AFTER the predecessor's consumption frontier
  // (trigger_frontier_at, stamped by the gated activation). The claim
  // constraint in start_workflow_run makes replays structurally impossible
  // even if this scan is wrong.
  const definitions = await q<
    (Pick<WorkflowDefinitionRow, "id" | "business_id" | "key" | "trigger"> & {
      trigger_frontier_at: string | null;
    })[]
  >(
    db
      .from("workflow_definitions")
      .select("id, business_id, key, trigger, trigger_frontier_at")
      .eq("status", "active")
      .is("archived_at", null),
    "active definitions"
  );
  for (const definition of definitions) {
    const action = definition.trigger?.action;
    if (!action) continue;
    try {
      let eventScan = db
        .from("events")
        .select("id, entity_id, source:payload->attribution->>source")
        .eq("business_id", definition.business_id)
        .eq("action", action)
        .eq("entity_type", "engagement");
      if (definition.trigger_frontier_at) {
        eventScan = eventScan.gt("occurred_at", definition.trigger_frontier_at);
      }
      const events = await q<{ id: string; entity_id: string | null; source: string | null }[]>(
        eventScan.order("occurred_at", { ascending: true }).limit(200),
        "trigger event scan"
      );
      if (events.length === 0) continue;
      const consumedRows = await q<{ trigger_event_id: string }[]>(
        db
          .from("workflow_trigger_consumptions")
          .select("trigger_event_id")
          .eq("business_id", definition.business_id)
          .eq("workflow_key", definition.key),
        "consumed trigger lookup"
      );
      const consumed = new Set(consumedRows.map((r) => r.trigger_event_id).filter(Boolean));
      const source = definition.trigger?.source;
      let actors: { engine_actor_id: string; drafter_actor_id: string } | null = null;

      for (const evt of events) {
        if (consumed.has(evt.id)) continue;
        if (!evt.entity_id) continue;
        if (source && evt.source !== source) continue;
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
          // Another live run already works this lead, a parallel tick got
          // here first, or the KEY already consumed this event (WS6) — all
          // are the idempotency structures doing their job.
          if (
            !/duplicate key|workflow_runs_one_live_uniq|workflow_runs_trigger_event_uniq|workflow_trigger_consumptions/.test(
              message
            )
          ) {
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

    // Phase 2: awaiting-approval steps whose draft got the STAMP move on.
    // The stamp is what the run was blocked on; carriage is the send
    // pipeline's business (send.ts, after this pass). A stamped draft may
    // already read sent/delivered/read — or failed, which is a visible state
    // for a human, not a reason to hold the run's independent steps hostage.
    // A rejected draft returns to `draft` with no stamp and the run stays
    // blocked, exactly as before.
    //
    // EGRESS DIET: inverted — instead of loading every awaiting step's full
    // run/definition/steps bundle and THEN discovering its draft is unstamped
    // (the shadow-mode rejection pile made that ~100 bundles per tick), the
    // sweep reads only (id, run_id, step_id, communication_id) per awaiting
    // step, asks in one batched indexed query which of those drafts are
    // stamped, and touches a bundle only for genuine unblocks — steady state
    // transfers two small queries and loads nothing.
    const awaiting = await q<{ id: string; run_id: string; step_id: string; communication_id: string | null }[]>(
      db
        .from("step_runs")
        .select("id, run_id, step_id, communication_id:outcome->>communication_id")
        .eq("status", "awaiting_approval"),
      "awaiting steps"
    );
    const awaitedCommIds = [...new Set(awaiting.map((s) => s.communication_id).filter((v): v is string => Boolean(v)))];
    const stampedStatusByComm = new Map<string, string>();
    for (let i = 0; i < awaitedCommIds.length; i += 100) {
      const chunk = awaitedCommIds.slice(i, i + 100);
      const rows = await q<{ id: string; status: string }[]>(
        db
          .from("communications")
          .select("id, status")
          .in("id", chunk)
          .in("status", ["approved", "sent", "delivered", "read", "failed"]),
        "stamped drafts lookup"
      );
      for (const row of rows) stampedStatusByComm.set(row.id, row.status);
    }
    for (const stepRun of awaiting) {
      if (!stepRun.communication_id) continue;
      const commStatus = stampedStatusByComm.get(stepRun.communication_id);
      if (!commStatus) continue; // unstamped (incl. shadow-mode rejections) — the run stays blocked
      try {
        const bundle = await loadRunBundle(db, stepRun.run_id, bundles);
        if (bundle.run.status !== "blocked") continue;
        await completeStep(
          db,
          bundle,
          stepRun,
          "completed",
          { communication_id: stepRun.communication_id, stamped: true, communication_status: commStatus },
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
            await executeMoveStage(db, bundle, step, stepRun, now(), report);
            break;
          case "close":
            await executeClose(db, bundle, step, stepRun, now(), report);
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

  // Carriage of stamped drafts — workflow-born and hand-written alike — is
  // the send pipeline's sweep (dispatchApprovedCommunications in send.ts),
  // which the tick route runs after this pass. The Session 6 stub sweep that
  // lived here is gone.
  return report;
}
