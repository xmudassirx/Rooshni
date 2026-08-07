import { loadEnv } from "./env";
import { createServiceClient } from "../src/client";
import { emitEvent } from "../src/events";
import { backfillConsentShape, planWhatsAppBackfill, type BackfillChannel } from "../src/whatsapp-backfill";

/**
 * D187 (founder-ruled 7 Aug 2026) — the one-off WhatsApp channel backfill,
 * extending D186 retroactively. The seed:memory pattern: the app door,
 * never SQL inserts; every created row is evented per contact as
 * contact.channel_added with backfill provenance and the original grant
 * date. IDEMPOTENT — an existing whatsapp row stands the contact down; the
 * chore runs safely twice.
 *
 *   npm run backfill:whatsapp-channels --workspace=@rooshni/db
 *
 * Scan universe: live contacts holding at least one live phone channel.
 * Per D187, only a phone consent whose source is meta_lead_form is basis;
 * every other source is a counted, visible skip — never touched.
 * Staged on GO-LIVE; run against live only at the founder's explicit go.
 */

interface Report {
  eligible: number;
  created: number;
  skipped_existing: number;
  skipped_out_of_basis: number;
}

async function main() {
  loadEnv();
  const db = createServiceClient();

  const { data: channelRows, error: chError } = await db
    .from("contact_channels")
    .select("contact_id, business_id, channel, value, consent, archived_at")
    .is("archived_at", null);
  if (chError) throw new Error(`channel scan failed: ${chError.message}`);

  const byContact = new Map<string, { business_id: string; channels: BackfillChannel[] }>();
  for (const row of channelRows ?? []) {
    const entry = byContact.get(row.contact_id as string) ?? {
      business_id: row.business_id as string,
      channels: [],
    };
    entry.channels.push({
      channel: row.channel as string,
      value: row.value as string | null,
      consent: (row.consent ?? null) as Record<string, unknown> | null,
      archived_at: row.archived_at as string | null,
    });
    byContact.set(row.contact_id as string, entry);
  }

  const contactIds = [...byContact.keys()];
  if (contactIds.length === 0) {
    console.log("No live contact channels found — nothing to backfill.");
    return;
  }
  const { data: contacts, error: cError } = await db
    .from("contacts")
    .select("id, archived_at")
    .in("id", contactIds);
  if (cError) throw new Error(`contact scan failed: ${cError.message}`);
  const archivedById = new Map((contacts ?? []).map((c) => [c.id as string, c.archived_at !== null]));

  const reports = new Map<string, Report>();
  const reportFor = (businessId: string): Report => {
    const r = reports.get(businessId) ?? { eligible: 0, created: 0, skipped_existing: 0, skipped_out_of_basis: 0 };
    reports.set(businessId, r);
    return r;
  };

  for (const [contactId, entry] of byContact) {
    // The universe is phone-bearing contacts; others are outside the scan.
    if (!entry.channels.some((c) => c.channel === "phone")) continue;
    const decision = planWhatsAppBackfill({
      archived: archivedById.get(contactId) ?? true,
      channels: entry.channels,
    });
    if (decision.action === "skip_archived") continue;
    const report = reportFor(entry.business_id);
    if (decision.action === "skip_existing") {
      report.skipped_existing += 1;
      continue;
    }
    if (decision.action === "skip_out_of_basis") {
      report.skipped_out_of_basis += 1;
      continue;
    }
    report.eligible += 1;

    // JUDGMENT: is_primary false — the backfill grants an ADDITIONAL
    // channel to an existing contact (the D175b enrichment lane); primacy
    // stays a human call. Listed at close.
    const { error: insError } = await db.from("contact_channels").insert({
      business_id: entry.business_id,
      created_by: await workflowActorFor(db, entry.business_id),
      contact_id: contactId,
      channel: "whatsapp",
      value: decision.value,
      is_primary: false,
      consent: backfillConsentShape(decision.granted_at),
    });
    if (insError) throw new Error(`whatsapp insert failed for ${contactId}: ${insError.message}`);

    await emitEvent(db, {
      business_id: entry.business_id,
      actor_id: await workflowActorFor(db, entry.business_id),
      action: "contact.channel_added",
      entity_type: "contact",
      entity_id: contactId,
      payload: {
        channel: "whatsapp",
        value: decision.value,
        consent_source: "meta_lead_form",
        backfill: "D187",
        original_granted_at: decision.granted_at,
        note: "D187 one-off backfill extending D186: the form's privacy-policy gate is explicit consent; the whatsapp channel joins phone and email retroactively",
      },
    });
    report.created += 1;
  }

  if (reports.size === 0) {
    console.log("No phone-bearing live contacts found — nothing to backfill.");
    return;
  }
  for (const [businessId, r] of reports) {
    console.log(
      `business ${businessId}: ${r.eligible} eligible, ${r.created} created, ` +
        `${r.skipped_existing} skipped (existing whatsapp), ${r.skipped_out_of_basis} skipped (out of basis).`
    );
  }
}

const actorCache = new Map<string, string>();
async function workflowActorFor(db: ReturnType<typeof createServiceClient>, businessId: string): Promise<string> {
  const cached = actorCache.get(businessId);
  if (cached) return cached;
  const { data: biz, error: bizError } = await db
    .from("businesses")
    .select("account_id")
    .eq("id", businessId)
    .maybeSingle();
  if (bizError || !biz) throw new Error(`business lookup failed for ${businessId}: ${bizError?.message ?? "not found"}`);
  const { data: actors, error: actorError } = await db
    .from("actors")
    .select("id")
    .eq("account_id", biz.account_id)
    .eq("actor_type", "workflow")
    .is("archived_at", null);
  if (actorError) throw new Error(`actor lookup failed: ${actorError.message}`);
  if ((actors ?? []).length !== 1) {
    throw new Error(`business ${businessId} needs exactly one workflow actor (saw ${(actors ?? []).length})`);
  }
  const id = actors![0]!.id as string;
  actorCache.set(businessId, id);
  return id;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
