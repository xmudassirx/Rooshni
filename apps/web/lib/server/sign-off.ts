import "server-only";
import type { SupabaseClient } from "@rooshni/db";
import {
  createServiceClient,
  emitEvent,
  loadMemoryContext,
  memoryFactValue,
  resolveSignOffBody,
  resolveSignOffMode,
  resolveSignOffText,
  INBOUND_EVENT_KINDS,
  MEMORY_FACT_KEYS,
} from "@rooshni/db";

/**
 * Session 16 (PR-F, decision 133e) — the stamp-time half of approver-mode
 * sign-off. Render and stamp share ONE deterministic resolver (sign-off.ts
 * in @rooshni/db): the card showed the body with the approver's name; this
 * writes exactly that transformation onto the STORED body (never trusting a
 * client copy), re-runs the compliance check on the exact resolved words
 * with the carried attestation (decision 132's edited-body semantics), and
 * puts the resolution on The Record — then the caller stamps. A failure
 * anywhere returns an error and the stamp is withheld: fail closed, never a
 * body that changes after the stamp.
 */
export async function resolveSignOffAtStamp(
  db: SupabaseClient,
  business: { id: string; name: string },
  approver: { id: string; display_name: string },
  communicationId: string
): Promise<{ error: string | null }> {
  const { data: bizRow, error: bizError } = await db
    .from("businesses")
    .select("settings")
    .eq("id", business.id)
    .maybeSingle();
  if (bizError) return { error: `Sign-off settings lookup failed: ${bizError.message}` };
  const settings = (bizRow?.settings ?? {}) as Record<string, unknown>;
  if (resolveSignOffMode(settings) !== "approver") return { error: null };

  const { data: comm, error: commError } = await db
    .from("communications")
    .select("id, body, channel, status, attributes, compliance_required")
    .eq("id", communicationId)
    .eq("business_id", business.id)
    .maybeSingle();
  if (commError) return { error: `Draft lookup failed: ${commError.message}` };
  if (!comm || comm.channel !== "email" || comm.status !== "pending_approval") return { error: null };

  const attrs = (comm.attributes ?? {}) as Record<string, unknown>;
  // Session 32 (D181, Q1): the memory signature fact joins the candidate
  // list — Memory is the sign-off's home now; the settings text stays a
  // candidate so bodies drafted before the move still resolve.
  const memory = await loadMemoryContext(db, business.id);
  const memorySignature = memoryFactValue(memory, MEMORY_FACT_KEYS.signature);
  const candidates = [
    ...(memorySignature ? [memorySignature] : []),
    resolveSignOffText(settings, business.name),
    business.name,
    ...(typeof attrs.sign_off_resolved_to === "string" ? [attrs.sign_off_resolved_to] : []),
  ];
  const resolved = resolveSignOffBody(comm.body as string, candidates, approver.display_name);
  if (resolved === null) return { error: null }; // nothing to resolve — what was seen is what sends

  const { error: updateError } = await db
    .from("communications")
    .update({
      body: resolved,
      attributes: { ...attrs, sign_off_resolved_to: approver.display_name },
    })
    .eq("id", communicationId)
    .eq("business_id", business.id);
  if (updateError) return { error: `Sign-off resolution failed: ${updateError.message}` };

  await emitEvent(db, {
    business_id: business.id,
    actor_id: approver.id,
    action: INBOUND_EVENT_KINDS.communicationSignOffResolved,
    entity_type: "communication",
    entity_id: communicationId,
    payload: { resolved_to: approver.display_name, mode: "approver" },
  });

  // The 0026 gate demands a recorded check on EXACTLY the current wording —
  // the resolution changed it, so re-check with the carried attestation
  // (heuristics re-screen the words; the attestation attests the
  // generation). Server-only door: the service client carries the call.
  if (comm.compliance_required) {
    const service = createServiceClient();
    const { data: lastCheck } = await service
      .from("communication_compliance_checks")
      .select("attestation")
      .eq("communication_id", communicationId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const { error: checkError } = await service.rpc("run_compliance_check", {
      p_comm: communicationId,
      p_actor: approver.id,
      p_attestation: lastCheck?.attestation ?? null,
    });
    if (checkError) {
      return {
        error: `The sign-off resolved but the compliance re-check failed — the stamp is withheld (fail closed): ${checkError.message}`,
      };
    }
  }
  return { error: null };
}
