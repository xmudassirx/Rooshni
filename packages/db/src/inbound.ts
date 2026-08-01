import type { SupabaseClient } from "@supabase/supabase-js";
import { emitEvent } from "./events";
import { INBOUND_EVENT_KINDS } from "./event-kinds";
import { normalisePhone } from "./meta";
import { armSettleTimer } from "./supersede";
import type { GraphInboundReader } from "./graph";

/**
 * Inbound capture (Session 16, PR-A) — the supersede engine's prerequisite.
 * Client messages become communications rows (direction inbound, status
 * received), thread-matched, consent-refreshed, every one evented.
 *
 * Discipline (external-integrations): idempotency on the PROVIDER's message
 * id via the 0028 claim tables (wa_webhook_events / graph_mail_events —
 * webhook replays and overlapping polls change nothing); an inbound path may
 * create Level 2 rows under the integration actor but can NEVER approve,
 * publish or send — the human-stamp triggers apply identically.
 *
 * The WhatsApp 24h customer-service window is PROVIDER law in real time
 * (decision 92 class — never TIME_SCALE data): an inbound message opens it,
 * the state is recorded on the thread, and the 0021 pre-flight remains the
 * enforcement truth (it reads the inbound rows this module writes).
 */

export const WA_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

async function q<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>, what: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${what}: ${error.message}`);
  return (data ?? ([] as unknown)) as T;
}

export interface InboundBinding {
  business_id: string;
  account_id: string;
  integration_actor_id: string;
}

/**
 * Which tenant does an inbound door belong to? The binding lives in
 * businesses.settings (settings.whatsapp.phone_number_id for the WhatsApp
 * number, settings.graph.mailbox for the polled mailbox) — set by
 * `npm run wire-inbound`. Exactly one match is lawful; ambiguity or absence
 * is a loud failure, never a guess (the resolveMetaBusiness pattern).
 */
export async function resolveInboundBusiness(
  db: SupabaseClient,
  binding: { whatsapp_phone_number_id?: string; graph_mailbox?: string }
): Promise<InboundBinding> {
  let query = db.from("businesses").select("id, account_id").is("archived_at", null);
  let label: string;
  if (binding.whatsapp_phone_number_id) {
    query = query.eq("settings->whatsapp->>phone_number_id", binding.whatsapp_phone_number_id);
    label = `WhatsApp number ${binding.whatsapp_phone_number_id}`;
  } else if (binding.graph_mailbox) {
    query = query.eq("settings->graph->>mailbox", binding.graph_mailbox.toLowerCase());
    label = `mailbox ${binding.graph_mailbox}`;
  } else {
    throw new Error("resolveInboundBusiness needs a binding value");
  }
  const businesses = await q<{ id: string; account_id: string }[]>(query, "inbound business lookup");
  if (businesses.length !== 1) {
    throw new Error(
      `${label} maps to ${businesses.length} businesses — run \`npm run wire-inbound\` so the binding names exactly one`
    );
  }
  const business = businesses[0]!;
  const integrations = await q<{ id: string }[]>(
    db
      .from("actors")
      .select("id")
      .eq("account_id", business.account_id)
      .eq("actor_type", "integration")
      .is("archived_at", null),
    "integration actor lookup"
  );
  if (integrations.length !== 1) {
    throw new Error(`Account for ${label} holds ${integrations.length} integration actors — exactly one is required`);
  }
  return {
    business_id: business.id,
    account_id: business.account_id,
    integration_actor_id: integrations[0]!.id,
  };
}

const digitsOf = (value: string) => value.replace(/[^\d]/g, "");

/** Newest live (outcome-less, unarchived) engagement the contact participates
 * in — the deterministic best-effort attachment for a fresh inbound thread.
 * JUDGMENT: PR-A says "unmatched inbound creating a new thread on the
 * contact" without naming an engagement; attaching the contact's newest live
 * enquiry keeps the supersede guard (per engagement per channel) reachable,
 * and null stays honest when the contact has none. */
async function latestLiveEngagementId(
  db: SupabaseClient,
  businessId: string,
  contactId: string
): Promise<string | null> {
  const participants = await q<{ engagement_id: string }[]>(
    db
      .from("engagement_participants")
      .select("engagement_id")
      .eq("business_id", businessId)
      .eq("contact_id", contactId)
      .is("archived_at", null),
    "participant lookup"
  );
  if (participants.length === 0) return null;
  const engagements = await q<{ id: string }[]>(
    db
      .from("engagements")
      .select("id")
      .in("id", participants.map((p) => p.engagement_id))
      .is("outcome", null)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(1),
    "live engagement lookup"
  );
  return engagements[0]?.id ?? null;
}

/** The contact's newest thread on a channel, or a fresh one. */
async function ensureThread(
  db: SupabaseClient,
  binding: InboundBinding,
  contactId: string,
  channel: "email" | "whatsapp",
  subject: string | null
): Promise<{ id: string; engagement_id: string | null; created: boolean }> {
  const existing = await q<{ id: string; engagement_id: string | null }[]>(
    db
      .from("comm_threads")
      .select("id, engagement_id")
      .eq("business_id", binding.business_id)
      .eq("contact_id", contactId)
      .eq("channel", channel)
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(1),
    "thread lookup"
  );
  if (existing[0]) return { ...existing[0], created: false };
  const engagementId = await latestLiveEngagementId(db, binding.business_id, contactId);
  const created = await q<{ id: string }[]>(
    db
      .from("comm_threads")
      .insert({
        business_id: binding.business_id,
        created_by: binding.integration_actor_id,
        contact_id: contactId,
        engagement_id: engagementId,
        channel,
        subject,
      })
      .select("id"),
    "thread insert"
  );
  return { id: created[0]!.id, engagement_id: engagementId, created: true };
}

export interface InboundWhatsAppInput {
  phone_number_id: string;
  wamid: string;
  /** Sender's WhatsApp id — digits with country code, no plus. */
  from: string;
  profile_name: string | null;
  /** Message text; non-text types arrive as a stated placeholder body. */
  body: string;
  wa_type: string;
  occurred_at: string;
}

/**
 * The consent an inbound WhatsApp message earns — PURE, so the harness can
 * prove the law (founder-ruled, 1 Aug 2026): "an inbound message on a
 * channel is transactional consent to be answered on that channel."
 * Transactional only; MARKETING consent is never inferred and any prior
 * marketing value passes through untouched.
 */
export function whatsAppInboundConsent(
  prior: Record<string, unknown> | null | undefined,
  occurredAt: string,
  serviceWindow: { opened_at: string; expires_at: string; source: string }
): Record<string, unknown> {
  return {
    ...(prior ?? {}),
    transactional: true,
    granted_at: occurredAt,
    source: "inbound_message",
    service_window: serviceWindow,
  };
}

export interface InboundRecordResult {
  communication_id: string;
  thread_id: string;
  contact_id: string;
  engagement_id: string | null;
  business_id: string;
  contact_created: boolean;
  service_window_expires_at?: string;
}

/**
 * One inbound WhatsApp message → communications row. The caller (webhook
 * route) has already verified the signature and claimed the wamid.
 *
 * JUDGMENT: an unknown number messaging the firm's WABA becomes a NEW
 * contact (a person choosing to message an immigration firm is an enquirer,
 * the same Level 2 act as lead ingest) — while unmatched EMAIL inbound
 * without a known contact is skipped with a recorded outcome: an open
 * mailbox attracts spam, and fabricating contact rows from spam would be
 * data-minimisation in reverse. Both listed for sign-off at close.
 */
export async function recordInboundWhatsApp(
  db: SupabaseClient,
  binding: InboundBinding,
  input: InboundWhatsAppInput
): Promise<InboundRecordResult> {
  const fromDigits = digitsOf(input.from);
  const e164 = normalisePhone(input.from.startsWith("+") ? input.from : `+${fromDigits}`);
  const windowExpiresAt = new Date(new Date(input.occurred_at).getTime() + WA_SERVICE_WINDOW_MS).toISOString();

  // Contact match: any live whatsapp/phone channel whose digits equal the
  // sender's. Newest channel row wins when several contacts share a number.
  const channels = await q<{ contact_id: string; channel: string; value: string; id: string; consent: Record<string, unknown> | null }[]>(
    db
      .from("contact_channels")
      .select("id, contact_id, channel, value, consent")
      .eq("business_id", binding.business_id)
      .in("channel", ["whatsapp", "phone"])
      .is("archived_at", null)
      .order("created_at", { ascending: false }),
    "contact channel lookup"
  );
  const matches = channels.filter((c) => digitsOf(c.value) === fromDigits);

  let contactId = matches[0]?.contact_id ?? null;
  let contactCreated = false;
  if (!contactId) {
    const displayName = input.profile_name?.trim() || e164;
    const contacts = await q<{ id: string }[]>(
      db
        .from("contacts")
        .insert({
          business_id: binding.business_id,
          created_by: binding.integration_actor_id,
          type: "person",
          display_name: displayName,
          given_name: input.profile_name?.trim() ? displayName.split(/\s+/)[0] : null,
          status: "active",
          first_touch: { source: "whatsapp_inbound", occurred_at: input.occurred_at },
          locale: "en-GB",
        })
        .select("id"),
      "contact insert"
    );
    contactId = contacts[0]!.id;
    contactCreated = true;
    await emitEvent(db, {
      business_id: binding.business_id,
      actor_id: binding.integration_actor_id,
      action: "contact.created",
      entity_type: "contact",
      entity_id: contactId,
      payload: { source: "whatsapp_inbound", display_name: displayName },
    });
  }

  // Consent refresh — founder-ruled (1 Aug 2026, Session 19 fold-in): "an
  // inbound message on a channel is transactional consent to be answered on
  // that channel." Ingest creates-or-refreshes a TRANSACTIONAL consent row
  // on the whatsapp channel FOR THE MATCHED CONTACT (source:
  // inbound_message); marketing consent is NEVER inferred from an inbound
  // message and is left untouched. The 24h service-window state also rides
  // the row; its display truth lives on the thread. The row is scoped to
  // contactId — when several contacts share a number, the consent lands on
  // the contact the message was filed under, never a namesake's row.
  const waChannel = matches.find((c) => c.channel === "whatsapp" && c.contact_id === contactId);
  const serviceWindow = { opened_at: input.occurred_at, expires_at: windowExpiresAt, source: "whatsapp_inbound" };
  if (waChannel) {
    await q(
      db
        .from("contact_channels")
        .update({
          consent: whatsAppInboundConsent(waChannel.consent, input.occurred_at, serviceWindow),
        })
        .eq("id", waChannel.id)
        .select("id"),
      "consent refresh"
    );
  } else {
    const ownWa = await q<{ id: string }[]>(
      db
        .from("contact_channels")
        .select("id")
        .eq("contact_id", contactId)
        .eq("channel", "whatsapp")
        .is("archived_at", null)
        .limit(1),
      "own whatsapp channel check"
    );
    await q(
      db
        .from("contact_channels")
        .insert({
          business_id: binding.business_id,
          created_by: binding.integration_actor_id,
          contact_id: contactId,
          channel: "whatsapp",
          value: e164,
          is_primary: ownWa.length === 0,
          consent: whatsAppInboundConsent(null, input.occurred_at, serviceWindow),
        })
        .select("id"),
      "whatsapp channel insert"
    );
    await emitEvent(db, {
      business_id: binding.business_id,
      actor_id: binding.integration_actor_id,
      action: "contact.channel_consented",
      entity_type: "contact",
      entity_id: contactId,
      payload: {
        channel: "whatsapp",
        consent: "transactional",
        source: "inbound_message",
        note: "an inbound message on a channel is transactional consent to be answered on that channel",
      },
    });
  }

  const thread = await ensureThread(db, binding, contactId, "whatsapp", null);

  const comms = await q<{ id: string }[]>(
    db
      .from("communications")
      .insert({
        business_id: binding.business_id,
        created_by: binding.integration_actor_id,
        thread_id: thread.id,
        contact_id: contactId,
        engagement_id: thread.engagement_id,
        channel: "whatsapp",
        direction: "inbound",
        status: "received",
        body: input.body,
        body_format: "plain",
        occurred_at: input.occurred_at,
        attributes: { wa_type: input.wa_type, ...(input.profile_name ? { from_name: input.profile_name } : {}) },
        external_refs: [{ system: "whatsapp", external_id: input.wamid, synced_at: new Date().toISOString() }],
      })
      .select("id"),
    "inbound communication insert"
  );
  const communicationId = comms[0]!.id;

  // The recorded window state (PR-A) — display truth on the thread; the
  // enforcement truth stays the 0021 pre-flight over inbound rows.
  await q(
    db
      .from("comm_threads")
      .update({ last_inbound_at: input.occurred_at, wa_service_window_expires_at: windowExpiresAt })
      .eq("id", thread.id)
      .select("id"),
    "thread window update"
  );

  // PR-C (decision 133b): every inbound arms — and RESTARTS — the thread's
  // settle timer; the cron evaluates it server-side.
  const settleDueAt = await armSettleTimer(db, thread.id);

  await emitEvent(db, {
    business_id: binding.business_id,
    actor_id: binding.integration_actor_id,
    action: INBOUND_EVENT_KINDS.communicationReceived,
    entity_type: "communication",
    entity_id: communicationId,
    payload: {
      channel: "whatsapp",
      thread_id: thread.id,
      contact_id: contactId,
      engagement_id: thread.engagement_id,
      wamid: input.wamid,
      service_window_expires_at: windowExpiresAt,
      ...(settleDueAt ? { settle_due_at: settleDueAt } : {}),
      ...(contactCreated ? { contact_created: true } : {}),
    },
  });

  return {
    communication_id: communicationId,
    thread_id: thread.id,
    contact_id: contactId,
    engagement_id: thread.engagement_id,
    business_id: binding.business_id,
    contact_created: contactCreated,
    service_window_expires_at: windowExpiresAt,
  };
}

export interface GraphPollReport {
  configured: boolean;
  polled: number;
  ingested: number;
  skipped: number;
  errors: string[];
  cursor: string | null;
}

/** Read-modify-write of the settings.graph cursor (service-role act). */
async function writeGraphCursor(db: SupabaseClient, businessId: string, cursorIso: string): Promise<void> {
  const rows = await q<{ settings: Record<string, unknown> }[]>(
    db.from("businesses").select("settings").eq("id", businessId).limit(1),
    "settings read"
  );
  const settings = rows[0]?.settings ?? {};
  const graph = (settings.graph ?? {}) as Record<string, unknown>;
  await q(
    db
      .from("businesses")
      .update({ settings: { ...settings, graph: { ...graph, inbound_cursor: cursorIso } } })
      .eq("id", businessId)
      .select("id"),
    "cursor write"
  );
}

/**
 * Poll the connected tenant mailbox for new inbound mail (PR-A: the existing
 * 5-minute cron; Graph webhook subscriptions are the recorded GO-LIVE future
 * tightening). Thread-matched by References/In-Reply-To against the ids our
 * outbound rows carry, then by sender address; unmatched inbound with a
 * known contact opens a new thread; inbound from strangers is skipped with a
 * recorded outcome. Idempotent on the RFC message id (graph_mail_events).
 *
 * FAIL VISIBLY: an unconfigured carrier or a Graph permission refusal
 * (Mail.Read application consent not yet granted) lands in the report's
 * errors — never a silent no-op, never a crash that blocks the tick.
 */
export async function pollGraphInbound(
  db: SupabaseClient,
  reader: GraphInboundReader | null,
  options: { now?: Date; top?: number } = {}
): Promise<GraphPollReport> {
  const report: GraphPollReport = { configured: false, polled: 0, ingested: 0, skipped: 0, errors: [], cursor: null };
  if (!reader) return report;
  report.configured = true;
  const now = options.now ?? new Date();

  let binding: InboundBinding;
  try {
    binding = await resolveInboundBusiness(db, { graph_mailbox: reader.mailbox });
  } catch (err) {
    report.errors.push(err instanceof Error ? err.message : String(err));
    return report;
  }

  const settingsRows = await q<{ settings: Record<string, unknown> }[]>(
    db.from("businesses").select("settings").eq("id", binding.business_id).limit(1),
    "settings read"
  );
  const graphSettings = (settingsRows[0]?.settings?.graph ?? {}) as Record<string, unknown>;
  let cursor = typeof graphSettings.inbound_cursor === "string" ? graphSettings.inbound_cursor : null;
  if (!cursor) {
    // First run establishes the baseline: only mail arriving AFTER wiring is
    // ingested — the mailbox's history is not ours to trawl.
    cursor = now.toISOString();
    try {
      await writeGraphCursor(db, binding.business_id, cursor);
    } catch (err) {
      report.errors.push(`cursor baseline write failed: ${err instanceof Error ? err.message : err}`);
      return report;
    }
    report.cursor = cursor;
    return report;
  }

  let listed: Awaited<ReturnType<GraphInboundReader["listNewMessages"]>>;
  try {
    listed = await reader.listNewMessages(cursor, options.top ?? 25);
  } catch (err) {
    // The Mail.Read consent gap lands here as ErrorAccessDenied — visible,
    // recorded, retried next tick; the founder's console steps lift it.
    report.errors.push(`inbox list failed: ${err instanceof Error ? err.message : err}`);
    return report;
  }
  report.polled = listed.length;

  let advancedTo: string | null = null;
  for (const head of listed) {
    const claimKey = head.internetMessageId ?? `graph:${head.id}`;
    try {
      // Idempotency claim on the RFC message id — an overlapping poll or a
      // cursor replay changes nothing.
      const { error: claimError } = await db.from("graph_mail_events").insert({
        internet_message_id: claimKey,
        graph_message_id: head.id,
        mailbox: reader.mailbox,
      });
      if (claimError) {
        if (claimError.code === "23505") {
          report.skipped += 1;
          advancedTo = head.receivedDateTime;
          continue;
        }
        throw new Error(`claim failed: ${claimError.message}`);
      }
      const stamp = async (outcome: string) => {
        await db
          .from("graph_mail_events")
          .update({ processed_at: new Date().toISOString(), outcome })
          .eq("internet_message_id", claimKey);
      };

      if (head.fromAddress && head.fromAddress === reader.mailbox.toLowerCase()) {
        await stamp("skipped: our own mail");
        report.skipped += 1;
        advancedTo = head.receivedDateTime;
        continue;
      }

      const detail = await reader.getMessage(head.id);

      // 1) Reply-header match: any referenced RFC id our rows already carry
      // (outbound sends record their internetMessageId; inbound rows record
      // theirs) names the thread.
      let threadId: string | null = null;
      let threadEngagementId: string | null = null;
      let contactId: string | null = null;
      for (const refId of detail.referenceIds) {
        const referenced = await q<{ thread_id: string; business_id: string }[]>(
          db
            .from("communications")
            .select("thread_id, business_id")
            .contains("external_refs", JSON.stringify([{ system: "graph", external_id: refId }]))
            .limit(1),
          "reference match lookup"
        );
        if (referenced[0] && referenced[0].business_id === binding.business_id) {
          threadId = referenced[0].thread_id;
          break;
        }
      }
      if (threadId) {
        const threads = await q<{ engagement_id: string | null; contact_id: string }[]>(
          db.from("comm_threads").select("engagement_id, contact_id").eq("id", threadId).limit(1),
          "matched thread read"
        );
        threadEngagementId = threads[0]?.engagement_id ?? null;
        contactId = threads[0]?.contact_id ?? null;
      }

      // 2) Sender match: the address names the contact; their newest email
      // thread carries the reply, or a fresh thread opens on the contact.
      if (!threadId) {
        if (!detail.fromAddress) {
          await stamp("skipped: no sender address");
          report.skipped += 1;
          advancedTo = head.receivedDateTime;
          continue;
        }
        const senderChannels = await q<{ contact_id: string }[]>(
          db
            .from("contact_channels")
            .select("contact_id")
            .eq("business_id", binding.business_id)
            .eq("channel", "email")
            .eq("value", detail.fromAddress)
            .is("archived_at", null)
            .order("created_at", { ascending: false })
            .limit(1),
          "sender lookup"
        );
        contactId = senderChannels[0]?.contact_id ?? null;
        if (!contactId) {
          // JUDGMENT: unmatched senders are skipped with a recorded outcome,
          // never turned into contact rows — an open mailbox attracts spam,
          // and PR-A's "new thread on the contact" presumes a contact.
          await stamp("skipped: no matching contact");
          report.skipped += 1;
          advancedTo = head.receivedDateTime;
          continue;
        }
        const thread = await ensureThread(db, binding, contactId, "email", detail.subject);
        threadId = thread.id;
        threadEngagementId = thread.engagement_id;
      }

      const comms = await q<{ id: string }[]>(
        db
          .from("communications")
          .insert({
            business_id: binding.business_id,
            created_by: binding.integration_actor_id,
            thread_id: threadId,
            contact_id: contactId,
            engagement_id: threadEngagementId,
            channel: "email",
            direction: "inbound",
            status: "received",
            body: detail.bodyText,
            body_format: "plain",
            occurred_at: detail.receivedDateTime,
            attributes: {
              ...(detail.subject ? { subject: detail.subject } : {}),
              ...(detail.fromName ? { from_name: detail.fromName } : {}),
            },
            external_refs: [
              {
                system: "graph",
                external_id: detail.internetMessageId ?? claimKey,
                synced_at: new Date().toISOString(),
              },
            ],
          })
          .select("id"),
        "inbound communication insert"
      );
      const communicationId = comms[0]!.id;

      await q(
        db
          .from("comm_threads")
          .update({ last_inbound_at: detail.receivedDateTime })
          .eq("id", threadId)
          .select("id"),
        "thread inbound update"
      );

      // PR-C (decision 133b): the settle timer arms/restarts on each inbound.
      const settleDueAt = await armSettleTimer(db, threadId);

      await emitEvent(db, {
        business_id: binding.business_id,
        actor_id: binding.integration_actor_id,
        action: INBOUND_EVENT_KINDS.communicationReceived,
        entity_type: "communication",
        entity_id: communicationId,
        payload: {
          channel: "email",
          thread_id: threadId,
          contact_id: contactId,
          engagement_id: threadEngagementId,
          internet_message_id: detail.internetMessageId,
          ...(settleDueAt ? { settle_due_at: settleDueAt } : {}),
        },
      });

      await stamp(`ingested: communication ${communicationId}`);
      report.ingested += 1;
      advancedTo = head.receivedDateTime;
    } catch (err) {
      // Stop advancing at the first hard failure so the next tick retries
      // from this message — the claim rows keep replays harmless.
      report.errors.push(`message ${claimKey}: ${err instanceof Error ? err.message : err}`);
      break;
    }
  }

  if (advancedTo && advancedTo > cursor) {
    try {
      await writeGraphCursor(db, binding.business_id, advancedTo);
      report.cursor = advancedTo;
    } catch (err) {
      report.errors.push(`cursor advance failed: ${err instanceof Error ? err.message : err}`);
    }
  } else {
    report.cursor = cursor;
  }
  return report;
}
