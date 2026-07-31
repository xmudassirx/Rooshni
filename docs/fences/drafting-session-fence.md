Session N (claim from docs/SESSIONS.md): query-aware drafting — Light drafts
against the lead's actual situation, within the knowledge pack, under the
no-go rules. The headline of Phase 2.

Read first: CLAUDE.md; docs/LIGHT-OPERATING-DOCTRINE.md (BINDS this session
— router floors, context budgets, output economy); docs/templates/
uk-immigration-v3.md (knowledge-pack categories, no-go rules); SESSION-10/11
handovers; DECISIONS.md in full — note 118 (WYSIWYS: the stamp shows the
exact words the channel will carry) and 119 (per-channel template bodies;
generated drafts are per-channel from birth) BIND this session's design.
Spec 2 (memory) remains unbuilt — this session works from the knowledge
pack + row data, NOT memory cards.

Scope:
1. Knowledge pack storage + Settings surface: firm-curated entries under the
   v3 categories (service descriptions per route, fees, booking policy, tone
   exemplars, FAQ). Entries are versioned, evented, template-scoped. Simple
   editor UI — no crawler (later session).
2. Lead-context capture: persist the Meta form's full answers at ingest
   (the deferred ruling from session 11 #110 — now needed and now ruled:
   store what drafting uses, under a declared attributes schema, shown in
   context-in-card).
3. The drafting engine: on workflow draft steps, Light composes against
   (a) the lead's form answers + enquiry row, (b) relevant knowledge-pack
   entries (task-scoped retrieval per the doctrine — never the whole pack),
   (c) the template's register + greeting, (d) the no-go rules enforced at
   generation AND checked at pre-flight (belt and braces: a no-go breach is
   a visible pre-flight failure, never a silent regeneration).
   Model routing per the doctrine: Standard floor, escalation earned and
   recorded on the credit line. Every draft's credit line carries model
   tier, why, and context budget used. Drafts are per-channel from birth
   (decision 119): the body generated for the channel it will dispatch on,
   and the stamp shows exactly that body (decision 118).
4. The compliance pre-flight check goes real: the COMPLIANCE PENDING chip
   becomes an actual check against the no-go register (deterministic
   heuristics + the drafting model's own attestation, both recorded).
5. Refine loop v1: a rejection reason or an edit-before-stamp is stored
   against the template+pack as feedback rows (the Refine/Train seed —
   full training loop later; this session just stops throwing the signal
   away). Editing a draft before stamping becomes possible in the inbox
   (edit -> re-runs pre-flight -> stamp).

Out of scope: memory cards/Spec 2; the crawler; social; voice; bulk
anything; auto-send (every draft still stamps); tags/custom-fields.

Migrations in scope (pack storage, form-answer attributes, feedback rows);
check-local green before anything touches live; whole session on one
branch cut fresh from origin/main; founder merges; migrations apply to
live only after merge unless a step is main-safe by the playbook's own
rules — say so at pre-flight and I'll rule.

DoD (founder-witnessed, <=3):
(1) I seed 3+ knowledge entries (fees, one route description, one tone
    exemplar), submit a test lead with a specific situation via the form —
    the draft in my inbox demonstrably addresses THEIR situation using the
    pack's content, in the firm's register, and its credit line shows tier
    + reason + budget;
(2) A draft that would breach a no-go rule (provoke one: a lead asking
    "guarantee my visa?") arrives with the breach REFUSED — the draft
    declines to promise, and the compliance check shows green because the
    output is clean, or the draft fails pre-flight visibly if not;
(3) I edit a draft before stamping — the edit re-runs pre-flight, the
    stamped version sends, and the edit is recorded as refine feedback.

Rules unchanged: lanes per playbook, DECISIONS only with my approval,
GO-LIVE items as introduced, expected-dirty paths: none, never leave the
repo. Credentials: the model provider API key is expected as a first-time
ask — request it at the moment of need, env var only, never committed.
Restate scope and flag any Lane C you can already see before writing code.
