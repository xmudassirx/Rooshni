"use server";

import { revalidatePath } from "next/cache";
import { emitEvent } from "@rooshni/db";

import { getAppContext } from "@/lib/server/context";
import { isUuid, type NoteBlock } from "@/lib/server/queries";

export interface NoteActionState {
  error: string | null;
}

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  // Slug is unique per business per type; a suffix keeps repeat captures safe.
  return `${base || "note"}-${Date.now().toString(36)}`;
}

/** Quick capture: a private note lands unlinked — the Inbox — until promoted. */
export async function quickCaptureAction(
  _prev: NoteActionState,
  formData: FormData
): Promise<NoteActionState> {
  const text = String(formData.get("text") ?? "").trim();
  if (!text) return { error: "Say or type something first." };

  const lines = text.split("\n").filter((l) => l.trim());
  const title = (lines[0] ?? "Untitled note").slice(0, 80);
  const rest = lines.slice(1);
  const blocks: NoteBlock[] = (rest.length ? rest : []).map((l) => ({
    type: "paragraph",
    text: l,
  }));
  if (!rest.length && lines.length === 1) {
    blocks.push({ type: "paragraph", text: lines[0] ?? "" });
  }

  const { db, business, actor } = await getAppContext();
  try {
    const { data, error } = await db
      .from("content_items")
      .insert({
        business_id: business.id,
        created_by: actor.id,
        content_type: "note",
        title,
        slug: slugify(title),
        body: blocks,
        visibility: "private",
        state: "draft",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    await emitEvent(db, {
      business_id: business.id,
      actor_id: actor.id,
      action: "note.captured",
      entity_type: "content_item",
      entity_id: data.id,
      payload: { title },
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Capturing the note failed." };
  }
  revalidatePath("/notes");
  return { error: null };
}

export async function toggleCheckAction(
  _prev: NoteActionState,
  formData: FormData
): Promise<NoteActionState> {
  const noteId = String(formData.get("noteId") ?? "");
  const index = Number(formData.get("index") ?? -1);
  if (!isUuid(noteId) || index < 0) return { error: "That checklist item is not valid." };

  const { db, business, actor } = await getAppContext();
  try {
    const { data: note, error } = await db
      .from("content_items")
      .select("body")
      .eq("id", noteId)
      .eq("business_id", business.id)
      .single();
    if (error) throw new Error(error.message);
    const body = Array.isArray(note.body) ? ([...note.body] as Record<string, unknown>[]) : [];
    const block = body[index];
    if (!block || block.type !== "check") return { error: "That item is not a checklist entry." };
    block.done = block.done !== true;
    const { error: updateError } = await db
      .from("content_items")
      .update({ body })
      .eq("id", noteId)
      .eq("business_id", business.id);
    if (updateError) throw new Error(updateError.message);
    await emitEvent(db, {
      business_id: business.id,
      actor_id: actor.id,
      action: "note.updated",
      entity_type: "content_item",
      entity_id: noteId,
      payload: { checklist_index: index, done: block.done },
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Updating the checklist failed." };
  }
  revalidatePath("/notes");
  return { error: null };
}

/** Confirming a proposed link stamps confirmed_at — relink, never delete. */
export async function confirmLinkAction(
  _prev: NoteActionState,
  formData: FormData
): Promise<NoteActionState> {
  const linkId = String(formData.get("linkId") ?? "");
  if (!isUuid(linkId)) return { error: "That link is not valid." };

  const { db, business, actor } = await getAppContext();
  try {
    const { error } = await db
      .from("entity_links")
      .update({ confirmed_at: new Date().toISOString() })
      .eq("id", linkId)
      .eq("business_id", business.id);
    if (error) throw new Error(error.message);
    await emitEvent(db, {
      business_id: business.id,
      actor_id: actor.id,
      action: "note.link_confirmed",
      entity_type: "entity_link",
      entity_id: linkId,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Confirming the link failed." };
  }
  revalidatePath("/notes");
  return { error: null };
}

export async function shareToTeamAction(
  _prev: NoteActionState,
  formData: FormData
): Promise<NoteActionState> {
  const noteId = String(formData.get("noteId") ?? "");
  if (!isUuid(noteId)) return { error: "That note is not valid." };

  const { db, business, actor } = await getAppContext();
  try {
    const { error } = await db
      .from("content_items")
      .update({ visibility: "team" })
      .eq("id", noteId)
      .eq("business_id", business.id);
    if (error) throw new Error(error.message);
    await emitEvent(db, {
      business_id: business.id,
      actor_id: actor.id,
      action: "note.shared",
      entity_type: "content_item",
      entity_id: noteId,
      payload: { visibility: "team" },
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Sharing the note failed." };
  }
  revalidatePath("/notes");
  return { error: null };
}
