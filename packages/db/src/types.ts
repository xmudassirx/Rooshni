/**
 * Hand-maintained types for the Spec 1 schema (v0.5).
 * Generated types (supabase gen types) can replace these once the CI pipeline exists.
 */

export type ActorType = "human" | "agent" | "workflow" | "integration";

export type EventAction = `${string}.${string}`;

/** Spec 1 §5.2 — the append-only audit ledger row. */
export interface EventRow {
  id: string;
  business_id: string;
  actor_id: string;
  action: EventAction;
  entity_type: string | null;
  entity_id: string | null;
  payload: Record<string, unknown>;
  approval: {
    level: number;
    gate_id?: string;
    approved_by: string;
    decided_at: string;
  } | null;
  cost: {
    credits?: number;
    provider?: string;
    model?: string;
    tokens?: number;
  } | null;
  occurred_at: string;
}

// --- Spec 3: permissions and approvals ------------------------------------

export type GrantAccess = "view" | "draft" | "execute";
export type GrantDuration = "this_task" | "until" | "standing";
export type GrantVia = "chat" | "voice" | "dashboard";
export type GrantScopeLevel = "account" | "business" | "engagement";

/** Spec 3 §3 — no null scopes, ever. */
export interface GrantScope {
  level: GrantScopeLevel;
  ref: string;
}

/** Spec 3 §4 — approval levels 0–4, stored in `permission_levels`. */
export type PermissionLevel = 0 | 1 | 2 | 3 | 4;

export interface PermissionLevelRow {
  level: PermissionLevel;
  key: string;
  label: string;
  meaning: string;
}

/** Spec 3 §3a — platform tool registry row. */
export interface ToolRow {
  key: string;
  label: string;
  category: string;
  default_level: PermissionLevel;
  surface: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/** Spec 3 §3 — a scoped permission held by an actor (human or AI alike). */
export interface GrantRow {
  id: string;
  business_id: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  archived_at: string | null;
  grantee_actor_id: string;
  tool: string;
  access: GrantAccess;
  scope: GrantScope;
  duration: GrantDuration;
  expires_at: string | null;
  granted_by_actor_id: string;
  via: GrantVia;
  revoked_at: string | null;
  revoked_by_actor_id: string | null;
  last_used_at: string | null;
  use_count: number;
}

// --- Session 3: the Approval Inbox ------------------------------------------

/** One deterministic readiness check (Spec 3 §6, decision 11). */
export interface PreflightCheck {
  key: "body" | "placeholders" | "consent" | "attachment" | string;
  label: string;
  pass: boolean;
  detail: string | null;
}

/** The checklist shown on an inbox card; `pass` gates the Approve control. */
export interface PreflightResult {
  pass: boolean;
  checks: PreflightCheck[];
}

export type ApprovalInboxItemType = "communication" | "content" | "task";

/** One row of public.approval_inbox — a view over the pending states. */
export interface ApprovalInboxRow {
  item_type: ApprovalInboxItemType;
  item_id: string;
  business_id: string;
  engagement_id: string | null;
  contact_id: string | null;
  channel: string | null;
  title: string | null;
  preview: string | null;
  drafted_by_actor_id: string;
  drafted_by: string | null;
  drafted_by_type: ActorType | null;
  awaiting_since: string;
  scheduled_for: string | null;
  /** Communications only; null for content and tasks (no pre-flight yet). */
  preflight: PreflightResult | null;
  preflight_pass: boolean | null;
}

// --- Spec 4: the workflow engine ---------------------------------------------

export type WorkflowDefinitionStatus = "draft" | "pending_approval" | "active" | "paused";
export type WorkflowRunStatus = "running" | "waiting" | "blocked" | "completed" | "cancelled" | "paused";
export type StepRunStatus =
  | "scheduled"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "skipped"
  | "failed"
  | "cancelled";
export type WorkflowStepKind =
  | "draft_comm"
  | "create_task"
  | "wait"
  | "move_stage"
  | "branch"
  | "close"
  | "fire_conversion"
  | "notify";

/** A real-world duration, as stored in step config. Scaled ONLY at scheduling
 * time via scaleDurationMs() — never pre-scaled in data. */
export interface RealDuration {
  days?: number;
  hours?: number;
  minutes?: number;
  seconds?: number;
}

/** Spec 4 §3 — workflow_steps.config: template ref, channel, assignee, wait
 * duration, branch conditions. Phase 1 evaluator keys documented inline. */
export interface WorkflowStepConfig {
  /** message_templates.key (highest live version wins). */
  template?: string;
  channel?: string;
  /** Used when the configured channel has no consented contact channel. */
  fallback_channel?: string;
  /** true = the run parks at `blocked` until the draft is stamped. */
  await_approval?: boolean;
  /** wait steps: how long the timer sleeps (real time; TIME_SCALE applies). */
  wait?: RealDuration;
  /** create_task: due offset from execution (real time; TIME_SCALE applies). */
  due?: RealDuration;
  title?: string;
  description?: string;
  /** Phase 1: "owner" resolves to the engagement's accountable human. */
  assignee?: string;
  priority?: string;
  /** stage_definitions.key for move_stage/close steps. */
  stage?: string;
  /** Condition gate: the step runs only when this holds (unknown/unobservable
   * conditions resolve false and the step is SKIPPED on the ledger). */
  when?: string;
  /** Nurture touches: an inbound reply cancels the remaining queued touches. */
  cancel_on_reply?: boolean;
  /** fire_conversion: which Meta signal the (Phase 1: STUB) executor logs. */
  signal?: string;
  cooling?: RealDuration;
  [key: string]: unknown;
}

export interface WorkflowDefinitionRow {
  id: string;
  business_id: string;
  created_at: string;
  updated_at: string;
  created_by: string;
  archived_at: string | null;
  attributes: Record<string, unknown>;
  external_refs: unknown[];
  key: string;
  version: number;
  template_id: string;
  trigger: { action?: string; source?: string; [key: string]: unknown };
  status: WorkflowDefinitionStatus;
  description_plain: string;
  approved_by_actor_id: string | null;
}

export interface WorkflowStepRow {
  id: string;
  business_id: string;
  definition_id: string;
  key: string;
  sort_order: number;
  kind: WorkflowStepKind;
  config: WorkflowStepConfig;
  gate_level: number | null;
  archived_at: string | null;
}

export interface WorkflowRunRow {
  id: string;
  business_id: string;
  created_by: string;
  definition_id: string;
  engagement_id: string;
  status: WorkflowRunStatus;
  current_step: string | null;
  started_at: string;
  context: Record<string, unknown>;
  archived_at: string | null;
}

export interface StepRunRow {
  id: string;
  business_id: string;
  created_by: string;
  run_id: string;
  step_id: string;
  status: StepRunStatus;
  scheduled_for: string;
  started_at: string | null;
  finished_at: string | null;
  outcome: Record<string, unknown>;
}

export interface MessageTemplateRow {
  id: string;
  business_id: string;
  key: string;
  channel: string;
  subject: string | null;
  body: string;
  locale: string;
  version: number;
  archived_at: string | null;
}

/** What one runWorkflowTick() pass did — returned to the cron/route caller. */
export interface TickReport {
  runs_started: number;
  steps_completed: number;
  steps_skipped: number;
  steps_failed: number;
  steps_awaiting_approval: number;
  runs_completed: number;
  sends_stubbed: number;
  errors: string[];
}

export interface EmitEventInput {
  business_id: string;
  actor_id: string;
  action: EventAction;
  entity_type?: string;
  entity_id?: string;
  payload?: Record<string, unknown>;
  approval?: EventRow["approval"];
  cost?: EventRow["cost"];
  /** Defaults to now() in the database when omitted. */
  occurred_at?: string;
}
