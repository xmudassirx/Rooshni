"use server";

import { revalidatePath } from "next/cache";
import { emitEvent } from "@rooshni/db";

import { getAppContext } from "@/lib/server/context";
import { isUuid } from "@/lib/server/queries";

/*
 * Tasks are deliberately ungated (Spec 1 §4.3): RLS lets members write their
 * business's rows directly, and every act still lands on The Record via
 * emitEvent — the single lawful ledger path. Nothing here touches a
 * protected pipeline.
 */

export interface TaskActionState {
  error: string | null;
}

export async function saveTaskAction(
  _prev: TaskActionState,
  formData: FormData
): Promise<TaskActionState> {
  const id = String(formData.get("id") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const dueAtISO = String(formData.get("dueAtISO") ?? "");
  const allDay = formData.get("allDay") === "true";
  const engagementId = String(formData.get("engagementId") ?? "");
  // "✦ Hand to Light" on an unsaved task creates it assigned to the agent.
  const assigneeAgentId = String(formData.get("assigneeAgentId") ?? "");

  if (!title) return { error: "Name the task first." };
  if (!dueAtISO) return { error: "Every task has a day — pick one." };
  if (engagementId && !isUuid(engagementId)) return { error: "That enquiry link is not valid." };
  if (assigneeAgentId && !isUuid(assigneeAgentId)) return { error: "That hand-off is not valid." };

  const { db, business, actor } = await getAppContext();

  // JUDGMENT: the schema has only due_at; an untimed task (the modal's
  // "+ time" state) is recorded as due_at at the day's start with
  // attributes.all_day = true — additive, reversible (Session 8, Lane B).
  const row = {
    title,
    description: description || null,
    due_at: dueAtISO,
    engagement_id: engagementId || null,
    attributes: { all_day: allDay },
  };

  try {
    if (id) {
      if (!isUuid(id)) return { error: "That task id is not valid." };
      const { error } = await db
        .from("tasks")
        .update(row)
        .eq("id", id)
        .eq("business_id", business.id);
      if (error) throw new Error(error.message);
      await emitEvent(db, {
        business_id: business.id,
        actor_id: actor.id,
        action: "task.updated",
        entity_type: "task",
        entity_id: id,
        payload: { title, all_day: allDay, engagement_id: engagementId || null },
      });
    } else {
      const { data, error } = await db
        .from("tasks")
        .insert({
          ...row,
          business_id: business.id,
          created_by: actor.id,
          assignee_actor_id: assigneeAgentId || actor.id,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      await emitEvent(db, {
        business_id: business.id,
        actor_id: actor.id,
        action: assigneeAgentId ? "task.handed_to_light" : "task.created",
        entity_type: "task",
        entity_id: data.id,
        payload: {
          title,
          all_day: allDay,
          engagement_id: engagementId || null,
          ...(assigneeAgentId ? { assignee_actor_id: assigneeAgentId } : {}),
        },
      });
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Saving the task failed." };
  }
  revalidatePath("/tasks");
  revalidatePath("/dashboard");
  return { error: null };
}

export async function setTaskStatusAction(
  _prev: TaskActionState,
  formData: FormData
): Promise<TaskActionState> {
  const id = String(formData.get("id") ?? "");
  const done = formData.get("done") === "true";
  if (!isUuid(id)) return { error: "That task id is not valid." };

  const { db, business, actor } = await getAppContext();
  try {
    const { error } = await db
      .from("tasks")
      .update({ status: done ? "done" : "open" })
      .eq("id", id)
      .eq("business_id", business.id);
    if (error) throw new Error(error.message);
    await emitEvent(db, {
      business_id: business.id,
      actor_id: actor.id,
      action: done ? "task.completed" : "task.reopened",
      entity_type: "task",
      entity_id: id,
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Updating the task failed." };
  }
  revalidatePath("/tasks");
  revalidatePath("/dashboard");
  return { error: null };
}

export async function handToLightAction(
  _prev: TaskActionState,
  formData: FormData
): Promise<TaskActionState> {
  const id = String(formData.get("id") ?? "");
  const agentId = String(formData.get("agentId") ?? "");
  if (!isUuid(id) || !isUuid(agentId)) return { error: "That hand-off is not valid." };

  const { db, business, actor } = await getAppContext();
  try {
    const { error } = await db
      .from("tasks")
      .update({ assignee_actor_id: agentId })
      .eq("id", id)
      .eq("business_id", business.id);
    if (error) throw new Error(error.message);
    await emitEvent(db, {
      business_id: business.id,
      actor_id: actor.id,
      action: "task.handed_to_light",
      entity_type: "task",
      entity_id: id,
      payload: { assignee_actor_id: agentId },
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "The hand-off failed." };
  }
  revalidatePath("/tasks");
  return { error: null };
}
