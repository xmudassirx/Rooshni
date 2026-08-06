"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { archiveContact, canArchiveContact } from "@rooshni/db";
import { archivedContactRedirect } from "@/lib/archive-redirect";
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

  let displayName: string;
  try {
    const archived = await archiveContact(db, {
      business_id: business.id,
      contact_id: contactId,
      actor_id: actor.id,
      reason: reason || undefined,
    });
    displayName = archived.displayName;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  revalidatePath("/contacts");
  revalidatePath("/record");
  // Workstream C (founder-witnessed): the archived page honestly 404s once
  // the read layer refuses the row — so the ACTION lands the browser on the
  // Contacts book, server-side, with the once-per-event confirmation named
  // in the URL. redirect() throws by design; it sits outside the catch.
  redirect(archivedContactRedirect(displayName));
}
