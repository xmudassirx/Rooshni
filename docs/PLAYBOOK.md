# Rooshni Build Playbook

**Status: v1.0 — founder-approved 9 July 2026. Law once committed to `docs/`. Amended only via the tightening loop (§10).**

This document is the method by which Rooshni is built. It exists so that the standard of the build does not depend on which model runs a session. A cheaper model cannot be made smarter, but almost every occasion where the difference matters can be removed: smaller scopes, tighter contracts, judgment pre-decided on paper and delivered at point of use.

**Who reads what:**
- **The builder (Claude Code)** reads `CLAUDE.md` (always loaded), the session prompt it was given, and whichever skill matches the job at hand. It consults this playbook only when a prompt points at a specific section.
- **The founder and strategy chats** read this whole document. It is the manual for *writing* sessions, not for running them.
- **Any new model or contractor** reads this first, end to end. It is the onboarding.

---

## 1. The doctrine — five laws

These are the laws. They appear (in short form) in `CLAUDE.md` and in the rules block of every session prompt. Everything else in this playbook is derivation.

1. **The repo and project knowledge are the only truth.** Chat history never is. A decision exists when it is committed; until then it is a draft. No session inherits another session's context — if a fact matters across sessions, it lives in a file.
2. **Anything that must be true is enforced in the database.** Triggers, RLS policies, column privileges, security-definer functions — never only prompts, never only application code. The canonical example: the send pipeline physically refuses outbound communications without a human `approved_by_actor_id`. The AI cannot hold the stamp because Postgres won't let it, not because it was asked nicely.
3. **The founder holds the stamp.** Judgment calls wait for his sign-off before `DECISIONS.md`. UI merges wait for his click-review. Nothing leaves the repo, ever; credentials are provided by him on request, never discovered.
4. **check-local green before anything touches live.** All migrations applied, all smoke tests passing in the in-memory harness, before live Supabase is touched.
5. **Sessions are small, numbered, and stateless.** Fresh Claude Code context each. Scope stated in one sentence. A session that needs "and then" is two sessions.

## 2. Roles and rooms

- **The founder (Mudassir)** — stamps, merges, decides, provides credentials, runs the click-reviews. Holds the only authority that matters.
- **Strategy chats (Claude Project)** — Build Ops (sessions, sign-offs, infrastructure), Design (mockups ahead of the build), Playbook (this document). Chats talk to the cabinet — repo + project knowledge — never to each other.
- **The builder (Claude Code)** — executes one session at a time in `C:\dev\rooshni` against `xmudassirx/Rooshni`. It never decides; it implements, flags, and reports.

## 3. The session pattern

### 3.1 Anatomy of a session prompt

Every session prompt (template: Appendix A) contains, in order:

1. **Goal line** — session number + one sentence, with spec reference.
2. **Read first** — the exact spec sections and files needed. Never "read the specs"; always which ones and which sections.
3. **Scope** — what to build, *and what is explicitly out of scope*. The out-list is not decoration: it is the fence a weaker model needs most.
4. **Definition of done** — numbered proofs (§4).
5. **Rules block** — the standing five laws in short form, verbatim every time.
6. **Report format** — the session-close report (Appendix B).

### 3.2 Session lifecycle

1. **Open** — fresh Claude Code context in the repo. Paste the prompt.
2. **Pre-flight** — before writing any code, the builder restates the scope in its own words and lists anything it can already see will be a Lane C stop (§5). If the restatement is wrong, the founder corrects it before a line is written — the cheapest possible place to catch a misread. If nothing is flagged, it proceeds without waiting.
3. **Build** — within scope, per the relevant skills.
4. **Gate 1: check-local** — the in-memory harness (PGlite): boots Postgres in memory, fakes the Supabase auth surroundings, applies *all* migrations from zero, runs *all* smoke tests. Green or nothing moves.
5. **Gate 2: live** — migrations/seed applied to live Supabase only after Gate 1. UI work instead goes to a branch + Vercel preview (Gate 3).
6. **Report** — the close report (Appendix B): delivered / judgment calls awaiting sign-off / GO-LIVE additions / what the founder must do.
7. **Gate 3: founder stamp** — judgment calls signed off (then and only then recorded in `DECISIONS.md`); for UI, click-review of the preview URL, then the founder merges. The builder never merges UI branches.
8. **Close** — books balance: nothing pending, nothing untracked, session number retired.

### 3.3 Failure rule

If a session fails twice on the same step, close it. Do not push through in a degrading context. Shrink the scope (§6), write a new numbered session, fresh context. Sessions failing, retrying, and splitting is the system working, not the system breaking.

## 4. Definition of done — the proof rules

1. **Every proof is checkable by script or by click.** "Implemented X" is not a proof; "smoke test shows X" or "click path Y shows X" is.
2. **Refusal proofs are mandatory wherever an enforcement is built.** It is not enough to prove the permitted thing works; the forbidden thing must be *attempted* and shown to fail. An unstamped send must throw. A cross-tenant read must return nothing. An agent approving must be refused by the database. The product's promises are refusals; the tests must be too.
3. **At most three numbered proofs per session.** A fourth proof means the scope is too big — split (§6).
4. **Timers and durations are proven via `timeScale()`**, never by waiting. No hardcoded duration exists anywhere; a smoke test at compressed time is the proof.

## 5. The judgment-call protocol — three lanes

The single most important page for a weaker model. Every deviation, gap, or surprise falls into exactly one lane.

### Lane A — proceed, no record
Pure implementation choices invisible at every boundary: variable names, file layout inside a package, idiomatic library usage. **Test: would any spec, any mockup, any founder-visible behaviour, or anything the database permits read differently? If no — proceed.**

### Lane B — proceed, record, sign-off at session close
The spec is silent or has a small gap, and the fill is **additive and reversible**: a column needed for an RLS policy to work, a rename forced by a reserved keyword, an index, an attachment point the spec's column list implies but omits. Proceed, mark it with a `JUDGMENT:` comment at the site (migration comment, code comment), list it in the close report. It enters `DECISIONS.md` only after the founder approves. *Precedent: Session 1's five calls (`sort_order`, `field_definitions.template_id`, nullable `actors.account_id`, `content_versions.business_id`, one `enquiry` type with `visa_route` as a custom field) — all Lane B, all approved.*

### Lane C — stop and ask before proceeding
Stop mid-session, present the question with a recommendation, wait. Lane C is triggered by **any** of:

1. **Weakening a protected structure** (§7) — any change that loosens a trigger, RLS policy, column privilege, approval gate, or append-only rule, however locally sensible.
2. **Destructive operations on live data** — any DELETE, TRUNCATE, or destructive migration against live Supabase.
3. **A spec contradiction that changes behaviour** — the spec says X, reality demands Y, and a user or the founder would notice the difference.
4. **Deviating from an approved mockup** — anything founder-visible that doesn't match the signed design. Pixel judgment within the design is Lane A; structure is Lane C.
5. **New external service, paid dependency, or credential** — anything that creates an account, adds a bill, or needs a secret.
6. **Touching live before check-local is green** — never; not even "just this once".
7. **Scope growth** — the session needs something not in its scope block. The answer may be "yes, do it", but the founder re-draws the fence, not the builder.
8. **Leaving the repo** — not actually a question. The answer is pre-given: never.

**The rule of thumb, which outranks the list: if you are constructing an argument for why it's fine, it's Lane C.** A justification forming is the signal, not a comfort.

## 6. Small scopes — the split rules

The insurance policy in one section: any session a weaker model could fumble is split into two it cannot.

1. **One layer per session.** A session touches at most one of: {schema + enforcement} · {database functions / pipelines} · {UI} · {external integration}. The Session 1 scaffold was the founding exception; there are no others.
2. **Schema and UI never share a session.** No exceptions at all.
3. **External integrations are always two sessions:** first the contract (webhook shape, seeded payloads exactly matching the provider's format, handler tested against seeds — the Meta payloads in the Session 1 seed are the pattern), then the live wiring (credentials, real endpoint, one real event proven end to end).
4. **Enforcement and convenience split.** If a session both builds a gate and builds the pleasant path through the gate, the gate ships first, alone, with its refusal proofs. Convenience never rides in the same commit as the law it obeys.
5. **The one-sentence test.** If the goal line needs "and then", it is two sessions. If the definition of done needs a fourth proof, it is two sessions.
6. **Split at the seam the database gives you.** When splitting, the boundary is a table, a function signature, or a payload shape — something the second session can verify exists rather than remember.
7. **Model routing.** Sessions written to this playbook are runnable on a Sonnet-class model. Sessions that *design* (novel structure, spec ambiguity known in advance, anything Lane-C-dense) stay on the strong model, or better: the strategy chat resolves the design first and the session is rewritten until it routes cheap. The same principle as the product's model router — cheap for execution, strong for judgment — applied to building the product itself.

## 7. Protected structures

The named list behind Lane C-1. A session may **never** weaken, bypass, or special-case any of these without a founder stop, whatever the local justification:

- The **human-stamp triggers**: outbound communications cannot reach `approved`/`sent` without a human `approved_by_actor_id`; publishing requires a human; an agent cannot own an engagement; an agent actor cannot approve.
- The **append-only rules**: no UPDATE or DELETE on `events` or `stage_history`, ever (triggers plus revoked privileges); `content_versions` UPDATE is revoked — a saved version is immutable.
- The **stage door**: direct writes to `stage_id` / `stage_entered_at` are revoked at the column level; all stage movement goes through `move_engagement_stage()`.
- The **approval door** (Session 3, decision 16): direct UPDATE of `communications.status`, `approved_by_actor_id` and the rejection columns is revoked for every API role; the only paths are `submit_communication()`, `approve_communication()` and `reject_communication()`.
- The **readiness pre-flight** (Session 3, decision 19): a trigger refuses any transition into `approved`/`sent` that fails the deterministic checks (body present, no unresolved placeholders, per-channel consent, referenced attachments actually attached) — approving broken things is impossible, not discouraged.
- The **grant rules** (Session 2): no self-granting (check constraint); grant terms are immutable after issue — a change of terms is revoke + new grant; revocation is permanent and must name a human holding the authority; no DELETE on grants; comms, content-publish and Level 2 writes consume grants via triggers; tenant tool-level overrides can only raise floors, never lower them.
- **RLS on every table**, with explicit business-membership policies; **no DELETE policy for users** anywhere (hard delete is a Level 3+ service-role act).
- The **single ledger write path**: all event writes via `emitEvent()`.
- **Rejection requires a reason** in the approval pipeline.
- The **sign-in door** (Session 5): `allowed_emails` is RLS-walled — a
  signed-in user can read exactly one fact (whether their own live row
  exists) and no authenticated role may write it (service-role flow only);
  middleware gates every app route behind session + allowlist, and the
  tenancy wall behind the door stays memberships + RLS.

New enforcements added by future sessions join this list at the same session's close.

## 8. The paper trail

- **`CLAUDE.md`** (repo root) — the laws in short form. Always loaded by Claude Code. Amended only by founder-approved decision.
- **`docs/DECISIONS.md`** — approved judgment calls and founder decisions, numbered continuously and grouped by session: what was decided, the rationale, any founder caveat. Nothing enters without founder sign-off; nothing is ever deleted (superseded entries are marked retired/superseded in place, mirroring the memory doctrine: re-label, never destroy).
- **`docs/GO-LIVE.md`** — everything that must be true before real client data or real leads flow. Items added the moment they are introduced ("set TIME_SCALE=1 in Vercel", "infra off free tiers per §3.8", "purge seed/demo data"), never deleted, ticked at go-live. The builder adds items freely; only the founder ticks them.
- **Session close reports** — Appendix B format, posted in the session and relayed to Build Ops. The report *is* the session's existence to the outside world.

## 9. Standing technical discipline — the skills

Full procedures live in `.claude/skills/`; Claude Code loads each when doing that job. Skills follow the Agent Skills standard (an open format, portable across builder models): a folder with `SKILL.md` plus bundled `resources/` (templates) and `scripts/` (executable checks). Two rules govern their growth: **anything deterministic becomes a script, not prose** — a check the builder runs beats a rule it must remember; and **skills reference repo truth by path, never copy it** — copies drift, the repo doesn't. Skill scripts are code: they are written and proven in sessions by the builder, never pasted in from strategy chats. Summaries:

- **`migration-discipline`** — migrations are numbered and forward-only; an applied migration is never edited (fix-forward with a new one); every new table gets RLS + envelope columns + UUIDv7 ids in the same migration; append-only and privilege rules where specced; `JUDGMENT:` comments at every Lane B site; check-local green before live apply.
- **`smoke-tests`** — the PGlite harness pattern; every enforcement gets a refusal test (seed → attempt the forbidden thing → expect the database to throw); cross-tenant invisibility tested on every new table; time-dependent behaviour tested through `timeScale()`.
- **`external-integrations`** — the two-session rule (contract with seeded provider-exact fixtures, then live wiring); signature verification and idempotency on external ids, both refusal-tested; integrations never bypass the approval gates; secret hygiene (env vars named not valued in `.env.example`, every new secret a GO-LIVE item with rotation date); everything evented via `emitEvent()`.
- **`repo-map`** (builder-generated, kept current) — the monorepo map: what lives where, what each package owns, where truth for each concern sits. Regenerated whenever structure changes; a fresh-context session's first orientation.
- **`ui-system`** (builder-generated, kept current) — the theme engine as actually implemented: design tokens, Ledger/Frost, the semantic invariants (gold = Light acted, red = human stamp, green = done, monospace register), shadcn conventions, and the signed design amendments in force.
- **`preview-verification`** — UI branches named `ui/session-N-slug`; pushed for a Vercel preview; the handover to the founder is a checklist: preview URL · exact click path · expected result · which approved mockup screen each view must match (including the semantic invariants: gold = Light acted, red = human stamp, green = done, monospace register unchanged). The builder never merges; the founder's click-review is the merge gate.
- **`session-close`** — the Appendix B report ritual: nothing delivered that isn't listed, nothing listed that isn't proven, judgment calls gathered in one place, GO-LIVE additions named, founder actions explicit. Books must balance before the session ends.

## 10. How this document grows — the tightening loop

Rules here are **extracted from incidents, never invented in advance**. When a builder model behaves differently than a session assumed — a misread scope, a lawyered lane, a proof claimed but not run — the incident is reported to the Playbook chat, the smallest rule that would have prevented it is drafted, and it lands here or in the relevant skill via a founder-approved commit. One incident, one rule, same discipline as `DECISIONS.md`: dated, never deleted, superseded entries re-labelled. The playbook is to the build what memory cards are to Light — it improves by being corrected during real work.

---

## Appendix A — session prompt template

```
Session N: <one sentence — the goal>. Spec: <doc §sections>.

Read first: CLAUDE.md; docs/<spec file> §<sections>; <skill name if one clearly applies>.

Scope:
- <what to build, concrete>
- <...>
Out of scope (do not touch): <the fence — adjacent things this session must not do>.

Definition of done:
(1) <proof — script or click>;
(2) <proof — must include the refusal proof if any enforcement is built>;
(3) <proof — optional; a fourth means split the session>.

Rules unchanged: check-local green before anything touches live; judgment calls per
docs/PLAYBOOK.md §5 (Lane B recorded for sign-off, Lane C stops and asks);
DECISIONS.md only after my approval; GO-LIVE items to docs/GO-LIVE.md as introduced;
never leave the repo; credentials from me on request only; [UI sessions:] work on
branch ui/session-N-<slug>, Vercel preview for my click-review, never merge.

Before you write any code: restate the scope in your own words and flag anything
you can already see is a Lane C stop. Then proceed.

Close with the report format in docs/PLAYBOOK.md Appendix B.
```

## Appendix B — session close report template

```
## Session N — close report

**Delivered** (each with its proof):
1. <thing> — proven by <smoke test name / click path>.

**Judgment calls awaiting your sign-off** (Lane B; JUDGMENT: comments at each site):
1. <call> — <one-line rationale>. Recommend: <approve/alternative>.

**GO-LIVE additions:**
- <item added to docs/GO-LIVE.md, or "none">

**What I need from you:**
- <founder actions: sign-offs, click-review URL + path, credentials, merge>

**State:** check-local <green, N tests> · live Supabase <applied/untouched> ·
branch <name/none> · nothing outside the above was modified.
```
