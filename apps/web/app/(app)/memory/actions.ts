"use server";

import { revalidatePath } from "next/cache";
import {
  createMemoryEntry,
  deactivateMemoryEntry,
  promoteObservation,
  supersedeMemoryEntry,
  sweepFactEdit,
  type MemorySurfaceDecl,
} from "@rooshni/db";

import { getAppContext } from "@/lib/server/context";
import { getAgentActor } from "@/lib/server/queries";

/**
 * Session 32 (D181) — Light's Memory, the doors behind the surface. Every
 * act goes through the @rooshni/db memory module (evented; the 0044
 * triggers are the law beneath: append-only supersede, human-only
 * instructions, the 800-token ceiling naming its count). A fact edit fires
 * the ripple sweep — corrections to the Approval Inbox, tasks for external
 * surfaces, one event.
 */

export interface MemoryActionState {
  error: string | null;
  saved?: boolean;
  /** The sweep's one-act summary, shown after a fact edit. */
  sweepNote?: string | null;
}

const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function parseSurfaces(raw: string): MemorySurfaceDecl[] | { error: string } {
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "The surfaces list could not be read — please retry." };
  }
  if (!Array.isArray(parsed)) return { error: "The surfaces list could not be read — please retry." };
  const surfaces: MemorySurfaceDecl[] = [];
  for (const item of parsed) {
    const s = item as Record<string, unknown>;
    const surface = String(s.surface ?? "").trim();
    const label = String(s.label ?? "").trim();
    if (!surface || !label) return { error: "Every surface needs a kind and a name." };
    surfaces.push({
      surface,
      label,
      ref: typeof s.ref === "string" && s.ref.trim() ? s.ref.trim() : null,
      in_platform: Boolean(s.in_platform),
    });
  }
  return surfaces;
}

function slugKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

export async function addFactAction(_prev: MemoryActionState, formData: FormData): Promise<MemoryActionState> {
  const title = String(formData.get("title") ?? "").trim();
  const value = String(formData.get("value") ?? "").trim();
  const surfaces = parseSurfaces(String(formData.get("surfaces") ?? ""));
  if (!title) return { error: "A fact needs a name." };
  if (!value) return { error: "A fact needs a value — Light states facts exactly, never invents them." };
  if ("error" in surfaces) return { error: surfaces.error };

  const { db, business, actor } = await getAppContext();
  try {
    await createMemoryEntry(db, {
      business_id: business.id,
      actor_id: actor.id,
      kind: "fact",
      title,
      body: value,
      why: "Added in Light's Memory",
      surfaces,
      attributes: { fact_key: slugKey(title) },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "The fact could not be saved.";
    return {
      error: /duplicate|unique/i.test(message)
        ? `A fact named "${title}" already exists — edit that one instead; one active fact per name.`
        : message,
    };
  }
  revalidatePath("/memory");
  return { error: null, saved: true };
}

export async function editFactAction(_prev: MemoryActionState, formData: FormData): Promise<MemoryActionState> {
  const entryId = String(formData.get("entryId") ?? "");
  const value = String(formData.get("value") ?? "").trim();
  const surfacesRaw = String(formData.get("surfaces") ?? "");
  const surfaces = surfacesRaw ? parseSurfaces(surfacesRaw) : null;
  if (!isUuid(entryId)) return { error: "No fact was selected." };
  if (!value) return { error: "A fact needs a value — deactivate it instead if it no longer holds." };
  if (surfaces && "error" in surfaces) return { error: surfaces.error };

  const { db, business, actor } = await getAppContext();
  const light = await getAgentActor();
  try {
    const { predecessor, successor } = await supersedeMemoryEntry(db, {
      business_id: business.id,
      actor_id: actor.id,
      predecessor_id: entryId,
      body: value,
      why: "Edited in Light's Memory",
      ...(surfaces ? { surfaces } : {}),
    });
    if (predecessor.kind === "fact" && predecessor.body.trim() !== value) {
      const sweep = await sweepFactEdit(db, {
        business_id: business.id,
        editor_actor_id: actor.id,
        light_actor_id: light?.id ?? actor.id,
        fact: successor,
        old_value: predecessor.body,
        new_value: value,
      });
      revalidatePath("/memory");
      revalidatePath("/inbox");
      revalidatePath("/tasks");
      return {
        error: null,
        saved: true,
        sweepNote: `${successor.title} changed: ${sweep.corrections.length} correction${
          sweep.corrections.length === 1 ? "" : "s"
        } proposed to the Approval Inbox, ${sweep.tasks.length} manual task${
          sweep.tasks.length === 1 ? "" : "s"
        } raised${sweep.deferred.length ? `, ${sweep.deferred.length} website surface${sweep.deferred.length === 1 ? "" : "s"} deferred` : ""}.`,
      };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "The edit failed." };
  }
  revalidatePath("/memory");
  return { error: null, saved: true };
}

export async function addInstructionAction(
  _prev: MemoryActionState,
  formData: FormData
): Promise<MemoryActionState> {
  const title = String(formData.get("title") ?? "").trim();
  const body = String(formData.get("body") ?? "").trim();
  if (!title) return { error: "An instruction needs a short name." };
  if (!body) return { error: "An instruction needs its wording — it rides every draft verbatim." };

  const { db, business, actor } = await getAppContext();
  try {
    await createMemoryEntry(db, {
      business_id: business.id,
      actor_id: actor.id,
      kind: "instruction",
      title,
      body,
      why: "Added in Light's Memory",
      attributes: { instruction_key: slugKey(title) },
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "The instruction could not be saved." };
  }
  revalidatePath("/memory");
  return { error: null, saved: true };
}

export async function editInstructionAction(
  _prev: MemoryActionState,
  formData: FormData
): Promise<MemoryActionState> {
  const entryId = String(formData.get("entryId") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  if (!isUuid(entryId)) return { error: "No instruction was selected." };
  if (!body) return { error: "An instruction needs its wording — deactivate it instead if it should stop riding." };

  const { db, business, actor } = await getAppContext();
  try {
    await supersedeMemoryEntry(db, {
      business_id: business.id,
      actor_id: actor.id,
      predecessor_id: entryId,
      body,
      why: "Edited in Light's Memory",
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "The edit failed." };
  }
  revalidatePath("/memory");
  return { error: null, saved: true };
}

export async function deactivateEntryAction(
  _prev: MemoryActionState,
  formData: FormData
): Promise<MemoryActionState> {
  const entryId = String(formData.get("entryId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!isUuid(entryId)) return { error: "No entry was selected." };

  const { db, business, actor } = await getAppContext();
  try {
    await deactivateMemoryEntry(db, {
      business_id: business.id,
      actor_id: actor.id,
      entry_id: entryId,
      reason: reason || null,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "The entry could not be deactivated." };
  }
  revalidatePath("/memory");
  return { error: null, saved: true };
}

/** D181: PROMOTE — one click, a human act, evented under their name. */
export async function promoteObservationAction(
  _prev: MemoryActionState,
  formData: FormData
): Promise<MemoryActionState> {
  const observationId = String(formData.get("observationId") ?? "");
  if (!isUuid(observationId)) return { error: "No observation was selected." };

  const { db, business, actor } = await getAppContext();
  try {
    await promoteObservation(db, {
      business_id: business.id,
      actor_id: actor.id,
      observation_id: observationId,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "The promotion failed." };
  }
  revalidatePath("/memory");
  return { error: null, saved: true };
}
