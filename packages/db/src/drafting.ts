import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DRAFT_CONTEXT_BUDGETS,
  estimateTokens,
  resolveEscalation,
  type EscalationDecision,
} from "./model-router";
import type { FormAnswer } from "./meta";
import { substituteBookingLink } from "./booking-link";

/**
 * The query-aware drafting engine (Session 15). Light composes against:
 *   (a) the lead's form answers + enquiry row — what the lead SAID, never
 *       what a model infers about who they are;
 *   (b) task-scoped PUBLISHED knowledge entries (PR-1) — selected by
 *       category relevance and route match, never the whole pack, ids
 *       recorded for the credit line and draft_feedback;
 *   (c) the installed template's register — neutral greeting (decision 97),
 *       client-facing subject law (decision 98), British English;
 *   (d) the no-go rules IN the generation prompt (belt) — the 0026
 *       pre-flight is the braces.
 *
 * The provider call is injected (GenerateFn) so the engine is testable
 * without a credential and provider-agnostic at the seam; the real
 * generator is the official Anthropic SDK (PR-3 — ANTHROPIC_API_KEY, env
 * var only, never committed, never logged).
 */

export interface KnowledgeEntry {
  id: string;
  title: string;
  category: string;
  visa_route: string | null;
  text: string;
}

export interface RetrievalResult {
  entries: KnowledgeEntry[];
  /** Route keys the lead's own words matched (deterministic vocabulary match). */
  route_matches: string[];
}

/** Deterministic route matching: the lead's words against the declared route
 * vocabulary (0024). A lookup, not an inference. */
const ROUTE_MATCHERS: Array<{ key: string; pattern: RegExp }> = [
  { key: "skilled_worker", pattern: /skilled\s*worker|work\s*visa|sponsor(ship)?\s*(licence|license)?|cos\b/i },
  { key: "spouse_family", pattern: /spouse|partner|marriage|married|fianc|family\s*visa|dependant|dependent/i },
  { key: "ilr", pattern: /\bilr\b|indefinite\s*leave|settlement(?!\s*status)/i },
  { key: "naturalisation", pattern: /naturalis|naturaliz|citizenship|british\s*citizen/i },
  { key: "student", pattern: /student|study|tier\s*4|cas\b/i },
  { key: "visitor", pattern: /visit(or|ing)?\s*(visa)?|tourist/i },
  { key: "euss", pattern: /\beuss\b|settled\s*status|pre-?settled/i },
  { key: "asylum_human_rights", pattern: /asylum|human\s*rights|article\s*8|protection/i },
  { key: "appeals", pattern: /appeal|tribunal|refused|refusal|reconsideration/i },
];

export function matchRoutes(leadText: string): string[] {
  return ROUTE_MATCHERS.filter((m) => m.pattern.test(leadText)).map((m) => m.key);
}

function entryText(body: unknown): string {
  if (!Array.isArray(body)) return typeof body === "string" ? body : "";
  return body
    .map((block) => (block && typeof block === "object" && "text" in block ? String((block as { text: unknown }).text ?? "") : ""))
    .filter((t) => t.trim() !== "")
    .join("\n");
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "have", "from", "what", "your",
  "about", "would", "could", "please", "hello", "there", "been", "will", "them",
]);

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length > 3 && !STOP_WORDS.has(w))
  );
}

/**
 * Task-scoped SELECTION (pure, smoke-testable): which of the published
 * entries this draft may read, by category relevance and route match —
 * capped at DRAFT_CONTEXT_BUDGETS.max_pack_entries, never the whole pack.
 */
export function selectKnowledgeEntries(all: KnowledgeEntry[], leadText: string): RetrievalResult {
  const routeMatches = matchRoutes(leadText);
  const byCategory = (category: string) => all.filter((e) => e.category === category);

  // Priority order: the route's service description, then fees and booking
  // policy (rule 3's published amounts live here), then tone, then the two
  // most word-relevant FAQ entries.
  const selected: KnowledgeEntry[] = [];
  const seen = new Set<string>();
  const take = (entries: KnowledgeEntry[]) => {
    for (const entry of entries) {
      if (selected.length >= DRAFT_CONTEXT_BUDGETS.max_pack_entries) return;
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      selected.push(entry);
    }
  };

  take(byCategory("service_description").filter((e) => e.visa_route && routeMatches.includes(e.visa_route)));
  take(byCategory("published_fees"));
  take(byCategory("consultation_booking_policy"));
  take(byCategory("tone_exemplar").slice(0, 2));

  const leadWords = significantWords(leadText);
  const rankedFaq = byCategory("faq")
    .map((entry) => {
      const words = significantWords(`${entry.title} ${entry.text}`);
      let overlap = 0;
      for (const w of leadWords) if (words.has(w)) overlap += 1;
      return { entry, overlap };
    })
    .filter((r) => r.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 2)
    .map((r) => r.entry);
  take(rankedFaq);

  return { entries: selected, route_matches: routeMatches };
}

/**
 * Task-scoped retrieval (LIGHT-OPERATING-DOCTRINE: assemble, never dump).
 * Only PUBLISHED entries are readable; selection is the pure function above.
 */
export async function retrieveKnowledgeEntries(
  db: SupabaseClient,
  businessId: string,
  leadText: string
): Promise<RetrievalResult> {
  const { data, error } = await db
    .from("content_items")
    .select("id, title, body, attributes")
    .eq("business_id", businessId)
    .eq("content_type", "knowledge_entry")
    .eq("state", "published")
    .is("archived_at", null);
  if (error) throw new Error(`knowledge retrieval failed: ${error.message}`);

  const all = (data ?? []).map((row) => {
    const attrs = (row.attributes ?? {}) as Record<string, unknown>;
    return {
      id: row.id as string,
      title: row.title as string,
      category: String(attrs.knowledge_category ?? ""),
      visa_route: attrs.visa_route ? String(attrs.visa_route) : null,
      text: entryText(row.body),
    } satisfies KnowledgeEntry;
  });

  return selectKnowledgeEntries(all, leadText);
}

export interface DraftAttestation {
  attested: boolean;
  mode: "generated" | "approved_template";
  model?: string;
  statement: string;
}

/**
 * Session 27 (D158c): the returning-lead register — the prompt acknowledges
 * prior contact, references the route, and forbids the cold introduction and
 * any re-offer of an already-sent guide. Carried by both composers.
 */
export interface ReturningContext {
  /** The route label (or key) of the contact's prior enquiry, when known. */
  prior_route: string | null;
  form_label: string | null;
  resubmitted_at: string;
  /** Human-readable changed-detail lines from the marker's diff. */
  changed_lines: string[];
  /** True when the firm's guide document already reached this contact —
   * the draft must never offer or promise to send it again (no duplicate
   * booklet). */
  booklet_already_sent: boolean;
}

/** Session 27 (D161b): classification rides the existing drafting call —
 * the caller passes the declared route vocabulary when the enquiry's route
 * is unset or default-sourced, and the model's ONE response carries a
 * confident key or an honest null. No extra model call, ever. */
export interface RouteClassifyOption {
  key: string;
  label: string;
}

function returningRegisterLines(returning: ReturningContext): string[] {
  return [
    `- This enquirer has contacted the firm before${returning.prior_route ? ` about ${returning.prior_route}` : ""} and has just submitted the ${returning.form_label ?? "enquiry form"} again. Acknowledge their earlier contact naturally, in one phrase.`,
    `- Never introduce the firm as if this were first contact. No cold introduction, no "thank you for your enquiry" opening as though they were new.`,
    ...(returning.booklet_already_sent
      ? [
          `- The firm's guide document has already been sent to this enquirer. Never offer, promise or mention sending it again.`,
        ]
      : []),
  ];
}

function returningFactsBlock(returning: ReturningContext): string[] {
  return [
    ``,
    `Returning enquirer: submitted the ${returning.form_label ?? "enquiry form"} again on ${returning.resubmitted_at}.`,
    ...(returning.changed_lines.length
      ? [`Details changed since their previous submission:`, ...returning.changed_lines.map((l) => `- ${l}`)]
      : [`No details changed since their previous submission.`]),
  ];
}

function classificationInstruction(options: RouteClassifyOption[]): string {
  const keys = options.map((o) => `${o.key} (${o.label})`).join(", ");
  return `Separately from the message body, classify this enquiry's visa route in the "route" output field: set route.key to ONE of ${keys} only if the form and the enquirer's own words give you a confident read; otherwise set route.key to null. State your one-line reason either way. The classification never appears in the message body.`;
}

export interface GenerateRequest {
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
  /** PR-E (decision 133f): when present these replace `system` — ordered
   * blocks whose cache-marked prefix bills cached-input rates on
   * regenerations. The thread tail and fresh inbound stay in `prompt`,
   * uncached. */
  systemBlocks?: Array<{ text: string; cache?: boolean }>;
}

export interface GenerateResult {
  subject: string | null;
  body: string;
  attestation: { attested: boolean; statement: string };
  usage: { input_tokens: number; output_tokens: number };
  /** PR-E: cache read/written tokens from the SDK's usage fields, plus the
   * recorded reason when the provider rejected cache_control and the call
   * fell back uncached — a draft never fails over caching. */
  cache?: { read_tokens: number; written_tokens: number; fallback_reason?: string };
  /** Session 27 (D161b): the route classification riding the SAME call's
   * output — a confident key from the declared vocabulary, or null. */
  route?: { key: string | null; reason: string } | null;
}

export type GenerateFn = (request: GenerateRequest) => Promise<GenerateResult>;

/** A provider failure that should RETRY on a later tick (rate limit,
 * overload, network) — the step stays claimable, nothing completes. */
export class TransientGenerationError extends Error {}
/** A failure no retry will fix (bad credential, over-budget assembly,
 * malformed output twice) — the step fails VISIBLY with the reason. */
export class PermanentGenerationError extends Error {}
/** Session 25: the register screen's own refusal (em/en dash in a generated
 * body). Still permanent for the classifier — no lease retry — but the
 * CALLER retries exactly once with the violation fed back into the
 * regeneration prompt (evented), before a second breach stands visible.
 * Carries the failed attempt's provider usage so metering stays honest. */
export class RegisterBreachError extends PermanentGenerationError {
  constructor(
    public readonly breach: "em dash" | "en dash",
    message: string,
    public readonly usage: { input_tokens: number; output_tokens: number }
  ) {
    super(message);
  }
}

/**
 * Session 25 (founder-ordered): the register retry-once, shared by both
 * drafting callers. A register-screen breach retries exactly ONCE with the
 * violation fed back into the regeneration prompt; `onRetry` runs BEFORE the
 * second attempt so the caller can put the retry on The Record whatever the
 * outcome. Any second failure — register or otherwise — propagates untouched
 * to the caller's visible-failure lane. One retry, never a loop.
 */
export async function composeWithRegisterRetry<TIn>(
  compose: (input: TIn, options: { feedback?: string }) => Promise<ComposeDraftResult>,
  input: TIn,
  onRetry: (breach: RegisterBreachError) => Promise<void>
): Promise<{ composed: ComposeDraftResult; registerRetried: boolean }> {
  try {
    return { composed: await compose(input, {}), registerRetried: false };
  } catch (err) {
    if (!(err instanceof RegisterBreachError)) throw err;
    await onRetry(err);
    const retried = await compose(input, { feedback: err.message });
    const credit = {
      ...retried.credit_line,
      register_retry: err.breach,
    } as ComposeDraftResult["credit_line"];
    return {
      composed: {
        ...retried,
        credit_line: credit,
        // Both attempts are metered spend — the refused attempt's tokens are
        // priced too.
        usage: {
          input_tokens: retried.usage.input_tokens + err.usage.input_tokens,
          output_tokens: retried.usage.output_tokens + err.usage.output_tokens,
        },
      },
      registerRetried: true,
    };
  }
}

export interface ComposeDraftInput {
  business_name: string;
  /** The firm's configured email sign-off (founder-ruled, Session 15 close
   * review): a business-identity value, default = the firm's display name —
   * never the owner's personal name, never hardcoded. */
  sign_off: string;
  first_name: string;
  full_name: string;
  channel: string;
  /** intro | nudge — from the workflow step's template key. */
  task: "intro" | "nudge";
  enquiry_title: string;
  stage_label: string;
  source: string;
  form_answers: FormAnswer[];
  no_go_rules: string[];
  retrieval: RetrievalResult;
  /** PR-iv (Session 19): the firm's configured booking URL. When set, the
   * prompt invites the literal [link] token and composition substitutes the
   * real URL into the stored body — WYSIWYS holds. When null, no [link] may
   * survive composition. */
  booking_url?: string | null;
  /** PR-i (Session 19): the route-matched PUBLISHED guide that will ride the
   * email — the prompt may reference it naturally. Null = no guide published
   * for this route: the draft never mentions one (no placeholders, ever). */
  attachment?: { title: string; filename: string } | null;
  /** Session 27 (D158c): the returning-lead register, when this enquirer is
   * a returning contact. */
  returning?: ReturningContext | null;
  /** Session 27 (D161b): pass the declared vocabulary to request route
   * classification riding this call's output; omit to request none. */
  route_options?: RouteClassifyOption[] | null;
}

export interface ComposeDraftResult {
  subject: string | null;
  body: string;
  attestation: DraftAttestation;
  credit_line: {
    tier: "standard" | "pro";
    model: string;
    reason: string;
    context_tokens: number;
    budget_tokens: number;
    knowledge_entry_ids: string[];
    /** PR-E: "cache: X read / Y written" on the credit line; the fallback
     * reason is recorded when the API rejected cache_control. */
    cache?: { read_tokens: number; written_tokens: number; fallback_reason?: string };
  };
  usage: { input_tokens: number; output_tokens: number };
  /** Session 27 (D161b): present only when the caller requested
   * classification (route_options); a key outside the passed vocabulary is
   * normalised to null — an undeclared route is never written. */
  route_classification: { key: string | null; reason: string } | null;
}

/** Normalise the model's route read against the requested vocabulary —
 * pure, harness-proven: no options = no classification; an undeclared key
 * never survives. */
export function normaliseRouteClassification(
  options: RouteClassifyOption[] | null | undefined,
  route: { key: string | null; reason: string } | null | undefined
): { key: string | null; reason: string } | null {
  if (!options || options.length === 0) return null;
  if (!route) return { key: null, reason: "the model returned no classification" };
  if (route.key !== null && !options.some((o) => o.key === route.key)) {
    return { key: null, reason: `undeclared route "${route.key}" refused — ${route.reason}` };
  }
  return { key: route.key, reason: route.reason };
}

/** The lead's own words, flattened for escalation triggers and retrieval. */
export function leadTextFromAnswers(answers: FormAnswer[]): string {
  return answers.map((a) => `${a.label}: ${a.value}`).join("\n");
}

/**
 * The register rule (Session 18, founder-ruled): no em or en dashes in
 * client-facing drafted copy — the generation prompt instructs commas and
 * full stops, and a generated body that slips one anyway is refused by the
 * output screen beside the braces check. Scope is machine-drafted bodies
 * only (email + WhatsApp free-form); human-authored text is never screened —
 * humans punctuate as they wish.
 */
export function findRegisterBreach(body: string): "em dash" | "en dash" | null {
  if (body.includes("—")) return "em dash";
  if (body.includes("–")) return "en dash";
  return null;
}

/** The prompt line both generation registers carry — written without the
 * forbidden marks so the instruction never exemplifies the breach. */
export const REGISTER_PUNCTUATION_LINE =
  "- Never use an em dash or an en dash anywhere in the draft; punctuate with commas and full stops instead.";

function assemblePrompt(input: ComposeDraftInput): { system: string; prompt: string } {
  const rules = input.no_go_rules.map((r, i) => `${i + 1}. ${r}`).join("\n");
  const system = [
    `You are Light, the assistant at ${input.business_name}, a UK immigration advisory firm. You are drafting a short, professional ${input.returning ? "reply to a RETURNING enquirer who has submitted the firm's enquiry form again" : input.task === "intro" ? "first reply to a new enquiry" : "gentle follow-up to an enquiry that has not yet replied"} for the firm to review and send by ${input.channel}.`,
    ``,
    `Laws that bind this draft — breaching any is a failure:`,
    rules,
    ``,
    `Register:`,
    `- Address the enquirer's actual situation using ONLY the firm's published knowledge provided. Never invent services, availability, or claims.`,
    `- Never state or quote any fee amount that does not appear verbatim in the provided published knowledge.`,
    `- If the enquirer asks for a guarantee, a promised outcome, or a Home Office timescale commitment, decline plainly and honestly — no honest adviser can promise an outcome — and steer to a consultation.`,
    `- Open with exactly: "Hello ${input.first_name}," — nothing warmer, nothing inferred.`,
    `- British English. Plain text only. Brief — a few short sentences; say less.`,
    REGISTER_PUNCTUATION_LINE,
    ...(input.booking_url
      ? [
          `- The firm has a booking page. Where you invite a consultation, offer it by writing the token [link] exactly (it becomes the booking URL); never write any other URL and never invent one.`,
        ]
      : []),
    ...(input.attachment
      ? [
          `- The firm's guide "${input.attachment.title}" (${input.attachment.filename}) is attached to this email. Mention the attached guide in one natural phrase; never describe its contents beyond its title.`,
        ]
      : [
          // D159 (Session 27): the honesty instruction — the deterministic
          // pre-flight (0043) is the braces; this line is the belt.
          `- Nothing is attached to this message. Never write that anything is attached or enclosed, and never promise a document you are not sending.`,
        ]),
    ...(input.returning ? returningRegisterLines(input.returning) : []),
    `- Sign off as "${input.sign_off}" — the firm's configured sign-off; never any other name.`,
    ``,
    ...(input.route_options?.length ? [classificationInstruction(input.route_options), ``] : []),
    `Attest honestly: attested is true only if the draft fully complies with every law above.`,
  ].join("\n");

  const answers = input.form_answers.length
    ? input.form_answers.map((a) => `- ${a.label}: ${a.value}`).join("\n")
    : "- (no form answers on file)";
  const knowledge = input.retrieval.entries.length
    ? input.retrieval.entries
        .map((e) => `### ${e.title} [${e.category}${e.visa_route ? ` · ${e.visa_route}` : ""}]\n${e.text}`)
        .join("\n\n")
    : "(the firm has published no knowledge entries yet — keep to generalities and the consultation invitation)";

  const prompt = [
    `The enquiry:`,
    `- Enquirer: ${input.full_name}`,
    `- Enquiry: ${input.enquiry_title} (stage: ${input.stage_label}; source: ${input.source})`,
    `- Their form answers, verbatim:`,
    answers,
    ...(input.returning ? returningFactsBlock(input.returning) : []),
    ``,
    `The firm's published knowledge (your only source of facts):`,
    knowledge,
    ``,
    `Compose the ${input.returning ? "returning-enquirer reply" : input.task === "intro" ? "first reply" : "follow-up"} now.`,
  ].join("\n");

  return { system, prompt };
}

/**
 * Compose one draft: assemble task-scoped context, resolve the routing tier
 * (escalation earned and recorded), call the provider once, screen the
 * output shape. The doctrine's retry-once rule lives in the caller's no-go
 * loop (workflow.ts): a breach found by heuristics retries once at the same
 * tier with the failure fed back before anything escalates.
 */
export async function composeDraft(
  generate: GenerateFn,
  input: ComposeDraftInput,
  options: { escalationOverride?: EscalationDecision; feedback?: string } = {}
): Promise<ComposeDraftResult> {
  const { system, prompt } = assemblePrompt(input);
  const feedbackSuffix = options.feedback
    ? `\n\nYour previous attempt failed the firm's compliance screen: ${options.feedback}. Redraft so the failure cannot recur.`
    : "";
  const contextTokens = estimateTokens(system + prompt + feedbackSuffix);

  if (contextTokens > DRAFT_CONTEXT_BUDGETS.escalation_tokens) {
    throw new PermanentGenerationError(
      `assembled context (${contextTokens} tokens) exceeds the hard budget (${DRAFT_CONTEXT_BUDGETS.escalation_tokens}) — over-budget assembly is a visible failure, never a trim-and-hope`
    );
  }

  const decision =
    options.escalationOverride ??
    resolveEscalation({
      leadText: leadTextFromAnswers(input.form_answers),
      routeMatches: input.retrieval.route_matches.length,
      contextTokens,
    });

  const result = await generate({
    model: decision.model,
    system,
    prompt: prompt + feedbackSuffix,
    maxTokens: DRAFT_CONTEXT_BUDGETS.max_output_tokens,
  });

  const body = result.body?.trim();
  if (!body) {
    throw new PermanentGenerationError("the provider returned an empty draft body");
  }
  if (/\{\{|\}\}/.test(body)) {
    throw new PermanentGenerationError("the generated body carries unresolved template braces");
  }
  // JUDGMENT: the Session 18 register rule lands as an output screen in the
  // braces-check lane (a permanent, visible refusal) — that is what makes
  // "a drafted body containing an em or en dash fails the harness" true in
  // production, not only in a test's own assertion. Session 25: the breach
  // throws its own class so the caller can retry once with feedback.
  const registerBreach = findRegisterBreach(body);
  if (registerBreach) {
    throw new RegisterBreachError(
      registerBreach,
      `the generated body contains an ${registerBreach} — the client-facing register uses commas and full stops (Session 18)`,
      result.usage
    );
  }

  // PR-iv (Session 19): the [link] token becomes the real booking URL in the
  // STORED body — the stamp approves the exact words, URL included. A token
  // with no configured URL is a visible composition failure, never a literal
  // "[link]" in a client's inbox.
  let finalBody: string;
  try {
    finalBody = substituteBookingLink(body, input.booking_url ?? null);
  } catch (err) {
    throw new PermanentGenerationError(err instanceof Error ? err.message : String(err));
  }

  return {
    subject: result.subject?.trim() || null,
    body: finalBody,
    attestation: {
      attested: result.attestation.attested === true,
      mode: "generated",
      model: decision.model,
      statement: String(result.attestation.statement ?? ""),
    },
    credit_line: {
      tier: decision.tier,
      model: decision.model,
      reason: decision.reason,
      context_tokens: contextTokens,
      budget_tokens:
        decision.tier === "standard"
          ? DRAFT_CONTEXT_BUDGETS.floor_tokens
          : DRAFT_CONTEXT_BUDGETS.escalation_tokens,
      knowledge_entry_ids: input.retrieval.entries.map((e) => e.id),
      ...(result.cache ? { cache: result.cache } : {}),
    },
    usage: result.usage,
    route_classification: normaliseRouteClassification(input.route_options, result.route),
  };
}

/** One message of the thread as the reply engine reads it — only what the
 * client actually saw or said. */
export interface ThreadMessage {
  role: "client" | "firm";
  body: string;
  at: string;
  channel: string;
}

export interface ComposeReplyInput {
  business_name: string;
  sign_off: string;
  first_name: string;
  full_name: string;
  channel: string;
  enquiry_title: string;
  stage_label: string;
  form_answers: FormAnswer[];
  no_go_rules: string[];
  retrieval: RetrievalResult;
  /** PR-iv (Session 19): the firm's configured booking URL — same law as
   * ComposeDraftInput. */
  booking_url?: string | null;
  /** Full thread context (decision 133a: the newest complete picture) —
   * chronological, sent-and-received only. */
  thread_messages: ThreadMessage[];
  /** How many client messages arrived since the last firm reply (the burst). */
  new_inbound_count: number;
  /** Session 27 (D158c): the returning-lead register — the settled marker's
   * facts; the reply acknowledges prior contact, no cold intro, no
   * duplicate booklet. */
  returning?: ReturningContext | null;
  /** Session 27 (D161b): classification riding this call's output. */
  route_options?: RouteClassifyOption[] | null;
}

/**
 * The reply register (PR-D, decision 133d): answer what the inbound actually
 * asked — generalities are lawful, case-specific advice never (no-go rule
 * 2); a consultation is invited only where the answer genuinely needs one,
 * per the published booking policy when one exists in the pack.
 *
 * PR-E: the prompt is assembled as a STABLE PREFIX (identity, laws,
 * register, tone exemplars, selected pack entries — cache-marked system
 * blocks) plus an UNCACHED tail (the thread transcript and fresh inbound),
 * so a burst's regenerations bill cached-input rates.
 */
export function assembleReplyPrompt(input: ComposeReplyInput): {
  systemBlocks: Array<{ text: string; cache?: boolean }>;
  prompt: string;
} {
  const rules = input.no_go_rules.map((r, i) => `${i + 1}. ${r}`).join("\n");
  const lawsBlock = [
    `You are Light, the assistant at ${input.business_name}, a UK immigration advisory firm. You are drafting a reply to a client's message(s) on an existing ${input.channel} conversation, for the firm to review, stamp and send.`,
    ``,
    `Laws that bind this draft — breaching any is a failure:`,
    rules,
    ``,
    `The reply register:`,
    `- Answer what the client's message actually asked. Generalities about process and the firm's published services are lawful; case-specific legal advice is never given in a draft — that happens in consultations with the humans.`,
    `- Use ONLY the firm's published knowledge provided. Never invent services, availability, fees or claims.`,
    `- Never state or quote any fee amount that does not appear verbatim in the provided published knowledge.`,
    `- If the client asks for a guarantee, a promised outcome, or a Home Office timescale commitment, decline plainly and honestly — no honest adviser can promise an outcome.`,
    `- Invite a consultation ONLY where the answer genuinely needs one — never as a reflex; follow the published booking policy where one is provided.`,
    ...(input.booking_url
      ? [
          `- The firm has a booking page. Where a consultation is genuinely invited, offer it by writing the token [link] exactly (it becomes the booking URL); never write any other URL and never invent one.`,
        ]
      : []),
    `- Open with exactly: "Hello ${input.first_name}," — nothing warmer, nothing inferred.`,
    `- British English. Plain text only. Brief — answer, then stop.`,
    REGISTER_PUNCTUATION_LINE,
    `- Sign off as "${input.sign_off}" — the firm's configured sign-off; never any other name.`,
    ``,
    `Attest honestly: attested is true only if the draft fully complies with every law above.`,
  ].join("\n");

  const knowledge = input.retrieval.entries.length
    ? input.retrieval.entries
        .map((e) => `### ${e.title} [${e.category}${e.visa_route ? ` · ${e.visa_route}` : ""}]\n${e.text}`)
        .join("\n\n")
    : "(the firm has published no knowledge entries yet — keep to generalities and invite a consultation only if genuinely needed)";
  const knowledgeBlock = `The firm's published knowledge (your only source of facts):\n\n${knowledge}`;

  const answers = input.form_answers.length
    ? input.form_answers.map((a) => `- ${a.label}: ${a.value}`).join("\n")
    : "- (no form answers on file)";
  const transcript = input.thread_messages.length
    ? input.thread_messages
        .map((m) => `[${m.at} · ${m.role === "client" ? "CLIENT" : "FIRM"}] ${m.body}`)
        .join("\n---\n")
    : "(no prior messages)";

  // Session 27 (D158c): the returning register and facts ride the UNCACHED
  // tail — they vary per thread; the cached prefix (laws + knowledge) stays
  // stable. Same for the classification instruction (D161b).
  const prompt = [
    `The enquiry: ${input.enquiry_title} (client: ${input.full_name}; stage: ${input.stage_label})`,
    `Their original enquiry form answers, verbatim:`,
    answers,
    ...(input.returning
      ? [``, `Returning-enquirer register — these lines bind this reply:`, ...returningRegisterLines(input.returning), ...returningFactsBlock(input.returning)]
      : []),
    ``,
    `The conversation so far (oldest first; only messages actually sent or received):`,
    transcript,
    ``,
    ...(input.route_options?.length ? [classificationInstruction(input.route_options), ``] : []),
    input.returning && input.new_inbound_count === 0
      ? `The client has not written a new message; their returning form submission (above) is what needs answering. Compose the firm's returning-enquirer reply now.`
      : `The client's last ${input.new_inbound_count > 1 ? `${input.new_inbound_count} messages have` : "message has"} not been answered. Compose the firm's reply now — answer what was actually asked.`,
  ].join("\n");

  return {
    systemBlocks: [
      { text: lawsBlock, cache: true },
      { text: knowledgeBlock, cache: true },
    ],
    prompt,
  };
}

/**
 * Compose one reply draft against the full thread (decision 133a/d).
 * Routing, budgets, output screening and the caller-side retry-once rule
 * all match composeDraft; the burst text (the unanswered client messages)
 * drives escalation triggers and retrieval.
 */
export async function composeReplyDraft(
  generate: GenerateFn,
  input: ComposeReplyInput,
  options: { escalationOverride?: EscalationDecision; feedback?: string } = {}
): Promise<ComposeDraftResult> {
  const { systemBlocks, prompt } = assembleReplyPrompt(input);
  const feedbackSuffix = options.feedback
    ? `\n\nYour previous attempt failed the firm's compliance screen: ${options.feedback}. Redraft so the failure cannot recur.`
    : "";
  const allText = systemBlocks.map((b) => b.text).join("\n") + prompt + feedbackSuffix;
  const contextTokens = estimateTokens(allText);

  if (contextTokens > DRAFT_CONTEXT_BUDGETS.escalation_tokens) {
    throw new PermanentGenerationError(
      `assembled context (${contextTokens} tokens) exceeds the hard budget (${DRAFT_CONTEXT_BUDGETS.escalation_tokens}) — over-budget assembly is a visible failure, never a trim-and-hope`
    );
  }

  const burstText = input.thread_messages
    .filter((m) => m.role === "client")
    .slice(-Math.max(1, input.new_inbound_count))
    .map((m) => m.body)
    .join("\n");
  const decision =
    options.escalationOverride ??
    resolveEscalation({
      leadText: burstText,
      routeMatches: input.retrieval.route_matches.length,
      contextTokens,
    });

  const result = await generate({
    model: decision.model,
    system: systemBlocks.map((b) => b.text).join("\n\n"),
    systemBlocks,
    prompt: prompt + feedbackSuffix,
    maxTokens: DRAFT_CONTEXT_BUDGETS.max_output_tokens,
  });

  const body = result.body?.trim();
  if (!body) {
    throw new PermanentGenerationError("the provider returned an empty draft body");
  }
  if (/\{\{|\}\}/.test(body)) {
    throw new PermanentGenerationError("the generated body carries unresolved template braces");
  }
  // Session 18 register rule — same screen, same lane as composeDraft's
  // (Session 25: the breach class carries the retry-once contract).
  const registerBreach = findRegisterBreach(body);
  if (registerBreach) {
    throw new RegisterBreachError(
      registerBreach,
      `the generated body contains an ${registerBreach} — the client-facing register uses commas and full stops (Session 18)`,
      result.usage
    );
  }

  // PR-iv (Session 19): same booking-link law as composeDraft.
  let finalBody: string;
  try {
    finalBody = substituteBookingLink(body, input.booking_url ?? null);
  } catch (err) {
    throw new PermanentGenerationError(err instanceof Error ? err.message : String(err));
  }

  return {
    subject: result.subject?.trim() || null,
    body: finalBody,
    attestation: {
      attested: result.attestation.attested === true,
      mode: "generated",
      model: decision.model,
      statement: String(result.attestation.statement ?? ""),
    },
    credit_line: {
      tier: decision.tier,
      model: decision.model,
      reason: decision.reason,
      context_tokens: contextTokens,
      budget_tokens:
        decision.tier === "standard"
          ? DRAFT_CONTEXT_BUDGETS.floor_tokens
          : DRAFT_CONTEXT_BUDGETS.escalation_tokens,
      knowledge_entry_ids: input.retrieval.entries.map((e) => e.id),
      ...(result.cache ? { cache: result.cache } : {}),
    },
    usage: result.usage,
    route_classification: normaliseRouteClassification(input.route_options, result.route),
  };
}

const DRAFT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    subject: {
      type: ["string", "null"],
      description: "A short client-facing email subject, or null for channels without one.",
    },
    body: { type: "string", description: "The message body, plain text, exactly as it will be sent." },
    attestation: {
      type: "object",
      properties: {
        attested: {
          type: "boolean",
          description: "True ONLY if the body fully complies with every no-go rule and register law.",
        },
        statement: { type: "string", description: "One sentence: what was checked and the honest verdict." },
      },
      required: ["attested", "statement"],
      additionalProperties: false,
    },
    // Session 27 (D161b): classification rides THIS call's output — no
    // extra model call exists anywhere. key is null unless the prompt asked
    // for a classification and the read is confident.
    route: {
      type: "object",
      properties: {
        key: {
          type: ["string", "null"],
          description:
            "The enquiry's visa route from the offered vocabulary, ONLY when the prompt requested classification and the read is confident; otherwise null.",
        },
        reason: { type: "string", description: "One line: why this key, or why no confident read." },
      },
      required: ["key", "reason"],
      additionalProperties: false,
    },
  },
  required: ["subject", "body", "attestation", "route"],
  additionalProperties: false,
};

/**
 * The real provider (PR-3): the official Anthropic SDK, key from
 * ANTHROPIC_API_KEY only — never committed, never logged. Returns null when
 * unconfigured (the graph.ts carrier-absent pattern); the CALLER decides
 * what an absent provider means (for drafting: a visible failure, never a
 * silent stub fallback).
 */
export function createAnthropicGenerator(): GenerateFn | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  return async (request: GenerateRequest): Promise<GenerateResult> => {
    // Imported lazily so environments without the key never load the SDK.
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });

    // PR-E (decision 133f): cache-mark the stable prefix via system blocks;
    // the thread tail stays uncached in the user message. If the API rejects
    // cache_control for any reason, fall back to an uncached call with the
    // reason recorded — never fail a draft over caching.
    const cachedSystem = request.systemBlocks?.map((b) => ({
      type: "text" as const,
      text: b.text,
      ...(b.cache ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));

    let cacheFallbackReason: string | undefined;
    const call = (system: string | typeof cachedSystem) =>
      client.messages.create({
        model: request.model,
        max_tokens: request.maxTokens,
        system: system as never,
        messages: [{ role: "user", content: request.prompt }],
        output_config: { format: { type: "json_schema", schema: DRAFT_OUTPUT_SCHEMA } },
      });

    let response: Awaited<ReturnType<typeof call>>;
    if (cachedSystem) {
      try {
        response = await call(cachedSystem);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/cache_control|cache/i.test(message) || isTransientProviderError(err)) throw err;
        cacheFallbackReason = `provider rejected cache_control — retried uncached: ${message}`;
        response = await call(request.system);
      }
    } else {
      response = await call(request.system);
    }

    if (response.stop_reason === "refusal") {
      throw new PermanentGenerationError("the provider's safety layer declined the request (stop_reason: refusal)");
    }
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => (block as { text: string }).text)
      .join("");
    let parsed: {
      subject: string | null;
      body: string;
      attestation: { attested: boolean; statement: string };
      route?: { key: string | null; reason: string } | null;
    };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new PermanentGenerationError("the provider returned output that does not parse as the draft schema");
    }
    const usage = response.usage as {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number | null;
      cache_read_input_tokens?: number | null;
    };
    return {
      subject: parsed.subject,
      body: parsed.body,
      attestation: parsed.attestation,
      route: parsed.route ?? null,
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
      },
      // The SDK's usage fields are the verification PR-E names: what was
      // read from cache and what was written to it, on the credit line.
      ...(cachedSystem
        ? {
            cache: {
              read_tokens: usage.cache_read_input_tokens ?? 0,
              written_tokens: usage.cache_creation_input_tokens ?? 0,
              ...(cacheFallbackReason ? { fallback_reason: cacheFallbackReason } : {}),
            },
          }
        : {}),
    };
  };
}

/** Classify a provider error: transient failures retry on a later tick;
 * everything else fails the step visibly. Uses the SDK's typed classes by
 * name so the classifier needs no SDK import at module load. */
export function isTransientProviderError(err: unknown): boolean {
  if (err instanceof TransientGenerationError) return true;
  if (err instanceof PermanentGenerationError) return false;
  const name = err instanceof Error ? err.constructor.name : "";
  return (
    name === "RateLimitError" ||
    name === "InternalServerError" ||
    name === "APIConnectionError" ||
    name === "APIConnectionTimeoutError"
  );
}
