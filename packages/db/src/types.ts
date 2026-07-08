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
