/*
 * The Record's row behaviour — Session 26 (C1, founder-ordered): clicking a
 * row EXPANDS it in place; where an entry leads renders as a labelled button
 * INSIDE the expanded row, never as the row's own click target.
 *
 * The where-does-this-lead decision lives here, pure, so the harness proves
 * it component-level (the live-inbox-rules precedent: the rules module is
 * imported by check-local, the component's shape pinned by tripwire).
 */

export interface RecordRowEvent {
  entityType: string | null;
  entityId: string | null;
  payload: Record<string, unknown>;
}

export interface RecordRowTarget {
  href: string;
  /** British English, the surface's own vocabulary. */
  label: "Open enquiry" | "Open contact";
}

/** The ledger links back into the faces — engagement entries (and entries
 * whose payload names an engagement) lead to the enquiry, contact entries to
 * the contact. Entries concerning neither lead nowhere and expand only. */
export function recordRowTarget(event: RecordRowEvent): RecordRowTarget | null {
  if (event.entityType === "engagement" && event.entityId) {
    return { href: `/enquiries/${event.entityId}`, label: "Open enquiry" };
  }
  if (event.entityType === "contact" && event.entityId) {
    return { href: `/contacts/${event.entityId}`, label: "Open contact" };
  }
  const engagementId = event.payload.engagement_id;
  if (typeof engagementId === "string" && engagementId.length > 0) {
    return { href: `/enquiries/${engagementId}`, label: "Open enquiry" };
  }
  return null;
}
