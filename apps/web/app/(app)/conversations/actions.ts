"use server";

import { revalidatePath } from "next/cache";
import {
  createAnthropicGenerator,
  createAnthropicRouteClassifier,
  createServiceClient,
  emitEvent,
  requestThreadDraftNow,
  sweepSettleAndSupersede,
  sweepUneventedSupersedes,
  INBOUND_EVENT_KINDS,
  SETTLE_WINDOW_MINUTES_OPTIONS,
} from "@rooshni/db";

import { getAppContext } from "@/lib/server/context";
import { dispatchAfterApproval } from "@/lib/server/outbound";
import {
  getOlderThreadMessages,
  isUuid,
  type ThreadCursor,
  type ThreadMessage,
} from "@/lib/server/queries";

/**
 * Session 16 — Conversations becomes a drafting AND sending surface
 * (decision 133c/d). Everything structural stays in the database: the
 * insert-at-approved path fires every trigger (human stamp, readiness
 * pre-flight, session window, the 0030 auto-supersede), and superseding is
 * the service-only 0030 pipeline. This file asks; the database decides.
 */

export interface ThreadActionState {
  error: string | null;
  done?: boolean;
}

async function threadForMember(threadId: string) {
  const { db, business, actor, membershipRole } = await getAppContext();
  const { data: thread, error } = await db
    .from("comm_threads")
    .select(
      "id, business_id, contact_id, engagement_id, channel, subject, auto_draft_paused, settle_override_seconds"
    )
    .eq("id", threadId)
    .eq("business_id", business.id)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error(`Thread lookup failed: ${error.message}`);
  if (!thread) throw new Error("That conversation no longer exists.");
  return { db, business, actor, membershipRole, thread };
}

/**
 * The human replies directly (decision 21 insert-at-approved): the message is
 * born approved BY the signed-in human — every trigger fires on the insert
 * (human stamp, pre-flight, WhatsApp session window), the 0030 trigger
 * supersedes any pending draft on the thread IN THE SAME TRANSACTION
 * (decision 133c — the human always wins), and dispatch is attempted inline.
 */
export async function sendDirectMessageAction(
  _prev: ThreadActionState,
  formData: FormData
): Promise<ThreadActionState> {
  const threadId = String(formData.get("threadId") ?? "");
  const body = String(formData.get("body") ?? "").trim();
  if (!isUuid(threadId)) return { error: "No conversation was selected." };
  if (!body) return { error: "There is nothing to send." };

  let ctx: Awaited<ReturnType<typeof threadForMember>>;
  try {
    ctx = await threadForMember(threadId);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Thread lookup failed." };
  }
  const { db, business, actor, thread } = ctx;
  if (!["email", "whatsapp"].includes(thread.channel)) {
    return { error: `No carrier exists for the "${thread.channel}" channel yet.` };
  }

  const subject =
    thread.channel === "email" && thread.subject
      ? thread.subject.startsWith("Re:")
        ? thread.subject
        : `Re: ${thread.subject}`
      : null;

  const { data: inserted, error: insertError } = await db
    .from("communications")
    .insert({
      business_id: business.id,
      created_by: actor.id,
      thread_id: thread.id,
      contact_id: thread.contact_id,
      engagement_id: thread.engagement_id,
      channel: thread.channel,
      direction: "outbound",
      status: "approved",
      body,
      body_format: "plain",
      drafted_by_actor_id: actor.id,
      approved_by_actor_id: actor.id,
      attributes: { ...(subject ? { subject } : {}), sent_from: "conversations" },
    })
    .select("id")
    .single();
  if (insertError) {
    // The database's own refusals surface verbatim — pre-flight failures
    // (consent, the WhatsApp session window) are guidance, not bugs.
    return { error: `The database refused the send: ${insertError.message}` };
  }
  const commId = inserted.id as string;

  // The approval envelope on The Record (the insert IS the stamp —
  // decision 21; the event mirrors approve_communication's shape).
  const approvalEvent = await emitEvent(db, {
    business_id: business.id,
    actor_id: actor.id,
    action: "communication.approved",
    entity_type: "communication",
    entity_id: commId,
    approval: { level: 3, approved_by: actor.id, decided_at: new Date().toISOString() },
    payload: { insert_at_approved: true, thread_id: thread.id },
  });
  await db.from("communications").update({ approval_event_id: approvalEvent.id }).eq("id", commId);

  // The 0030 trigger already superseded any pending draft in the same
  // transaction as the insert; put those transitions on The Record now
  // (reason human_replied — no orphan, and no silent bookkeeping).
  try {
    await sweepUneventedSupersedes(db, { threadId: thread.id });
  } catch (err) {
    console.error("supersede eventing failed (the tick self-heals):", err);
  }

  // Carriage: inline best-effort; quiet hours hold it, the tick retries.
  await dispatchAfterApproval(commId);

  revalidatePath("/", "layout");
  return { error: null, done: true };
}

/**
 * "Ask Light to draft" (decision 133d): the manual trigger bypasses the
 * remaining settle wait — the due moment moves to NOW and the sweep runs
 * inline for this thread only. The paused toggle does not block a manual
 * ask: pausing stops the AUTOMATIC drafting, the button IS the manual door.
 */
export async function askLightToDraftAction(
  _prev: ThreadActionState,
  formData: FormData
): Promise<ThreadActionState> {
  const threadId = String(formData.get("threadId") ?? "");
  if (!isUuid(threadId)) return { error: "No conversation was selected." };

  try {
    await threadForMember(threadId); // membership + existence under RLS
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Thread lookup failed." };
  }

  const service = createServiceClient();
  try {
    await requestThreadDraftNow(service, threadId);
    const report = await sweepSettleAndSupersede(service, {
      generator: createAnthropicGenerator(),
      classifier: createAnthropicRouteClassifier(),
      onlyThreadId: threadId,
      // The paused toggle stops AUTOMATIC drafting; the human's explicit
      // ask is the manual door and runs regardless.
      ignorePause: true,
    });
    if (report.errors.length > 0) {
      return { error: report.errors.join("; ") };
    }
    if (report.drafts_created === 0) {
      return {
        error:
          "Nothing to draft — no unanswered client message on this conversation (a pending draft may already answer it).",
      };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Drafting failed." };
  }

  revalidatePath("/", "layout");
  return { error: null, done: true };
}

/** PR-D: the per-conversation toggle PAUSES auto-draft — it never enables;
 * on is the default and the only other state is paused. Evented. */
export async function setAutoDraftPausedAction(
  _prev: ThreadActionState,
  formData: FormData
): Promise<ThreadActionState> {
  const threadId = String(formData.get("threadId") ?? "");
  const paused = String(formData.get("paused") ?? "") === "true";
  if (!isUuid(threadId)) return { error: "No conversation was selected." };

  let ctx: Awaited<ReturnType<typeof threadForMember>>;
  try {
    ctx = await threadForMember(threadId);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Thread lookup failed." };
  }
  const { db, business, actor, thread } = ctx;

  const { error } = await db
    .from("comm_threads")
    .update({ auto_draft_paused: paused })
    .eq("id", thread.id);
  if (error) return { error: `Toggle failed: ${error.message}` };

  await emitEvent(db, {
    business_id: business.id,
    actor_id: actor.id,
    action: INBOUND_EVENT_KINDS.threadDraftingPreferenceChanged,
    entity_type: "comm_thread",
    entity_id: thread.id,
    payload: { auto_draft_paused: paused },
  });

  revalidatePath("/conversations");
  return { error: null, done: true };
}

/**
 * Session 23 (WS2, 5c) — the upward scroll: one bounded older window per
 * call, cursor-keyed. A read, not an act; RLS scopes it, nothing is evented.
 */
export async function loadOlderMessagesAction(
  threadId: string,
  before: ThreadCursor
): Promise<{ messages: ThreadMessage[]; hasOlder: boolean; oldestCursor: ThreadCursor | null }> {
  if (!isUuid(threadId)) return { messages: [], hasOlder: false, oldestCursor: null };
  return getOlderThreadMessages(threadId, before);
}

/**
 * Session 23 (WS1c) — opening a thread clears its unread state: stamp
 * last_opened_at; the 0035 generated column derives unread from it in the
 * database. JUDGMENT (0035): reading correspondence is not an act on the
 * world — no ledger event; the write rides the existing member-RLS UPDATE
 * policy on comm_threads.
 */
export async function markThreadOpenedAction(threadId: string): Promise<void> {
  if (!isUuid(threadId)) return;
  try {
    const { db, business } = await getAppContext();
    await db
      .from("comm_threads")
      .update({ last_opened_at: new Date().toISOString() })
      .eq("id", threadId)
      .eq("business_id", business.id);
  } catch {
    // Unread clearing is bookkeeping — a miss self-heals on the next open.
  }
  revalidatePath("/", "layout");
}

/** PR-C: the per-conversation settle override — instant/1/3/5 minutes, or
 * back to the business default. Evented. */
export async function setSettleOverrideAction(
  _prev: ThreadActionState,
  formData: FormData
): Promise<ThreadActionState> {
  const threadId = String(formData.get("threadId") ?? "");
  const raw = String(formData.get("override_minutes") ?? "default");
  if (!isUuid(threadId)) return { error: "No conversation was selected." };

  let overrideSeconds: number | null = null;
  if (raw !== "default") {
    const minutes = Number(raw);
    if (!(SETTLE_WINDOW_MINUTES_OPTIONS as readonly number[]).includes(minutes)) {
      return { error: "The settle window must be instant, 1, 3 or 5 minutes." };
    }
    overrideSeconds = minutes * 60;
  }

  let ctx: Awaited<ReturnType<typeof threadForMember>>;
  try {
    ctx = await threadForMember(threadId);
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Thread lookup failed." };
  }
  const { db, business, actor, thread } = ctx;

  const { error } = await db
    .from("comm_threads")
    .update({ settle_override_seconds: overrideSeconds })
    .eq("id", thread.id);
  if (error) return { error: `Override failed: ${error.message}` };

  await emitEvent(db, {
    business_id: business.id,
    actor_id: actor.id,
    action: INBOUND_EVENT_KINDS.threadDraftingPreferenceChanged,
    entity_type: "comm_thread",
    entity_id: thread.id,
    payload: { settle_override_seconds: overrideSeconds },
  });

  revalidatePath("/conversations");
  return { error: null, done: true };
}
