import type { SupabaseClient } from "@supabase/supabase-js";

import { CONTACT_EVENT_KINDS } from "./event-kinds";
import { emitEvent } from "./events";

/*
 * Session 30 (177c) — the contact ARCHIVE. Archiving stamps archived_at on
 * the contact AND on every live channel row, so:
 *   - the contact leaves RESOLUTION — every channel-value resolver
 *     (returning-leads, inbound WhatsApp/email matching, conversions) already
 *     filters contact_channels.archived_at is null;
 *   - its channels leave CONSENT — the 0043 consent pre-flight reads only
 *     live channel rows;
 *   - its HISTORY stands untouched — threads, communications, enquiries and
 *     every ledger line keep their rows; nothing is deleted, deletion does
 *     not exist (append-only; 0012/0013 grant no DELETE anywhere).
 *
 * JUDGMENT (Lane B): owner-only "for now" is gated in the app layer (the
 * pure predicate below + the server action's membershipRole check — the
 * 0037 task-cancellation manager-gate precedent). The database's own walls
 * (RLS, no DELETE, append-only history) are untouched; a database door for
 * the owner gate is a natural later hardening if the founder orders it.
 */

/** The single render/act truth for the Archive control (decision 116). */
export function canArchiveContact(input: { isOwner: boolean; alreadyArchived: boolean }): boolean {
  return input.isOwner && !input.alreadyArchived;
}

export interface ArchiveContactInput {
  business_id: string;
  contact_id: string;
  /** The owner's own human actor. */
  actor_id: string;
  reason?: string;
}

export async function archiveContact(
  db: SupabaseClient,
  input: ArchiveContactInput
): Promise<{ channelsArchived: number; displayName: string }> {
  const archivedAt = new Date().toISOString();
  const { data: contact, error } = await db
    .from("contacts")
    .update({ archived_at: archivedAt })
    .eq("id", input.contact_id)
    .eq("business_id", input.business_id)
    .is("archived_at", null)
    .select("id, display_name")
    .maybeSingle();
  if (error) throw new Error(`contact archive failed: ${error.message}`);
  if (!contact) throw new Error("The contact does not exist or is already archived.");

  const { data: channels, error: channelError } = await db
    .from("contact_channels")
    .update({ archived_at: archivedAt })
    .eq("contact_id", input.contact_id)
    .eq("business_id", input.business_id)
    .is("archived_at", null)
    .select("id");
  if (channelError) throw new Error(`channel archive failed: ${channelError.message}`);

  await emitEvent(db, {
    business_id: input.business_id,
    actor_id: input.actor_id,
    action: CONTACT_EVENT_KINDS.archived,
    entity_type: "contact",
    entity_id: input.contact_id,
    payload: {
      display_name: contact.display_name,
      channels_archived: channels?.length ?? 0,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });
  return { channelsArchived: channels?.length ?? 0, displayName: contact.display_name as string };
}
