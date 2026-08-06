import type { SupabaseClient } from "@supabase/supabase-js";
import { FEE_PROHIBITION_LINE, REGISTER_PUNCTUATION_LINE } from "./drafting";
import { resolveSignOffText } from "./sign-off";
import { isQuietHoursSet, sendWindowFromQuietHours, type QuietHours } from "./quiet-hours";
import { createMemoryEntry, MEMORY_FACT_KEYS, type MemorySurfaceDecl } from "./memory";

/**
 * Session 32 (D181) — the seed backfill: today's scattered behaviour
 * becomes memory entries, so day one shows real memory, not an empty
 * screen. Seeding is DATA THROUGH DOORS — every row goes through
 * createMemoryEntry (the same evented door the surface uses; law 11 is why
 * this is TS, not migration SQL), and the 0044 triggers judge each insert.
 *
 * Idempotent: an entry whose identity key (fact_key / instruction_key) has
 * EVER existed for the business is never re-seeded — a founder's later
 * edit or deactivation is their ruling, and the seed never argues with it.
 *
 * Values read from their pre-D181 homes (businesses.settings, the account
 * row); facts with no known value are SKIPPED and reported — a fact with
 * an invented value would be a lie on day one.
 */

export interface MemorySeedReport {
  created: Array<{ key: string; kind: string; title: string }>;
  skipped: Array<{ key: string; reason: string }>;
}

const GMB_SURFACE: MemorySurfaceDecl = {
  surface: "google_business_profile",
  label: "Google Business Profile",
  ref: null,
  in_platform: false,
};

/** Detect which in-platform surfaces carry the value verbatim TODAY — the
 * declared list starts honest instead of guessed. */
async function detectSurfaces(
  db: SupabaseClient,
  businessId: string,
  value: string
): Promise<MemorySurfaceDecl[]> {
  const surfaces: MemorySurfaceDecl[] = [];
  if (!value.trim()) return surfaces;

  const { data: entries } = await db
    .from("content_items")
    .select("id, title, body")
    .eq("business_id", businessId)
    .eq("content_type", "knowledge_entry")
    .eq("state", "published")
    .is("archived_at", null);
  for (const entry of entries ?? []) {
    const text = Array.isArray(entry.body)
      ? entry.body
          .map((b: unknown) =>
            b && typeof b === "object" && "text" in (b as object) ? String((b as { text: unknown }).text ?? "") : ""
          )
          .join("\n")
      : "";
    if (text.includes(value)) {
      surfaces.push({ surface: "knowledge_entry", label: entry.title, ref: entry.id, in_platform: true });
    }
  }

  const { data: templates } = await db
    .from("message_templates")
    .select("key, body, subject, version")
    .eq("business_id", businessId)
    .order("version", { ascending: false });
  const newestByKey = new Map<string, { key: string; body: string; subject: string | null }>();
  for (const t of templates ?? []) {
    if (!newestByKey.has(t.key)) newestByKey.set(t.key, { key: t.key, body: t.body, subject: t.subject });
  }
  for (const t of newestByKey.values()) {
    if (t.body.includes(value) || t.subject?.includes(value)) {
      surfaces.push({ surface: "message_template", label: `Template: ${t.key}`, ref: t.key, in_platform: true });
    }
  }

  return surfaces;
}

export async function seedMemoryEntries(
  db: SupabaseClient,
  input: {
    business_id: string;
    /** The owner's HUMAN actor — instructions require a human author (0044). */
    owner_actor_id: string;
  }
): Promise<MemorySeedReport> {
  const report: MemorySeedReport = { created: [], skipped: [] };

  const { data: existing, error: existingError } = await db
    .from("memory_entries")
    .select("attributes")
    .eq("business_id", input.business_id);
  if (existingError) throw new Error(`memory seed read failed: ${existingError.message}`);
  const seen = new Set(
    (existing ?? [])
      .map((r) => {
        const attrs = (r.attributes ?? {}) as Record<string, unknown>;
        return String(attrs.fact_key ?? attrs.instruction_key ?? "");
      })
      .filter(Boolean)
  );

  const { data: bizRows, error: bizError } = await db
    .from("businesses")
    .select("name, timezone, account_id, settings")
    .eq("id", input.business_id)
    .maybeSingle();
  if (bizError || !bizRows) throw new Error(`memory seed business read failed: ${bizError?.message ?? "no row"}`);
  const settings = (bizRows.settings ?? {}) as Record<string, unknown>;
  const businessName = (bizRows.name as string) ?? "";
  const timezone = (bizRows.timezone as string) || "Europe/London";

  const seedInstruction = async (key: string, title: string, body: string, law: string) => {
    if (seen.has(key)) {
      report.skipped.push({ key, reason: "already present — a founder's later edit is never argued with" });
      return;
    }
    const entry = await createMemoryEntry(db, {
      business_id: input.business_id,
      actor_id: input.owner_actor_id,
      kind: "instruction",
      title,
      body,
      why: `Seeded at Session 32 from the ${law} ruling — previously hardcoded in both generation prompts (D181: nothing about how Light behaves lives hardcoded)`,
      attributes: { instruction_key: key, law },
    });
    report.created.push({ key, kind: "instruction", title: entry.title });
  };

  const seedFact = async (
    key: string,
    title: string,
    value: string | null,
    why: string,
    extraSurfaces: MemorySurfaceDecl[] = []
  ) => {
    if (seen.has(key)) {
      report.skipped.push({ key, reason: "already present — a founder's later edit is never argued with" });
      return;
    }
    const trimmed = value?.trim() ?? "";
    if (!trimmed) {
      report.skipped.push({ key, reason: "no value in the pre-D181 home — add the fact in Light's Memory when known" });
      return;
    }
    const detected = await detectSurfaces(db, input.business_id, trimmed);
    const entry = await createMemoryEntry(db, {
      business_id: input.business_id,
      actor_id: input.owner_actor_id,
      kind: "fact",
      title,
      body: trimmed,
      why,
      surfaces: [...detected, ...extraSurfaces],
      attributes: { fact_key: key },
    });
    report.created.push({ key, kind: "fact", title: entry.title });
  };

  // The two law-mirror instructions (Q3 ruling): editable as prose; their
  // floor is the deterministic screen, and the surface says so (the law in
  // attributes drives the "enforced by pre-flight" note).
  await seedInstruction(
    "fees_rule",
    "Fees never appear in drafts",
    FEE_PROHIBITION_LINE.replace(/^-\s*/, ""),
    "D179a"
  );
  await seedInstruction(
    "register_rule",
    "No em or en dashes in drafts",
    REGISTER_PUNCTUATION_LINE.replace(/^-\s*/, ""),
    "D142"
  );

  // Signature: the configured sign-off text (firm display name default).
  await seedFact(
    MEMORY_FACT_KEYS.signature,
    "Signature",
    resolveSignOffText(settings, businessName),
    "Seeded at Session 32 from Settings (email sign-off) — Memory is now the home (D181, Q1)"
  );

  // Booking link.
  const bookingUrl = typeof settings.booking_url === "string" ? settings.booking_url : null;
  await seedFact(
    MEMORY_FACT_KEYS.bookingLink,
    "Booking link",
    bookingUrl,
    "Seeded at Session 32 from Settings (booking URL) — Memory is now the home (D181, Q1)"
  );

  // Phone: the only pre-D181 home is the signup record.
  let phone: string | null = null;
  if (bizRows.account_id) {
    const { data: account } = await db
      .from("accounts")
      .select("signup_phone")
      .eq("id", bizRows.account_id)
      .maybeSingle();
    phone = (account?.signup_phone as string | null) ?? null;
  }
  await seedFact(
    MEMORY_FACT_KEYS.phone,
    "Phone",
    phone,
    "Seeded at Session 32 from the signup record — Memory is now the home (D181, Q1)",
    [GMB_SURFACE]
  );

  // Opening hours: only when firm-set (the shipped default window is
  // dispatch policy, not a client-facing fact — never seeded as one).
  let hours: string | null = null;
  if (isQuietHoursSet(settings) && settings.quiet_hours) {
    const window = sendWindowFromQuietHours(settings.quiet_hours as QuietHours);
    hours = `${window.open} to ${window.close} (${timezone})`;
  }
  await seedFact(
    MEMORY_FACT_KEYS.openingHours,
    "Opening hours",
    hours,
    "Seeded at Session 32 from Settings (business hours) — Memory is now the home (D181, Q1)",
    [GMB_SURFACE]
  );

  return report;
}
