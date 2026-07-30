import type { SupabaseClient } from "@supabase/supabase-js";
import { emitEvent } from "./events";
import { EVENT_KINDS, FIRST_LIGHT_EVENT_KINDS } from "./event-kinds";
import type { FirstLightPredicateKey } from "./onboarding";

/**
 * First Light — the earned-tick engine (Session 11; decisions 81–83).
 *
 * Predicates are ROWS (0020): state in the database, every flip paired to a
 * ledger event by constraint, no authenticated write path — a tick can never
 * be self-reported from a browser. This module is the ONLY place flips
 * happen, always through the service client, always after the predicate's
 * own deterministic condition holds.
 *
 * Decision 19's caveat governs the rendering side: the UI must never show an
 * unearned tick — keys this phase cannot evaluate render honestly pending.
 */

/** The three connection predicates: earned when a LIVE grant for the tool
 * exists to an INTEGRATION actor of this business (decision 82 — "the grant
 * row exists"). Light's own agent grants do not count: an agent holding
 * comms.email is not a connected mailbox. */
export const CONNECTION_PREDICATE_TOOLS: Partial<Record<FirstLightPredicateKey, string>> = {
  email_calendar_connected: "comms.email",
  whatsapp_connected: "comms.whatsapp",
  // Decision 7: lead ingestion is the enquiries tool, granted to the Meta
  // integration actor — the grant IS the connection.
  meta_lead_forms_connected: "enquiries",
};

/** Keys whose earning machinery does not exist yet — the panel renders these
 * pending with the session that brings them. Never a fake tick, never a
 * dismissable row (decision 82). */
export const FIRST_LIGHT_PENDING_ARRIVALS: Partial<Record<FirstLightPredicateKey, string>> = {
  memory_tray_reviewed: "arrives with the crawler session",
  sending_domain_verified: "arrives with the domain-verification session",
  walkthrough_booked: "arrives with the booking-link session",
};

export interface FirstLightPredicateRow {
  id: string;
  business_id: string;
  task_id: string;
  predicate_key: FirstLightPredicateKey;
  optional: boolean;
  satisfied_at: string | null;
  satisfied_event_id: string | null;
}

async function loadPredicates(
  db: SupabaseClient,
  businessId: string
): Promise<FirstLightPredicateRow[]> {
  const { data, error } = await db
    .from("first_light_predicates")
    .select("id, business_id, task_id, predicate_key, optional, satisfied_at, satisfied_event_id")
    .eq("business_id", businessId)
    .is("archived_at", null);
  if (error) throw new Error(`first_light_predicates lookup failed: ${error.message}`);
  return (data ?? []) as FirstLightPredicateRow[];
}

/**
 * Flip one predicate: ledger event first (the flip is impossible without
 * it — 0020 all-or-none constraint), then the row, then the task completes.
 * Idempotent: an already-satisfied predicate is left untouched.
 * Requires the SERVICE client — there is no authenticated write path.
 */
export async function satisfyFirstLightPredicate(
  db: SupabaseClient,
  input: {
    businessId: string;
    predicateKey: FirstLightPredicateKey;
    /** Who earned it: the human whose act completed the condition, or the
     * business's workflow actor for state the evaluator observed. */
    actorId: string;
    payload?: Record<string, unknown>;
  }
): Promise<{ flipped: boolean; completedFirstLight: boolean }> {
  const rows = await loadPredicates(db, input.businessId);
  const row = rows.find((r) => r.predicate_key === input.predicateKey);
  if (!row) throw new Error(`No "${input.predicateKey}" predicate for business ${input.businessId}`);
  if (row.satisfied_at) return { flipped: false, completedFirstLight: false };

  const event = await emitEvent(db, {
    business_id: input.businessId,
    actor_id: input.actorId,
    action: FIRST_LIGHT_EVENT_KINDS.predicateSatisfied,
    entity_type: "first_light_predicate",
    entity_id: row.id,
    payload: { predicate_key: input.predicateKey, ...(input.payload ?? {}) },
  });

  const { error: flipError } = await db
    .from("first_light_predicates")
    .update({ satisfied_at: new Date().toISOString(), satisfied_event_id: event.id })
    .eq("id", row.id)
    .is("satisfied_at", null);
  if (flipError) throw new Error(`predicate flip failed: ${flipError.message}`);

  const { error: taskError } = await db
    .from("tasks")
    .update({ status: "done" })
    .eq("id", row.task_id)
    .not("status", "in", "(done,cancelled)");
  if (taskError) throw new Error(`task completion failed: ${taskError.message}`);
  await emitEvent(db, {
    business_id: input.businessId,
    actor_id: input.actorId,
    action: "task.completed",
    entity_type: "task",
    entity_id: row.task_id,
    payload: { via: "first_light", predicate_key: input.predicateKey },
  });

  const completedFirstLight = await checkFirstLightCompletion(db, input.businessId, input.actorId);
  return { flipped: true, completedFirstLight };
}

/**
 * Skip an OPTIONAL row (the Meta only-if-running-ads rule, decision 82).
 * The predicate stays honestly unsatisfied — the tick was never earned; the
 * task is cancelled with the reason, and the skip is a line on The Record.
 */
export async function skipFirstLightRow(
  db: SupabaseClient,
  input: {
    businessId: string;
    predicateKey: FirstLightPredicateKey;
    actorId: string;
    reason: string;
  }
): Promise<{ skipped: boolean; completedFirstLight: boolean }> {
  const rows = await loadPredicates(db, input.businessId);
  const row = rows.find((r) => r.predicate_key === input.predicateKey);
  if (!row) throw new Error(`No "${input.predicateKey}" predicate for business ${input.businessId}`);
  if (!row.optional) throw new Error(`"${input.predicateKey}" is not optional — its tick must be earned, never skipped`);
  if (row.satisfied_at) return { skipped: false, completedFirstLight: false };
  if (!input.reason.trim()) throw new Error("Skipping needs a stated reason");

  const { data: task, error: taskLookupError } = await db
    .from("tasks")
    .select("id, status")
    .eq("id", row.task_id)
    .maybeSingle();
  if (taskLookupError) throw new Error(`task lookup failed: ${taskLookupError.message}`);
  if (task && task.status === "cancelled") return { skipped: false, completedFirstLight: false };

  const { error: cancelError } = await db
    .from("tasks")
    .update({ status: "cancelled" })
    .eq("id", row.task_id);
  if (cancelError) throw new Error(`task cancel failed: ${cancelError.message}`);
  await emitEvent(db, {
    business_id: input.businessId,
    actor_id: input.actorId,
    action: FIRST_LIGHT_EVENT_KINDS.rowSkipped,
    entity_type: "first_light_predicate",
    entity_id: row.id,
    payload: { predicate_key: input.predicateKey, reason: input.reason },
  });

  const completedFirstLight = await checkFirstLightCompletion(db, input.businessId, input.actorId);
  return { skipped: true, completedFirstLight };
}

/**
 * Retirement condition (decision 83): every non-optional predicate satisfied
 * AND every optional row either satisfied or explicitly skipped. Emits
 * first_light.completed exactly once; the pill reads completion from the
 * predicate rows, the ledger carries the moment.
 */
export async function checkFirstLightCompletion(
  db: SupabaseClient,
  businessId: string,
  actorId: string
): Promise<boolean> {
  const rows = await loadPredicates(db, businessId);
  if (rows.length === 0) return false;
  const open = rows.filter((r) => !r.satisfied_at);
  if (open.length > 0) {
    const optionalOpen = open.filter((r) => r.optional);
    if (optionalOpen.length !== open.length) return false;
    // Optional rows block retirement until satisfied OR skipped.
    const { data: tasks, error } = await db
      .from("tasks")
      .select("id, status")
      .in("id", optionalOpen.map((r) => r.task_id));
    if (error) throw new Error(`optional task lookup failed: ${error.message}`);
    if ((tasks ?? []).some((t) => t.status !== "cancelled")) return false;
  }

  const { data: prior, error: priorError } = await db
    .from("events")
    .select("id")
    .eq("business_id", businessId)
    .eq("action", EVENT_KINDS.firstLightCompleted)
    .limit(1);
  if (priorError) throw new Error(`completion lookup failed: ${priorError.message}`);
  if ((prior ?? []).length > 0) return true;

  await emitEvent(db, {
    business_id: businessId,
    actor_id: actorId,
    action: EVENT_KINDS.firstLightCompleted,
    entity_type: "business",
    entity_id: businessId,
    payload: { note: "Every First Light row earned its tick — the pill retires itself; the rows live on in Tasks and on The Record." },
  });
  return true;
}

/**
 * Evaluate the connection predicates from grant state (decision 82: the
 * grant row exists → connected). Flips are attributed to the business's
 * workflow actor — the evaluation is platform automation observing state,
 * the Session 6 attribution precedent.
 */
export async function evaluateConnectionPredicates(
  db: SupabaseClient,
  businessId: string
): Promise<FirstLightPredicateKey[]> {
  const rows = await loadPredicates(db, businessId);
  const open = rows.filter(
    (r) => !r.satisfied_at && r.predicate_key in CONNECTION_PREDICATE_TOOLS
  );
  if (open.length === 0) return [];

  const { data: business, error: bizError } = await db
    .from("businesses")
    .select("id, account_id")
    .eq("id", businessId)
    .maybeSingle();
  if (bizError || !business) throw new Error(`business lookup failed: ${bizError?.message ?? "not found"}`);

  const { data: integrationActors, error: actorError } = await db
    .from("actors")
    .select("id")
    .eq("account_id", business.account_id)
    .eq("actor_type", "integration")
    .is("archived_at", null);
  if (actorError) throw new Error(`integration actor lookup failed: ${actorError.message}`);
  const integrationIds = (integrationActors ?? []).map((a) => a.id);
  if (integrationIds.length === 0) return [];

  const { data: grants, error: grantError } = await db
    .from("grants")
    .select("tool, grantee_actor_id, revoked_at, expires_at")
    .eq("business_id", businessId)
    .in("grantee_actor_id", integrationIds)
    .is("revoked_at", null)
    .is("archived_at", null);
  if (grantError) throw new Error(`grant lookup failed: ${grantError.message}`);
  const liveTools = new Set(
    (grants ?? [])
      .filter((g) => !g.expires_at || new Date(g.expires_at) > new Date())
      .map((g) => g.tool)
  );

  const { data: workflowActors, error: wfError } = await db
    .from("actors")
    .select("id")
    .eq("account_id", business.account_id)
    .eq("actor_type", "workflow")
    .is("archived_at", null);
  if (wfError) throw new Error(`workflow actor lookup failed: ${wfError.message}`);
  if ((workflowActors ?? []).length !== 1) return []; // decision 93: no guessing

  const flipped: FirstLightPredicateKey[] = [];
  for (const row of open) {
    const tool = CONNECTION_PREDICATE_TOOLS[row.predicate_key]!;
    if (liveTools.has(tool)) {
      const { flipped: didFlip } = await satisfyFirstLightPredicate(db, {
        businessId,
        predicateKey: row.predicate_key,
        actorId: workflowActors![0]!.id,
        payload: { tool, observed: "live integration grant" },
      });
      if (didFlip) flipped.push(row.predicate_key);
    }
  }
  return flipped;
}

/**
 * The canonical basics rows — 0022 v3 `business_identity.standard_keys`,
 * declared here as the ONE fallback both the evaluator and the modal resolve
 * to when a business has no template install (the Session-9-era tenants).
 *
 * JUDGMENT: (Session 13 fix round, decision 84) the founder's unearned tick
 * came from the evaluator and the modal disagreeing — the modal fell back to
 * six displayed rows while the evaluator fell back to an EMPTY required set,
 * which read as "nothing missing". One resolver, shared, ends the split; an
 * empty resolved set can no longer occur, and the evaluator additionally
 * fails closed on one (`evaluateBasicsReadiness`).
 */
export const CANONICAL_BASICS_KEYS = [
  "business_name",
  "regulated_status",
  "address",
  "business_hours",
  "languages",
  "quiet_hours",
] as const;

/** The required basics set: the template's standard_keys when installed,
 * else the canonical six. Never empty. */
export function resolveBasicsRequiredKeys(
  templateStandardKeys: string[] | null | undefined
): string[] {
  return templateStandardKeys && templateStandardKeys.length > 0
    ? templateStandardKeys
    : [...CANONICAL_BASICS_KEYS];
}

/** One entry in the basics stamp store: businesses.settings.basics_confirmed.
 * `state` absent (Session 11 entries) means confirmed. */
export interface BasicsRowStamp {
  state?: "confirmed" | "not_applicable";
  confirmed_at?: string;
  confirmed_by?: string;
  provenance?: string;
}

export function readBasicsStamps(
  settings: Record<string, unknown> | null | undefined
): Record<string, BasicsRowStamp> {
  const raw = settings?.basics_confirmed;
  if (!raw || typeof raw !== "object") return {};
  return raw as Record<string, BasicsRowStamp>;
}

/** The basics stamp store's addressed keys (confirmed OR marked not
 * applicable — every one an explicit human act). */
export function confirmedBasicsKeys(settings: Record<string, unknown> | null | undefined): string[] {
  return Object.keys(readBasicsStamps(settings));
}

/**
 * The decision core, pure and testable: the basics predicate is ready ONLY
 * when the required set is non-empty and EVERY required row is individually
 * addressed — confirmed, corrected, or explicitly marked not applicable
 * (decision 84's per-row law; Session 13 fix round). An empty required set
 * fails closed: if we cannot name the rows, no tick can be earned.
 */
export function evaluateBasicsReadiness(
  requiredKeys: string[],
  settings: Record<string, unknown> | null | undefined
): {
  ready: boolean;
  missing: string[];
  confirmedKeys: string[];
  notApplicableKeys: string[];
} {
  const stamps = readBasicsStamps(settings);
  const addressed = new Set(Object.keys(stamps));
  const missing = requiredKeys.filter((k) => !addressed.has(k));
  const inRequired = requiredKeys.filter((k) => addressed.has(k));
  return {
    ready: requiredKeys.length > 0 && missing.length === 0,
    missing,
    confirmedKeys: inRequired.filter((k) => stamps[k]?.state !== "not_applicable"),
    notApplicableKeys: inRequired.filter((k) => stamps[k]?.state === "not_applicable"),
  };
}

/**
 * Evaluate the basics predicate (decision 82, per-row law of decision 84).
 * The flip attributes to the human whose act completed the set; the payload
 * splits confirmed from not-applicable honestly.
 */
export async function evaluateBasicsPredicate(
  db: SupabaseClient,
  input: { businessId: string; requiredKeys: string[]; actorId: string }
): Promise<boolean> {
  const { data: business, error } = await db
    .from("businesses")
    .select("id, settings")
    .eq("id", input.businessId)
    .maybeSingle();
  if (error || !business) throw new Error(`business lookup failed: ${error?.message ?? "not found"}`);
  const readiness = evaluateBasicsReadiness(
    input.requiredKeys,
    business.settings as Record<string, unknown>
  );
  if (!readiness.ready) return false;
  const { flipped } = await satisfyFirstLightPredicate(db, {
    businessId: input.businessId,
    predicateKey: "basics_confirmed",
    actorId: input.actorId,
    payload: {
      required_keys: input.requiredKeys,
      confirmed_keys: readiness.confirmedKeys,
      not_applicable_keys: readiness.notApplicableKeys,
    },
  });
  return flipped;
}

/**
 * Strike a recorded tick (Session 13 fix round — the Jurists correction).
 * The un-earn is itself on The Record BEFORE the row clears: the event
 * carries the reason and the struck flip's own event id, then satisfied_at
 * and satisfied_event_id return to null together (the 0020 all-or-none
 * shape) and the task reopens. Requires the SERVICE client.
 */
export async function unearnFirstLightPredicate(
  db: SupabaseClient,
  input: {
    businessId: string;
    predicateKey: FirstLightPredicateKey;
    actorId: string;
    reason: string;
  }
): Promise<{ unearned: boolean }> {
  if (!input.reason.trim()) throw new Error("Un-earning needs a stated reason — it goes on The Record.");
  const rows = await loadPredicates(db, input.businessId);
  const row = rows.find((r) => r.predicate_key === input.predicateKey);
  if (!row) throw new Error(`No "${input.predicateKey}" predicate for business ${input.businessId}`);
  if (!row.satisfied_at) return { unearned: false };

  await emitEvent(db, {
    business_id: input.businessId,
    actor_id: input.actorId,
    action: FIRST_LIGHT_EVENT_KINDS.predicateUnearned,
    entity_type: "first_light_predicate",
    entity_id: row.id,
    payload: {
      predicate_key: input.predicateKey,
      reason: input.reason.trim(),
      struck_satisfied_at: row.satisfied_at,
      struck_satisfied_event_id: row.satisfied_event_id,
    },
  });

  const { error: clearError } = await db
    .from("first_light_predicates")
    .update({ satisfied_at: null, satisfied_event_id: null })
    .eq("id", row.id)
    .not("satisfied_at", "is", null);
  if (clearError) throw new Error(`predicate un-earn failed: ${clearError.message}`);

  const { error: taskError } = await db
    .from("tasks")
    .update({ status: "open" })
    .eq("id", row.task_id)
    .eq("status", "done");
  if (taskError) throw new Error(`task reopen failed: ${taskError.message}`);
  await emitEvent(db, {
    business_id: input.businessId,
    actor_id: input.actorId,
    action: "task.reopened",
    entity_type: "task",
    entity_id: row.task_id,
    payload: { via: "first_light_unearn", predicate_key: input.predicateKey },
  });

  return { unearned: true };
}
