# Light Operating Doctrine — token discipline and judgment economy

Status: strategy artifact, drafted 19 July 2026 (Strategy chat). Governs how
Light (and any model acting through Barakah, including external Claude via the
Phase 3 MCP bridge) spends intelligence. Companion to the model router, the
context assembly engine, and the per-action credit gates — this document sets
their defaults and their spirit.

## The law in one line

**Light spends the minimum intelligence that produces a correct, safe act —
and every unit it spends is a metered line on The Record.**

## Why this exists

Barakah's margin and its trust story are the same fact: every AI act is gated,
priced, and visible. A Light that burns tokens carelessly is expensive for us,
surprising for the customer, and — worst — unaccountable. Token discipline is
not a cost programme; it is the credibility of "own the context, rent the
intelligence." The rent must be visibly fair.

## The four disciplines

### 1. Route down, escalate up (the model router's default)
- Every task class has a FLOOR model, not a ceiling. Triage, classification,
  stage mapping, junk detection, template filling: Standard tier, always.
- Escalation to Pro is EARNED by the task, per attempt, never sticky: complex
  drafting against a knowledge pack, multi-thread synthesis, contested
  judgment. The router records WHY it escalated as part of the credit line.
- If a Standard attempt fails pre-flight (placeholder missing, no-go breach),
  retry once at Standard with the specific failure fed back before any
  escalation. Most failures are context failures, not capability failures.

### 2. Assemble context, never dump it (the context engine's default)
- Light receives the RELEVANT memory cards, the CURRENT thread, and the
  task-scoped knowledge entries — never the whole store, never the whole
  history. The context assembly engine is a retrieval system, not a firehose.
- Budgets are explicit per task class (e.g. intro draft: contact card +
  enquiry row + form answers + template + at most N knowledge entries).
  Budgets live in configuration, are visible in the credit line's metadata,
  and are tuned from ledger data, not vibes.
- Long threads are summarised ONCE, and the summary is stored as working
  memory with provenance — never re-read raw on every act. Summaries expire
  on their own clock unless promoted (Spec 2 law, unchanged).

### 3. Do it once, on the record (idempotency of thought)
- An act that failed for a mechanical reason (provider refusal, missing
  credential) is retried WITHOUT re-drafting — the draft already exists;
  re-generation is pure waste. Dispatch retries are free of model spend.
- Identical inbound situations reuse decided outputs: a junk-pattern lead
  matching a prior triage decision cites it (a lookup) rather than
  re-reasoning it (a generation). The ledger is a cache of judgment.
- Nothing is generated speculatively. No pre-drafting for leads that may
  never need it; the workflow's step, not optimism, triggers generation.

### 4. Say less, structurally (output economy)
- Light's outputs are structured and terse by default: a draft, a stage
  proposal, a card — not essays about them. Explanations are generated only
  when a human asks "why" (and the answer is largely assembled from the
  ledger's existing lines, which is retrieval, not generation).
- Internal reasoning chains are capped per task class. A triage decision
  does not get a dissertation budget.

## The gates around the disciplines (already law, restated)

- Per-action gate: any single act over the threshold asks first ("this costs
  ~£4 — proceed?"). Soft cap warns; hard cap stops Light and queues work
  with the reason visible. Caps are enforced in the database, not politeness.
- Every metered act lands as a credit line with: model tier, why that tier,
  context budget used, and the act it fed. "Why did Light cost that?" is
  always answerable from The Record — the same answerable-forever standard
  as "why did Light say that?"

## External intelligence (the MCP bridge, Phase 3)

External Claude connecting through the Barakah MCP server is an actor with
grants whose writes land as proposals — and it is also a SPENDER whose acts
meter like any other. The same four disciplines bind it: scoped context out
(the server returns assembled context, never raw tables), structured
proposals in, priced on the ledger. A customer's Claude may be verbose on
their own bill; what crosses into Barakah is terse, typed, and metered.

## Training and tuning loop

- The provisional budgets and routing floors ship as constants in one named
  place (AUTO_CLOSE_POLICY precedent) and are tuned from live ledger data —
  per-task-class cost distributions are readable straight off the credit
  lines.
- Refine/Train (Phase 2) feeds judgment quality; this doctrine feeds
  judgment PRICE. The two meet in the ledger: a draft that needed three
  escalated attempts is a training signal, not just a cost.
- Review cadence: at each phase boundary, read the ledger's cost
  distributions and re-cut the floors and budgets. The doctrine's numbers
  are always provisional; its laws are not.

## What this doctrine refuses

- No sticky escalation ("this firm seems complex, use Pro for everything").
- No whole-history context dumps, ever, for any actor.
- No speculative generation.
- No invisible spend: an act that cannot be attributed to a credit line
  does not run.
- No greeting/persona inference from protected characteristics — warmth
  personalisation follows the CLIENT'S OWN recorded behaviour and stated
  preferences, never demographic guessing.
