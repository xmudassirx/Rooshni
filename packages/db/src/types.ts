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
