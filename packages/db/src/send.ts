import type { SupabaseClient } from "@supabase/supabase-js";
import { emitEvent } from "./events";
import { SEND_EVENT_KINDS } from "./event-kinds";
import { quietHoursHoldUntil, resolveQuietHours } from "./quiet-hours";
import { renderEmailHtml, resolveEmailIdentity } from "./email-html";
import { ATTACHMENT_MAX_BYTES, FILES_BUCKET } from "./route-guides";

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
/** PR-i (Session 19): a mail attachment as the carrier receives it — bytes
 * already fetched from storage, base64-encoded. */
export interface OutboundAttachment {
  filename: string;
  mimeType: string;
  contentBase64: string;
}

export type SendEmailFn = (input: {
  to: string;
  subject: string | null;
  body: string;
  bodyFormat: string;
  attachments?: OutboundAttachment[];
}) => Promise<SendResult>;

export interface OutboundProviders {
  /** The Microsoft Graph email carrier — the tenant default since Session 10. */
  sendEmail?: SendEmailFn;
  /** The Gmail email carrier (Session 20) — carries ONLY businesses whose
   * settings select mail_provider "gmail"; a Graph business never touches it. */
  sendGmail?: SendEmailFn;
  sendWhatsApp?: (input: {
    to: string;
    body: string;
    template: WaTemplateRef | null;
  }) => Promise<SendResult>;
}

/** Which mail pipe carries a business's tenant email (Session 20). Selected
 * per business in businesses.settings.mail_provider; anything but the
 * literal "gmail" reads as the Graph default — an unknown value can never
 * route mail to an unintended carrier. */
export type TenantMailProvider = "graph" | "gmail";

export function resolveMailProvider(settings: Record<string, unknown> | null | undefined): TenantMailProvider {
  return settings?.mail_provider === "gmail" ? "gmail" : "graph";
}

/**
 * The ONE place a business's email carrier is chosen (Session 20) — pure, so
 * the harness proves the isolation law: selection is absolute, a business
 * never falls back to the OTHER provider's carrier (the firm's mail leaves
 * only as the firm configured it), and an unconfigured selected carrier
 * returns null — the dispatcher's visible skip, never a silent reroute.
 */
export function selectEmailCarrier(
  providers: OutboundProviders,
  settings: Record<string, unknown> | null | undefined
): { provider: TenantMailProvider; send: SendEmailFn | null } {
  const provider = resolveMailProvider(settings);
  return {
    provider,
    send: (provider === "gmail" ? providers.sendGmail : providers.sendEmail) ?? null,
  };
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
  name: string;
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
  const businesses = await q<
    { id: string; name: string; account_id: string; timezone: string; settings: Record<string, unknown> }[]
  >(
    db.from("businesses").select("id, name, account_id, timezone, settings").eq("id", businessId).limit(1),
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
    name: businesses[0].name,
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

/** The engagement's current stage (id + key), for observing the Contacted
 * transition around a dispatch. */
async function currentStage(
  db: SupabaseClient,
  engagementId: string
): Promise<{ id: string; key: string } | null> {
  const rows = await q<{ stage_id: string }[]>(
    db.from("engagements").select("stage_id").eq("id", engagementId).limit(1),
    "stage observation"
  );
  const row = rows[0];
  if (!row) return null;
  const stages = await q<{ key: string }[]>(
    db.from("stage_definitions").select("key").eq("id", row.stage_id).limit(1),
    "stage key lookup"
  );
  return { id: row.stage_id, key: stages[0]?.key ?? "" };
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

  const FULL_COLUMNS =
    "id, business_id, thread_id, contact_id, engagement_id, channel, body, body_format, scheduled_for, attributes";

  // EGRESS DIET: the sweep resolves its working set from ids alone — due-ness
  // by indexed predicate (communications_approved_idx) and the stub-era
  // exclusion below — and pulls bodies/attributes only for rows it will
  // actually carry. The old single full-row select re-transferred every
  // stub-era body on every tick. The inline post-stamp path (one known id)
  // keeps the direct full fetch.
  let candidateIds: string[];
  if (options.onlyCommunicationId) {
    candidateIds = [options.onlyCommunicationId];
  } else {
    const candidates = await q<{ id: string }[]>(
      db
        .from("communications")
        .select("id")
        .eq("status", "approved")
        .eq("direction", "outbound")
        .is("archived_at", null)
        .or(`scheduled_for.is.null,scheduled_for.lte.${now.toISOString()}`),
      "approved candidates lookup"
    );
    candidateIds = candidates.map((c) => c.id);
  }
  if (candidateIds.length === 0) return report;

  // JUDGMENT: messages already carrying a communication.send_stubbed event
  // are the Session 6 stub-era rehearsal rows — "sent" in the stub's terms,
  // never to be re-carried for real. They stay approved until the go-live
  // purge sweeps the demo data; the dispatcher walks past them — since the
  // egress session, before their bodies ever leave the database.
  const stubbed = await q<{ entity_id: string }[]>(
    db
      .from("events")
      .select("entity_id")
      .eq("action", "communication.send_stubbed")
      .in("entity_id", candidateIds),
    "stub-era lookup"
  );
  const stubEra = new Set(stubbed.map((s) => s.entity_id));
  report.skipped += candidateIds.filter((id) => stubEra.has(id)).length;
  const dispatchableIds = candidateIds.filter((id) => !stubEra.has(id));
  if (dispatchableIds.length === 0) return report;

  const approved = await q<ApprovedComm[]>(
    db
      .from("communications")
      .select(FULL_COLUMNS)
      .in("id", dispatchableIds)
      .eq("status", "approved")
      .eq("direction", "outbound")
      .is("archived_at", null),
    "approved communications lookup"
  );
  if (approved.length === 0) return report;

  const businesses = new Map<string, BusinessFacts>();

  for (const comm of approved) {
    try {
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

      // The destination contact is the pre-flight's definition of it:
      // coalesce(comm.contact_id, thread.contact_id) — the thread always
      // carries one (0008: comm_threads.contact_id not null).
      const threads = await q<{ subject: string | null; contact_id: string }[]>(
        db.from("comm_threads").select("subject, contact_id").eq("id", comm.thread_id).limit(1),
        "thread lookup"
      );
      const contactId = comm.contact_id ?? threads[0]?.contact_id ?? null;
      if (!contactId) {
        report.skipped += 1;
        report.errors.push(`comm ${comm.id}: no contact on the row or its thread — cannot resolve a destination`);
        continue;
      }

      let result: SendResult;
      let sentEmailHtml: string | null = null;
      if (comm.channel === "email") {
        // Session 20: the business's selected mail pipe carries its email —
        // the pure selectEmailCarrier decides (isolation proven in the
        // harness), and an unconfigured selected carrier is a visible skip.
        const { provider: mailProvider, send: sendViaProvider } = selectEmailCarrier(
          options.providers,
          facts.settings
        );
        if (!sendViaProvider) {
          report.skipped += 1;
          report.errors.push(
            `comm ${comm.id}: ${mailProvider === "gmail" ? "Gmail" : "email (Graph)"} carrier not configured — it stays approved`
          );
          continue;
        }
        const to = await resolveDestination(db, contactId, "email");
        if (!to) throw new ProviderRejectedError("no live email channel on the contact", mailProvider);
        // PR-iii (Session 19): the HTML dress — the SAME deterministic
        // renderer the stamp card previewed, over the STORED body (WYSIWYS,
        // the decision 140 pattern). Firm name + regulated-status footer come
        // from Settings; the plain alternative derives from the same body.
        // A row already carrying html (none is born so today) passes through.
        if (comm.body_format === "plain") {
          sentEmailHtml = renderEmailHtml(comm.body, resolveEmailIdentity(facts.name, facts.settings));
        }
        // PR-i (Session 19): declared attachments ride the send. The 0032
        // pre-flight already proved existence, linkage and the 8MB ceiling
        // at the stamp; here the bytes are fetched from storage. A missing
        // or oversize file at this point is a VISIBLE refusal; a storage
        // hiccup is transient (the row stays approved, the tick retries).
        let attachments: OutboundAttachment[] | undefined;
        const declared = comm.attributes?.attachments as
          | Array<{ file_id?: string; filename?: string }>
          | undefined;
        if (Array.isArray(declared) && declared.length > 0) {
          attachments = [];
          for (const att of declared) {
            if (!att.file_id) {
              throw new ProviderRejectedError(`a declared attachment carries no file id`, mailProvider);
            }
            const files = await q<{ storage_key: string; filename: string; mime_type: string; size_bytes: number }[]>(
              db
                .from("files")
                .select("storage_key, filename, mime_type, size_bytes")
                .eq("id", att.file_id)
                .is("archived_at", null)
                .limit(1),
              "attachment file lookup"
            );
            const file = files[0];
            if (!file) {
              throw new ProviderRejectedError(
                `declared attachment ${att.filename ?? att.file_id} no longer exists — nothing was sent`,
                mailProvider
              );
            }
            if (Number(file.size_bytes) > ATTACHMENT_MAX_BYTES) {
              throw new ProviderRejectedError(
                `attachment "${file.filename}" is over the 8MB limit — the send is refused (config error)`,
                mailProvider
              );
            }
            const { data: blob, error: downloadError } = await db.storage
              .from(FILES_BUCKET)
              .download(file.storage_key);
            if (downloadError || !blob) {
              // Transient lane: storage unavailable ≠ message undeliverable.
              throw new Error(
                `attachment download failed for "${file.filename}": ${downloadError?.message ?? "no data"}`
              );
            }
            attachments.push({
              filename: file.filename,
              mimeType: file.mime_type,
              contentBase64: Buffer.from(await blob.arrayBuffer()).toString("base64"),
            });
          }
        }
        // Client-facing subject law (founder-ruled at the first witnessed
        // send): the message's own rendered subject travels on the row;
        // the thread's subject — which may be an internal label — is only
        // the fallback for hand-written replies on subject-titled threads.
        result = await sendViaProvider({
          to,
          subject: (comm.attributes?.subject as string | undefined) ?? threads[0]?.subject ?? null,
          body: sentEmailHtml ?? comm.body,
          bodyFormat: sentEmailHtml ? "html" : comm.body_format,
          ...(attachments?.length ? { attachments } : {}),
        });
      } else {
        if (!options.providers.sendWhatsApp) {
          report.skipped += 1;
          report.errors.push(`comm ${comm.id}: WhatsApp carrier not configured — it stays approved`);
          continue;
        }
        const to = await resolveDestination(db, contactId, "whatsapp");
        if (!to) throw new ProviderRejectedError("no live WhatsApp channel on the contact", "whatsapp");
        const template = (comm.attributes?.wa_template as WaTemplateRef | undefined) ?? null;
        result = await options.providers.sendWhatsApp({ to: waNumber(to), body: comm.body, template });
      }

      // The Contacted transition law (0022): the trigger inside the `sent`
      // transition moves a new_lead enquiry to Contacted on its first
      // genuinely dispatched outbound. The trigger owns the truth; this
      // dispatcher observes the move and puts it on The Record (law 11 —
      // SQL never writes the ledger).
      const stageBefore = comm.engagement_id
        ? await currentStage(db, comm.engagement_id)
        : null;

      const { error: sentError } = await db.rpc("mark_communication_sent", {
        p_comm: comm.id,
        p_provider: result.provider,
        p_provider_message_id: result.providerMessageId,
      });
      if (sentError) throw new Error(`mark_communication_sent failed: ${sentError.message}`);

      // PR-iii (Session 19): The Record stores what was sent — the row's body
      // becomes the exact dispatched HTML with body_format moved to html (the
      // ruling's words), and attributes.plain_body preserves the approved
      // plain source (the compliance check row pins it too). The pre-flight
      // and stamp already ran on the plain words; this write records
      // carriage, it changes no status. JUDGMENT: a failure here never
      // unwinds a successful send — it lands in the report as a visible
      // bookkeeping error instead.
      let recordedFormat = comm.body_format;
      if (sentEmailHtml) {
        const { error: recordError } = await db
          .from("communications")
          .update({
            body: sentEmailHtml,
            body_format: "html",
            attributes: { ...comm.attributes, plain_body: comm.body },
          })
          .eq("id", comm.id);
        if (recordError) {
          report.errors.push(`comm ${comm.id}: sent, but recording the dispatched HTML failed: ${recordError.message}`);
        } else {
          recordedFormat = "html";
        }
      }

      if (comm.engagement_id && stageBefore) {
        const stageAfter = await currentStage(db, comm.engagement_id);
        if (stageAfter && stageAfter.id !== stageBefore.id) {
          await emitEvent(db, {
            business_id: comm.business_id,
            actor_id: facts.dispatch_actor_id,
            action: "engagement.stage_changed",
            entity_type: "engagement",
            entity_id: comm.engagement_id,
            payload: {
              from_stage: stageBefore.key,
              to_stage: stageAfter.key,
              reason: "first_outbound_dispatched",
              note: "First outbound reached the client — New → Contacted (the template's transition law).",
              communication_id: comm.id,
            },
          });
        }
      }
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
          contact_id: contactId,
          // PR-iii: how the mail actually left — html rows carry the exact
          // dispatched document on the communication row itself.
          body_format: recordedFormat,
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
