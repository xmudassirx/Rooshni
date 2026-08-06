import type { SupabaseClient } from "@supabase/supabase-js";
import { emitEvent } from "./events";
import { ROUTE_EVENT_KINDS } from "./event-kinds";
import { classifyRoute, type ClassifyFn, type ClassifyRouteInput } from "./drafting";
import { LIGHT_MODEL_FLOOR, priceGeneration } from "./model-router";

/**
 * Route classification — the app-side face of the 0042 door (Session 27,
 * D161). The database enforces the precedence ladder
 * (human > form_answer > light > form_default; a human-set route is final
 * against machine writes); this module is the single wrapper every caller
 * uses, so the ledger event and the door write never separate.
 */

export type RouteSource = "human" | "form_answer" | "light" | "form_default";

export interface RouteOption {
  key: string;
  label: string;
}

/** Rank mirror of the 0042 ladder — used ONLY for polite pre-checks (does a
 * write stand a chance?); the database remains the enforcement. */
export function routeSourceRank(source: string | null | undefined): number {
  switch (source) {
    case "human": return 4;
    case "form_answer": return 3;
    case "light": return 2;
    case "form_default": return 1;
    default: return 0;
  }
}

/** May Light set the route? Only over unset or form_default (D161b) — never
 * over a human, a form answer, or its own earlier confident read. */
export function lightMaySetRoute(currentSource: string | null | undefined): boolean {
  return routeSourceRank(currentSource) <= 1;
}

/** The declared route vocabulary for a business (0024: the installed
 * template's field_definitions content.visa_route validation.allowed — the
 * same vocabulary the enquiry rows use). Empty when none is declared. */
export async function loadRouteOptions(db: SupabaseClient, businessId: string): Promise<RouteOption[]> {
  const { data: businesses, error: bizError } = await db
    .from("businesses")
    .select("template_id")
    .eq("id", businessId)
    .limit(1);
  if (bizError) throw new Error(`route vocabulary: business lookup failed: ${bizError.message}`);
  const templateId = businesses?.[0]?.template_id;
  if (!templateId) return [];
  const { data, error } = await db
    .from("field_definitions")
    .select("validation")
    .eq("template_id", templateId)
    .eq("entity", "content")
    .eq("key", "visa_route")
    .is("archived_at", null)
    .limit(1);
  if (error) throw new Error(`route vocabulary query failed: ${error.message}`);
  const allowed = (data?.[0]?.validation as { allowed?: Array<{ key?: string; label?: string }> } | null)?.allowed;
  if (!Array.isArray(allowed)) return [];
  return allowed
    .filter((a) => typeof a.key === "string" && a.key !== "")
    .map((a) => ({ key: String(a.key), label: String(a.label ?? a.key) }));
}

export function routeLabel(options: RouteOption[], key: string | null | undefined): string | null {
  if (!key) return null;
  return options.find((o) => o.key === key)?.label ?? key;
}

/** What resolution settled on: the route the draft may key retrieval and
 * booklet selection on (D179c), with its provenance. Null route = the draft
 * stays route-neutral — a missing booklet is recoverable; a wrong one is
 * not. */
export interface ResolvedRoute {
  route: string | null;
  source: string | null;
}

export interface ResolveRouteInput {
  business_id: string;
  engagement_id: string;
  /** The engagement's current field values (attributes.visa_route /
   * visa_route_source), read by the caller. */
  current_route: string | null;
  current_source: string | null;
  /** Light's agent actor — the read's evented author and the door's actor
   * on a confident write. */
  actor_id: string;
  /** Null when no provider is configured — the ladder stands as it is. */
  classifier: ClassifyFn | null;
  /** The evidence for the read (D161b: form name, form answers, the
   * person's own words). Options are loaded here, not passed. */
  evidence: Omit<ClassifyRouteInput, "options">;
}

/**
 * Session 31 (D179c): route resolution, COMPLETE, before composition.
 * The 0042 ladder is consulted first; only over an unset or form_default
 * source does Light read (one floor-tier call), and a confident read lands
 * through the door with its stated reason. The read itself — confident or
 * abstained — is evented with its priced spend (D161d's visibility). A
 * refused write (a human or form answer won a race) is the ladder working:
 * the field's standing value is returned.
 * JUDGMENT (Session 31): when the source is form_default and Light's read
 * is NOT confident, the form default STANDS as the resolved route — D179c's
 * route-neutral clause names only "unset", and D161a made the per-form
 * default a real rung of the ladder (the person chose the route-specific
 * form). Route-neutral applies only when the field is genuinely null after
 * resolution. Awaiting sign-off at close.
 */
export async function resolveEngagementRoute(db: SupabaseClient, input: ResolveRouteInput): Promise<ResolvedRoute> {
  const standing: ResolvedRoute = { route: input.current_route, source: input.current_source };
  if (input.current_route && !lightMaySetRoute(input.current_source)) return standing;
  if (!input.classifier) return standing;

  const options = await loadRouteOptions(db, input.business_id);
  if (!options.length) return standing;

  const read = await classifyRoute(input.classifier, { ...input.evidence, options });
  const price = priceGeneration({
    model: LIGHT_MODEL_FLOOR.model,
    input_tokens: read.usage.input_tokens,
    output_tokens: read.usage.output_tokens,
  });
  await emitEvent(db, {
    business_id: input.business_id,
    actor_id: input.actor_id,
    action: ROUTE_EVENT_KINDS.routeRead,
    entity_type: "engagement",
    entity_id: input.engagement_id,
    payload: { key: read.key, reason: read.reason, applied: Boolean(read.key) },
    cost: {
      provider: "anthropic",
      model: LIGHT_MODEL_FLOOR.model,
      tokens: read.usage.input_tokens + read.usage.output_tokens,
      input_tokens: read.usage.input_tokens,
      output_tokens: read.usage.output_tokens,
      ...(price ? { amount_gbp: price.amount_gbp, amount_usd: price.amount_usd, fx_rate: price.fx_rate } : {}),
    },
  });
  if (!read.key) return standing;

  try {
    await setEngagementRoute(db, {
      business_id: input.business_id,
      engagement_id: input.engagement_id,
      route: read.key,
      source: "light",
      actor_id: input.actor_id,
      reason: read.reason,
    });
  } catch (err) {
    // A precedence refusal is the ladder working (a human or form answer
    // landed between the caller's read and this write) — the standing value
    // carries the draft; anything else is a real failure.
    const message = err instanceof Error ? err.message : String(err);
    if (!/precedence/i.test(message)) throw err;
    return standing;
  }
  return { route: read.key, source: "light" };
}

export interface SetRouteInput {
  business_id: string;
  engagement_id: string;
  route: string;
  source: RouteSource;
  /** human → the reclassifying member's own actor; light → Light's agent
   * actor; form_answer / form_default → the integration actor at ingest. */
  actor_id: string;
  reason?: string | null;
}

export interface SetRouteResult {
  previous_route: string | null;
  previous_source: string | null;
  route: string;
  source: RouteSource;
}

/** Set (or reclassify) the enquiry's route through the 0042 door and put
 * the act on The Record — one call, never separated. Throws on refusal (the
 * ladder, the vocabulary, the caller rules); callers that expect to lose a
 * precedence race pre-check with lightMaySetRoute()/routeSourceRank(). */
export async function setEngagementRoute(db: SupabaseClient, input: SetRouteInput): Promise<SetRouteResult> {
  const { data, error } = await db.rpc("set_engagement_route", {
    p_engagement: input.engagement_id,
    p_route: input.route,
    p_source: input.source,
    p_actor: input.actor_id,
    p_reason: input.reason ?? null,
  });
  if (error) throw new Error(`set_engagement_route failed: ${error.message}`);
  const out = data as SetRouteResult;
  await emitEvent(db, {
    business_id: input.business_id,
    actor_id: input.actor_id,
    action: ROUTE_EVENT_KINDS.routeSet,
    entity_type: "engagement",
    entity_id: input.engagement_id,
    payload: {
      route: input.route,
      source: input.source,
      ...(input.reason ? { reason: input.reason } : {}),
      previous_route: out.previous_route ?? null,
      previous_source: out.previous_source ?? null,
    },
  });
  return { ...out, route: input.route, source: input.source };
}
