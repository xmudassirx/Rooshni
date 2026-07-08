import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmitEventInput, EventRow } from "./types";

/**
 * The single write path to the events ledger (Spec 1 §5.2).
 *
 * Every part of the system that records an event calls this — seed scripts,
 * workflow steps, connectors, server routes. Nothing inserts into `events`
 * directly. The table itself is append-only (database triggers refuse
 * UPDATE and DELETE), so what this writes is permanent.
 */
export async function emitEvent(
  db: SupabaseClient,
  input: EmitEventInput
): Promise<EventRow> {
  if (!/^[a-z_]+\.[a-z_]+$/.test(input.action)) {
    throw new Error(
      `Event action must be a namespaced verb like "contact.created", got "${input.action}".`
    );
  }

  const { data, error } = await db
    .from("events")
    .insert({
      business_id: input.business_id,
      actor_id: input.actor_id,
      action: input.action,
      entity_type: input.entity_type ?? null,
      entity_id: input.entity_id ?? null,
      payload: input.payload ?? {},
      approval: input.approval ?? null,
      cost: input.cost ?? null,
      ...(input.occurred_at ? { occurred_at: input.occurred_at } : {}),
    })
    .select()
    .single();

  if (error) {
    throw new Error(`emitEvent failed for "${input.action}": ${error.message}`);
  }
  return data as EventRow;
}
