/*
 * The live inbox's decision rules — PURE, so the check-local harness proves
 * them (the defect-trio hotfix, 2 Aug 2026: the badge missed drafts entering
 * pending_approval because the channel could die silently; the rules and the
 * channel's lifecycle are now both pinned by the live-inbox smoke).
 *
 * No imports: this module is loaded by the browser component AND by the
 * PGlite harness, and must carry no Next/browser dependency either way.
 */

export interface CommChangeRow {
  status?: string;
  direction?: string;
  attributes?: { kind?: string } | null;
}

/**
 * What a communications change means for the shell. TONE rings for a draft
 * ARRIVING at pending (a stamp newly owed — Session 16 PR-G), for an
 * inbound client message (Session 23 WS1c, founder-ruled), and for a
 * returning-lead system marker (Session 27, D158a: "thread to top, unread
 * badge, arrival sound" — the marker is direction 'internal', so the
 * inbound test alone would stay silent) — not for edits, not for
 * decisions. Every change still reconciles the server render.
 *
 * Realtime's old record carries only the primary key (REPLICA IDENTITY
 * default), so `prev.status` is usually undefined — the arrival test treats
 * that as "was not pending", which errs toward ringing, never toward silence.
 */
export function classifyCommChange(
  eventType: string,
  next: CommChangeRow | null | undefined,
  prev: CommChangeRow | null | undefined
): { tone: boolean } {
  const draftArrived = next?.status === "pending_approval" && prev?.status !== "pending_approval";
  const inboundArrived = eventType === "INSERT" && next?.direction === "inbound";
  const markerArrived =
    eventType === "INSERT" &&
    next?.direction === "internal" &&
    next?.attributes?.kind === "returning_lead_marker";
  return { tone: draftArrived || inboundArrived || markerArrived };
}

/** Channel states that mean the subscription is DEAD and must be rejoined —
 * a dead channel delivers nothing and raises nothing, which is exactly the
 * silence the defect shipped. */
export function shouldRejoin(status: string): boolean {
  return status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED";
}

/** Transport retry backoff — capped exponential. A NETWORK cadence, not a
 * product timer (the decision 92 class): timeScale() governs product
 * durations; a socket rejoin has nothing to scale. */
export function rejoinDelayMs(attempt: number): number {
  return Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
}
