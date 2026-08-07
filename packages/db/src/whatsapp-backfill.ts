/**
 * D187 (founder-ruled 7 Aug 2026) — the one-off WhatsApp channel backfill's
 * PURE eligibility core, proven in the check-local harness without a
 * database. The ruled basis is D186's: contacts who arrived through the
 * Meta lead form (phone consent source meta_lead_form) gave explicit
 * consent at the form's privacy-policy gate — they gain a whatsapp channel
 * for the same value, same consent shape. Contacts whose phone consent has
 * ANY other source are not touched; archived contacts are never scanned
 * into eligibility.
 */

export interface BackfillChannel {
  channel: string;
  value: string | null;
  consent: Record<string, unknown> | null;
  archived_at?: string | null;
}

export type WhatsAppBackfillDecision =
  | { action: "create"; value: string; granted_at: string | null }
  | { action: "skip_archived" }
  | { action: "skip_existing" }
  | { action: "skip_out_of_basis" };

export function planWhatsAppBackfill(contact: {
  archived: boolean;
  channels: BackfillChannel[];
}): WhatsAppBackfillDecision {
  if (contact.archived) return { action: "skip_archived" };
  const live = contact.channels.filter((c) => !c.archived_at);
  // "No whatsapp channel" reads literally: ANY live whatsapp row — whatever
  // its consent — stands the backfill down (idempotency; a consent question
  // on an existing row is not this chore's to answer).
  if (live.some((c) => c.channel === "whatsapp")) return { action: "skip_existing" };
  const basisPhone = live.find(
    (c) =>
      c.channel === "phone" &&
      typeof c.value === "string" &&
      c.value !== "" &&
      c.consent?.source === "meta_lead_form" &&
      (c.consent?.transactional === true || c.consent?.marketing === true)
  );
  if (!basisPhone) return { action: "skip_out_of_basis" };
  const grantedAt = basisPhone.consent?.granted_at;
  return {
    action: "create",
    value: basisPhone.value!,
    granted_at: typeof grantedAt === "string" ? grantedAt : null,
  };
}

/** The consent shape the backfill writes — D186's ingest shape exactly,
 * granted_at carrying the ORIGINAL grant date from the basis phone row. */
export function backfillConsentShape(originalGrantedAt: string | null): Record<string, unknown> {
  return {
    marketing: true,
    transactional: true,
    ...(originalGrantedAt ? { granted_at: originalGrantedAt } : {}),
    source: "meta_lead_form",
  };
}
