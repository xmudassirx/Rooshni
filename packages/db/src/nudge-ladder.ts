/**
 * The ruled nudge ladder — Session 26 (C4, founder-ruled, 3 August 2026):
 * intro unchanged (blocks for the stamp, WhatsApp companion) → call task due
 * 2h unchanged → nudge 1 T+1d WhatsApp (fallback email) → nudge 2 T+3d email
 * → nudge 3 T+6d final email → close wait 3d → auto-close ≈T+9d. Waits stay
 * sequential after the intro stamp (decision 48) and cancel-on-reply; the
 * decision 96 auto-close refusal is untouched.
 *
 * The ladder changes by RE-ISSUE (decisions 40/102): a NEW definition
 * version through the pipeline, the superseded version paused — never an
 * edit of the active one. This module is the transformation's one home so
 * the chore script and the harness prove the same logic.
 *
 * JUDGMENT: the nurture step KEYS rename to their new T-offsets
 * (nurture_wait_t1/nurture_t1, t3, t6) — keys are self-describing labels of
 * the moment they fire, and nothing routes on them (the executor routes on
 * message-template keys; step keys travel only into event payloads). The
 * MESSAGE TEMPLATE keys (nurture_t2_v1 etc.) are stable content identities
 * bound to the approved wa_template mapping and are NOT renamed.
 */

export interface LadderStep {
  key: string;
  sort_order: number;
  kind: string;
  config: Record<string, unknown> | null;
  gate_level: number | null;
}

/** The ruled waits, in ladder order: gaps of 1/2/3 days produce T+1/3/6;
 * the 3-day close wait lands the auto-close at ≈T+9. */
export const RULED_LADDER_WAITS: Record<string, number> = {
  nurture_wait_t1: 1,
  nurture_wait_t3: 2,
  nurture_wait_t6: 3,
  close_wait: 3,
};

/** Old step key → its ruled successor (waits carry their new gap). */
const RENAMES: Record<string, { key: string; days?: number }> = {
  nurture_wait_t2: { key: "nurture_wait_t1", days: 1 },
  nurture_t2: { key: "nurture_t1" },
  nurture_wait_t5: { key: "nurture_wait_t3", days: 2 },
  nurture_t5: { key: "nurture_t3" },
  nurture_wait_t9: { key: "nurture_wait_t6", days: 3 },
  nurture_t9: { key: "nurture_t6" },
};

/** Does a definition's step list already carry the ruled ladder? (The
 * chore's idempotency check — a re-run re-issues nothing.) */
export function carriesRuledLadder(steps: LadderStep[]): boolean {
  return Object.entries(RULED_LADDER_WAITS).every(([key, days]) => {
    const step = steps.find((s) => s.key === key);
    const wait = (step?.config as { wait?: { days?: number } } | null)?.wait;
    return step?.kind === "wait" && wait?.days === days;
  });
}

/** The v(N+1) step rows: waits re-gapped to the ruled ladder, nurture keys
 * renamed to their true T-offsets, everything else copied verbatim
 * (channels, templates, fallbacks, cancel-on-reply, gates all unchanged). */
export function reissueNudgeLadderSteps(steps: LadderStep[]): LadderStep[] {
  return steps.map((step) => {
    const rename = RENAMES[step.key];
    if (!rename) return { ...step, config: step.config ? { ...step.config } : step.config };
    const config = { ...(step.config ?? {}) } as Record<string, unknown>;
    if (rename.days !== undefined) config.wait = { days: rename.days };
    return { ...step, key: rename.key, config };
  });
}

/** A definition row as the chore's scan sees it. */
export interface ReissueCandidate {
  id: string;
  version: number;
  status: string;
}

/** The chore's next move for one business (Session 30, WS B3). */
export type ReissueAction<T extends ReissueCandidate = ReissueCandidate> =
  | { action: "skip"; reason: string }
  | { action: "stamp"; target: T; active: T }
  | { action: "issue"; version: number; active: T };

/**
 * The issue-vs-stamp decision (Session 30, WS B3 — the v4/v5 incident,
 * decision 169). A re-run must FIND its own earlier staging: a draft or
 * pending_approval version already carrying the ruled ladder is stamped,
 * never duplicated. A withdrawn staging is terminal and is never revived —
 * only a live staging counts. Extracted here (the transformation-module
 * precedent above) so the chore and the harness prove the same decision.
 */
export function chooseReissueAction<T extends ReissueCandidate>(
  versions: T[],
  stepsByDefinitionId: Map<string, LadderStep[]>
): ReissueAction<T> {
  const active = versions.find((v) => v.status === "active");
  if (!active) return { action: "skip", reason: "no ACTIVE version" };
  if (carriesRuledLadder(stepsByDefinitionId.get(active.id) ?? [])) {
    return { action: "skip", reason: `active v${active.version} already carries the ruled ladder` };
  }
  const staged = versions
    .filter((v) => v.status === "pending_approval" || v.status === "draft")
    .sort((a, b) => b.version - a.version)
    .find((v) => carriesRuledLadder(stepsByDefinitionId.get(v.id) ?? []));
  if (staged) return { action: "stamp", target: staged, active };
  return { action: "issue", version: Math.max(...versions.map((v) => v.version)) + 1, active };
}

/** The re-issued version's plain-English description (the §2.4 preview at
 * the approval gate) — the day numbers tell the ruled truth. */
export function ruledLadderDescription(): string {
  return (
    "When a new Meta lead arrives: draft an instant acknowledgement email for approval (with a WhatsApp " +
    "companion where consent and the approved template exist); create a call task for the owner, due within " +
    "two hours; if both calls fail, draft a sorry-we-missed-you message; watch for replies and, once " +
    "qualified, send a booking link with consultation reminders (later phase); if there is no response, " +
    "nudge on day one (WhatsApp), day three (email) and day six (final notice); after three further days of " +
    "silence, close the enquiry as Unresponsive and log the outcome signal for Meta. Every outgoing message " +
    "waits for a human stamp before anything is sent."
  );
}
