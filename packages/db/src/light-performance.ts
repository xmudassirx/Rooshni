import { pricedAmountGbp } from "./ai-budget";

/**
 * The Light performance tile — Session 22, WS3 (founder pre-ruled): one
 * dashboard tile reading EXISTING truth only — events + draft_feedback +
 * communication statuses. No new stores, no model calls, honest empty
 * states. This is the founder's shadow-exit calibration instrument: the day
 * approval rate is high and edit rate is low on real leads is the day
 * shadow mode ends.
 *
 * The computation is pure so the harness proves the tile's numbers against
 * a constructed fixture's known truth (the ordered smoke).
 */

/** The current week, Monday-started, UTC. JUDGMENT: "this week" is the UTC
 * calendar week — one clock across the meter, the caps and this tile; the
 * business-timezone refinement is a future tightening, not a different law. */
export function weekWindowUtc(now: Date): { start: string; end: string } {
  const day = now.getUTCDay(); // 0 = Sunday
  const sinceMonday = (day + 6) % 7;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - sinceMonday));
  const end = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export interface LightPerformanceInput {
  /** count of light.draft_generated events in the week. */
  drafts_generated: number;
  /** count of communication.approved events in the week (the stamps). */
  stamped: number;
  /** count of communication.rejected events in the week. */
  rejected: number;
  /** count of draft_feedback rows kind=edit in the week (edit signals —
   * one row per recorded edit act). */
  edit_signals: number;
  /** count of communication.compliance_checked events with result=breach. */
  compliance_refusals: number;
  /** the week's light.draft_generated cost blocks (bounded read). */
  cost_blocks: Array<Record<string, unknown> | null>;
}

export interface LightPerformance {
  drafts_generated: number;
  /** stamped / (stamped + rejected), percent — null until a stamp or a
   * rejection exists (an unearned rate is never invented). */
  approval_rate_pct: number | null;
  stamped: number;
  rejected: number;
  /** edit signals per stamped draft, percent — null until a stamp exists. */
  edit_rate_pct: number | null;
  edit_signals: number;
  compliance_refusals: number;
  /** mean total tokens per generated draft — null until a priced or
   * token-bearing line exists. */
  mean_tokens: number | null;
  /** the week's priced spend, GBP; unpriced lines counted honestly. */
  spend_gbp: number;
  unpriced_lines: number;
}

export function computeLightPerformance(input: LightPerformanceInput): LightPerformance {
  const decided = input.stamped + input.rejected;
  let tokenSum = 0;
  let tokenLines = 0;
  let spend = 0;
  let unpriced = 0;
  for (const cost of input.cost_blocks) {
    const tokens = typeof cost?.tokens === "number" ? (cost.tokens as number) : null;
    if (tokens !== null) {
      tokenSum += tokens;
      tokenLines += 1;
    }
    const amount = pricedAmountGbp(cost);
    if (amount === null) unpriced += 1;
    else spend += amount;
  }
  return {
    drafts_generated: input.drafts_generated,
    approval_rate_pct: decided > 0 ? Math.round((input.stamped / decided) * 100) : null,
    stamped: input.stamped,
    rejected: input.rejected,
    edit_rate_pct: input.stamped > 0 ? Math.round((input.edit_signals / input.stamped) * 100) : null,
    edit_signals: input.edit_signals,
    compliance_refusals: input.compliance_refusals,
    mean_tokens: tokenLines > 0 ? Math.round(tokenSum / tokenLines) : null,
    spend_gbp: Math.round(spend * 100) / 100,
    unpriced_lines: unpriced,
  };
}
