import type { SupabaseClient } from "@supabase/supabase-js";
import { emitEvent } from "./events";
import { RETURNING_EVENT_KINDS, RETURNING_MARKER_KIND, SEND_EVENT_KINDS } from "./event-kinds";
import { matchRoutes } from "./drafting";
import { armSettleTimer } from "./supersede";
import { routeSourceRank, setEngagementRoute } from "./routes";
import type { FormAnswer, MetaBusinessBinding, MetaLeadDetail } from "./meta";

/**
 * The returning-leads engine (Session 27, D158 — founder-ruled 2 Aug 2026).
 *
 * The frontier's ruled unit: consumption blocks re-processing of the SAME
 * submission (same leadgen id — the 0021 webhook claim + the external_refs
 * guard, both untouched), never a NEW submission by a known contact. A new
 * leadgen id resolving to a known contact is a returning-lead event, always
 * processed:
 *   (a) a system marker posts into the contact's existing thread — a fact,
 *       not Light's act and not a human's (neutral chrome; direction
 *       'internal', so the reply engine's transcript never reads it as the
 *       client's words);
 *   (c) Light drafts the returning-context reply — open fork through the
 *       settle window (armed here), closed fork through the successor's
 *       enrolled workflow run (returning-aware intro, workflow.ts);
 *   (d) enquiry linkage — open enquiry: the resubmission events onto it;
 *       closed enquiry: a successor is opened, linked both ways, and its
 *       engagement.created event enrols it on the ACTIVE definition.
 * No auto-send anywhere: the marker is internal, the reply is stamped.
 */

// ---------------------------------------------------------------------------
// Pure core — proven in the check-local harness without a database.
// ---------------------------------------------------------------------------

export interface KnownChannelRow {
  contact_id: string;
  channel: string;
  value: string;
}

/**
 * Deterministic known-contact resolution: exact email match first, then
 * exact phone. Resolution keys on channel VALUES only — the submitted name
 * is never consulted (D174a).
 * JUDGMENT: an AMBIGUOUS match (two or more distinct contacts behind the
 * priority channel) falls to the next channel, and if still ambiguous
 * resolves to NO ONE — a regulated firm never merges identities on a
 * guess; the submission then processes as a fresh lead (Session 27
 * pre-flight, D158b).
 * D174(c)/(d) — the cross-channel conflict guard: a match on one channel
 * whose OTHER submitted value belongs to a different contact is ambiguity
 * and resolves to no one — fresh lead, identities never merged on a guess.
 * JUDGMENT: D174(d)'s "belonging to another contact" is read literally —
 * the other value belonging to one other contact (c's canonical case) OR
 * shared by several other contacts is equally conflict; only a value that
 * is unknown, or already the matched contact's own, leaves the match
 * standing (Session 28 pre-flight).
 */
export function resolveKnownContactId(
  rows: KnownChannelRow[],
  email: string | null,
  phone: string | null
): string | null {
  const distinct = (channel: string, value: string | null): string[] => {
    if (!value) return [];
    const ids = rows
      .filter((r) => r.channel === channel && r.value === value)
      .map((r) => r.contact_id);
    return [...new Set(ids)];
  };
  const byEmail = distinct("email", email ? email.toLowerCase() : null);
  const byPhone = distinct("phone", phone);
  if (byEmail.length === 1) {
    return byPhone.length === 0 || byPhone.includes(byEmail[0]!) ? byEmail[0]! : null;
  }
  if (byPhone.length === 1) {
    return byEmail.length === 0 || byEmail.includes(byPhone[0]!) ? byPhone[0]! : null;
  }
  return null;
}

export interface EnrichmentChannel {
  channel: "email" | "phone" | "whatsapp";
  value: string;
}

/**
 * D174(b)/(d): which submitted channel values the matched contact gains as
 * ADDITIONAL channels. A value is enrichment only when it belongs to NO
 * contact in the rows read — a value already on the matched contact adds
 * nothing (idempotent: the same new value on a later submission finds its
 * own row and stands down), and a value on another contact never reaches
 * here because the conflict guard resolved the submission to no one.
 */
export function planChannelEnrichment(
  rows: KnownChannelRow[],
  email: string | null,
  phone: string | null
): EnrichmentChannel[] {
  const plan: EnrichmentChannel[] = [];
  for (const entry of [
    { channel: "email" as const, value: email ? email.toLowerCase() : null },
    { channel: "phone" as const, value: phone },
    // D186: whatsapp is enriched like its siblings — the submitted phone is
    // its value; an existing whatsapp row for that value stands the plan
    // down (idempotent), exactly as email and phone do.
    { channel: "whatsapp" as const, value: phone },
  ]) {
    if (!entry.value) continue;
    const known = rows.some((r) => r.channel === entry.channel && r.value === entry.value);
    if (!known) plan.push({ channel: entry.channel, value: entry.value });
  }
  return plan;
}

export interface AnswerDiffEntry {
  name: string;
  label: string;
  value: string;
  previous_value: string | null;
  changed: boolean;
}

/** The changed-fields diff the marker highlights (D158a): aligned to the new
 * submission's order; a field the contact never answered before counts as
 * changed. Fields absent from the new submission are simply not rows. */
export function diffFormAnswers(previous: FormAnswer[], next: FormAnswer[]): AnswerDiffEntry[] {
  const prevByName = new Map(previous.map((a) => [a.name, a.value]));
  return next.map((a) => {
    const before = prevByName.has(a.name) ? (prevByName.get(a.name) ?? "") : null;
    return {
      name: a.name,
      label: a.label,
      value: a.value,
      previous_value: before,
      changed: before === null ? true : before !== a.value,
    };
  });
}

/** The marker's plain-text body — the fallback for surfaces without the
 * structured render. British English, no em or en dashes (D142's spirit,
 * though the marker is internal and never dispatches). */
export function buildMarkerBody(input: {
  form_label: string;
  submitted_at: string;
  diff: AnswerDiffEntry[];
}): string {
  const lines = input.diff.map(
    (d) => `${d.label}: ${d.value}${d.changed ? (d.previous_value === null ? " (new)" : ` (was ${d.previous_value})`) : ""}`
  );
  return [`Submitted the ${input.form_label} again, ${input.submitted_at}.`, ...lines].join("\n");
}

export interface FormRouteDefault {
  route: string;
  label: string | null;
}

/** Per-form default route mapping (D161a): businesses.settings.meta
 * .form_route_defaults = { "<form_id>": { route, label? } | "<route>" }.
 * A settings key, not schema (the quiet-hours precedent, D91). */
export function resolveFormRouteDefault(
  settings: Record<string, unknown> | null | undefined,
  formId: string | null | undefined
): FormRouteDefault | null {
  if (!formId) return null;
  const meta = (settings?.meta ?? {}) as Record<string, unknown>;
  const defaults = (meta.form_route_defaults ?? {}) as Record<string, unknown>;
  const entry = defaults[formId];
  if (typeof entry === "string" && entry.trim() !== "") return { route: entry, label: null };
  if (entry && typeof entry === "object") {
    const route = (entry as { route?: unknown }).route;
    if (typeof route === "string" && route.trim() !== "") {
      const label = (entry as { label?: unknown }).label;
      return { route, label: typeof label === "string" && label.trim() !== "" ? label : null };
    }
  }
  return null;
}

/** A route carried BY the form's own answers (D161 provenance form_answer):
 * a field whose name reads as the route question, whose value maps to
 * exactly one declared route. Deterministic — a lookup, not an inference. */
export function routeFromFormAnswers(answers: FormAnswer[]): { route: string; answer_name: string } | null {
  const candidate = answers.find((a) => /route|visa[_\s]?type|which[_\s]?visa/i.test(a.name));
  if (!candidate || candidate.value.trim() === "") return null;
  const matches = matchRoutes(candidate.value);
  if (matches.length === 1) return { route: matches[0]!, answer_name: candidate.name };
  return null;
}

// ---------------------------------------------------------------------------
// Orchestration — the ingest-side returning path (service role).
// ---------------------------------------------------------------------------

async function q<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return (data ?? ([] as unknown)) as T;
}

export interface KnownContactMatch {
  contact_id: string;
  /** D174(b): submitted values the matched contact does not yet hold —
   * written as additional channels by processReturningLead. */
  enrich: EnrichmentChannel[];
}

/** Business-scoped lookup behind resolveKnownContactId — served by the 0041
 * index; reads only the channels that could match. The same read feeds the
 * enrichment plan (D174b): a submitted value matching no row is new. */
export async function findKnownContactId(
  db: SupabaseClient,
  businessId: string,
  email: string | null,
  phone: string | null
): Promise<KnownContactMatch | null> {
  const values = [email ? email.toLowerCase() : null, phone].filter((v): v is string => Boolean(v));
  if (values.length === 0) return null;
  const rows = await q<KnownChannelRow[]>(
    db
      .from("contact_channels")
      .select("contact_id, channel, value")
      .eq("business_id", businessId)
      // D186: whatsapp rows are read ONLY so the enrichment plan can stand
      // down against an existing row (idempotency) — RESOLUTION still keys
      // on email and phone alone (D174a, untouched).
      .in("channel", ["email", "phone", "whatsapp"])
      .in("value", values)
      .is("archived_at", null),
    "known-contact lookup"
  );
  const contactId = resolveKnownContactId(rows, email, phone);
  if (!contactId) return null;
  return { contact_id: contactId, enrich: planChannelEnrichment(rows, email, phone) };
}

export interface ReturningResult {
  mode: "resubmission" | "successor";
  engagement_id: string;
  predecessor_engagement_id: string | null;
  thread_id: string | null;
  marker_communication_id: string | null;
}

interface PredecessorFacts {
  id: string;
  title: string;
  attributes: Record<string, unknown>;
  external_refs: unknown[];
  is_terminal: boolean;
}

async function loadPredecessor(db: SupabaseClient, contactId: string): Promise<PredecessorFacts | null> {
  const participantRows = await q<{ engagement_id: string }[]>(
    db
      .from("engagement_participants")
      .select("engagement_id")
      .eq("contact_id", contactId)
      .eq("role", "client")
      .is("archived_at", null),
    "predecessor participant lookup"
  );
  if (participantRows.length === 0) return null;
  const engagements = await q<
    {
      id: string;
      title: string;
      attributes: Record<string, unknown> | null;
      external_refs: unknown[] | null;
      created_at: string;
      stage: { is_terminal: boolean } | { is_terminal: boolean }[] | null;
    }[]
  >(
    db
      .from("engagements")
      .select("id, title, attributes, external_refs, created_at, stage:stage_definitions!engagements_stage_id_fkey(is_terminal)")
      .in("id", participantRows.map((r) => r.engagement_id))
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(1),
    "predecessor engagement lookup"
  );
  const row = engagements[0];
  if (!row) return null;
  const stage = Array.isArray(row.stage) ? (row.stage[0] ?? null) : row.stage;
  return {
    id: row.id,
    title: row.title,
    attributes: row.attributes ?? {},
    external_refs: row.external_refs ?? [],
    is_terminal: stage?.is_terminal ?? false,
  };
}

/** The contact's existing thread (D158a), resolved deterministically.
 * JUDGMENT: "the contact's existing thread" reads as the target enquiry's
 * email thread (the ingest-created primary) first, else the contact's most
 * recently active thread; created fresh only if the contact somehow has
 * none (Session 27 pre-flight). */
async function resolveMarkerThread(
  db: SupabaseClient,
  binding: MetaBusinessBinding,
  contactId: string,
  engagementId: string,
  subject: string
): Promise<{ id: string; channel: string }> {
  const byEngagement = await q<{ id: string; channel: string }[]>(
    db
      .from("comm_threads")
      .select("id, channel")
      .eq("engagement_id", engagementId)
      .eq("channel", "email")
      .is("archived_at", null)
      .limit(1),
    "marker thread lookup (engagement)"
  );
  if (byEngagement[0]) return byEngagement[0];
  const byContact = await q<{ id: string; channel: string }[]>(
    db
      .from("comm_threads")
      .select("id, channel")
      .eq("contact_id", contactId)
      .is("archived_at", null)
      .order("last_activity_at", { ascending: false, nullsFirst: false })
      .limit(1),
    "marker thread lookup (contact)"
  );
  if (byContact[0]) return byContact[0];
  const created = await q<{ id: string; channel: string }[]>(
    db
      .from("comm_threads")
      .insert({
        business_id: binding.business_id,
        created_by: binding.integration_actor_id,
        contact_id: contactId,
        engagement_id: engagementId,
        channel: "email",
        subject,
      })
      .select("id, channel"),
    "marker thread insert"
  );
  return created[0]!;
}

/** Ingest a route for a NEW or open enquiry from the submission itself:
 * the form's own route answer (source form_answer) wins over the per-form
 * default (source form_default). Polite pre-checks mirror the 0042 ladder;
 * the database remains the enforcement. */
export async function ingestSubmissionRoute(
  db: SupabaseClient,
  binding: MetaBusinessBinding,
  engagementId: string,
  currentSource: string | null,
  answers: FormAnswer[],
  formId: string | null
): Promise<void> {
  const fromAnswers = routeFromFormAnswers(answers);
  if (fromAnswers && routeSourceRank(currentSource) < 4) {
    await setEngagementRoute(db, {
      business_id: binding.business_id,
      engagement_id: engagementId,
      route: fromAnswers.route,
      source: "form_answer",
      actor_id: binding.integration_actor_id,
      reason: `the form's own answer (${fromAnswers.answer_name})`,
    });
    return;
  }
  if (routeSourceRank(currentSource) > 0) return;
  const businesses = await q<{ settings: Record<string, unknown> | null }[]>(
    db.from("businesses").select("settings").eq("id", binding.business_id).limit(1),
    "form-default settings lookup"
  );
  const formDefault = resolveFormRouteDefault(businesses[0]?.settings, formId);
  if (!formDefault) return;
  await setEngagementRoute(db, {
    business_id: binding.business_id,
    engagement_id: engagementId,
    route: formDefault.route,
    source: "form_default",
    actor_id: binding.integration_actor_id,
    reason: `per-form default for form ${formId}`,
  });
}

/**
 * The returning-lead path (D158): marker + linkage + the draft's trigger.
 * Called by ingestMetaLead once the submission resolves to a known contact;
 * the same-leadgen guard has already passed upstream.
 */
export async function processReturningLead(
  db: SupabaseClient,
  binding: MetaBusinessBinding,
  lead: MetaLeadDetail,
  contactId: string,
  newAnswers: FormAnswer[],
  enrich: EnrichmentChannel[] = []
): Promise<ReturningResult> {
  // -- D174(b): a new value on the other channel joins the matched contact
  // as an ADDITIONAL channel — consent carried from the form (the ingest
  // path's exact shape), evented with provenance. The plan was computed at
  // resolution time from the same rows the resolver read: a value already
  // held adds nothing (idempotent), a value on another contact never
  // reaches here (the conflict guard resolved to no one).
  // JUDGMENT: the added channel inserts with is_primary false — the ruling
  // says "additional channel"; primacy is a human call, never a guess
  // (Session 28 pre-flight).
  for (const extra of enrich) {
    await q(
      db.from("contact_channels").insert({
        business_id: binding.business_id,
        created_by: binding.integration_actor_id,
        contact_id: contactId,
        channel: extra.channel,
        value: extra.value,
        is_primary: false,
        consent: {
          marketing: true,
          transactional: true,
          granted_at: lead.created_time,
          source: "meta_lead_form",
        },
      }).select("id"),
      "enrichment channel insert"
    );
    await emitEvent(db, {
      business_id: binding.business_id,
      actor_id: binding.integration_actor_id,
      action: RETURNING_EVENT_KINDS.channelAdded,
      entity_type: "contact",
      entity_id: contactId,
      payload: {
        channel: extra.channel,
        value: extra.value,
        lead_id: lead.id,
        form_id: lead.form_id ?? null,
        consent_source: "meta_lead_form",
      },
    });
  }

  const predecessor = await loadPredecessor(db, contactId);
  const previousAnswers =
    ((predecessor?.attributes ?? {}) as { form_answers?: FormAnswer[] }).form_answers ?? [];
  const diff = diffFormAnswers(previousAnswers, newAnswers);
  const changedCount = diff.filter((d) => d.changed).length;

  const contacts = await q<{ display_name: string }[]>(
    db.from("contacts").select("display_name").eq("id", contactId).limit(1),
    "returning contact lookup"
  );
  const fullName = contacts[0]?.display_name ?? "Returning lead";

  const businesses = await q<{ settings: Record<string, unknown> | null }[]>(
    db.from("businesses").select("settings").eq("id", binding.business_id).limit(1),
    "returning settings lookup"
  );
  const formDefault = resolveFormRouteDefault(businesses[0]?.settings, lead.form_id ?? null);
  const formLabel = formDefault?.label ?? (lead.form_id ? `enquiry form ${lead.form_id}` : "enquiry form");

  const externalRef = {
    system: "meta",
    external_id: lead.id,
    url: null,
    synced_at: new Date().toISOString(),
  };
  const attribution = {
    source: "meta",
    campaign_id: lead.campaign_id ?? null,
    adset_id: lead.adset_id ?? null,
    ad_id: lead.ad_id ?? null,
    form_id: lead.form_id ?? null,
    lead_id: lead.id,
  };

  let mode: ReturningResult["mode"];
  let targetEngagementId: string;

  if (predecessor && !predecessor.is_terminal) {
    // -- Open fork: the resubmission events onto the existing enquiry. ------
    mode = "resubmission";
    targetEngagementId = predecessor.id;
    // JUDGMENT: attributes.form_answers moves to the NEWEST submission —
    // the current details are what drafting composes against; the ledger
    // event below keeps the previous values (Session 27, D158d open fork).
    const nextAttributes = { ...predecessor.attributes, form_answers: newAnswers };
    const { error: updError } = await db
      .from("engagements")
      .update({
        attributes: nextAttributes,
        external_refs: [...predecessor.external_refs, externalRef],
      })
      .eq("id", predecessor.id);
    if (updError) throw new Error(`resubmission update failed: ${updError.message}`);
    await emitEvent(db, {
      business_id: binding.business_id,
      actor_id: binding.integration_actor_id,
      action: RETURNING_EVENT_KINDS.resubmissionReceived,
      entity_type: "engagement",
      entity_id: predecessor.id,
      payload: {
        lead_id: lead.id,
        form_id: lead.form_id ?? null,
        form_label: formLabel,
        submitted_at: lead.created_time,
        answers: newAnswers,
        changed: diff.filter((d) => d.changed),
      },
    });
    const currentSource = (predecessor.attributes.visa_route_source as string | undefined) ?? null;
    await ingestSubmissionRoute(db, binding, predecessor.id, currentSource, newAnswers, lead.form_id ?? null);
  } else {
    // -- Closed fork (or no prior enquiry at all): open a successor. --------
    mode = "successor";
    const types = await q<{ id: string }[]>(
      db
        .from("engagement_types")
        .select("id")
        .eq("template_id", binding.template_id)
        .eq("key", "enquiry")
        .is("archived_at", null)
        .limit(1),
      "engagement type lookup"
    );
    if (!types[0]) throw new Error(`No "enquiry" engagement type on template ${binding.template_id}`);
    const stages = await q<{ id: string }[]>(
      db
        .from("stage_definitions")
        .select("id")
        .eq("engagement_type_id", types[0].id)
        .eq("key", "new_lead")
        .is("archived_at", null)
        .limit(1),
      "new_lead stage lookup"
    );
    if (!stages[0]) throw new Error(`No "new_lead" stage on the enquiry type`);

    const inserted = await q<{ id: string }[]>(
      db
        .from("engagements")
        .insert({
          business_id: binding.business_id,
          created_by: binding.integration_actor_id,
          template_type_id: types[0].id,
          title: `${fullName} — enquiry`,
          stage_id: stages[0].id,
          stage_entered_at: lead.created_time,
          attribution,
          owner_actor_id: binding.owner_actor_id,
          predecessor_engagement_id: predecessor?.id ?? null,
          attributes: {
            form_answers: newAnswers,
            returning: {
              resubmitted_at: lead.created_time,
              form_id: lead.form_id ?? null,
              form_label: formLabel,
              changed: diff.filter((d) => d.changed),
              ...(predecessor ? { predecessor_engagement_id: predecessor.id } : {}),
            },
          },
          external_refs: [externalRef],
        })
        .select("id"),
      "successor engagement insert"
    );
    targetEngagementId = inserted[0]!.id;

    await q(
      db.from("engagement_participants").insert({
        business_id: binding.business_id,
        created_by: binding.integration_actor_id,
        engagement_id: targetEngagementId,
        contact_id: contactId,
        role: "client",
      }).select("id"),
      "successor participant insert"
    );
    await q(
      db.from("stage_history").insert({
        business_id: binding.business_id,
        engagement_id: targetEngagementId,
        from_stage: null,
        to_stage: stages[0].id,
        moved_at: lead.created_time,
        moved_by: binding.integration_actor_id,
      }).select("id"),
      "successor stage_history insert"
    );

    if (predecessor) {
      await emitEvent(db, {
        business_id: binding.business_id,
        actor_id: binding.integration_actor_id,
        action: RETURNING_EVENT_KINDS.successorOpened,
        entity_type: "engagement",
        entity_id: predecessor.id,
        payload: { successor_engagement_id: targetEngagementId, lead_id: lead.id, form_label: formLabel },
      });
      await emitEvent(db, {
        business_id: binding.business_id,
        actor_id: binding.integration_actor_id,
        action: RETURNING_EVENT_KINDS.openedFromPredecessor,
        entity_type: "engagement",
        entity_id: targetEngagementId,
        payload: { predecessor_engagement_id: predecessor.id, lead_id: lead.id, form_label: formLabel },
      });
    }
    await emitEvent(db, {
      business_id: binding.business_id,
      actor_id: binding.integration_actor_id,
      action: SEND_EVENT_KINDS.metaLeadReceived,
      entity_type: "engagement",
      entity_id: targetEngagementId,
      payload: { lead_id: lead.id, contact_id: contactId, returning: true },
    });
    // The workflow trigger matches on THIS event — the successor enrols on
    // the ACTIVE definition (session scope: v5 today; the scan reads
    // status='active', never a pinned version).
    await emitEvent(db, {
      business_id: binding.business_id,
      actor_id: binding.integration_actor_id,
      action: "engagement.created",
      entity_type: "engagement",
      entity_id: targetEngagementId,
      payload: {
        stage: "new_lead",
        attribution,
        returning: true,
        ...(predecessor ? { predecessor_engagement_id: predecessor.id } : {}),
      },
    });
    await ingestSubmissionRoute(db, binding, targetEngagementId, null, newAnswers, lead.form_id ?? null);
  }

  // -- The system marker (D158a), both forks: into the contact's existing
  // thread, neutral chrome; thread to top (0036 trigger), unread badge
  // (last_inbound_at), arrival sound (live-inbox rules on the INSERT).
  const marker = { thread: null as { id: string; channel: string } | null, comm: null as string | null };
  marker.thread = await resolveMarkerThread(
    db,
    binding,
    contactId,
    targetEngagementId,
    `${fullName} — enquiry`
  );
  const markerRows = await q<{ id: string }[]>(
    db
      .from("communications")
      .insert({
        business_id: binding.business_id,
        created_by: binding.integration_actor_id,
        thread_id: marker.thread.id,
        contact_id: contactId,
        engagement_id: targetEngagementId,
        channel: marker.thread.channel,
        direction: "internal",
        status: "received",
        body: buildMarkerBody({ form_label: formLabel, submitted_at: lead.created_time, diff }),
        body_format: "plain",
        occurred_at: lead.created_time,
        attributes: {
          kind: RETURNING_MARKER_KIND,
          marker: {
            form_id: lead.form_id ?? null,
            form_label: formLabel,
            lead_id: lead.id,
            submitted_at: lead.created_time,
            answers: diff,
          },
        },
      })
      .select("id"),
    "marker insert"
  );
  marker.comm = markerRows[0]!.id;
  const { error: unreadError } = await db
    .from("comm_threads")
    .update({ last_inbound_at: lead.created_time, engagement_id: targetEngagementId })
    .eq("id", marker.thread.id);
  if (unreadError) throw new Error(`marker thread bump failed: ${unreadError.message}`);
  await emitEvent(db, {
    business_id: binding.business_id,
    actor_id: binding.integration_actor_id,
    action: RETURNING_EVENT_KINDS.returningMarkerPosted,
    entity_type: "communication",
    entity_id: marker.comm,
    payload: {
      thread_id: marker.thread.id,
      engagement_id: targetEngagementId,
      lead_id: lead.id,
      form_label: formLabel,
      changed_count: changedCount,
    },
  });

  // -- The returning draft's trigger.
  // JUDGMENT: the closed fork's returning draft IS the enrolled run's intro
  // step, composed with returning context (deduced from the session order:
  // "NEW enquiries enrol on the ACTIVE workflow definition" — the run's
  // intro/nudge/close machinery drives the fork, and no cold intro may ever
  // be sent, so the intro composition itself becomes returning-aware; nudges
  // anchor after its stamp exactly as ever, D48). The open fork rides the
  // settle window verbatim per D158c: the timer arms here and the
  // Conversations sweep composes the reply. Arming the settle timer on the
  // closed fork too would invite a second draft (Session 27 pre-flight).
  if (mode === "resubmission") {
    await armSettleTimer(db, marker.thread.id);
  }

  return {
    mode,
    engagement_id: targetEngagementId,
    predecessor_engagement_id: predecessor?.id ?? null,
    thread_id: marker.thread.id,
    marker_communication_id: marker.comm,
  };
}
