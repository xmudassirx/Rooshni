import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { emitEvent } from "./events";
import { DRAFTING_EVENT_KINDS, MEMORY_EVENT_KINDS } from "./event-kinds";
import { estimateTokens } from "./model-router";
import { isValidBookingUrl } from "./booking-link";
import { resolveSignOffText } from "./sign-off";

/**
 * Light's Memory (D181, Session 32 — founder-ruled 6 August 2026).
 *
 * Everything Light knows that is not a database fact is a MEMORY ENTRY —
 * readable, editable, evented; nothing about how Light behaves lives
 * hardcoded. Two parts:
 *   FACTS — business facts (opening hours, phone, booking link, signature)
 *     each carrying a declared SURFACES LIST naming where the fact appears
 *     in the world. Editing a fact fires the RIPPLE SWEEP below.
 *   BEHAVIOUR — standing instructions (ride every composition, bounded by
 *     the 800-token ceiling) and learned observations (today: rejection
 *     reasons), promotable to instructions by a human hand only.
 *
 * The database is the law beneath this file (0044): append-only supersede
 * chains, the human-author gate on instructions, the token ceiling — all
 * triggers. This file is the app-side door that performs the acts and puts
 * them on The Record via emitEvent() (law 11).
 */

export type MemoryKind = "fact" | "instruction" | "observation";

/** One entry in a fact's declared surfaces list. `in_platform` is the
 * discriminator the ripple sweep acts on: true → Light drafts the
 * correction (message_template | knowledge_entry; website is declared but
 * deferred — nothing renders yet); false → a manual task is owed. */
export interface MemorySurfaceDecl {
  /** In-platform: 'message_template' | 'knowledge_entry' | 'website'.
   * External: a free name ('google_business_profile', a directory…). */
  surface: string;
  /** Human-readable name shown on chips, tasks and events. */
  label: string;
  /** In-platform reference: the message template KEY, or the knowledge
   * entry's content_item id. Null for external surfaces. */
  ref?: string | null;
  in_platform: boolean;
}

export interface MemoryEntryRow {
  id: string;
  business_id: string;
  kind: MemoryKind;
  title: string;
  body: string;
  active: boolean;
  superseded_by_entry_id: string | null;
  why: string | null;
  surfaces: MemorySurfaceDecl[];
  attributes: Record<string, unknown>;
  created_by: string;
  created_at: string;
}

/** D181: active standing instructions never exceed 800 tokens — the surface
 * shows the count and the door refuses past the cap, naming the count. The
 * 0044 trigger is the enforcement; this constant and estimateTokens (the
 * same ceil(chars/4)) are its TS mirror — the two doors must never
 * disagree. */
export const MEMORY_INSTRUCTION_TOKEN_CEILING = 800;

/** The seeded fact identities (attributes.fact_key) — one active fact per
 * key per business, enforced by the 0044 unique index. */
export const MEMORY_FACT_KEYS = {
  signature: "signature",
  bookingLink: "booking_link",
  phone: "phone",
  openingHours: "opening_hours",
} as const;

export const GOOGLE_BUSINESS_PROFILE_SURFACE: MemorySurfaceDecl = {
  surface: "google_business_profile",
  label: "Google Business Profile",
  ref: null,
  in_platform: false,
};

/**
 * Fact-surfaces micro-fix (6 Aug 2026, founder-witnessed defect A): the
 * per-key DEFAULT surfaces — ONE shared declaration for every creation
 * door (the seed, the Settings faces, the Memory surface's add), never two
 * lists. Opening hours and phone appear on Google Business Profile in the
 * world, so a fact born through any door declares it; a fact created with
 * an empty list would make the ripple sweep honestly sweep nothing.
 */
export function defaultSurfacesForFactKey(factKey: string): MemorySurfaceDecl[] {
  if (factKey === MEMORY_FACT_KEYS.openingHours || factKey === MEMORY_FACT_KEYS.phone) {
    return [GOOGLE_BUSINESS_PROFILE_SURFACE];
  }
  return [];
}

/** Total estimated tokens across instruction bodies (the ceiling's unit). */
export function memoryInstructionTokens(bodies: string[]): number {
  return bodies.reduce((sum, b) => sum + estimateTokens(b), 0);
}

const ENTRY_COLUMNS =
  "id, business_id, kind, title, body, active, superseded_by_entry_id, why, surfaces, attributes, created_by, created_at";

function toRow(raw: Record<string, unknown>): MemoryEntryRow {
  return {
    ...(raw as unknown as MemoryEntryRow),
    surfaces: Array.isArray(raw.surfaces) ? (raw.surfaces as MemorySurfaceDecl[]) : [],
    attributes: (raw.attributes ?? {}) as Record<string, unknown>,
  };
}

/** Every entry of the business, newest first — the Memory surface's read
 * (history included; the supersede chain renders from these rows). */
export async function listMemoryEntries(db: SupabaseClient, businessId: string): Promise<MemoryEntryRow[]> {
  const { data, error } = await db
    .from("memory_entries")
    .select(ENTRY_COLUMNS)
    .eq("business_id", businessId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`memory read failed: ${error.message}`);
  return (data ?? []).map((r) => toRow(r as Record<string, unknown>));
}

/**
 * What rides a composition (D181): every ACTIVE instruction and every
 * ACTIVE fact. The credit line records these ids so The Record answers
 * "why did Light say that" by name.
 */
export interface MemoryContext {
  instructions: Array<{ id: string; body: string }>;
  facts: Array<{ id: string; key: string | null; title: string; body: string }>;
}

export async function loadMemoryContext(db: SupabaseClient, businessId: string): Promise<MemoryContext> {
  const { data, error } = await db
    .from("memory_entries")
    .select("id, kind, title, body, attributes, created_at")
    .eq("business_id", businessId)
    .eq("active", true)
    .in("kind", ["fact", "instruction"])
    .order("created_at", { ascending: true });
  if (error) throw new Error(`memory context read failed: ${error.message}`);
  const rows = data ?? [];
  return {
    instructions: rows
      .filter((r) => r.kind === "instruction")
      .map((r) => ({ id: r.id as string, body: r.body as string })),
    facts: rows
      .filter((r) => r.kind === "fact")
      .map((r) => ({
        id: r.id as string,
        key: typeof (r.attributes as Record<string, unknown>)?.fact_key === "string"
          ? String((r.attributes as Record<string, unknown>).fact_key)
          : null,
        title: r.title as string,
        body: r.body as string,
      })),
  };
}

/** The active fact's value by key, or null — pure, harness-testable. */
export function memoryFactValue(memory: MemoryContext | null | undefined, key: string): string | null {
  const fact = memory?.facts.find((f) => f.key === key);
  const value = fact?.body.trim();
  return value ? value : null;
}

/**
 * Q1 ruling (Session 32 pre-flight, option A): Memory is the single home
 * for client-facing facts; businesses.settings remains only as the
 * TRANSITIONAL fallback for a business whose seed backfill has not landed.
 * Once every listed fact has a row the fallback is dead code in practice —
 * flagged at close for a future session to retire.
 */
export function resolveSignOffWithMemory(
  memory: MemoryContext | null | undefined,
  settings: Record<string, unknown> | null | undefined,
  businessName: string
): string {
  return memoryFactValue(memory, MEMORY_FACT_KEYS.signature) ?? resolveSignOffText(settings, businessName);
}

export function resolveBookingUrlWithMemory(
  memory: MemoryContext | null | undefined,
  settings: Record<string, unknown> | null | undefined
): string | null {
  const fromMemory = memoryFactValue(memory, MEMORY_FACT_KEYS.bookingLink);
  if (fromMemory && isValidBookingUrl(fromMemory)) return fromMemory;
  const raw = settings?.booking_url;
  if (typeof raw === "string" && isValidBookingUrl(raw.trim())) return raw.trim();
  return null;
}

// ---------------------------------------------------------------------------
// The doors. Each performs one act and events it. The 0044 triggers are the
// enforcement beneath; a trigger refusal surfaces as the thrown error, count
// and all.
// ---------------------------------------------------------------------------

export interface CreateMemoryEntryInput {
  business_id: string;
  /** The author — for an instruction the database requires a HUMAN actor. */
  actor_id: string;
  kind: MemoryKind;
  title: string;
  body: string;
  why?: string | null;
  surfaces?: MemorySurfaceDecl[];
  attributes?: Record<string, unknown>;
}

export async function createMemoryEntry(
  db: SupabaseClient,
  input: CreateMemoryEntryInput
): Promise<MemoryEntryRow> {
  const { data, error } = await db
    .from("memory_entries")
    .insert({
      business_id: input.business_id,
      created_by: input.actor_id,
      kind: input.kind,
      title: input.title,
      body: input.body,
      why: input.why ?? null,
      surfaces: input.surfaces ?? [],
      attributes: input.attributes ?? {},
    })
    .select(ENTRY_COLUMNS)
    .single();
  if (error) throw new Error(`memory entry create failed: ${error.message}`);
  const row = toRow(data as Record<string, unknown>);
  await emitEvent(db, {
    business_id: input.business_id,
    actor_id: input.actor_id,
    action: MEMORY_EVENT_KINDS.entryCreated,
    entity_type: "memory_entry",
    entity_id: row.id,
    payload: {
      kind: row.kind,
      title: row.title,
      ...(typeof row.attributes.fact_key === "string" ? { fact_key: row.attributes.fact_key } : {}),
      ...(input.why ? { why: input.why } : {}),
    },
  });
  return row;
}

export interface SupersedeMemoryEntryInput {
  business_id: string;
  actor_id: string;
  predecessor_id: string;
  /** The successor's content; title defaults to the predecessor's. */
  title?: string;
  body: string;
  why?: string | null;
  /** Facts: a new surfaces list, else the predecessor's carries forward. */
  surfaces?: MemorySurfaceDecl[];
}

/**
 * The edit: append-only supersede. The predecessor deactivates, the
 * successor is born, the chain links them, ONE event records the act.
 * JUDGMENT (Session 32): the order is flip-first — the active-fact unique
 * index and the instruction ceiling both count the predecessor while it
 * stands, so successor-first would refuse every lawful edit; the TS
 * ceiling pre-check below keeps the rare failure-after-flip path honest
 * (the predecessor stays deactivated, its wording visible in history, the
 * error says exactly that). Restoration is a fresh entry — reactivation
 * does not exist (append-only purity). Listed at close.
 */
export async function supersedeMemoryEntry(
  db: SupabaseClient,
  input: SupersedeMemoryEntryInput
): Promise<{ predecessor: MemoryEntryRow; successor: MemoryEntryRow }> {
  const { data: predRaw, error: lookupError } = await db
    .from("memory_entries")
    .select(ENTRY_COLUMNS)
    .eq("id", input.predecessor_id)
    .eq("business_id", input.business_id)
    .maybeSingle();
  if (lookupError) throw new Error(`memory entry lookup failed: ${lookupError.message}`);
  if (!predRaw) throw new Error("That memory entry no longer exists.");
  const predecessor = toRow(predRaw as Record<string, unknown>);
  if (!predecessor.active) throw new Error("Only an active entry can be edited — this one is already superseded.");

  if (predecessor.kind === "instruction") {
    // TS mirror of the 0044 ceiling — refuse BEFORE deactivating the
    // predecessor, naming the count exactly as the trigger would.
    const { data: siblings } = await db
      .from("memory_entries")
      .select("id, body")
      .eq("business_id", input.business_id)
      .eq("kind", "instruction")
      .eq("active", true)
      .neq("id", predecessor.id);
    const total = memoryInstructionTokens([...(siblings ?? []).map((s) => s.body as string), input.body]);
    if (total > MEMORY_INSTRUCTION_TOKEN_CEILING) {
      throw new Error(
        `active standing instructions would total ${total} tokens — the ceiling is ${MEMORY_INSTRUCTION_TOKEN_CEILING} (D181); shorten or deactivate an instruction first`
      );
    }
  }

  const { error: flipError } = await db
    .from("memory_entries")
    .update({ active: false })
    .eq("id", predecessor.id)
    .eq("business_id", input.business_id);
  if (flipError) throw new Error(`memory entry supersede failed: ${flipError.message}`);

  const { data: succRaw, error: insertError } = await db
    .from("memory_entries")
    .insert({
      business_id: input.business_id,
      created_by: input.actor_id,
      kind: predecessor.kind,
      title: input.title?.trim() || predecessor.title,
      body: input.body,
      why: input.why ?? null,
      surfaces: input.surfaces ?? predecessor.surfaces,
      attributes: predecessor.attributes,
    })
    .select(ENTRY_COLUMNS)
    .single();
  if (insertError) {
    throw new Error(
      `the edit failed after the old entry was retired: ${insertError.message} — its wording stands in history; add the entry again to restore it`
    );
  }
  const successor = toRow(succRaw as Record<string, unknown>);

  const { error: chainError } = await db
    .from("memory_entries")
    .update({ superseded_by_entry_id: successor.id })
    .eq("id", predecessor.id)
    .eq("business_id", input.business_id);
  if (chainError) throw new Error(`memory chain link failed: ${chainError.message}`);

  await emitEvent(db, {
    business_id: input.business_id,
    actor_id: input.actor_id,
    action: MEMORY_EVENT_KINDS.entrySuperseded,
    entity_type: "memory_entry",
    entity_id: successor.id,
    payload: {
      kind: successor.kind,
      title: successor.title,
      predecessor_id: predecessor.id,
      body_before: predecessor.body,
      body_after: successor.body,
      ...(typeof successor.attributes.fact_key === "string"
        ? { fact_key: successor.attributes.fact_key }
        : {}),
      ...(input.why ? { why: input.why } : {}),
    },
  });

  return { predecessor: { ...predecessor, active: false, superseded_by_entry_id: successor.id }, successor };
}

export async function deactivateMemoryEntry(
  db: SupabaseClient,
  input: { business_id: string; actor_id: string; entry_id: string; reason?: string | null }
): Promise<void> {
  const { data: entry, error: lookupError } = await db
    .from("memory_entries")
    .select("id, kind, title, active")
    .eq("id", input.entry_id)
    .eq("business_id", input.business_id)
    .maybeSingle();
  if (lookupError) throw new Error(`memory entry lookup failed: ${lookupError.message}`);
  if (!entry) throw new Error("That memory entry no longer exists.");
  if (!entry.active) throw new Error("That entry is already inactive.");

  const { error } = await db
    .from("memory_entries")
    .update({ active: false })
    .eq("id", input.entry_id)
    .eq("business_id", input.business_id);
  if (error) throw new Error(`memory entry deactivate failed: ${error.message}`);

  await emitEvent(db, {
    business_id: input.business_id,
    actor_id: input.actor_id,
    action: MEMORY_EVENT_KINDS.entryDeactivated,
    entity_type: "memory_entry",
    entity_id: input.entry_id,
    payload: {
      kind: entry.kind,
      title: entry.title,
      ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    },
  });
}

/**
 * The ONE door every fact write goes through — the Memory surface and the
 * Settings faces alike (Q1 ruling: Settings fields are faces over the
 * fact). Creates the fact when absent; supersedes and fires the ripple
 * sweep when the value changed; no-ops when nothing changed.
 */
export async function setMemoryFact(
  db: SupabaseClient,
  input: {
    business_id: string;
    actor_id: string;
    /** Light — the sweep's corrections and tasks are Light's drafted acts. */
    light_actor_id: string;
    fact_key: string;
    title: string;
    value: string;
    why?: string | null;
    /** A new surfaces list; existing facts keep theirs when omitted. */
    surfaces?: MemorySurfaceDecl[];
  }
): Promise<{ entry: MemoryEntryRow; sweep: FactSweepResult | null; changed: boolean }> {
  const value = input.value.trim();
  if (!value) throw new Error(`A fact needs a value — to retire "${input.title}", deactivate it instead.`);

  const { data: existingRaw, error } = await db
    .from("memory_entries")
    .select(ENTRY_COLUMNS)
    .eq("business_id", input.business_id)
    .eq("kind", "fact")
    .eq("active", true)
    .eq("attributes->>fact_key", input.fact_key)
    .maybeSingle();
  if (error) throw new Error(`fact lookup failed: ${error.message}`);

  if (!existingRaw) {
    const entry = await createMemoryEntry(db, {
      business_id: input.business_id,
      actor_id: input.actor_id,
      kind: "fact",
      title: input.title,
      body: value,
      why: input.why ?? null,
      // Fact-surfaces micro-fix: a fact born through ANY door carries the
      // shared per-key defaults when the caller declares nothing.
      surfaces: input.surfaces?.length ? input.surfaces : defaultSurfacesForFactKey(input.fact_key),
      attributes: { fact_key: input.fact_key },
    });
    return { entry, sweep: null, changed: true };
  }

  const existing = toRow(existingRaw as Record<string, unknown>);
  if (existing.body.trim() === value && !input.surfaces) {
    return { entry: existing, sweep: null, changed: false };
  }

  // Fact-surfaces micro-fix: a supersede over an EMPTY declared list heals
  // it with the shared per-key defaults (the witnessed defect: a
  // face-created hours fact with no surfaces swept honestly to 0/0, and a
  // plain carry-forward would repeat that forever). A caller-passed list
  // and a non-empty predecessor list are never overridden.
  const healedDefaults = existing.surfaces.length ? [] : defaultSurfacesForFactKey(input.fact_key);
  const { successor } = await supersedeMemoryEntry(db, {
    business_id: input.business_id,
    actor_id: input.actor_id,
    predecessor_id: existing.id,
    title: input.title,
    body: value,
    why: input.why ?? null,
    surfaces: input.surfaces ?? (healedDefaults.length ? healedDefaults : undefined),
  });

  const sweep =
    existing.body.trim() !== value
      ? await sweepFactEdit(db, {
          business_id: input.business_id,
          editor_actor_id: input.actor_id,
          light_actor_id: input.light_actor_id,
          fact: successor,
          old_value: existing.body,
          new_value: value,
        })
      : null;

  return { entry: successor, sweep, changed: true };
}

/**
 * A rejection reason becomes a Memory observation (D181): Light's
 * bookkeeping of what a human hand refused, with the refusal's provenance.
 * Machine-writable (only INSTRUCTIONS are human-gated); promotion is the
 * human act.
 * JUDGMENT (Session 32): the observation's author is the REJECTING HUMAN —
 * the reason is theirs, verbatim; the draft_feedback row and communication
 * id ride attributes as the structured provenance. Listed at close.
 */
export async function recordRejectionObservation(
  db: SupabaseClient,
  input: {
    business_id: string;
    /** The rejecting human — the reason is theirs, verbatim. */
    actor_id: string;
    communication_id: string;
    draft_feedback_id?: string | null;
    reason: string;
  }
): Promise<MemoryEntryRow> {
  const reason = input.reason.trim();
  return createMemoryEntry(db, {
    business_id: input.business_id,
    actor_id: input.actor_id,
    kind: "observation",
    title: `Rejection: ${reason.length > 70 ? `${reason.slice(0, 70)}…` : reason}`,
    body: reason,
    why: `Rejection reason recorded when a draft was refused the stamp`,
    attributes: {
      source: "draft_rejection",
      communication_id: input.communication_id,
      ...(input.draft_feedback_id ? { draft_feedback_id: input.draft_feedback_id } : {}),
    },
  });
}

/**
 * PROMOTION (D181): one click, a human act, evented under their name —
 * the 0044 human-author trigger is the law beneath; the ceiling binds the
 * new instruction.
 * JUDGMENT (Session 32): the observation is SUPERSEDED BY the instruction
 * it became — one chain records the graduation, so history renders it
 * without a second bookkeeping shape. Listed at close.
 */
export async function promoteObservation(
  db: SupabaseClient,
  input: {
    business_id: string;
    actor_id: string;
    observation_id: string;
    /** Optional rewording; defaults to the observation's body verbatim. */
    instruction_body?: string | null;
  }
): Promise<MemoryEntryRow> {
  const { data: obsRaw, error: lookupError } = await db
    .from("memory_entries")
    .select(ENTRY_COLUMNS)
    .eq("id", input.observation_id)
    .eq("business_id", input.business_id)
    .eq("kind", "observation")
    .maybeSingle();
  if (lookupError) throw new Error(`observation lookup failed: ${lookupError.message}`);
  if (!obsRaw) throw new Error("That observation no longer exists.");
  const observation = toRow(obsRaw as Record<string, unknown>);
  if (!observation.active) throw new Error("That observation was already promoted or retired.");

  const body = input.instruction_body?.trim() || observation.body;

  // TS mirror of the ceiling, for the named-count refusal before any write.
  const { data: siblings } = await db
    .from("memory_entries")
    .select("id, body")
    .eq("business_id", input.business_id)
    .eq("kind", "instruction")
    .eq("active", true);
  const total = memoryInstructionTokens([...(siblings ?? []).map((s) => s.body as string), body]);
  if (total > MEMORY_INSTRUCTION_TOKEN_CEILING) {
    throw new Error(
      `active standing instructions would total ${total} tokens — the ceiling is ${MEMORY_INSTRUCTION_TOKEN_CEILING} (D181); shorten or deactivate an instruction first`
    );
  }

  const { data: instrRaw, error: insertError } = await db
    .from("memory_entries")
    .insert({
      business_id: input.business_id,
      created_by: input.actor_id,
      kind: "instruction",
      title: observation.title.replace(/^Rejection: /, "From rejection: "),
      body,
      why: "Promoted from an observation by a human hand (D181)",
      attributes: { source: "promotion", promoted_from: observation.id },
    })
    .select(ENTRY_COLUMNS)
    .single();
  if (insertError) throw new Error(`promotion failed: ${insertError.message}`);
  const instruction = toRow(instrRaw as Record<string, unknown>);

  // The graduation chain: observation → superseded by the instruction.
  const { error: flipError } = await db
    .from("memory_entries")
    .update({ active: false, superseded_by_entry_id: instruction.id })
    .eq("id", observation.id)
    .eq("business_id", input.business_id);
  if (flipError) throw new Error(`promotion chain link failed: ${flipError.message}`);

  await emitEvent(db, {
    business_id: input.business_id,
    actor_id: input.actor_id,
    action: MEMORY_EVENT_KINDS.observationPromoted,
    entity_type: "memory_entry",
    entity_id: instruction.id,
    payload: {
      observation_id: observation.id,
      title: instruction.title,
      body: instruction.body,
    },
  });

  return instruction;
}

// ---------------------------------------------------------------------------
// The ripple sweep (D181a). A fact edit fires ONE evented act:
//   - every in-platform surface carrying the stale value gets a CORRECTION
//     drafted by Light into the Approval Inbox (a content_items row at
//     pending_approval — the existing content arm, the existing
//     human-publish gate; approval applies it, D102 lane for templates);
//   - a declared surface where the old value is NOT found verbatim raises a
//     review task (fail loud, never skip silently — founder-ruled Q2);
//   - every external surface raises a task naming the manual change owed;
//   - declared website surfaces are DEFERRED (out of scope — nothing
//     renders) and named on the event.
// Corrections are DETERMINISTIC substitutions (old value → new value),
// never a generative rewrite.
// ---------------------------------------------------------------------------

export interface FactSweepResult {
  corrections: Array<{ content_item_id: string; surface: string; label: string; ref: string | null }>;
  tasks: Array<{ task_id: string; surface: string; label: string; reason: "external" | "value_not_found" }>;
  deferred: string[];
}

function correctionSlug(base: string): string {
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${slug}-${randomUUID().slice(0, 8)}`;
}

function paragraphBlocks(text: string): Array<{ type: "paragraph"; text: string }> {
  return text
    .split(/\r?\n\r?\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) => ({ type: "paragraph" as const, text: p }));
}

function blocksText(body: unknown): string {
  if (!Array.isArray(body)) return typeof body === "string" ? body : "";
  return body
    .map((block) =>
      block && typeof block === "object" && "text" in block ? String((block as { text: unknown }).text ?? "") : ""
    )
    .filter((t) => t.trim() !== "")
    .join("\n");
}

/** What a declared surface actually carries today — loaded by sweepFactEdit,
 * consumed by the PURE planner below (the harness proves the planner). */
export interface SweepCarrier {
  decl: MemorySurfaceDecl;
  template?: {
    id: string;
    key: string;
    channel: string;
    subject: string | null;
    body: string;
    version: number;
  } | null;
  entry?: { id: string; title: string; version: number; body: unknown } | null;
}

export interface PlannedCorrection {
  decl: MemorySurfaceDecl;
  content_type: "template_correction" | "knowledge_entry_correction";
  title: string;
  body_after_text: string;
  correction: Record<string, unknown>;
}

export interface PlannedTask {
  decl: MemorySurfaceDecl;
  reason: "external" | "value_not_found";
  title: string;
  description: string;
}

export interface FactSweepPlan {
  corrections: PlannedCorrection[];
  tasks: PlannedTask[];
  deferred: string[];
}

/**
 * The sweep's PURE core — deterministic substitution planning per surface,
 * harness-proven: in-platform carriers of the stale value plan corrections;
 * external surfaces plan tasks; a declared surface where the old value is
 * not found verbatim plans a review task (fail loud, never skip silently —
 * founder-ruled Q2); website surfaces defer visibly.
 */
export function planFactSweep(input: {
  fact_title: string;
  old_value: string;
  new_value: string;
  carriers: SweepCarrier[];
}): FactSweepPlan {
  const plan: FactSweepPlan = { corrections: [], tasks: [], deferred: [] };
  const oldValue = input.old_value.trim();
  const newValue = input.new_value.trim();
  if (!oldValue || oldValue === newValue) return plan;

  const reviewTask = (decl: MemorySurfaceDecl, detail: string) => {
    plan.tasks.push({
      decl,
      reason: "value_not_found",
      title: `Review ${decl.label}: ${input.fact_title} changed`,
      description: `${input.fact_title} changed from "${oldValue}" to "${newValue}", and this fact declares ${decl.label} as a surface — but ${detail}, so no correction could be drafted. Review the surface by hand.`,
    });
  };

  for (const carrier of input.carriers) {
    const decl = carrier.decl;
    if (!decl.in_platform) {
      plan.tasks.push({
        decl,
        reason: "external",
        title: `Update ${decl.label}: ${input.fact_title}`,
        description: `${input.fact_title} changed from "${oldValue}" to "${newValue}". ${decl.label} is not connected to the platform, so the change there is owed by hand.`,
      });
      continue;
    }
    if (decl.surface === "website") {
      // Declared for later — the model is unchanged when it connects; today
      // nothing renders, so the sweep defers it visibly on the event.
      plan.deferred.push(decl.label);
      continue;
    }
    if (decl.surface === "message_template") {
      const template = carrier.template;
      const bodyBefore = template?.body ?? "";
      const subjectBefore = template?.subject ?? null;
      const inBody = bodyBefore.includes(oldValue);
      const inSubject = Boolean(subjectBefore?.includes(oldValue));
      if (!template || (!inBody && !inSubject)) {
        reviewTask(
          decl,
          template ? "the old value was not found verbatim in the template" : "no template exists for this key"
        );
        continue;
      }
      const bodyAfter = inBody ? bodyBefore.split(oldValue).join(newValue) : bodyBefore;
      const subjectAfter = inSubject && subjectBefore ? subjectBefore.split(oldValue).join(newValue) : subjectBefore;
      plan.corrections.push({
        decl,
        content_type: "template_correction",
        title: `Correction: ${decl.label} — ${input.fact_title}`,
        body_after_text: bodyAfter,
        correction: {
          template_id: template.id,
          template_key: template.key,
          channel: template.channel,
          template_version: template.version,
          body_before: bodyBefore,
          body_after: bodyAfter,
          ...(subjectBefore !== null ? { subject_before: subjectBefore, subject_after: subjectAfter } : {}),
        },
      });
      continue;
    }
    if (decl.surface === "knowledge_entry") {
      const entry = carrier.entry;
      const textBefore = entry ? blocksText(entry.body) : "";
      if (!entry || !textBefore.includes(oldValue)) {
        reviewTask(
          decl,
          entry ? "the old value was not found verbatim in the entry" : "the entry no longer exists"
        );
        continue;
      }
      const textAfter = textBefore.split(oldValue).join(newValue);
      // The substitution runs INSIDE the block structure — approval applies
      // blocks_after verbatim, so the entry's paragraph shape survives the
      // correction untouched.
      const blocksAfter = Array.isArray(entry.body)
        ? (entry.body as Array<Record<string, unknown>>).map((block) =>
            block && typeof block === "object" && typeof block.text === "string"
              ? { ...block, text: block.text.split(oldValue).join(newValue) }
              : block
          )
        : entry.body;
      plan.corrections.push({
        decl,
        content_type: "knowledge_entry_correction",
        title: `Correction: ${entry.title} — ${input.fact_title}`,
        body_after_text: textAfter,
        correction: {
          target_content_item_id: entry.id,
          target_title: entry.title,
          target_version: entry.version,
          body_before: textBefore,
          body_after: textAfter,
          blocks_after: blocksAfter,
        },
      });
      continue;
    }
    // An in-platform surface the sweep has no reach into — fail loud, never
    // skip silently.
    reviewTask(decl, `the sweep has no reach into the "${decl.surface}" surface kind`);
  }

  return plan;
}

export interface SweepFactEditInput {
  business_id: string;
  /** JUDGMENT (Session 32): sweep tasks are ASSIGNED to the human who
   * edited the fact (they know the change owed) while created_by is Light
   * on tasks and corrections alike — "Light drafts the correction" is the
   * ruling's own grammar, and the inbox card wears the gold drafted-by
   * chip accordingly. Listed at close. */
  editor_actor_id: string;
  light_actor_id: string;
  /** The successor fact entry (the new truth, surfaces list included). */
  fact: MemoryEntryRow;
  old_value: string;
  new_value: string;
}

export async function sweepFactEdit(db: SupabaseClient, input: SweepFactEditInput): Promise<FactSweepResult> {
  const result: FactSweepResult = { corrections: [], tasks: [], deferred: [] };
  const oldValue = input.old_value.trim();
  const newValue = input.new_value.trim();
  if (!oldValue || oldValue === newValue) return result;

  // Load what each declared surface carries today, then let the PURE
  // planner decide — the write below performs exactly the plan.
  const carriers: SweepCarrier[] = [];
  for (const decl of input.fact.surfaces) {
    if (decl.in_platform && decl.surface === "message_template") {
      const { data: templates, error } = await db
        .from("message_templates")
        .select("id, key, channel, subject, body, version")
        .eq("business_id", input.business_id)
        .eq("key", decl.ref ?? "")
        .order("version", { ascending: false })
        .limit(1);
      if (error) throw new Error(`sweep template read failed: ${error.message}`);
      carriers.push({ decl, template: (templates?.[0] as SweepCarrier["template"]) ?? null });
    } else if (decl.in_platform && decl.surface === "knowledge_entry") {
      const { data: entry, error } = await db
        .from("content_items")
        .select("id, title, body, version")
        .eq("id", decl.ref ?? "00000000-0000-0000-0000-000000000000")
        .eq("business_id", input.business_id)
        .eq("content_type", "knowledge_entry")
        .is("archived_at", null)
        .maybeSingle();
      if (error) throw new Error(`sweep knowledge read failed: ${error.message}`);
      carriers.push({ decl, entry: (entry as SweepCarrier["entry"]) ?? null });
    } else {
      carriers.push({ decl });
    }
  }

  const plan = planFactSweep({
    fact_title: input.fact.title,
    old_value: oldValue,
    new_value: newValue,
    carriers,
  });
  result.deferred = plan.deferred;

  const raiseTask = async (
    surface: MemorySurfaceDecl,
    reason: "external" | "value_not_found",
    title: string,
    description: string
  ) => {
    const { data: task, error } = await db
      .from("tasks")
      .insert({
        business_id: input.business_id,
        created_by: input.light_actor_id,
        title,
        description,
        status: "open",
        assignee_actor_id: input.editor_actor_id,
        attributes: {
          memory_sweep: {
            fact_entry_id: input.fact.id,
            fact_key: input.fact.attributes.fact_key ?? null,
            surface: surface.surface,
            label: surface.label,
            ref: surface.ref ?? null,
            reason,
          },
        },
      })
      .select("id")
      .single();
    if (error) throw new Error(`sweep task failed: ${error.message}`);
    result.tasks.push({ task_id: task.id, surface: surface.surface, label: surface.label, reason });
  };

  const proposeCorrection = async (
    surface: MemorySurfaceDecl,
    contentType: "template_correction" | "knowledge_entry_correction",
    title: string,
    bodyAfterText: string,
    correction: Record<string, unknown>
  ) => {
    const { data: item, error } = await db
      .from("content_items")
      .insert({
        business_id: input.business_id,
        created_by: input.light_actor_id,
        content_type: contentType,
        title,
        slug: correctionSlug(title),
        body: paragraphBlocks(bodyAfterText),
        visibility: "team",
        state: "pending_approval",
        attributes: {
          correction: {
            ...correction,
            surface: surface.surface,
            label: surface.label,
            fact_entry_id: input.fact.id,
            fact_key: input.fact.attributes.fact_key ?? null,
            fact_title: input.fact.title,
            old_value: oldValue,
            new_value: newValue,
          },
        },
      })
      .select("id")
      .single();
    if (error) throw new Error(`sweep correction failed: ${error.message}`);
    result.corrections.push({
      content_item_id: item.id,
      surface: surface.surface,
      label: surface.label,
      ref: surface.ref ?? null,
    });
  };

  for (const task of plan.tasks) {
    await raiseTask(task.decl, task.reason, task.title, task.description);
  }
  for (const correction of plan.corrections) {
    await proposeCorrection(
      correction.decl,
      correction.content_type,
      correction.title,
      correction.body_after_text,
      correction.correction
    );
  }

  await emitSweepEvent(db, input, result, oldValue, newValue);

  return result;
}

async function emitSweepEvent(
  db: SupabaseClient,
  input: SweepFactEditInput,
  result: FactSweepResult,
  oldValue: string,
  newValue: string
): Promise<void> {
  await emitEvent(db, {
    business_id: input.business_id,
    actor_id: input.light_actor_id,
    action: MEMORY_EVENT_KINDS.factRippleSwept,
    entity_type: "memory_entry",
    entity_id: input.fact.id,
    payload: {
      fact_key: input.fact.attributes.fact_key ?? null,
      fact_title: input.fact.title,
      old_value: oldValue,
      new_value: newValue,
      corrections_proposed: result.corrections.length,
      manual_tasks_raised: result.tasks.length,
      correction_ids: result.corrections.map((c) => c.content_item_id),
      task_ids: result.tasks.map((t) => t.task_id),
      ...(result.deferred.length ? { deferred_surfaces: result.deferred } : {}),
      summary: `${input.fact.title} changed: ${result.corrections.length} correction${result.corrections.length === 1 ? "" : "s"} proposed, ${result.tasks.length} manual task${result.tasks.length === 1 ? "" : "s"} raised`,
    },
  });
}

// ---------------------------------------------------------------------------
// The stamp on a sweep correction. Approval APPLIES the change — a template
// re-issue (D102 lane: a NEW message_templates version; the 0023 guard keeps
// superseded versions read-only history) or a knowledge-entry update (the
// existing version+event door). The correction item itself is published by
// the approver (the 0009 human-publish gate is the stamp) — nothing ever
// applies without it. Rejection records its reason and touches nothing.
// ---------------------------------------------------------------------------

interface CorrectionAttrs {
  surface: string;
  label?: string;
  fact_title?: string;
  old_value?: string;
  new_value?: string;
  template_id?: string;
  template_key?: string;
  channel?: string;
  template_version?: number;
  body_after?: string;
  subject_after?: string | null;
  target_content_item_id?: string;
  target_version?: number;
  blocks_after?: unknown[];
}

const CORRECTION_TYPES = ["template_correction", "knowledge_entry_correction"] as const;

async function loadPendingCorrection(
  db: SupabaseClient,
  businessId: string,
  correctionId: string
): Promise<{ id: string; content_type: string; title: string; correction: CorrectionAttrs; attributes: Record<string, unknown> }> {
  const { data, error } = await db
    .from("content_items")
    .select("id, content_type, title, state, attributes")
    .eq("id", correctionId)
    .eq("business_id", businessId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error(`correction lookup failed: ${error.message}`);
  if (!data || !CORRECTION_TYPES.includes(data.content_type as (typeof CORRECTION_TYPES)[number])) {
    throw new Error("That correction no longer exists.");
  }
  if (data.state !== "pending_approval") {
    throw new Error(`Only a stamp-awaiting correction can be decided — this one is "${data.state}".`);
  }
  const correction = ((data.attributes ?? {}) as Record<string, unknown>).correction as CorrectionAttrs | undefined;
  if (!correction) throw new Error("The correction row carries no correction payload — nothing can be applied.");
  return {
    id: data.id,
    content_type: data.content_type,
    title: data.title,
    correction,
    attributes: (data.attributes ?? {}) as Record<string, unknown>,
  };
}

export async function applyCorrection(
  db: SupabaseClient,
  input: { business_id: string; approver_actor_id: string; correction_id: string }
): Promise<{ surface: string; applied_version: number }> {
  const item = await loadPendingCorrection(db, input.business_id, input.correction_id);
  const c = item.correction;
  let appliedVersion: number;

  if (item.content_type === "template_correction") {
    if (!c.template_key || !c.channel || typeof c.body_after !== "string") {
      throw new Error("The template correction payload is incomplete — nothing can be applied.");
    }
    // JUDGMENT (Session 32): the staleness guard — a correction drafted
    // against version N refuses to apply over any other version (a
    // re-issued template, an edited entry); the refusal names both
    // versions. Applying blind would overwrite work the stamp never saw.
    // Listed at close.
    const { data: newest } = await db
      .from("message_templates")
      .select("version, subject")
      .eq("business_id", input.business_id)
      .eq("key", c.template_key)
      .order("version", { ascending: false })
      .limit(1);
    const currentVersion = newest?.[0]?.version ?? 0;
    if (c.template_version !== undefined && currentVersion !== c.template_version) {
      throw new Error(
        `The template was re-issued (v${currentVersion}) after this correction was drafted against v${c.template_version} — the correction is stale; reject it and re-edit the fact if the change is still owed.`
      );
    }
    const { data: reissued, error } = await db
      .from("message_templates")
      .insert({
        business_id: input.business_id,
        created_by: input.approver_actor_id,
        key: c.template_key,
        channel: c.channel,
        subject: c.subject_after !== undefined ? c.subject_after : (newest?.[0]?.subject ?? null),
        body: c.body_after,
        version: currentVersion + 1,
      })
      .select("id, version")
      .single();
    if (error) throw new Error(`template re-issue failed: ${error.message}`);
    appliedVersion = reissued.version;
  } else {
    if (!c.target_content_item_id || !Array.isArray(c.blocks_after)) {
      throw new Error("The knowledge correction payload is incomplete — nothing can be applied.");
    }
    const { data: target, error: targetError } = await db
      .from("content_items")
      .select("id, version, title")
      .eq("id", c.target_content_item_id)
      .eq("business_id", input.business_id)
      .eq("content_type", "knowledge_entry")
      .is("archived_at", null)
      .maybeSingle();
    if (targetError) throw new Error(`knowledge entry lookup failed: ${targetError.message}`);
    if (!target) throw new Error("The knowledge entry this correction targets no longer exists.");
    if (c.target_version !== undefined && target.version !== c.target_version) {
      throw new Error(
        `The entry was edited (v${target.version}) after this correction was drafted against v${c.target_version} — the correction is stale; reject it and re-edit the fact if the change is still owed.`
      );
    }
    const nextVersion = (target.version ?? 1) + 1;
    const { error: updateError } = await db
      .from("content_items")
      .update({ body: c.blocks_after, version: nextVersion })
      .eq("id", target.id)
      .eq("business_id", input.business_id);
    if (updateError) throw new Error(`knowledge entry update failed: ${updateError.message}`);
    const { error: versionError } = await db.from("content_versions").insert({
      business_id: input.business_id,
      content_id: target.id,
      version: nextVersion,
      body: c.blocks_after,
    });
    if (versionError) throw new Error(`version record failed: ${versionError.message}`);
    await emitEvent(db, {
      business_id: input.business_id,
      actor_id: input.approver_actor_id,
      action: DRAFTING_EVENT_KINDS.knowledgeEntryUpdated,
      entity_type: "content_item",
      entity_id: target.id,
      payload: {
        title: target.title,
        version: nextVersion,
        note: "memory sweep correction applied at the stamp",
        correction_id: item.id,
      },
    });
    appliedVersion = nextVersion;
  }

  // The stamp itself: the correction item is PUBLISHED by the approver —
  // the 0009 human-publish gate enforces the human hand.
  const { error: publishError } = await db
    .from("content_items")
    .update({
      state: "published",
      published_by_actor_id: input.approver_actor_id,
      published_at: new Date().toISOString(),
    })
    .eq("id", item.id)
    .eq("business_id", input.business_id);
  if (publishError) throw new Error(`the change applied but the correction could not be stamped: ${publishError.message}`);

  await emitEvent(db, {
    business_id: input.business_id,
    actor_id: input.approver_actor_id,
    action: MEMORY_EVENT_KINDS.correctionApplied,
    entity_type: "content_item",
    entity_id: item.id,
    payload: {
      surface: c.surface,
      label: c.label ?? null,
      fact_title: c.fact_title ?? null,
      old_value: c.old_value ?? null,
      new_value: c.new_value ?? null,
      applied_version: appliedVersion,
      ...(c.template_key ? { template_key: c.template_key } : {}),
      ...(c.target_content_item_id ? { target_content_item_id: c.target_content_item_id } : {}),
    },
  });

  return { surface: c.surface, applied_version: appliedVersion };
}

/** JUDGMENT (Session 32): a declined correction lands state `unpublished`
 * (the existing content_state vocabulary — no new enum) with the rejection
 * triple recorded in attributes and the act evented; the target surface is
 * never touched. Listed at close. */
export async function rejectCorrection(
  db: SupabaseClient,
  input: { business_id: string; actor_id: string; correction_id: string; reason: string }
): Promise<void> {
  const reason = input.reason.trim();
  if (!reason) throw new Error("A reason is required — it is recorded on the correction and the ledger.");
  const item = await loadPendingCorrection(db, input.business_id, input.correction_id);

  const { error } = await db
    .from("content_items")
    .update({
      state: "unpublished",
      attributes: {
        ...item.attributes,
        correction: {
          ...item.correction,
          rejected: { by_actor_id: input.actor_id, at: new Date().toISOString(), reason },
        },
      },
    })
    .eq("id", item.id)
    .eq("business_id", input.business_id);
  if (error) throw new Error(`correction rejection failed: ${error.message}`);

  await emitEvent(db, {
    business_id: input.business_id,
    actor_id: input.actor_id,
    action: MEMORY_EVENT_KINDS.correctionRejected,
    entity_type: "content_item",
    entity_id: item.id,
    payload: { surface: item.correction.surface, label: item.correction.label ?? null, reason },
  });
}
