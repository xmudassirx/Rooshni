import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DRAFT_CONTEXT_BUDGETS,
  estimateTokens,
  resolveEscalation,
  type EscalationDecision,
} from "./model-router";
import type { FormAnswer } from "./meta";

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

export interface GenerateRequest {
  model: string;
  system: string;
  prompt: string;
  maxTokens: number;
}

export interface GenerateResult {
  subject: string | null;
  body: string;
  attestation: { attested: boolean; statement: string };
  usage: { input_tokens: number; output_tokens: number };
}

export type GenerateFn = (request: GenerateRequest) => Promise<GenerateResult>;

/** A provider failure that should RETRY on a later tick (rate limit,
 * overload, network) — the step stays claimable, nothing completes. */
export class TransientGenerationError extends Error {}
/** A failure no retry will fix (bad credential, over-budget assembly,
 * malformed output twice) — the step fails VISIBLY with the reason. */
export class PermanentGenerationError extends Error {}

export interface ComposeDraftInput {
  business_name: string;
  owner_name: string;
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
  };
  usage: { input_tokens: number; output_tokens: number };
}

/** The lead's own words, flattened for escalation triggers and retrieval. */
export function leadTextFromAnswers(answers: FormAnswer[]): string {
  return answers.map((a) => `${a.label}: ${a.value}`).join("\n");
}

function assemblePrompt(input: ComposeDraftInput): { system: string; prompt: string } {
  const rules = input.no_go_rules.map((r, i) => `${i + 1}. ${r}`).join("\n");
  const system = [
    `You are Light, the assistant at ${input.business_name}, a UK immigration advisory firm. You are drafting a short, professional ${input.task === "intro" ? "first reply to a new enquiry" : "gentle follow-up to an enquiry that has not yet replied"} for the firm to review and send by ${input.channel}.`,
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
    `- Sign off as ${input.owner_name} at ${input.business_name}.`,
    ``,
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
    ``,
    `The firm's published knowledge (your only source of facts):`,
    knowledge,
    ``,
    `Compose the ${input.task === "intro" ? "first reply" : "follow-up"} now.`,
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

  return {
    subject: result.subject?.trim() || null,
    body,
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
    },
    usage: result.usage,
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
  },
  required: ["subject", "body", "attestation"],
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
    const response = await client.messages.create({
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: [{ role: "user", content: request.prompt }],
      output_config: { format: { type: "json_schema", schema: DRAFT_OUTPUT_SCHEMA } },
    });

    if (response.stop_reason === "refusal") {
      throw new PermanentGenerationError("the provider's safety layer declined the request (stop_reason: refusal)");
    }
    const text = response.content
      .filter((block) => block.type === "text")
      .map((block) => (block as { text: string }).text)
      .join("");
    let parsed: { subject: string | null; body: string; attestation: { attested: boolean; statement: string } };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new PermanentGenerationError("the provider returned output that does not parse as the draft schema");
    }
    return {
      subject: parsed.subject,
      body: parsed.body,
      attestation: parsed.attestation,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
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
