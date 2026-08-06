/*
 * The enquiry timeline's merge-and-order — one pure home (the record-row
 * precedent) so the page and the harness prove the same ordering law.
 *
 * Session 30 (177e): the timeline renders NEWEST FIRST — it answers "what
 * just happened"; the opening events belong at the bottom once history
 * exists. Every item kind — ledger events, stage moves, message cards and
 * their pins — flips together in the ONE sort below: no surface renders
 * both orders.
 *
 * JUDGMENT (carried from the page): the ledger's communication.* entries and
 * the opening stage_history row are not repeated as timeline rows — the
 * message cards (with their stamp and rejection detail) and
 * engagement.created already tell those moments, and a timeline that says
 * everything twice reads as noise, not truth.
 */

export type TimelineItem<E, M, C> =
  | { kind: "event"; at: string; event: E }
  | { kind: "stage"; at: string; move: M; label: string }
  | { kind: "comm"; at: string; comm: C };

export interface TimelineSource<E, M, C> {
  events: E[];
  stageHistory: M[];
  comms: C[];
  stages: Array<{ id: string; label: string }>;
}

export function buildTimeline<
  E extends { occurredAt: string; action: string },
  M extends { movedAt: string; fromStageId: string | null; toStageId: string },
  C extends { occurredAt: string; channel: string },
>(detail: TimelineSource<E, M, C>): TimelineItem<E, M, C>[] {
  const stageLabels = new Map(detail.stages.map((s) => [s.id, s.label]));
  const items: TimelineItem<E, M, C>[] = [];

  for (const event of detail.events) {
    // The communication cards tell the comms story with the full draft;
    // repeating their ledger entries here would say everything twice.
    if (event.action.startsWith("communication.")) continue;
    items.push({ kind: "event", at: event.occurredAt, event });
  }
  for (const move of detail.stageHistory) {
    // The opening move (from nowhere) is already told by engagement.created.
    if (!move.fromStageId) continue;
    items.push({
      kind: "stage",
      at: move.movedAt,
      move,
      label: stageLabels.get(move.toStageId) ?? "another stage",
    });
  }
  for (const comm of detail.comms) {
    if (comm.channel === "internal_note") continue;
    items.push({ kind: "comm", at: comm.occurredAt, comm });
  }

  // 177e: newest first — the one ordering, every kind together.
  return items.sort((a, b) => b.at.localeCompare(a.at));
}
