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

/**
 * Session 23 (WS4d) — "manager" resolved against the existing permission
 * truth (JUDGMENT, per the 0037 migration note): the owner, or a human
 * holding settings.team at execute (decision 8's managing-access tool).
 * App-side gate for an ungated primitive (decision 74); terminality itself
 * is the database's (0037 trigger).
 */
async function actorIsManager(
  db: Awaited<ReturnType<typeof getAppContext>>["db"],
  businessId: string,
  actorId: string,
  membershipRole: string
): Promise<boolean> {
  if (membershipRole === "owner") return true;
  const { data } = await db
    .from("grants")
    .select("id")
    .eq("business_id", businessId)
    .eq("grantee_actor_id", actorId)
    .eq("tool", "settings.team")
    .eq("access", "execute")
    .is("revoked_at", null)
    .is("archived_at", null)
    .limit(1);
  return Boolean(data?.length);
}

/**
 * WS4d — the manager's CANCEL: terminal (0037 trigger), evented, reason
 * optional. Serves both the direct cancel and the approval of a member's
 * request (the request bookkeeping travels into the event either way).
 * Never a delete; The Record never purges.
 */
export async function cancelTaskAction(
  _prev: TaskActionState,
  formData: FormData
): Promise<TaskActionState> {
  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!isUuid(id)) return { error: "That task id is not valid." };

  const { db, business, actor, membershipRole } = await getAppContext();
  if (!(await actorIsManager(db, business.id, actor.id, membershipRole))) {
    return {
      error:
        "Cancelling a task is a manager's act (owner, or settings.team) — use Request cancellation instead.",
    };
  }

  try {
    const { data: task, error: lookupError } = await db
      .from("tasks")
      .select("id, status, attributes")
      .eq("id", id)
      .eq("business_id", business.id)
      .maybeSingle();
    if (lookupError) throw new Error(lookupError.message);
    if (!task) return { error: "That task no longer exists." };
    if (task.status === "cancelled") return { error: "This task is already cancelled." };
    if (task.status === "done") return { error: "A completed task cannot be cancelled." };

    const attrs = (task.attributes ?? {}) as Record<string, unknown>;
    const request = attrs.cancellation_request as Record<string, unknown> | undefined;
    const { cancellation_request: _dropped, ...rest } = attrs;
    const { error } = await db
      .from("tasks")
      .update({
        status: "cancelled",
        attributes: {
          ...rest,
          cancellation: {
            cancelled_by: actor.id,
            cancelled_at: new Date().toISOString(),
            ...(reason ? { reason } : {}),
            ...(request ? { approved_request: request } : {}),
          },
        },
      })
      .eq("id", id)
      .eq("business_id", business.id);
    if (error) throw new Error(error.message);
    await emitEvent(db, {
      business_id: business.id,
      actor_id: actor.id,
      action: "task.cancelled",
      entity_type: "task",
      entity_id: id,
      payload: {
        ...(reason ? { reason } : {}),
        ...(request ? { approved_request: request } : {}),
      },
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Cancelling the task failed." };
  }
  revalidatePath("/", "layout");
  return { error: null };
}

/** WS4d — a non-manager's REQUEST: bookkeeping on the row; the 0037 view
 * arm lands it in the manager's Approval Inbox. Evented. */
export async function requestTaskCancellationAction(
  _prev: TaskActionState,
  formData: FormData
): Promise<TaskActionState> {
  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!isUuid(id)) return { error: "That task id is not valid." };

  const { db, business, actor } = await getAppContext();
  try {
    const { data: task, error: lookupError } = await db
      .from("tasks")
      .select("id, status, attributes")
      .eq("id", id)
      .eq("business_id", business.id)
      .maybeSingle();
    if (lookupError) throw new Error(lookupError.message);
    if (!task) return { error: "That task no longer exists." };
    if (task.status === "cancelled" || task.status === "done") {
      return { error: "This task is already closed." };
    }
    const attrs = (task.attributes ?? {}) as Record<string, unknown>;
    if (attrs.cancellation_request) {
      return { error: "A cancellation request is already awaiting the manager." };
    }
    const { error } = await db
      .from("tasks")
      .update({
        attributes: {
          ...attrs,
          cancellation_request: {
            requested_by: actor.id,
            requested_at: new Date().toISOString(),
            ...(reason ? { reason } : {}),
          },
        },
      })
      .eq("id", id)
      .eq("business_id", business.id);
    if (error) throw new Error(error.message);
    await emitEvent(db, {
      business_id: business.id,
      actor_id: actor.id,
      action: "task.cancellation_requested",
      entity_type: "task",
      entity_id: id,
      payload: reason ? { reason } : {},
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "The request failed." };
  }
  revalidatePath("/", "layout");
  return { error: null };
}

/** WS4d — the manager declines a request: the request clears with a stated
 * reason, the task stays open, everything on The Record. */
export async function declineTaskCancellationAction(
  _prev: TaskActionState,
  formData: FormData
): Promise<TaskActionState> {
  const id = String(formData.get("id") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!isUuid(id)) return { error: "That task id is not valid." };
  if (!reason) return { error: "Declining needs a stated reason — it goes on The Record." };

  const { db, business, actor, membershipRole } = await getAppContext();
  if (!(await actorIsManager(db, business.id, actor.id, membershipRole))) {
    return { error: "Deciding a cancellation request is a manager's act (owner, or settings.team)." };
  }

  try {
    const { data: task, error: lookupError } = await db
      .from("tasks")
      .select("id, attributes")
      .eq("id", id)
      .eq("business_id", business.id)
      .maybeSingle();
    if (lookupError) throw new Error(lookupError.message);
    if (!task) return { error: "That task no longer exists." };
    const attrs = (task.attributes ?? {}) as Record<string, unknown>;
    const request = attrs.cancellation_request as Record<string, unknown> | undefined;
    if (!request) return { error: "No cancellation request is pending on this task." };
    const { cancellation_request: _dropped, ...rest } = attrs;
    const { error } = await db
      .from("tasks")
      .update({ attributes: rest })
      .eq("id", id)
      .eq("business_id", business.id);
    if (error) throw new Error(error.message);
    await emitEvent(db, {
      business_id: business.id,
      actor_id: actor.id,
      action: "task.cancellation_request_declined",
      entity_type: "task",
      entity_id: id,
      payload: { reason, declined_request: request },
    });
  } catch (err) {
    return { error: err instanceof Error ? err.message : "The decision failed." };
  }
  revalidatePath("/", "layout");
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
