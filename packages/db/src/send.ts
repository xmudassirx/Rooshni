import type { SupabaseClient } from "@supabase/supabase-js";
import { emitEvent } from "./events";
import { SEND_EVENT_KINDS } from "./event-kinds";
import { quietHoursHoldUntil, resolveQuietHours } from "./quiet-hours";

/**
 * The send pipeline, app side (Session 10). APPROVED ≠ SENT is the pipeline
 * distinction: the stamp is the founder's authority (0017); dispatch is
 * mechanical carriage, performed by trusted server code through the 0021
 * doors — mark_communication_sent / mark_communication_send_failed are the
 * ONLY ways a stamped message's status moves, and the database re-runs the
 * human-stamp and readiness pre-flight triggers inside each transition.
 *
 * Failure discipline (external-integrations): a provider REFUSAL becomes the
 * visible `failed` status + communication.send_failed on The Record; a
 * TRANSIENT transport error leaves the row `approved` and the next tick
 * retries — either way, never a silent drop.
 *
 * Quiet hours: a message stamped inside the business's quiet window is held
 * (scheduled_for = the window's end) and dispatched then — the stamp is the
 * founder's, the timing is policy. Wall-clock policy, not a duration; see
 * quiet-hours.ts.
 */

/** Thrown by provider adapters when the PROVIDER refused the message —
 * distinguishes "the message is undeliverable" from "the network hiccuped". */
export class ProviderRejectedError extends Error {
  constructor(
    message: string,
    public readonly provider: string
  ) {
    super(message);
    this.name = "ProviderRejectedError";
  }
}

export interface WaTemplateRef {
  name: string;
  language: string;
  components?: unknown[];
}

export interface SendResult {
  provider: string;
  providerMessageId: string | null;
}

/** Injectable carriers — production wires Graph + WhatsApp Cloud; tests fake.
 * A channel with no carrier configured stays `approved` (reported, retried
 * next tick once configured) — configuration absence is not message failure. */
export interface OutboundProviders {
  sendEmail?: (input: {
    to: string;
    subject: string | null;
    body: string;
    bodyFormat: string;
  }) => Promise<SendResult>;
  sendWhatsApp?: (input: {
    to: string;
    body: string;
    template: WaTemplateRef | null;
  }) => Promise<SendResult>;
}

export interface DispatchReport {
  dispatched: number;
  failed: number;
  queued_quiet_hours: number;
  skipped: number;
  errors: string[];
}

export interface DispatchOptions {
  providers: OutboundProviders;
  /** Injectable clock for rehearsals and tests; production omits it. */
  now?: Date;
  /** Dispatch exactly one communication (the post-approval inline path). */
  onlyCommunicationId?: string;
}

interface ApprovedComm {
  id: string;
  business_id: string;
  thread_id: string;
  contact_id: string | null;
  engagement_id: string | null;
  channel: string;
  body: string;
  body_format: string;
  scheduled_for: string | null;
  attributes: Record<string, unknown>;
}

interface BusinessFacts {
  id: string;
  timezone: string;
  settings: Record<string, unknown>;
  dispatch_actor_id: string;
}

async function q<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return (data ?? ([] as unknown)) as T;
}

/** JUDGMENT: dispatch events attribute to the business's workflow actor (the
 * Session 6 engine-actor precedent) — carriage is platform automation; the
 * human authority is already on the row as approved_by_actor_id and in the
 * communication.approved event. Exactly one workflow actor per account;
 * ambiguity is a loud failure, not a guess. */
async function loadBusinessFacts(db: SupabaseClient, businessId: string): Promise<BusinessFacts> {
  const businesses = await q<{ id: string; account_id: string; timezone: string; settings: Record<string, unknown> }[]>(
    db.from("businesses").select("id, account_id, timezone, settings").eq("id", businessId).limit(1),
    "business lookup"
  );
  if (!businesses[0]) throw new Error(`Business ${businessId} not found`);
  const actors = await q<{ id: string }[]>(
    db
      .from("actors")
      .select("id")
      .eq("account_id", businesses[0].account_id)
      .eq("actor_type", "workflow")
      .is("archived_at", null),
    "dispatch actor lookup"
  );
  if (actors.length !== 1) {
    throw new Error(`Business ${businessId} needs exactly one workflow actor for dispatch attribution (saw ${actors.length})`);
  }
  return {
    id: businesses[0].id,
    timezone: businesses[0].timezone || "Europe/London",
    settings: businesses[0].settings ?? {},
    dispatch_actor_id: actors[0]!.id,
  };
}

/** The destination value for a channel — the consented contact_channel row
 * the readiness pre-flight already required at the stamp. */
async function resolveDestination(
  db: SupabaseClient,
  contactId: string,
  channel: "email" | "whatsapp"
): Promise<string | null> {
  const rows = await q<{ value: string; is_primary: boolean }[]>(
    db
      .from("contact_channels")
      .select("value, is_primary")
      .eq("contact_id", contactId)
      .eq("channel", channel)
      .is("archived_at", null)
      .order("is_primary", { ascending: false }),
    "destination lookup"
  );
  return rows[0]?.value ?? null;
}

/** WhatsApp Cloud wants bare digits with country code — E.164 minus the plus. */
function waNumber(value: string): string {
  return value.replace(/[^\d]/g, "");
}

/**
 * Dispatch every stamped outbound communication that is due. Cron-safe and
 * idempotent: the 0021 door only moves approved → sent/failed, so a second
 * overlapping sweep finds nothing left to carry.
 */
export async function dispatchApprovedCommunications(
  db: SupabaseClient,
  options: DispatchOptions
): Promise<DispatchReport> {
  const report: DispatchReport = { dispatched: 0, failed: 0, queued_quiet_hours: 0, skipped: 0, errors: [] };
  const now = options.now ?? new Date();

  let query = db
    .from("communications")
    .select("id, business_id, thread_id, contact_id, engagement_id, channel, body, body_format, scheduled_for, attributes")
    .eq("status", "approved")
    .eq("direction", "outbound")
    .is("archived_at", null);
  if (options.onlyCommunicationId) query = query.eq("id", options.onlyCommunicationId);
  const approved = await q<ApprovedComm[]>(query, "approved communications lookup");
  if (approved.length === 0) return report;

  // JUDGMENT: messages already carrying a communication.send_stubbed event
  // are the Session 6 stub-era rehearsal rows — "sent" in the stub's terms,
  // never to be re-carried for real. They stay approved until the go-live
  // purge sweeps the demo data; the dispatcher walks past them.
  const stubbed = await q<{ entity_id: string }[]>(
    db
      .from("events")
      .select("entity_id")
      .eq("action", "communication.send_stubbed")
      .in("entity_id", approved.map((c) => c.id)),
    "stub-era lookup"
  );
  const stubEra = new Set(stubbed.map((s) => s.entity_id));

  const businesses = new Map<string, BusinessFacts>();

  for (const comm of approved) {
    try {
      if (stubEra.has(comm.id)) {
        report.skipped += 1;
        continue;
      }
      if (comm.scheduled_for && new Date(comm.scheduled_for) > now) {
        report.skipped += 1;
        continue;
      }
      if (comm.channel !== "email" && comm.channel !== "whatsapp") {
        report.skipped += 1;
        report.errors.push(`comm ${comm.id}: no carrier exists for channel "${comm.channel}" — it stays approved`);
        continue;
      }

      let facts = businesses.get(comm.business_id);
      if (!facts) {
        facts = await loadBusinessFacts(db, comm.business_id);
        businesses.set(comm.business_id, facts);
      }

      // Quiet hours: hold and dispatch at the window's end.
      const holdUntil = quietHoursHoldUntil(now, facts.timezone, resolveQuietHours(facts.settings));
      if (holdUntil) {
        const { error } = await db
          .from("communications")
          .update({ scheduled_for: holdUntil.toISOString() })
          .eq("id", comm.id);
        if (error) throw new Error(`quiet-hours hold failed: ${error.message}`);
        await emitEvent(db, {
          business_id: comm.business_id,
          actor_id: facts.dispatch_actor_id,
          action: SEND_EVENT_KINDS.communicationQueuedQuietHours,
          entity_type: "communication",
          entity_id: comm.id,
          payload: {
            channel: comm.channel,
            dispatch_at: holdUntil.toISOString(),
            note: "Stamped inside quiet hours — held; the stamp is the founder's, the timing is policy.",
          },
        });
        report.queued_quiet_hours += 1;
        continue;
      }

      if (!comm.contact_id) {
        report.skipped += 1;
        report.errors.push(`comm ${comm.id}: no contact on the row — cannot resolve a destination`);
        continue;
      }

      let result: SendResult;
      if (comm.channel === "email") {
        if (!options.providers.sendEmail) {
          report.skipped += 1;
          report.errors.push(`comm ${comm.id}: email carrier not configured — it stays approved`);
          continue;
        }
        const to = await resolveDestination(db, comm.contact_id, "email");
        if (!to) throw new ProviderRejectedError("no live email channel on the contact", "graph");
        const threads = await q<{ subject: string | null }[]>(
          db.from("comm_threads").select("subject").eq("id", comm.thread_id).limit(1),
          "thread lookup"
        );
        result = await options.providers.sendEmail({
          to,
          subject: threads[0]?.subject ?? null,
          body: comm.body,
          bodyFormat: comm.body_format,
        });
      } else {
        if (!options.providers.sendWhatsApp) {
          report.skipped += 1;
          report.errors.push(`comm ${comm.id}: WhatsApp carrier not configured — it stays approved`);
          continue;
        }
        const to = await resolveDestination(db, comm.contact_id, "whatsapp");
        if (!to) throw new ProviderRejectedError("no live WhatsApp channel on the contact", "whatsapp");
        const template = (comm.attributes?.wa_template as WaTemplateRef | undefined) ?? null;
        result = await options.providers.sendWhatsApp({ to: waNumber(to), body: comm.body, template });
      }

      const { error: sentError } = await db.rpc("mark_communication_sent", {
        p_comm: comm.id,
        p_provider: result.provider,
        p_provider_message_id: result.providerMessageId,
      });
      if (sentError) throw new Error(`mark_communication_sent failed: ${sentError.message}`);
      await emitEvent(db, {
        business_id: comm.business_id,
        actor_id: facts.dispatch_actor_id,
        action: SEND_EVENT_KINDS.communicationSent,
        entity_type: "communication",
        entity_id: comm.id,
        payload: {
          channel: comm.channel,
          provider: result.provider,
          provider_message_id: result.providerMessageId,
          engagement_id: comm.engagement_id,
          contact_id: comm.contact_id,
          ...(comm.attributes?.workflow_run_id ? { workflow_run_id: comm.attributes.workflow_run_id } : {}),
        },
      });
      report.dispatched += 1;
    } catch (err) {
      if (err instanceof ProviderRejectedError) {
        try {
          const facts = businesses.get(comm.business_id) ?? (await loadBusinessFacts(db, comm.business_id));
          businesses.set(comm.business_id, facts);
          const { error: failError } = await db.rpc("mark_communication_send_failed", {
            p_comm: comm.id,
            p_provider: err.provider,
            p_reason: err.message,
          });
          if (failError) throw new Error(`mark_communication_send_failed failed: ${failError.message}`);
          await emitEvent(db, {
            business_id: comm.business_id,
            actor_id: facts.dispatch_actor_id,
            action: SEND_EVENT_KINDS.communicationSendFailed,
            entity_type: "communication",
            entity_id: comm.id,
            payload: {
              channel: comm.channel,
              provider: err.provider,
              reason: err.message,
              engagement_id: comm.engagement_id,
              contact_id: comm.contact_id,
            },
          });
          report.failed += 1;
          report.errors.push(`comm ${comm.id}: provider refused — ${err.message}`);
        } catch (inner) {
          report.errors.push(
            `comm ${comm.id}: provider refused AND recording the failure failed: ${inner instanceof Error ? inner.message : inner}`
          );
        }
      } else {
        // Transient: the row stays approved; the next tick retries.
        report.errors.push(`comm ${comm.id}: transient dispatch error (will retry): ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  return report;
}
