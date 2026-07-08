# Phase 0 — Spec 2: The Memory Card Model

**Product:** Create You AI (working title)
**Status:** Draft v0.2 for founder sign-off
**Date:** 7 July 2026
**Changes in v0.2:** memory import added (paste/screenshot → proposed cards, §5, §7); export governance tightened — owner-only, Level 3, audited, via Settings; console-side assisted export (§7); decisions 10–11.
**Depends on:** Master context §3.2 (memory lifecycle), §3.11 (personal dimension), §3.6 (feedback loops), §3.10 (note promotion); Spec 1 v0.5 (entity_links, events, actors, tenancy)
**Feeds into:** Spec 3 (grants may scope what memory the AI can read/write), Spec 4 (workflow steps consume assembled context); the Memory Cards and Dashboard mockups

---

## 1. Purpose and scope

This document defines how Light remembers: the shape of a memory card, its lifecycle from fleeting observation to trusted knowledge, how cards are scoped so businesses never bleed into each other or into your personal life, and the contract of the **context assembly engine** — the layer that decides which memories a given task actually sees. Storage is deliberately boring; assembly is the moat.

Out of scope: the full skills system (skills get their own treatment when the first one is built from the funnel-page seed document; this spec defines only how a method *graduates* toward one) and the dashboard surface design (it borrows this spec's promotion/decay mechanics; its screens follow in mockup).

## 2. Design principles

1. **Memory is not the database.** The six primitives record *what happened* (facts of record: Ayesha replied, the invoice was paid). Memory records *what Light has learned* (interpretations, preferences, methods: "clients respond better to WhatsApp than email", "Mudassir writes intros under 80 words"). Facts of record are never duplicated into cards; a card may *point at* the records that taught it.

2. **Every card earns its place, or fades.** The default fate of an observation is expiry. Only confirmation (you say yes) or repetition (the pattern recurs) promotes it. A memory system without forgetting becomes the 4,000-note landfill — the same disease the notes surface was designed to cure, cured the same way.

3. **Nothing is silently learned.** Every promotion to core memory is either explicitly confirmed by a human or visibly notified ("I've noticed X — I'll remember this; tap to discard"). The card UI shows everything Light believes; there is no hidden second memory. This is the trust promise applied inward.

4. **Scope is a wall, not a hint.** A card lives at exactly one scope. Cross-scope reads are structurally impossible in assembly except for the one sanctioned crossing: account-level preference cards flow into every space (master context 3.11 hard rule).

5. **Re-label, never delete, when knowledge goes stale.** An outdated card is marked `outdated` (with what superseded it), a wrong one `rejected`. History of belief is itself knowledge — and audit.

## 3. The `memory_cards` table

Carries the Spec 1 common envelope (id, created_at/by, archived_at, external_refs) with one deviation: **scope columns replace the bare business_id**.

| Column | Type | Notes |
|---|---|---|
| `account_id` | uuid | Always set. RLS anchor |
| `business_id` | uuid, nullable | Null = account-scoped ("Global"/personal) card; set = business-scoped |
| `kind` | enum | `fact` \| `preference` \| `standard` \| `method` — see §4 |
| `title` | text | One-line human-readable claim: "Clients prefer WhatsApp over email" |
| `body` | text | The full content, written to be read by humans and models alike |
| `status` | enum | `working` \| `proposed` \| `core` \| `outdated` \| `rejected` — the lifecycle, §5 |
| `trust` | enum | `observed` \| `confirmed` \| `authoritative` — who vouches for it, §5 |
| `provenance` | jsonb | `{source: conversation\|refine_diff\|note_promotion\|train_example\|manual, event_id, entity_refs[], occurred_at}` |
| `embedding` | vector (pgvector) | Semantic index for assembly retrieval |
| `expires_at` | timestamptz, nullable | Set for `working` cards (verdict: 14 days); cleared on promotion |
| `last_used_at`, `use_count` | timestamptz, int | Written by assembly on every inclusion — fuels decay and the card UI's "earning its keep" signal |
| `superseded_by` | uuid, nullable | Set when marked `outdated` |
| `pinned` | boolean | Human override: never decays, always eligible |

Entity attachment reuses **`entity_links`** from Spec 1 (§5.5) — a card about Ayesha links to her contact row; no new join table. Conflict pairs are recorded as entity_links between cards with role `conflicts_with`.

## 4. Card kinds — four, and the boundaries between them

**`fact`** — a durable truth about an entity or the world: "Ayesha's husband is in Pakistan", "the firm is IAA Level 1." **`preference`** — how a person likes things: tone, language, formats, channels; account-scoped preferences are the personal layer that follows you everywhere. **`standard`** — a quality bar output must meet: "intros under 80 words", "never promise success." Standards are what the Refine loop mostly produces, and what content scoring reads. **`method`** — a way of doing something, in steps. Methods are the larval stage of skills: verdict — a method card that has been applied successfully N times (default 5) triggers a proposal to graduate into a versioned skill; until then it stays a card. This keeps the skills registry clean and earned.

## 5. The lifecycle and the trust ladder

Status is *where the card is in its life*; trust is *who vouches for it*. They move together but are not the same thing.

```
observation → WORKING (expires in 14 days unless…)
   ├─ repetition threshold met (default 3) → PROPOSED → human tap → CORE
   ├─ human confirms directly ────────────────────────────→ CORE
   └─ expiry → archived silently (still queryable in card UI history)
CORE → contradicted by new confirmed knowledge → OUTDATED (superseded_by set)
CORE → human says "that's wrong" → REJECTED
```

Trust: `observed` (Light inferred it), `confirmed` (a human tapped yes), `authoritative` (a human wrote or edited it directly). Assembly prefers higher trust at equal relevance; standards must be `confirmed`+ before they gate anything.

**Conflicts** are detected only *within* a scope (X Law preferring formal tone while BarakahX prefers casual is design, not conflict). On detection: both cards flagged, Light presents the pair, resolution is one tap — keep one (other → outdated), or **re-scope** (the usual fix: "this was true of X Law, not of you — moving it").

**Promotion sources** (all writing `provenance.source`): conversation observation; **Refine-diffs** (edit an AI draft → the diff is analysed → proposed standard); **Train** (show an example → extracted method); **note promotion** (a note's insight becomes a card, provenance pointing at the note — the notes surface's exit ramp, master context 3.10); **import** (§7a — pasted text or screenshots from Claude/ChatGPT/anywhere, parsed by Light into individual proposed cards, trust `observed`, never straight to core); manual creation in the card UI (born `core`/`authoritative`).

**Decay:** a core card unused for 180 days is flagged "possibly stale" in the card UI — surfaced for review, never auto-deleted. (Working-memory expiry is the aggressive forgetter; core decay is only a gentle question.) The dashboard borrows exactly this promotion/decay mechanic for its attention curation — same maths, different table.

## 6. The context assembly engine — contract, not implementation

Assembly is a function, called before every model invocation:

**Input:** `{actor, account_id, business_id, engagement_id?, task_kind, skill_ref?, token_budget}`
**Output:** an ordered context bundle + an audit record.

Selection, by layers (verdict on the order):
1. **Account preference cards** — always included, small, first (how to speak to/for this person).
2. **Scope-matching standards** for the task kind (they gate quality; they must be present).
3. **Entity-linked cards** — anything linked to the engagement/contact in play (via entity_links).
4. **Semantic retrieval** — pgvector similarity against the task description, filtered to scope, ranked by relevance × trust × recency-of-use, until the token budget is spent.

Hard rules: cards from *other businesses* are unqueryable at assembly time (RLS-enforced, not prompt-enforced); the 3.11 leakage wall is therefore physics, not policy. Ties between cards break toward higher trust, then more recent use.

**Every assembly writes an `events` row** (`context.assembled`: which cards, for which task, at what cost) and bumps `last_used_at`/`use_count` on the chosen cards. Two consequences worth naming: the audit trail can answer "*why did Light say that?*" by showing exactly which memories fed the draft — a debugging and trust feature no chat assistant offers; and card usage statistics make the card UI honest about which memories actually earn their keep.

## 7. The card UI — contract for the mockup

One screen, filterable by scope (Me / X Law / BarakahX), kind, and status. Each card shows: title, kind badge, scope badge, trust badge, "last used / times used", provenance ("learned from your edit on 14 Mar — view the moment" → deep-link to the ledger event). Actions: edit (→ authoritative), re-scope, pin, mark wrong, add card. A **Proposals tray** at the top holds pending promotions and conflict resolutions as one-tap decisions — this tray is also surfaced on the dashboard. Design language: cards literally as index cards in the Ledger theme.

### 7a. Import — bring your memory with you
An **Import memories** panel accepts pasted text and uploaded screenshots (e.g. of a ChatGPT/Claude memory page, since those tools often lack export). Light parses the material — multimodal read for images — and extracts *individual claims*, each becoming a **proposed** card (trust `observed`, `provenance.source: import` with the raw material referenced) routed through the Proposals tray for per-card confirmation, batch-confirmable. Nothing imported ever lands in core unvouched. Product significance: a switching weapon — we make leaving other AI tools painless and leaving us unnecessary. Ships Phase 2 as an onboarding step for pilots ("bring Light up to speed in five minutes").

### 7b. Export — the owner's door, on the record
No export control appears on the memory screen (an employee-visible one-click export of the firm's brain is an exfiltration hole). **Self-service export lives in Settings → Data, visible to the account owner only, gated Level 3, and writes a ledger event** — the "own the context" promise kept, with an audit alarm built in. The **platform console** additionally offers admin-assisted bulk export for company/agency requests; every console export is likewise evented. Employees never see either door unless explicitly granted (Spec 3).

## 8. Phase boundaries

**Phase 1:** the full lifecycle for `fact` and `preference` cards + account-scoped personal preferences + assembly layers 1, 3, 4 + the card UI + assembly audit events. `standard` cards exist but are only consulted by drafting prompts (no scoring yet). **Phase 2:** Refine/Train promotion sources, standards gating content scores, the Proposals tray on the dashboard, note promotion. **Phase 3:** method→skill graduation tooling, per-agent memory views for personas.

## 9. Decisions made in this document (founder sign-off)

1. **Memory is separate from the database of record** — cards interpret; primitives record; cards point at their evidence via provenance and entity_links. (§2.1)
2. **Four kinds:** fact / preference / standard / method — and methods graduate to skills only after 5 successful applications. (§4)
3. **Lifecycle:** working (14-day expiry) → proposed (repetition threshold 3, or direct confirmation) → core; stale knowledge is re-labelled (outdated/rejected/superseded), never deleted. (§5)
4. **Trust ladder** observed → confirmed → authoritative; standards must be confirmed+ to gate anything. (§5)
5. **Nothing silently learned:** every promotion is confirmed or visibly notified; the card UI is the complete inventory of Light's beliefs. (§2.3)
6. **Scope walls are RLS physics:** account-level preferences are the only sanctioned crossing; conflict resolution's primary tool is one-tap re-scope. (§3, §6)
7. **Assembly contract:** preferences → standards → entity-linked → semantic retrieval within budget; every assembly is an audited event that also feeds usage-based decay. "Why did Light say that?" is always answerable. (§6)
8. **Core decay is a question, not a deletion:** 180 days unused → flagged for review; pinning exempts. (§5)
9. **Numbers chosen to be tuned, not defended:** 14 days, threshold 3, N=5, 180 days — all configuration, all adjustable from real Phase 1 behaviour. (§5)
10. **Import is a first-class promotion source** (paste text / screenshots → parsed into individual proposed cards, observed trust, per-card confirmation) — a Phase 2 onboarding step and a deliberate switching weapon. (§7a)
11. **Export governance:** no export on the memory screen; owner-only in Settings → Data, Level 3 gated, ledger-evented; console-side admin-assisted bulk export for company/agency requests. "Own the context" kept; exfiltration hole closed. (§7b)

## 10. Explicitly deferred

- Skills registry format, versioning, and marketplace packaging → specified when the first skill is built (Phase 2, from the funnel-page seed).
- Dashboard surface design → mockup pass, borrowing §5 mechanics.
- Embedding model choice and re-embedding strategy → implementation detail under the model router; nothing in this spec constrains it.
- Cross-account memory (teams sharing an account) → Phase 3 with agency tier.
