import type { SupabaseClient } from "@supabase/supabase-js";
import { emitEvent } from "./events";
import { BILLING_EVENT_KINDS } from "./event-kinds";
import { PermanentGenerationError } from "./drafting";

/**
 * AI budget caps — Session 22, WS2 (founder pre-ruling 2b) and the
 * doctrine's budget line made real: "Soft cap warns; hard cap stops Light
 * and queues work with the reason visible."
 *
 * businesses.settings.ai_budget = { soft_cap: number, hard_cap: number } —
 * monthly, GBP, owner-set, both optional. Enforcement is SERVER-SIDE in the
 * drafting path (pre-ruled): the hard cap refuses GENERATION in the s15
 * provider-failure lane (a visible failed step naming the cap, never a
 * silent stub); workflow sends that need no generation continue; the
 * approval gate is untouched. The soft cap banners and events — it never
 * blocks anything.
 */

export interface AiBudget {
  soft_cap_gbp: number | null;
  hard_cap_gbp: number | null;
}

export function resolveAiBudget(settings: Record<string, unknown> | null | undefined): AiBudget {
  const budget = (settings?.ai_budget ?? {}) as Record<string, unknown>;
  const read = (key: string): number | null => {
    const value = budget[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  };
  return { soft_cap_gbp: read("soft_cap"), hard_cap_gbp: read("hard_cap") };
}

export interface BudgetAssessment {
  spend_gbp: number;
  soft_cap_gbp: number | null;
  hard_cap_gbp: number | null;
  soft_crossed: boolean;
  hard_crossed: boolean;
}

/** Pure: where does this month's metered spend stand against the caps? */
export function evaluateAiBudget(spendGbp: number, budget: AiBudget): BudgetAssessment {
  return {
    spend_gbp: spendGbp,
    soft_cap_gbp: budget.soft_cap_gbp,
    hard_cap_gbp: budget.hard_cap_gbp,
    soft_crossed: budget.soft_cap_gbp !== null && spendGbp >= budget.soft_cap_gbp,
    hard_crossed: budget.hard_cap_gbp !== null && spendGbp >= budget.hard_cap_gbp,
  };
}

/**
 * The hard-cap gate — called ONLY in the generative paths, immediately
 * before a model call. Throws in the s15 permanent-failure lane so the
 * refusal lands as a visible light.draft_generation_failed naming the cap
 * and the step fails loudly. A soft cap NEVER throws.
 */
export function guardGenerationBudget(spendGbp: number, budget: AiBudget): void {
  if (budget.hard_cap_gbp !== null && spendGbp >= budget.hard_cap_gbp) {
    throw new PermanentGenerationError(
      `the monthly AI hard cap is reached (£${spendGbp.toFixed(2)} of the £${budget.hard_cap_gbp.toFixed(2)} cap, owner-set in Billing & usage) — generation refuses; raise the cap or wait for the new month. Approved sends and template-path drafts continue.`
    );
  }
}

/** Pure: did this generation take the month's spend across the soft cap? */
export function softCapJustCrossed(beforeGbp: number, afterGbp: number, budget: AiBudget): boolean {
  return budget.soft_cap_gbp !== null && beforeGbp < budget.soft_cap_gbp && afterGbp >= budget.soft_cap_gbp;
}

/** The UTC calendar month window. JUDGMENT: billing months are UTC-bounded —
 * one clock for the meter, the caps and the events that record crossings. */
export function monthWindowUtc(now: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

/**
 * Session 23 (WS1d, founder-ruled): display precision that can EXPLAIN a
 * sub-penny position. The cap comparison itself always runs on RAW metered
 * amounts (evaluateAiBudget/guardGenerationBudget above — never on rounded
 * display values); this formatter exists so the display cannot contradict
 * the comparison: an amount under 1p shows 3 decimal places (falling back to
 * its first significant digits when even 3dp would read as zero), so a
 * £0.01 cap sitting beside £0.006 of spend is explicable at a glance rather
 * than rendering as "£0.01 of £0.01" while nothing has crossed.
 */
export function formatMeteredGbp(amount: number): string {
  if (!Number.isFinite(amount)) return "£0.00";
  const abs = Math.abs(amount);
  if (abs > 0 && abs < 0.01) {
    const threeDp = amount.toFixed(3);
    if (Number(threeDp) !== 0) return `£${threeDp}`;
    return `£${amount.toFixed(6).replace(/0+$/, "")}`;
  }
  return `£${amount.toFixed(abs >= 100 ? 0 : 2)}`;
}

/** A priced line's GBP amount, or null for a pre-s22 (unpriced) cost block —
 * an old line is shown as tokens, never retro-priced. */
export function pricedAmountGbp(cost: Record<string, unknown> | null | undefined): number | null {
  const amount = cost?.amount_gbp;
  return typeof amount === "number" && Number.isFinite(amount) ? amount : null;
}

export interface MonthSpend {
  priced_gbp: number;
  priced_lines: number;
  unpriced_lines: number;
}

/**
 * This month's metered spend from events.cost (the s15 producer's truth).
 * Bounded read (egress law 5e's spirit): cost blocks only, capped — a month
 * that somehow exceeds the bound reports itself in the close rather than
 * silently truncating the meter.
 */
export const MONTH_SPEND_ROW_BOUND = 5000;

export async function getMonthSpend(db: SupabaseClient, businessId: string, now: Date): Promise<MonthSpend> {
  const window = monthWindowUtc(now);
  const { data, error } = await db
    .from("events")
    .select("cost")
    .eq("business_id", businessId)
    .not("cost", "is", null)
    .gte("occurred_at", window.start)
    .lt("occurred_at", window.end)
    .limit(MONTH_SPEND_ROW_BOUND);
  if (error) throw new Error(`month spend query failed: ${error.message}`);
  let priced = 0;
  let pricedLines = 0;
  let unpriced = 0;
  for (const row of data ?? []) {
    const amount = pricedAmountGbp(row.cost as Record<string, unknown> | null);
    if (amount === null) unpriced += 1;
    else {
      priced += amount;
      pricedLines += 1;
    }
  }
  return { priced_gbp: priced, priced_lines: pricedLines, unpriced_lines: unpriced };
}

/** Read the budget + this month's spend for one business in one motion —
 * the drafting path's pre-generation check and the pages' banner truth. */
export async function assessAiBudget(
  db: SupabaseClient,
  businessId: string,
  now: Date = new Date()
): Promise<BudgetAssessment & { unpriced_lines: number }> {
  const { data: biz, error } = await db
    .from("businesses")
    .select("settings")
    .eq("id", businessId)
    .maybeSingle();
  if (error) throw new Error(`budget settings read failed: ${error.message}`);
  const budget = resolveAiBudget((biz?.settings ?? {}) as Record<string, unknown>);
  const spend = await getMonthSpend(db, businessId, now);
  return { ...evaluateAiBudget(spend.priced_gbp, budget), unpriced_lines: spend.unpriced_lines };
}

/**
 * Record a soft-cap crossing on The Record — once per business per month
 * (the append-only ledger holds the crossing, the pages render the banner
 * live from assessAiBudget). Never throws to its caller's drafting flow.
 */
export async function maybeEmitSoftCapCrossed(
  db: SupabaseClient,
  input: {
    business_id: string;
    actor_id: string;
    before_gbp: number;
    after_gbp: number;
    budget: AiBudget;
    now?: Date;
  }
): Promise<void> {
  if (!softCapJustCrossed(input.before_gbp, input.after_gbp, input.budget)) return;
  try {
    const window = monthWindowUtc(input.now ?? new Date());
    const { data: existing } = await db
      .from("events")
      .select("id")
      .eq("business_id", input.business_id)
      .eq("action", BILLING_EVENT_KINDS.softCapCrossed)
      .gte("occurred_at", window.start)
      .lt("occurred_at", window.end)
      .limit(1);
    if (existing && existing.length > 0) return;
    await emitEvent(db, {
      business_id: input.business_id,
      actor_id: input.actor_id,
      action: BILLING_EVENT_KINDS.softCapCrossed,
      entity_type: "business",
      entity_id: input.business_id,
      payload: {
        soft_cap_gbp: input.budget.soft_cap_gbp,
        spend_gbp: Math.round(input.after_gbp * 100) / 100,
      },
    });
  } catch {
    // The banner still renders from live truth; a bookkeeping miss here must
    // never fail a draft.
  }
}
