/**
 * The model router — Session 15 (PR-3), governed by LIGHT-OPERATING-DOCTRINE.
 *
 * ONE config module (model-agnosticism = one-line swap): every model id and
 * every routing constant Light spends through lives here. Route down,
 * escalate up: the floor is a FLOOR, not a ceiling; escalation is EARNED by
 * the task, per attempt, never sticky, and the reason lands on the credit
 * line (events.cost + the draft's credit_line attribute).
 *
 * Budgets are PROVISIONAL (the AUTO_CLOSE_POLICY precedent) — tuned from
 * live ledger data, not vibes; the numbers are provisional, the laws are not.
 */

/** Standard tier — the floor. Current Haiku-class model (founder-ruled PR-3). */
export const LIGHT_MODEL_FLOOR = {
  tier: "standard" as const,
  model: "claude-haiku-4-5",
};

/** Pro tier — escalation, earned by recorded trigger. Current Sonnet-class model. */
export const LIGHT_MODEL_ESCALATION = {
  tier: "pro" as const,
  model: "claude-sonnet-5",
};

/**
 * Context budgets per task class (doctrine: budgets are explicit, visible in
 * the credit line's metadata). Token counts are the assembly estimate
 * (~4 chars/token) — the cap is on what Light READS, not what it writes.
 */
export const DRAFT_CONTEXT_BUDGETS = {
  /** Assembled context beyond this earns escalation (recorded). */
  floor_tokens: 3000,
  /** Hard cap: assembly beyond this is an over-budget VISIBLE failure, never a trim-and-hope. */
  escalation_tokens: 9000,
  /** Task-scoped retrieval cap — never the whole pack. */
  max_pack_entries: 6,
  /** Output economy: a draft is a message, not an essay. */
  max_output_tokens: 1024,
};

/** Rough token estimate for budget arithmetic (~4 chars per token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Session 22 (WS2, ruling 2a) — pricing the meter. Our RECORDED cost, no
 * margin invented: the provider's published list rates for the two routed
 * models, held here in the ONE config module beside the model ids they
 * price. PROVISIONAL constants (the AUTO_CLOSE_POLICY precedent) — re-cut
 * when the provider's pricing page moves; the numbers are provisional, the
 * no-margin law is not.
 *
 * JUDGMENT: the provider bills in USD; the ruled display is the business's
 * currency (GBP for the pilot). The conversion is a pinned provisional rate,
 * recorded on every priced line (fx_rate) so each amount is auditable
 * against the rate that produced it.
 */
export const MODEL_PRICING_USD_PER_MTOK: Record<
  string,
  { input: number; output: number; cache_read: number; cache_write: number }
> = {
  [LIGHT_MODEL_FLOOR.model]: { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
  [LIGHT_MODEL_ESCALATION.model]: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
};

export const USD_TO_GBP_RATE = 0.79;

export interface GenerationPrice {
  amount_usd: number;
  amount_gbp: number;
  fx_rate: number;
}

/** Price one generation from its recorded usage. Returns null for a model
 * the table does not know — an unpriced line stays honestly unpriced, never
 * guessed. Amounts are rounded to 6 dp (fractions of a penny are real at
 * these magnitudes). */
export function priceGeneration(input: {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}): GenerationPrice | null {
  const rates = MODEL_PRICING_USD_PER_MTOK[input.model];
  if (!rates) return null;
  const usd =
    (input.input_tokens / 1_000_000) * rates.input +
    (input.output_tokens / 1_000_000) * rates.output +
    ((input.cache_read_tokens ?? 0) / 1_000_000) * rates.cache_read +
    ((input.cache_write_tokens ?? 0) / 1_000_000) * rates.cache_write;
  const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
  return { amount_usd: round6(usd), amount_gbp: round6(usd * USD_TO_GBP_RATE), fx_rate: USD_TO_GBP_RATE };
}

export interface EscalationDecision {
  tier: "standard" | "pro";
  model: string;
  /** The recorded reason — "floor" when no trigger fired. */
  reason: string;
}

/**
 * Escalation triggers (PR-3, recorded on the credit line):
 *   - no-go proximity in the lead's question — the lead's OWN words steer
 *     toward guarantee/outcome/fee/timescale territory, where the no-go
 *     rules bite hardest;
 *   - a multi-route situation — more than one visa route matched;
 *   - assembled context beyond the floor budget.
 * Detection reads what the lead SAID — never who the model thinks they are
 * (no demographic inference, ever).
 */
const NO_GO_PROXIMITY = /\b(guarantee|guaranteed|promise|promised|100\s*%|certain|assure|assurance|refus\w*|reject\w*|appeal\w*|deadline|urgent\w*|how\s+long|how\s+much|timescale|fee|fees|cost|costs|price|charges?)\b/i;

export function resolveEscalation(input: {
  leadText: string;
  routeMatches: number;
  contextTokens: number;
}): EscalationDecision {
  if (NO_GO_PROXIMITY.test(input.leadText)) {
    return { ...LIGHT_MODEL_ESCALATION, reason: "no-go proximity in the lead's question" };
  }
  if (input.routeMatches > 1) {
    return { ...LIGHT_MODEL_ESCALATION, reason: "multi-route situation" };
  }
  if (input.contextTokens > DRAFT_CONTEXT_BUDGETS.floor_tokens) {
    return { ...LIGHT_MODEL_ESCALATION, reason: "assembled context beyond the floor budget" };
  }
  return { ...LIGHT_MODEL_FLOOR, reason: "floor" };
}
