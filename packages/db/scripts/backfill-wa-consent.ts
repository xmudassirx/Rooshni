import { loadEnv } from "./env";
import { createServiceClient } from "../src/client";
import { emitEvent } from "../src/events";

/**
 * WhatsApp inbound consent backfill (Session 19 fold-in, founder-ruled
 * 1 Aug 2026): "an inbound message on a channel is transactional consent to
 * be answered on that channel."
 *
 *   npm run backfill:wa-consent --workspace=@rooshni/db
 *
 * For every contact who has SENT an inbound WhatsApp message but holds no
 * consented whatsapp channel row, create-or-refresh one: transactional only
 * (marketing consent untouched, never inferred), source inbound_message,
 * evented. IDEMPOTENT — a contact already consented is skipped; the chore
 * runs safely twice. A contact whose number cannot be resolved (no whatsapp
 * or phone channel value on file) is a counted, visible skip, never silent.
 */

async function main() {
  loadEnv();
  const db = createServiceClient();

  const { data: inbound, error: inboundError } = await db
    .from("communications")
    .select("id, business_id, contact_id, occurred_at, thread_id, comm_threads(contact_id)")
    .eq("channel", "whatsapp")
    .eq("direction", "inbound")
    .is("archived_at", null);
  if (inboundError) throw new Error(`inbound scan failed: ${inboundError.message}`);

  // Latest inbound per contact — its occurred_at becomes granted_at.
  const latestByContact = new Map<string, { business_id: string; occurred_at: string }>();
  for (const row of inbound ?? []) {
    const thread = row.comm_threads as unknown as { contact_id: string | null } | null;
    const contactId = (row.contact_id as string | null) ?? thread?.contact_id ?? null;
    if (!contactId) continue;
    const existing = latestByContact.get(contactId);
    if (!existing || row.occurred_at > existing.occurred_at) {
      latestByContact.set(contactId, { business_id: row.business_id, occurred_at: row.occurred_at });
    }
  }
  if (latestByContact.size === 0) {
    console.log("No inbound WhatsApp messages found — nothing to backfill.");
    return;
  }

  let refreshed = 0;
  let created = 0;
  let alreadyConsented = 0;
  let skippedNoNumber = 0;

  for (const [contactId, fact] of latestByContact) {
    const { data: channels, error: chError } = await db
      .from("contact_channels")
      .select("id, channel, value, consent, is_primary")
      .eq("contact_id", contactId)
      .is("archived_at", null);
    if (chError) throw new Error(`channels lookup failed for ${contactId}: ${chError.message}`);

    const wa = (channels ?? []).filter((c) => c.channel === "whatsapp");
    const consented = wa.some(
      (c) => (c.consent as Record<string, unknown> | null)?.transactional === true
        || (c.consent as Record<string, unknown> | null)?.marketing === true
    );
    if (consented) {
      alreadyConsented += 1;
      continue;
    }

    if (wa.length > 0) {
      // Refresh the newest whatsapp row in place — transactional only.
      const target = wa[0]!;
      const { error: updError } = await db
        .from("contact_channels")
        .update({
          consent: {
            ...((target.consent as Record<string, unknown> | null) ?? {}),
            transactional: true,
            granted_at: fact.occurred_at,
            source: "inbound_message",
          },
        })
        .eq("id", target.id);
      if (updError) throw new Error(`consent refresh failed for ${contactId}: ${updError.message}`);
      refreshed += 1;
    } else {
      const phone = (channels ?? []).find((c) => c.channel === "phone" && c.value);
      if (!phone) {
        console.warn(`contact ${contactId}: inbound WhatsApp exists but no whatsapp/phone number is on file — skipped (visible).`);
        skippedNoNumber += 1;
        continue;
      }
      const { error: insError } = await db.from("contact_channels").insert({
        business_id: fact.business_id,
        // The backfill acts as the platform's own record-keeping; the row's
        // creator is resolved below per business (the workflow actor).
        created_by: await workflowActorFor(db, fact.business_id),
        contact_id: contactId,
        channel: "whatsapp",
        value: phone.value,
        is_primary: true,
        consent: { transactional: true, granted_at: fact.occurred_at, source: "inbound_message" },
      });
      if (insError) throw new Error(`consent insert failed for ${contactId}: ${insError.message}`);
      created += 1;
    }

    await emitEvent(db, {
      business_id: fact.business_id,
      actor_id: await workflowActorFor(db, fact.business_id),
      action: "contact.channel_consented",
      entity_type: "contact",
      entity_id: contactId,
      payload: {
        channel: "whatsapp",
        consent: "transactional",
        source: "inbound_message",
        backfill: true,
        note: "an inbound message on a channel is transactional consent to be answered on that channel (founder-ruled, 1 Aug 2026)",
      },
    });
  }

  console.log(
    `WhatsApp consent backfill: ${latestByContact.size} inbound-bearing contact(s) scanned — ` +
      `${alreadyConsented} already consented, ${refreshed} refreshed, ${created} created, ${skippedNoNumber} skipped (no number on file).`
  );
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
