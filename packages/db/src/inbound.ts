import type { SupabaseClient } from "@supabase/supabase-js";
import { scaleDurationMs } from "@rooshni/config";
import { emitEvent } from "./events";
import { INBOUND_EVENT_KINDS } from "./event-kinds";
import { normalisePhone } from "./meta";
import { armSettleTimer } from "./supersede";
import type { MailboxInboundReader } from "./mailbox";

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
 * number, settings.graph.mailbox / settings.gmail.mailbox for the polled
 * mailbox of each provider) — set by `npm run wire-inbound`. Exactly one
 * match is lawful; ambiguity or absence is a loud failure, never a guess
 * (the resolveMetaBusiness pattern).
 */
export async function resolveInboundBusiness(
  db: SupabaseClient,
  binding: { whatsapp_phone_number_id?: string; graph_mailbox?: string; gmail_mailbox?: string }
): Promise<InboundBinding> {
  let query = db.from("businesses").select("id, account_id").is("archived_at", null);
  let label: string;
  if (binding.whatsapp_phone_number_id) {
    query = query.eq("settings->whatsapp->>phone_number_id", binding.whatsapp_phone_number_id);
    label = `WhatsApp number ${binding.whatsapp_phone_number_id}`;
  } else if (binding.graph_mailbox) {
    query = query.eq("settings->graph->>mailbox", binding.graph_mailbox.toLowerCase());
    label = `mailbox ${binding.graph_mailbox}`;
  } else if (binding.gmail_mailbox) {
    query = query.eq("settings->gmail->>mailbox", binding.gmail_mailbox.toLowerCase());
    label = `Gmail mailbox ${binding.gmail_mailbox}`;
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

export interface MailPollReport {
  configured: boolean;
  polled: number;
  ingested: number;
  skipped: number;
  /** Claims still unprocessed past the stale window AFTER this poll's
   * recovery attempt — each one is an evented, visible failure (hotfix,
   * 2 Aug 2026). */
  stale: number;
  errors: string[];
  cursor: string | null;
}

/** The Session 16 name, kept for its call sites. */
export type GraphPollReport = MailPollReport;

/** Per-provider wiring for the shared mailbox poll (Session 20): where the
 * binding and cursor live in businesses.settings, which claim table takes
 * the idempotency insert, and which external_refs system names the rows. */
interface MailProviderConfig {
  provider: "graph" | "gmail";
  claimTable: "graph_mail_events" | "gmail_mail_events";
  providerIdColumn: "graph_message_id" | "gmail_message_id";
}

const MAIL_POLL_CONFIGS: Record<"graph" | "gmail", MailProviderConfig> = {
  graph: { provider: "graph", claimTable: "graph_mail_events", providerIdColumn: "graph_message_id" },
  gmail: { provider: "gmail", claimTable: "gmail_mail_events", providerIdColumn: "gmail_message_id" },
};

/**
 * HOTFIX (2 Aug 2026, founder-ruled): a claimed inbound mail row still
 * unprocessed after this REAL duration is itself an evented, visible failure
 * — the silence was the worst part of the defect this hotfix repairs. A
 * product timer: scaled through timeScale() (law 11).
 */
export const MAIL_CLAIM_STALE_AFTER_MS = 15 * 60 * 1000;

/** The moment before which an unprocessed claim counts as stale — PURE, so
 * the harness proves the window rides timeScale(). */
export function mailClaimStaleCutoffIso(now: Date): string {
  return new Date(now.getTime() - scaleDurationMs(MAIL_CLAIM_STALE_AFTER_MS)).toISOString();
}

/** Read-modify-write of the settings.<provider> cursor (service-role act). */
async function writeMailCursor(
  db: SupabaseClient,
  businessId: string,
  provider: "graph" | "gmail",
  cursorIso: string
): Promise<void> {
  const rows = await q<{ settings: Record<string, unknown> }[]>(
    db.from("businesses").select("settings").eq("id", businessId).limit(1),
    "settings read"
  );
  const settings = rows[0]?.settings ?? {};
  const providerSettings = (settings[provider] ?? {}) as Record<string, unknown>;
  await q(
    db
      .from("businesses")
      .update({ settings: { ...settings, [provider]: { ...providerSettings, inbound_cursor: cursorIso } } })
      .eq("id", businessId)
      .select("id"),
    "cursor write"
  );
}

/**
 * Poll a connected tenant mailbox for new inbound mail (Session 16 PR-A for
 * Graph, on the existing 5-minute cron; Session 20 adds the Gmail sibling
 * through the same engine — webhook/push subscriptions remain the recorded
 * GO-LIVE future tightening). Thread-matched by References/In-Reply-To
 * against the ids our outbound rows carry, then by sender address; unmatched
 * inbound with a known contact opens a new thread; inbound from strangers is
 * skipped with a recorded outcome. Idempotent on the RFC message id
 * (graph_mail_events / gmail_mail_events).
 *
 * FAIL VISIBLY: an unconfigured carrier or a provider permission refusal
 * (Mail.Read consent, Gmail scope consent) lands in the report's errors —
 * never a silent no-op, never a crash that blocks the tick.
 */
/**
 * Process ONE claimed inbound mail into its communications row (or a recorded
 * skip). Shared by the live poll loop and the stale-claim recovery sweep —
 * the caller owns the claim row and stamps the returned outcome.
 *
 * Idempotent on the claim key: a communications row already carrying it means
 * an earlier attempt died between the insert and the claim stamp — the row is
 * the truth; recover the stamp, never duplicate the mail.
 */
async function processOneMailMessage(
  db: SupabaseClient,
  binding: InboundBinding,
  reader: MailboxInboundReader,
  cfg: MailProviderConfig,
  head: { id: string; fromAddress: string | null },
  claimKey: string
): Promise<{ outcome: string; ingested: boolean }> {
  const already = await q<{ id: string }[]>(
    db
      .from("communications")
      .select("id")
      .eq("business_id", binding.business_id)
      .contains("external_refs", JSON.stringify([{ system: cfg.provider, external_id: claimKey }]))
      .limit(1),
    "prior ingest check"
  );
  if (already[0]) {
    return { outcome: `ingested: communication ${already[0].id} (stamp recovered)`, ingested: true };
  }

  if (head.fromAddress && head.fromAddress === reader.mailbox.toLowerCase()) {
    return { outcome: "skipped: our own mail", ingested: false };
  }

  const detail = await reader.getMessage(head.id);
  if (detail.fromAddress && detail.fromAddress === reader.mailbox.toLowerCase()) {
    // The recovery path carries no listing head — the check re-runs on the
    // fetched detail so a recovered claim obeys the same law.
    return { outcome: "skipped: our own mail", ingested: false };
  }

  // 1) Reply-header match: any referenced RFC id our rows already carry
  // (outbound sends record their internetMessageId; inbound rows record
  // theirs) names the thread.
  let threadId: string | null = null;
  let threadEngagementId: string | null = null;
  let contactId: string | null = null;
  for (const refId of detail.referenceIds) {
    // JUDGMENT (Session 20): the reference match reads BOTH mail systems'
    // refs — an RFC message id is globally unique whichever carrier minted
    // it, and a thread whose history spans a provider switch must still
    // match. Business isolation is the check below, never the system string.
    //
    // HOTFIX (2 Aug 2026): the s20 shape packed both containments into one
    // PostgREST `or=` string; embedded JSON can NEVER parse there (PGRST100
    // "failed to parse logic tree", proven against production with the
    // founder's own reply), so every reply threw and the claim/cursor march
    // orphaned the mail. Two `.contains` filters (the meta.ts pattern, in
    // production since Meta ingest) express the same match parseably; the
    // check-local tripwire fences the `or=` shape off this column for good.
    for (const system of ["graph", "gmail"] as const) {
      const referenced = await q<{ thread_id: string; business_id: string }[]>(
        db
          .from("communications")
          .select("thread_id, business_id")
          .contains("external_refs", JSON.stringify([{ system, external_id: refId }]))
          .limit(1),
        "reference match lookup"
      );
      if (referenced[0] && referenced[0].business_id === binding.business_id) {
        threadId = referenced[0].thread_id;
        break;
      }
    }
    if (threadId) break;
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
      return { outcome: "skipped: no sender address", ingested: false };
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
      return { outcome: "skipped: no matching contact", ingested: false };
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
            system: cfg.provider,
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

  return { outcome: `ingested: communication ${communicationId}`, ingested: true };
}

/**
 * FAIL-CLOSED TIGHTENING (founder-ruled hotfix, 2 Aug 2026): "a claimed row
 * still unprocessed after N minutes is itself an evented, visible failure —
 * silence was the worst part of this bug."
 *
 * Every poll sweeps its claim table for rows unprocessed past the stale
 * window: each one (a) lands `inbound.mail_claim_stale` on The Record — once
 * per claim, deduped against the ledger (the meta.spend_pulled precedent) —
 * and (b) is retried through the same processing pipeline until it stamps.
 * This sweep is also the backlog healer: claims the defect orphaned BEHIND
 * the cursor are unreachable by the listing loop forever, so only a
 * cursor-independent scan can recover them.
 */
async function sweepStaleMailClaims(
  db: SupabaseClient,
  binding: InboundBinding,
  reader: MailboxInboundReader,
  cfg: MailProviderConfig,
  report: MailPollReport,
  now: Date
): Promise<void> {
  type StaleClaim = { id: string; internet_message_id: string; created_at: string } & Record<string, string | null>;
  let stale: StaleClaim[];
  try {
    stale = await q<StaleClaim[]>(
      db
        .from(cfg.claimTable)
        .select(`id, internet_message_id, ${cfg.providerIdColumn}, created_at`)
        .eq("mailbox", reader.mailbox)
        .is("processed_at", null)
        .lt("created_at", mailClaimStaleCutoffIso(now))
        .order("created_at", { ascending: true })
        .limit(20), // bounded read (decision 157 5e) — the rest next tick
      "stale claim scan"
    );
  } catch (err) {
    report.errors.push(`stale claim scan failed: ${err instanceof Error ? err.message : err}`);
    return;
  }

  for (const claim of stale) {
    let recovered = false;
    let lastError: string | null = null;
    const providerId = claim[cfg.providerIdColumn];
    if (!providerId) {
      lastError = "claim carries no provider message id — cannot re-fetch";
    } else {
      try {
        const result = await processOneMailMessage(
          db,
          binding,
          reader,
          cfg,
          { id: providerId, fromAddress: null },
          claim.internet_message_id
        );
        await q(
          db
            .from(cfg.claimTable)
            .update({
              processed_at: new Date().toISOString(),
              outcome: `${result.outcome} (recovered by stale sweep)`,
            })
            .eq("id", claim.id)
            .select("id"),
          "stale claim stamp"
        );
        recovered = true;
        if (result.ingested) report.ingested += 1;
        else report.skipped += 1;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        report.errors.push(`stale claim ${claim.internet_message_id}: ${lastError}`);
      }
    }
    if (!recovered) report.stale += 1;

    // The visible failure — once per claim on The Record, recovered or not:
    // the claim DID sit unprocessed past the window, and the ledger carries
    // what happened and why.
    try {
      const seen = await q<{ id: string }[]>(
        db
          .from("events")
          .select("id")
          .eq("business_id", binding.business_id)
          .eq("action", INBOUND_EVENT_KINDS.mailClaimStale)
          .eq("entity_id", claim.id)
          .limit(1),
        "stale event dedup"
      );
      if (!seen[0]) {
        await emitEvent(db, {
          business_id: binding.business_id,
          actor_id: binding.integration_actor_id,
          action: INBOUND_EVENT_KINDS.mailClaimStale,
          entity_type: "mail_claim",
          entity_id: claim.id,
          payload: {
            provider: cfg.provider,
            mailbox: reader.mailbox,
            internet_message_id: claim.internet_message_id,
            claimed_at: claim.created_at,
            recovered,
            ...(lastError ? { last_error: lastError } : {}),
          },
        });
      }
    } catch (err) {
      report.errors.push(`stale claim event failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function pollMailboxInbound(
  db: SupabaseClient,
  reader: MailboxInboundReader | null,
  cfg: MailProviderConfig,
  options: { now?: Date; top?: number } = {}
): Promise<MailPollReport> {
  const report: MailPollReport = { configured: false, polled: 0, ingested: 0, skipped: 0, stale: 0, errors: [], cursor: null };
  if (!reader) return report;
  report.configured = true;
  const now = options.now ?? new Date();

  let binding: InboundBinding;
  try {
    binding = await resolveInboundBusiness(
      db,
      cfg.provider === "graph" ? { graph_mailbox: reader.mailbox } : { gmail_mailbox: reader.mailbox }
    );
  } catch (err) {
    report.errors.push(err instanceof Error ? err.message : String(err));
    return report;
  }

  const settingsRows = await q<{ settings: Record<string, unknown> }[]>(
    db.from("businesses").select("settings").eq("id", binding.business_id).limit(1),
    "settings read"
  );
  const providerSettings = (settingsRows[0]?.settings?.[cfg.provider] ?? {}) as Record<string, unknown>;
  let cursor = typeof providerSettings.inbound_cursor === "string" ? providerSettings.inbound_cursor : null;
  if (!cursor) {
    // First run establishes the baseline: only mail arriving AFTER wiring is
    // ingested — the mailbox's history is not ours to trawl.
    cursor = now.toISOString();
    try {
      await writeMailCursor(db, binding.business_id, cfg.provider, cursor);
    } catch (err) {
      report.errors.push(`cursor baseline write failed: ${err instanceof Error ? err.message : err}`);
      return report;
    }
    report.cursor = cursor;
    return report;
  }

  // The fail-closed sweep runs BEFORE the listing so a broken reader or a
  // dead list call can never mute the stale-claim alarm (hotfix, 2 Aug
  // 2026); it is also what recovers claims the defect orphaned behind the
  // cursor, which no listing will ever return again.
  await sweepStaleMailClaims(db, binding, reader, cfg, report, now);

  let listed: Awaited<ReturnType<MailboxInboundReader["listNewMessages"]>>;
  try {
    listed = await reader.listNewMessages(cursor, options.top ?? 25);
  } catch (err) {
    // A consent gap lands here (Graph's ErrorAccessDenied, Gmail's 403) —
    // visible, recorded, retried next tick; the founder's console steps
    // lift it.
    report.errors.push(`inbox list failed: ${err instanceof Error ? err.message : err}`);
    return report;
  }
  report.polled = listed.length;

  let advancedTo: string | null = null;
  let halted = false;
  for (const head of listed) {
    const claimKey = head.internetMessageId ?? `${cfg.provider}:${head.id}`;
    try {
      // Idempotency claim on the RFC message id — an overlapping poll or a
      // cursor replay changes nothing.
      const { error: claimError } = await db.from(cfg.claimTable).insert({
        internet_message_id: claimKey,
        [cfg.providerIdColumn]: head.id,
        mailbox: reader.mailbox,
      });
      if (claimError) {
        if (claimError.code !== "23505") throw new Error(`claim failed: ${claimError.message}`);
        // HOTFIX (2 Aug 2026, the defect's heart): a duplicate claim is NOT
        // proof of completed work. Processed = a true replay (overlapping
        // poll / cursor rewind) — skip and advance. UNPROCESSED = an earlier
        // tick claimed this mail and died before finishing: the row is ours
        // to finish NOW, and the cursor must never advance past it. The old
        // branch skipped every duplicate blind, which marched the cursor
        // over claimed-but-dead rows and orphaned them in silence.
        const existing = await q<{ processed_at: string | null }[]>(
          db.from(cfg.claimTable).select("processed_at").eq("internet_message_id", claimKey).limit(1),
          "claim read"
        );
        if (existing[0]?.processed_at) {
          report.skipped += 1;
          if (!halted) advancedTo = head.receivedDateTime;
          continue;
        }
      }

      const result = await processOneMailMessage(db, binding, reader, cfg, head, claimKey);
      // The stamp is error-checked (it silently ignored failures before) —
      // a claim that cannot stamp stays unprocessed and trips the stale
      // sweep's alarm instead of vanishing.
      await q(
        db
          .from(cfg.claimTable)
          .update({ processed_at: new Date().toISOString(), outcome: result.outcome })
          .eq("internet_message_id", claimKey)
          .select("id"),
        "claim stamp"
      );
      if (result.ingested) report.ingested += 1;
      else report.skipped += 1;
      if (!halted) advancedTo = head.receivedDateTime;
    } catch (err) {
      // JUDGMENT (hotfix): a failed message FREEZES the cursor — the next
      // tick retries from it, the s16 law — but no longer aborts the rest
      // of the window: one poison mail must not silence the mailbox. Later
      // messages process under their own claims (replays harmless) and the
      // cursor holds until the failure clears or the stale sweep flags it.
      report.errors.push(`message ${claimKey}: ${err instanceof Error ? err.message : err}`);
      halted = true;
    }
  }

  if (advancedTo && advancedTo > cursor) {
    try {
      await writeMailCursor(db, binding.business_id, cfg.provider, advancedTo);
      report.cursor = advancedTo;
    } catch (err) {
      report.errors.push(`cursor advance failed: ${err instanceof Error ? err.message : err}`);
    }
  } else {
    report.cursor = cursor;
  }
  return report;
}

/** The Microsoft Graph poll (Session 16 shape, unchanged behaviour). */
export async function pollGraphInbound(
  db: SupabaseClient,
  reader: MailboxInboundReader | null,
  options: { now?: Date; top?: number } = {}
): Promise<MailPollReport> {
  return pollMailboxInbound(db, reader, MAIL_POLL_CONFIGS.graph, options);
}

/** The Gmail poll (Session 20) — same engine, same laws, its own claims. */
export async function pollGmailInbound(
  db: SupabaseClient,
  reader: MailboxInboundReader | null,
  options: { now?: Date; top?: number } = {}
): Promise<MailPollReport> {
  return pollMailboxInbound(db, reader, MAIL_POLL_CONFIGS.gmail, options);
}
