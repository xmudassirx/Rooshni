"use server";

import { revalidatePath } from "next/cache";
import { archiveContact, canArchiveContact } from "@rooshni/db";
import { getAppContext } from "@/lib/server/context";
import { isUuid } from "@/lib/server/queries";

/*
 * Session 30 (177c): the contact ARCHIVE — owner-only for now (the app-layer
 * gate, 0037 manager-gate precedent; the pure predicate is the one render
 * truth), evented with the optional reason. The archived contact leaves
 * resolution and its channels leave consent (archived_at cascades to every
 * live channel row); its history stands untouched; deletion does not exist.
 */

export interface ArchiveContactState {
  error: string | null;
  archived?: boolean;
}

export async function archiveContactAction(
  _prev: ArchiveContactState,
  formData: FormData
): Promise<ArchiveContactState> {
  const contactId = String(formData.get("contact_id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!isUuid(contactId)) return { error: "Unknown contact." };

  const { db, business, actor, membershipRole } = await getAppContext();
  if (!canArchiveContact({ isOwner: membershipRole === "owner", alreadyArchived: false })) {
    return { error: "Archiving a contact is the owner's act." };
  }

  try {
    await archiveContact(db, {
      business_id: business.id,
      contact_id: contactId,
      actor_id: actor.id,
      reason: reason || undefined,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  revalidatePath("/contacts");
  revalidatePath("/record");
  return { error: null, archived: true };
}
