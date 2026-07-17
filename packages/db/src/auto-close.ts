/**
 * Decision 15 — auto-close policy (Session 10; decision 51's caveat, verbatim:
 * "closing as Unresponsive when nudges expired unstamped misattributes the
 * silence — the close step must distinguish 'silent after sent nudges' from
 * 'nudges never approved' on the ledger").
 *
 * The two states:
 *   SILENT AFTER SENT NUDGES — nudges genuinely reached the client (status
 *   sent/delivered/read) and no reply came: the enquiry may close as
 *   Unresponsive; the silence is the client's.
 *   NUDGES NEVER APPROVED — the drafts died unstamped in the inbox (or
 *   failed dispatch): the client never heard from us; closing as
 *   Unresponsive is REFUSED and the enquiry stays open for a human.
 *
 * All values PROVISIONAL per docs/LEAD-LOG-BASELINE.md — the export holds no
 * reply-latency data to calibrate them; they are tuned from live ledger data
 * post-go-live. This module is the one named place they live. (The nurture
 * cadence itself — 2/5/9 days + 3 days' silence — is workflow DATA on the
 * seeded definition, scaled through timeScale(); it is policy in rows, not a
 * constant here.)
 */

export const AUTO_CLOSE_POLICY = {
  /** PROVISIONAL: how many nudges must have genuinely reached the client
   * before silence may close the enquiry as Unresponsive. */
  minimumSentNudges: 1,
} as const;

/** Statuses that mean the client genuinely received (or could have) the message. */
const DELIVERED_STATUSES = new Set(["sent", "delivered", "read"]);

export interface NudgeFact {
  communication_id: string;
  status: string;
}

export interface AutoCloseVerdict {
  close: boolean;
  reason: string;
  nudges_drafted: number;
  nudges_sent: number;
}

/** Pure and clock-free so check-local can prove the refusal without a provider. */
export function evaluateAutoClose(nudges: NudgeFact[]): AutoCloseVerdict {
  const sent = nudges.filter((n) => DELIVERED_STATUSES.has(n.status)).length;
  const drafted = nudges.length;
  if (drafted === 0) {
    return {
      close: false,
      reason:
        "auto-close refused: no nudges exist on this run — silence cannot be attributed to a client who was never nudged",
      nudges_drafted: drafted,
      nudges_sent: sent,
    };
  }
  if (sent < AUTO_CLOSE_POLICY.minimumSentNudges) {
    return {
      close: false,
      reason: `auto-close refused: ${sent} of ${drafted} nudges reached the client — the drafts died unstamped in the inbox; closing as Unresponsive would misattribute the silence (decision 15)`,
      nudges_drafted: drafted,
      nudges_sent: sent,
    };
  }
  return {
    close: true,
    reason: `silent after sent nudges: ${sent} of ${drafted} nudges delivered, no reply`,
    nudges_drafted: drafted,
    nudges_sent: sent,
  };
}
