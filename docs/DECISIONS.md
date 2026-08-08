# Implementation decisions — accepted by Mudassir

Deviations and judgment calls made during build, at the level below the
`docs/` specs. Specs remain the source of truth for design; this file records
where the implementation interprets them and why. Each entry names the session
that introduced it.

**Standing principle (set at Session 2 sign-off):** Anything that must be true
is enforced in the database; the app being well-behaved is not a control.

## Session 1 (8 July 2026) — Spec 1 schema, all approved

1. **`stage_definitions.sort_order`** — Spec 1 §5.3 names the column `order`,
   a reserved SQL keyword that would require quoting everywhere. Renamed to
   `sort_order`; meaning unchanged.

2. **`field_definitions.template_id`** — Spec 1 §5.3 lists no attachment
   point for field_definitions. Added `template_id` (FK → templates) for
   consistency with the sibling configuration tables.

3. **`actors.account_id` (nullable)** — Spec 1 §5.1 gives actors no tenancy
   column, but RLS-on-every-table needs a scope for actor visibility.
   Account-scoped actors (Mudassir, Light, Meta lead sync) set it; null means
   platform-level, visible to any signed-in user.

4. **`content_versions.business_id`** — Spec 1 §4.5 defines content_versions
   as `(id, content_id, version, body, saved_at)`. Added `business_id` so RLS
   applies directly rather than through a join.

5. **Single `enquiry` engagement type, `visa_route` as a declared field** —
   Spec 1 §6 lists seven X Law enquiry types (Skilled Worker, Spouse/Partner,
   Visit, Student, ILR, Citizenship, Ad-hoc advice) but also lists
   `visa_route` as an engagement custom field. Resolution: **visa routes are
   attributes, not lifecycles** — one `enquiry` type carries the §6 stage
   list; the route lives in `attributes.visa_route` (declared in
   field_definitions). `matter` remains a future separate engagement type
   (Spec 1 decision 17, Phase 3+).

## Session 2 (8 July 2026) — Spec 3 permissions engine, all approved

6. **Light's Phase 1 grant bundle** — Spec 3 §7 names "AI COO" without
   enumerating it. Light holds `enquiries`, `comms.email` and
   `comms.whatsapp` at **execute** (business scope, standing): §4 defines
   execute as "perform Level 2 actions and *submit* Level 3 actions into the
   approval queue" — draft-only access would keep Light's drafts out of the
   approval inbox. The stamp stays structurally unholdable on two layers
   (`approvals.*` never grantable to non-humans; human-approver trigger).

7. **Meta integration holds `enquiries` execute** — lead ingestion creates
   contacts, engagements and stage history, all Level 2 acts; Spec 3 §3
   explicitly allows integration grantees. Same grant system, no side door.

8. **Phase 1 tool registry contents** — the §3 example keys, one
   `comms.<channel>` row per external channel, plus
   `approvals.comms|content|money`. `settings.team` sits at level 2:
   granting is in-system and reversible via revoke, and the Admin preset
   implies managing access needs no stamp.

9. **`grants.business_id` is not null** — an account-level scope is recorded
   on a business row with `ref` = that business's account. **Caveat
   (Mudassir):** valid only while accounts are single-business; revisit when
   multi-business accounts arrive (agency tier, Phase 3) — account-scoped
   grants will need a home that is not a business row.

10. **Duration/expiry coherence** — `standing` ⇔ no `expires_at`;
    `this_task`/`until` require one. Expiry is enforced at use time by the
    grant check; the hygiene sweep itself is Spec 4's workflow engine.

11. **Grant terms are immutable** — after issue, only revocation, usage
    stamps and archiving may touch a row; a change of terms is revoke + new
    grant. Keeps the audit trail honest.

12. **Stage moves are a gated pipeline** (revised at sign-off — the original
    proposal accepted a DB-level gap on direct `stage_id` updates; Mudassir
    held it: an unlocked door is not an acceptable limitation). Column
    privileges revoke UPDATE on `engagements.stage_id` and
    `stage_entered_at` from every API role; the single path is
    `public.move_engagement_stage()` — grant check (via the gated
    `stage_history` insert), history append and engagement update in one
    transaction, terminal stages recording their outcome. Signed-in callers
    act only as their own actor within their own business; server code may
    act for any actor, but the grant still decides. Level 2 inserts
    (contacts/engagements/stage_history/tasks) require `enquiries` execute.

13. **Content drafting is ungated in Phase 1** — notes are Level 1 and carry
    no Phase 1 tool; content *publishing* requires the publisher to hold
    `approvals.content` execute on top of the Session 1 human check.

14. **Tenant level overrides** live in
    `businesses.settings.tool_level_overrides`, read by
    `private.resolve_tool_level()` through `greatest()` — tenants can raise
    floors, lowering is structurally impossible. Phase 1 home; revisit if
    overrides need their own table.

15. **No self-granting** — enforced as a check constraint
    (`grants_no_self_granting`), the Level 4 example of §4 made structural.

## Session 3 (8 July 2026) — the Approval Inbox, all approved

16. **The approval door is closed like the stage door** (the decision 12
    precedent applied to communications). Direct UPDATE of
    `communications.status`, `approved_by_actor_id` and the rejection record
    is revoked for every API role; the only paths are
    `public.submit_communication()`, `public.approve_communication()` and
    `public.reject_communication()`. Consequence, on the record: the send
    session must add its own mark-as-sent pipeline function — it inherits a
    locked door, not a gap.

17. **Rejection is recorded on the row as well as the ledger** — three
    columns added to `communications` (`rejected_at`, `rejected_by_actor_id`,
    `rejection_reason`, all-or-none constraint); Spec 1 §4.4 did not
    enumerate them (same class of addition as decision 4). Reject returns
    the item to `draft` — the drafter's queue — and the reason also travels
    to the ledger as `communication.rejected`.

18. **Rejecting requires the same authority as approving** (human +
    `approvals.comms` execute, or owner): refusing the stamp is exercising
    stamp authority. Spec 3 §6 lists Reject among the approver's one-tap
    actions.

19. **Phase 1 pre-flight check set** — everything deterministically
    checkable in the database today: body present; no unresolved `{{…}}`
    template variables; per-channel consent on file (email→email,
    whatsapp→whatsapp, sms/call→phone; meeting/portal have no consent
    dimension yet); a body that references an attachment must actually carry
    one (`file_links`). Enforced by trigger on any transition into
    `approved`/`sent` — approving broken things is impossible, not
    discouraged. Link resolution and no-go/standards compliance are not
    deterministically checkable in SQL and arrive with the app layer/Light.
    **Caveat (Mudassir):** the UI must never render an unearned tick —
    categories pre-flight has not checked display as *pending*, never green.

20. **Inbox contents Phase 1** = communications and content in
    `pending_approval` plus tasks in `awaiting_approval`. Spend gates and
    grant requests (Spec 3 §6) join the `approval_inbox` union when the
    spend pipeline and the grant-request flow exist; the view shape already
    accommodates them.

21. **Insert-at-approved stays legal** for an authorised human — drafting
    and approving your own message in one act (e.g. writing an email from
    Conversations); every trigger, pre-flight included, fires on that
    insert. The column closure is on UPDATE transitions, where an approval
    identity could otherwise be smuggled onto someone else's draft.

22. **The seed demonstrates the full trail as Mudassir in dev** — one Light
    draft approved, one rejected with a reason, exercising rpc + emitEvent +
    `approval_event_id` end to end. Dev-only demonstration data, listed on
    GO-LIVE.md for the go-live purge (Spec 4 §6 measures acceptance from the
    ledger).

## Session 4 (8 July 2026) — first UI slice, approved

23. **The web app acts server-side as the owner's actor, with no sign-in
    surface** — the UI resolves the business owner's human actor at runtime
    and calls the approval pipeline through the service client; the database
    still enforces every structural rule (human stamp, grants, readiness
    pre-flight). **Condition (Mudassir):** valid ONLY while (a) Mudassir is
    the sole user AND (b) Vercel Deployment Protection remains ON for the
    project. Either condition failing voids this decision — sign-in is built
    first, before anything else ships. The go-live trigger is on GO-LIVE.md.
    **RETIRED — Session 5 (9 July 2026):** real authentication shipped ahead
    of both conditions failing. See decision 24.
    **Amendment (Mudassir, Session 5 close-out):** condition (b) was
    partially void all along — the project's Deployment Protection setting
    is Vercel's Standard (previews only), so production was never behind
    Vercel's wall during Sessions 4–5; the owner-actor build was publicly
    reachable at the production URL until the Session 5 merge closed the
    exposure window. Discovered during the go-live checks, acknowledged by
    Mudassir; the setting stays Standard (nothing to flip). This validates
    the early-auth trigger — the wall assumed by decision 23 has to be the
    application's own, not the platform's.

## Session 5 (9 July 2026) — authentication, all approved

24. **Decision 23 is retired: the app acts as the signed-in human.**
    Supabase Auth with Google as the sole provider; every query in the web
    app runs through a user-scoped, cookie-based client under RLS — the
    pipeline functions see signed-in callers acting as their own actor
    (decision 12's rule, now actually exercised from a browser session). The
    service client remains only where it always belonged: the health check,
    the seed and future integration/server pipelines. The seeded owner auth
    user (created by email in Session 1) acquires the Google identity by
    Supabase's automatic linking on matching verified email, so
    `actors.user_id` maps the sign-in to the existing Mudassir owner actor —
    no new actor, no data movement.

25. **The allowlist is the front door; RLS remains the wall.**
    `allowed_emails` (0018): lower-case unique emails, soft archive, RLS on.
    A signed-in user can read exactly one fact from it — whether their own
    live row exists; managing the list has no authenticated policy at all
    (service-role flow, like actor creation). Middleware on every app route
    checks session + allowlist and shows everyone else the public holding
    page as a REWRITE, not a redirect — the URL never changes, so the
    deployment reads as a quiet site under construction and the app's shape
    is not advertised. Even a visitor who somehow got past the door holds no
    membership: RLS shows them zero rows on every table (the standing
    principle — the middleware is UX, the database is the control).
    **Founder amendment (sign-off):** the public surface carries no product
    name and no hint of what sits behind it — wordmark, tagline, tab-title
    metadata and even the theme localStorage key were scrubbed from the
    holding and sign-in pages; the discreet sign-in link is the only way in.

26. **Auth events on the ledger: sign-ins yes, denials not yet.**
    `auth.signed_in` (at the OAuth callback) and `auth.signed_out` (before
    the session is destroyed — a signed-out client can write nothing) are
    emitted via emitEvent, attributed to the signer's own actor in their own
    business. A DENIED sign-in writes nothing: events require a business_id
    and an actor_id, and a stranger belongs to no business.
    **Deferred, not declined (Mudassir, sign-off) — a known gap:** recording
    denials needs a platform-level system actor, which is real schema
    surgery, and Supabase's own auth logs give denial visibility for
    Phase 1. Trigger to revisit: when platform-level events arrive for
    other reasons (platform admin actions, the agency tier).

27. **Sign-out is local-scope** (production finding from the founder's
    proof circuit, fixed and re-proven at close). supabase-js `signOut()`
    defaults to GLOBAL scope — one sign-out revokes every session the user
    holds on every device, which surfaced as "sessions never persist":
    each sign-out anywhere silently killed the founder's other sessions
    server-side. Sign-out now confines itself to the browser performing it
    (`scope: "local"`). Proven by A/B experiment against production: a
    second session's refresh survives the first session's sign-out
    (previously `refresh_token_not_found`). Founder re-test: session
    persists across a full browser restart with no re-authentication.

28. **The middleware heals stray OAuth codes** (production finding, fixed
    and re-proven at close). When a redirect misses Supabase's allowlist,
    Supabase falls back to the Site URL and strands the one-time `?code=`
    on whatever page that names — the non-allowlisted tester's "bounced
    back to /signin". A session-less request carrying `?code=` anywhere
    but the callback is now forwarded to the exchange, so sign-in
    completes wherever the code lands; the callback's own no-code, error
    and denied paths all end at the holding page. Site URL confirmed by
    Mudassir as the production root. Founder re-test: the non-allowlisted
    account lands on the holding page.

## Playbook install session (9 July 2026) — verification close-out, all approved

29. **The four install commits are accepted as-is, with the record
    corrected here.** Commits `99bd2f2`, `000af5f`, `5773d10` and `c35e50c`
    were made and pushed by a concurrent builder session running in the same
    repo folder, before Mudassir approved the verification report —
    bypassing the agreed approval gate and the intended single commit
    ("Install build playbook v1.0"). Provenance correction: the `repo-map`
    and `ui-system` skills and the PLAYBOOK §7/§8 amendments that those
    commit messages describe as "received from Mudassir at Session 5 close"
    were in fact generated by the verification session from the codebase.
    Content was verified byte-for-byte against the verification session's
    work and accepted; history stays untouched.

30. **`check-local` gets a root alias.** CLAUDE.md law 5 names
    `npm run check-local`, but the script lives in `@rooshni/db`, so the
    command failed at the repo root. A root alias
    (`"check-local": "npm run check-local --workspace=@rooshni/db"`,
    matching the existing `db:migrate`/`db:seed` pattern) makes the
    documented command true everywhere. Command wording in CLAUDE.md and
    the skills stays as written.

31. **The single-session rule** (first tightening-loop extraction —
    PLAYBOOK §10, incident 1). Only one builder session runs in this repo
    folder at a time, founder-enforced; and if at pre-flight or any point
    the working tree contains changes the session did not make, the session
    stops — Lane C. A session never commits, pushes, or builds on foreign
    work. Added to PLAYBOOK §3.2 and the CLAUDE.md pre-flight ritual.

## Skill-hardening session (9 July 2026) — Incident 2 close-out, approved

32. **The direct-SHA push is retroactively accepted; the manoeuvre is
    banned** (second tightening-loop extraction — PLAYBOOK §10, incident 2).
    During a commit-and-push, a concurrent session in the same repo folder
    switched HEAD to another branch mid-operation; the builder completed
    the push by fast-forwarding the remote to the commit's SHA directly
    rather than stopping. The pushed content was correct and is accepted
    as-is; the precedent is rejected. The single-session rule is tightened
    (PLAYBOOK §3.2): one builder session per folder; parallel sessions are
    permitted only via separate git worktrees — own folder, own branch,
    the folder granted explicitly in the session prompt; and if HEAD, the
    current branch, or the working tree changes underneath a session
    mid-flight, the session stops — Lane C, no exceptions, even when
    stopping blocks completing an explicit founder instruction; report and
    wait. The CLAUDE.md pre-flight ritual is extended to match. The
    skill-hardening session that recorded this decision ran in its own
    granted worktree — the first session under the amended rule.

33. **The founding-exception allowlist in `check_migration.mjs`** — the
    Session 1 scaffold (0002–0011) predates the same-migration RLS rule;
    its tables pass the lint only because their RLS is verified present in
    0012_rls.sql, not assumed. The allowlist is closed: new migrations get
    the strict rule, no additions. JUDGMENT comment at the site.

34. **Canon test paths added to the smoke-tests skill** — the session
    prompt assumed SKILL.md already referenced canon tests by path; it did
    not. Added: the harness and every smoke test live inline in
    `packages/db/scripts/check-local.ts` (no separate test directory), with
    the stage-door and approval-door blocks named as the reference refusal
    tests.

35. **The DECISIONS.md guard in `pre_close_check.mjs`** — a session diff
    that touches docs/DECISIONS.md fails the close unless
    `--decisions-approved "<what covers it>"` records the founder approval;
    the note is echoed into the close-report summary block, so the paper
    trail shows what authority the write rested on.

36. **A non-clean tree at close is a failure, whatever its origin** —
    `pre_close_check.mjs` cannot distinguish foreign changes from
    unfinished session work, so any uncommitted or untracked state fails
    the close. The books balance only on a fully committed tree.

## Session 6 (12 July 2026) — the workflow engine and the MVP workflow, all approved

Founder watch on the live compressed clock: PASS — intro drafts held for the
stamp without the run hanging, stub-send and call task on approval, skips
with reasons, nurture at exactly +2/+5/+9, auto-close to Unresponsive, both
stories reconstructed from events alone by `npm run verify`.

37. **`workflow_steps.sort_order`** — Spec 4 §3 names the column `order`, a
    reserved SQL keyword. Renamed per the decision 1 precedent; meaning
    unchanged.

38. **`workflow_definitions.approved_by_actor_id`** — Spec 4 §2.4 makes
    activating a definition a gated act; the human stamp needs a column to
    live on (the decision 4/17 class of addition). Status and the stamp are
    revoked from direct update for every API role.

39. **New tool `approvals.workflows` (level 3, approvals category)** —
    decision 8 fixed the Phase 1 registry; §2.4 creates the need. Stays
    structurally unholdable by non-humans (0014 trigger).

40. **A definition is immutable once it leaves draft; its steps freeze with
    it** — a change of behaviour is a new version (the grants precedent,
    decision 11: re-issue, never rewrite).

41. **The table is `step_runs`, per Spec 4 §3** — the session prompt said
    "step_executions"; the spec's name won ("as specced").

42. **Run pause/resume/cancel gate on `enquiries` (execute) or the owner** —
    the spec names the acts but not their gate; enquiries execute is the
    Level 2 tool every enquiry mutation consumes. **Caveat (Mudassir):**
    approved for Phase 1 — flag a proper `workflows.control` tool for the
    Phase 2 registry review, alongside the message-templates tool (53).

43. **Two idempotency keys on runs** — at most one live run per
    (definition, engagement); a triggering event is consumed at most once,
    ever. Cron retries and webhook replays start nothing.

44. **The 5-minute claim lease is not TIME_SCALE data** — it is
    infrastructure crash-recovery time (how long a claimed step may sit
    `running` before a later tick reclaims it), not a workflow timer.

45. **Pending workflow definitions join the `approval_inbox` union** —
    decision 20 anticipated new arms; `description_plain` is the
    plain-English preview §2.4 requires at the gate.

46. **The Workflow engine actor** (actor_type `workflow`, a Spec 1 type
    unused until now) holds `enquiries` execute — honest ledger
    attribution: Light drafts, the engine schedules, skips, moves and
    closes.

47. **The Session 1 stand-in call task is retired** — the run's
    `create_task` step (Spec 4 §4 step 2) owns it, with `workflow_run_id`
    set. Existing fixture tasks stay on the go-live purge list.

48. **Nurture waits anchor sequentially after the intro stamp** — gaps of
    2/3/4 days produce the spec's T+2/5/9; the 3-day close wait lands at
    ≈T+12 (spec's "total sequence ≈ 12 days").

49. **"2 business hours" runs as plain hours in Phase 1** — no
    business-hours calendar exists. **Caveat (Mudassir):** all §4 timers
    remain provisional pending the two-week lead log; the log amends
    numbers, not structure.

50. **The WhatsApp nudge falls back to email when no consented WhatsApp
    channel is on file** — §4 step 4's "(if consented)" applied to step 8.
    Exercised live: both fixture leads hold phone+email consent only; the
    fallback fired and the drafts passed pre-flight.

51. **The intro blocks the run for the stamp; nurture nudges do not** —
    silence auto-closes even with nudges unstamped (proven live: t5/t9
    expired unstamped, close still fired). **Caveat (Mudassir, verbatim):**
    "closing as Unresponsive when nudges expired unstamped misattributes
    the silence — at the send-pipeline session, the close step must
    distinguish 'silent after sent nudges' from 'nudges never approved' on
    the ledger."

52. **Unobservable step conditions skip ON THE LEDGER** — steps 3–7 exist
    as data; conditions Phase 1 cannot observe resolve false and
    `workflow.step_skipped` records why. A run never hangs on machinery
    that does not exist yet, and never acts silently.

53. **`message_templates` writes are RLS-only in Phase 1** — Spec 4 §3 says
    editing a template is a Level 2 change, but no Phase 1 tool exists for
    it (the decision 13 precedent). Flagged for the Phase 2 registry review
    with 42's `workflows.control`.

54. **`CRON_SECRET` and the public tick path** — /api/workflows/tick sits
    outside the session middleware because a cron holds no session; it
    fails closed (503 with no secret configured, exact bearer match
    otherwise) and every act a tick performs remains gated in the database.
    The variable name lives in `.env.example`; the value is Mudassir's.

55. **Demo-reset semantics** — live runs cancelled through the gated
    pipeline, stale drafts soft-archived, workflow tasks cancelled, stage
    moves through the stage door; every act evented, nothing deleted.

56. **Definition rejection mirrors the comms pipeline** — a reason is
    required and the proposal returns to draft; refusing the stamp is
    exercising stamp authority (decision 18).

**Incidents, accepted at sign-off:** (a) the working copy was on
`ui/screens-record-detail` when the session opened (stale context snapshot);
the engine commit was cherry-picked to main and the UI branch restored
exactly to its pushed tip — the parallel UI session switches back on resume.
(b) PLAYBOOK §7 gained the workflow doors at close per §7's own rule
(commit 77e69ba), reviewed and approved. **Correction (Mudassir):** Vercel
preview aliases follow `rooshni-web-git-<branch>-…` — the `-web` segment was
missing from a reported preview URL; recorded in the preview-verification
skill.

## Session 7 (12 July 2026) — method finding-sweep, approved in the session prompt

57. **The pathway X-ray fixes and the close-gate rulings, as one sweep.**
    A read-only pathway X-ray (the builder describing its own end-to-end
    session pathway from cold context) produced seven findings, all
    accepted; approval is on record verbatim in the Session 7 prompt and
    its follow-up rulings (a)–(c). The fixes: (i) §3.2 close wording —
    nothing pending that isn't listed in the report; Lane B sign-offs are
    Gate 3's business and follow the close. (ii) The post-close DECISIONS
    path (§8): calls approved after a session closes are recorded by a
    follow-up bookkeeping session (or the next session touching `docs/`)
    whose prompt quotes the approval; entries always take the next free
    number read from the file, never assumed; mid-session approvals keep
    `--decisions-approved`. (iii) `docs/SESSIONS.md`, the session ledger —
    one line per session; appending the session's own line is part of
    every close; backfill reconstructed from git history and this file,
    marked ®. (iv) Branch discipline made law (§3.2, CLAUDE.md law 8):
    backend/schema/docs sessions on `main` with small commits, UI on
    `ui/session-N-<slug>`; every session records the `origin/main` SHA at
    pre-flight and passes it as `--base` at close. (v) Gate 1's reach:
    check-local green before live Supabase and before close; UI branches
    may push to preview at any time — previews touch no database.
    (vi) The playbook header matches CLAUDE.md: consult when pointed, and
    always §5 when ambiguous. (vii) Harness-supplied skill ecosystems
    (superpowers et al.) are subordinate to CLAUDE.md and the playbook;
    no harness demand precedes pre-flight; whether the ecosystem stays
    installed is the founder's call. From the same rulings:
    `--allow-dirty "<path>: <reason>"` (repeatable) joins
    `pre_close_check.mjs` — a founder-declared path may be dirty or
    untracked and echoes into the summary with its reason; any undeclared
    dirty state still fails; no flag, no exception. And the declaration
    rule, proven twice in one session (§10 entry 4): founder edits are
    committed or declared before a session opens; the folder is frozen
    while a session runs. The Session 6 block (37–56) and the second
    bookkeeping wave (preview-verification alias correction, decision 51's
    GO-LIVE caveat) were committed as separate founder-content commits
    (`4025795`, `e974526`) on explicit instruction — the first exercise of
    the (ii) path.

## Design Pass 3 close-out (15 July 2026) — signed by Mudassir, docs/design/AMENDMENTS-PASS3.md

58. **Connections live ONCE, in Settings → Integrations** — providers are
    actors with grants (media models connect over MCP); surfaces keep only
    behaviour preferences (a small Preferences panel), never per-surface
    settings tabs. Rationale: one door for credentials keeps grants the
    single permission truth — a settings tab per surface is a side door.

59. **Video storage law: never our bytes** — provider CDN via signed URL;
    poster + provenance (provider, prompt, cost) in the library only; Meta
    hosts published copies; images → R2 (zero egress); unpinned assets
    expire after 30 days. Supabase stores rows, not media. Rationale: video
    bytes are cost and liability with no product value — the row is the
    truth, the bytes are the provider's problem.

60. **Stage sync: stages ARE `engagement.stage`** — one vocabulary across
    pipeline, contact, conversations, workflows, portal; a stage move is one
    proposed change, stamped once, reflected everywhere, and may trigger
    due-at-stage invoices and portal updates in the same act. Rationale:
    one database, many faces — a second stage vocabulary anywhere is a
    parallel store.

61. **Colour taxonomy law** — ACCENT = chrome & kinds (active states,
    primary buttons, table headers, focus rings, data bars, kind chips) and
    follows the user's accent; PRISM|GOLD = Light's channel only (acts,
    chips, response mesh, avatars), user-selectable in Appearance, prism
    default; GREEN = done/published and RED = stamp/overdue NEVER move, any
    theme. Rationale: colour is semantics — the user may restyle chrome,
    never the meaning of Light's hand, the stamp, or done.

62. **Themes: default = Frost + blue accent + prism Light** — Frost defines
    its own paper/paper-deep/rule variables (no cream leakage); Mono theme =
    white/black luxury; seven accents; semantic colours invariant.
    Rationale: a theme is complete or it is broken — partial variable sets
    leak another theme's tint (the frost cream-leak incident).

63. **Mock one phase ahead of build, never more; signed exceptions only** —
    master mockup v2 is the design authority for all Phase 2 surfaces;
    Phase 3+ screens inside it are marked SIGNED EXCEPTION and are not
    build targets. Rationale: mockups beyond the next phase are fiction
    that hardens into accidental commitments.

## Session 8 (16 July 2026) — full-face UI, approved in the fix-round prompt (Part 3)

64. **One-door appearance** — the top-bar Aa control is removed; Settings →
    Appearance is the only appearance door (an amendment overriding the
    mockup's pixels). Conversations keeps its contextual phone/standard
    header toggle as the quick switch. Rationale: the one-door pattern,
    same law as connections-once (decision 58).

65. **Billing & usage stays a sidebar item, owner-gated** — the placement
    question (sidebar vs Settings tab) is closed; the DESIGN PROPOSAL chip
    removed. Rationale: founder click-review verdict.

66. **Green-as-chrome sweep** — the pass-1 screens (Enquiries board, The
    Record, contact detail) move to decision 61: accent drives chrome;
    green returns to done-semantics only. No other changes to those
    screens. Rationale: one colour law, no grandfathered screens.

67. **The Feedback nav gate keys on ownership** until a `feedback` tool row
    is registered (a migration, its own session); the GO-LIVE item carries
    the re-key. Rationale: grant-gating needs a registered tool to grant.

68. **Memory renders the honest empty store** — Spec 2's `memory_cards`
    table is unbuilt; the surface shows its full UI over an empty grid and
    the import stub, per the session's data-wiring rule ("empty state,
    defer"). Rationale: the UI never shows an unearned card.

69. **Untimed tasks are `due_at` at day-start plus `attributes.all_day =
    true`.** WATCH-ITEM: future SLA/vigilance logic must not read an
    all_day task as "overdue since 00:00" — the flag, not the timestamp,
    is the truth about timing. Rationale: the schema holds only due_at;
    the fill is additive and reversible.

70. **Tasks gains week-navigation arrows** — the static mockup draws one
    fixed week; the arrows and the month grid's tap-through are the two
    routes to other weeks. Rationale: an interaction the mockup could not
    draw, not a structural change.

71. **Finance and Client portal render present-but-disabled** nav entries
    with PHASE 3 chips. Rationale: the mockup's sidebar carries them, but
    live nav to SIGNED EXCEPTION screens would be an unearned affordance.

72. **Human avatars take the accent** — prism|gold is Light's channel only;
    the mockup's gold user-avatar is pass-1 residue. Rationale:
    AMENDMENTS-PASS3 (decision 61) outranks mockup pixels.

73. **`[{type:"paragraph"|"check", text, done}]` is the canonical
    note-block vocabulary** — import and MCP surfaces will emit it.
    Rationale: content_items.body was specced as "structured blocks" with
    no vocabulary; this one is portable and additive.

74. **Task and note mutations write directly to their ungated tables**
    under member RLS, with every act on The Record via `emitEvent()`.
    Rationale: tasks and notes are deliberately ungated primitives; the
    ledger path is the law that matters and it is honoured.

75. **Decision 15 (auto-close logic) is re-pinned to the integration
    session** — timers ship provisional and are tuned from live ledger
    data after go-live. Rationale: tuning against real behaviour beats
    guessing before any lead has flowed.

76. **The shell is fluid — containers stretch, prose doesn't** (fix round 3,
    overriding the mockup's fixed canvas width). The main content area has
    no maximum width: data surfaces reflow and stretch (boards widen their
    columns, grids gain columns, tables and panes grow), while long-form
    copy caps at a readable ~75ch measure inside stretching panels. Modals
    and the ask composer keep their intrinsic widths; the Light page and
    the generated workflow canvas column keep theirs (Lane B, noted at
    handover). Rationale: wide screens get more content, never longer lines.

77. **The Conversations header loses its phone/standard toggle** (fix round
    4, overriding mockup v2's quick-switch) — Settings → Appearance →
    Conversation view is the ONLY door, and the view renders straight from
    the appearance stamp. Root cause for the record: two writers (view-local
    toggle state vs the appearance stamp) raced on one value; removing the
    second writer removes the race. Rationale: the one-door pattern, third
    application (decisions 58, 64).

78. **Message alignment follows the AUTHOR SIDE, never the state** — firm-
    authored messages (Light drafts, stamped sends, direct messages,
    internal notes) sit right with a left gap; client inbound sits left
    with a right gap; a draft and its stamped version share a side, with
    state changing only the chrome (prism/gold border, not-yet-sent label);
    bubbles cap at ~72% of the pane at every viewport width; timestamps and
    meta lines follow their bubble's alignment — in both standard and phone
    views. Rationale: a thread must read as a chat; sides carry authorship,
    chrome carries state.

## Session 9 (17 July 2026) — onboarding foundations

Entries 79–84 are the signed Design Pass 4 handover rulings
(docs/design/ONBOARDING-HANDOVER.md, signed 16 July 2026), renumbered per
that document's own numbering note (its proposed 76–81 collided with
session 8's 77–78) and appended at close on the founder's in-session
instruction. Entries 85–89 are this session's rulings, approved verbatim in
the founder's rulings message of 17 July 2026.

79. **Two-step signup; payment before the shell.** Step 1: your name,
    business name, email, phone, website URL. Step 2: plan card + Stripe
    checkout. Pilots pay — there is no free tier and no trial wall to
    remove later. No template picker: UK Immigration Advisory v3 applies by
    default (vertical discipline deleted the screen); the vertical lives in
    Settings → General for the day there is a second one.

80. **Crawl-after-payment law.** The website crawl is triggered by the
    `payment.succeeded` webhook, never by URL entry. No AI spend exists for
    an unpaid signup. The URL is held (costs nothing) from step 1.

81. **First Light** is the onboarding surface: a top-bar pill beside Ask
    Light, wearing prism|gold (it is Light's channel — it speaks in Light's
    voice and carries Light's proposals; navigation rows inside the panel
    take accent — the prism is on the proposals, not the furniture). It
    opens a panel of setup rows. It is NOT a sidebar nav item.

82. **First Light rows are real task rows** (tasks table, tagged with
    `first_light` and a predicate key), visible in Tasks too — same rows,
    two doors. Every done-state is EARNED by a deterministic predicate,
    never by dismissing the row. Predicates live as ROWS in a table
    (founder-ruled): state in the database, flips evented on The Record;
    evaluation logic runs server-side. Rows: confirm business basics (all
    General rows stamped) · connect email & calendar / WhatsApp / Meta (the
    grant row exists; deep-link to Settings → Integrations; state reflects
    back; the panel never renders a credential field — decision 58 holds) ·
    review what Light found (memory proposals tray emptied) · review no-go
    rules (viewed/acknowledged event — the weakest tick, earned by
    acknowledgment; acceptable for Phase 2, never precedent) · verify
    sending domain (DNS checks pass) · book walkthrough (calendar event
    exists, via the product's OWN booking-link mechanism — dogfood or don't
    ship it). Meta Lead Forms row is skippable (only-if-running-ads,
    stated).

83. **First Light retires itself.** When every row is done, the pill
    disappears. Setup chrome must not haunt an onboarded firm. The rows
    remain in Tasks history and on The Record.

84. **The propose→stamp inversion is the first product experience.**
    Post-crawl, Settings → General values arrive as Light's PROPOSALS with
    provenance ("read from jurists.co.uk/about"); the founder confirms or
    corrects each — their first hour teaches the OS's core loop on their
    own data. Crawl findings land as memory PROPOSALS (trust: observed,
    provenance: crawl) — nothing enters memory unvouched. Values the crawl
    couldn't read are honest ("suggestion, not a reading" / blank), never
    silently defaulted-as-if-read.

85. **The naming law: platform = Barakah, agent = Light, company =
    BarakahX.** Public surfaces (the signup pair, the success page,
    reminder emails) carry the name BARAKAH; internal and repo names
    (Rooshni, package names, storage keys) are unchanged. This amends
    decision 25's no-name rule for exactly these surfaces; the holding page
    stays nameless. Production sending domain barakahx.com is on GO-LIVE.

86. **Platform-scope events** (decision 26's recorded revisit trigger,
    now arrived: platform-level events exist for another reason).
    `events.business_id` is nullable, guarded by a check constraint — a
    null business is lawful ONLY for the `account.*` namespace — plus one
    platform system actor (`actors.account_id` null, per decision 3;
    actor_type `workflow`, display name "Barakah platform"). Tenant RLS is
    untouched: a platform-scope row is visible to no API caller; append-only
    enforcement unchanged. First consumer: `account.deleted_unpaid` — a
    deleted unpaid signup has no business to charge the event to, and its
    event payload carries NO personal data (the ledger is append-only;
    eventing the deleted email would re-retain what the ruling deleted).

87. **Platform mail rides Resend; platform mail and tenant comms are
    separate pipes, permanently.** Graph sends as the firm and must never
    carry platform email; Resend sends as Barakah and must never carry a
    tenant's message. Pre-active reminder mail (24h, 7d, then silence)
    goes to people who are customers of no tenant — it touches neither the
    communications table nor the approval pipeline, stated on the record.

88. **The Google-only door at activation.** Payment-time activation
    provisions the auth user by admin API, writes the allowlist row and
    maps the owner actor; the shell is entered through the existing Google
    sign-in, with Supabase's verified-email auto-linking (the decision 24
    precedent) joining the identity to the actor. The constraint is stated
    at step 1 on the email field ("use an email you can sign in to Google
    with"), never after payment. Microsoft sign-in (Supabase Azure
    provider — the app registration exists) is a recorded fast-follow
    before the first external pilot, on GO-LIVE.

89. **Session 9 builder placements, approved as argued:** (a) Stripe
    references and `plan` live on `accounts` (Spec 1 §5.0 — billing is
    account-level; the account is the person), `website_url` on
    `businesses`; (b) a pre-active signup IS an `accounts` row
    (billing_status `pre_active`) holding the four signup facts — plus the
    business name, read as within the ruling's data-minimisation intent
    (activation cannot otherwise name the business the payer paid for);
    (c) no money-domain rows for the platform subscription —
    `invoices.contact_id` bills tenant contacts and §4.6 keeps platform
    billing outside the tenant schema; the amount lives in the
    `payment.succeeded` payload; (d) ledger event kinds are TS constants
    in `@rooshni/db` (no kind registry exists in schema; inventing one
    would be improvised schema); (e) contract discipline and TEST-MODE
    wiring run in this one session because the DoD demands a test-card
    circuit — live keys remain the GO-LIVE tick (the two-session rule's
    spirit: nothing live until the checklist says so).

## Session 10 (17 July 2026) — the send pipeline and the Meta door, all approved

Entries 90–96 are the session's Lane B calls, approved verbatim in the
founder's message at close ("All seven approved, decision 15 line approved
verbatim"); recorded in-session per §8. JUDGMENT comments at each site.

90. **The semantic stage set IS the seeded `stage_definitions`** — decision
    60's one-vocabulary law applied to the LEAD-LOG ruling: an inbound Meta
    lead lands at `new_lead` ("New"); no stages are renamed or added, and
    Brevo's four timer-costume stages are never created — timers are
    workflow data, not stages.

91. **Quiet hours are a wall-clock window, not a duration** — default
    20:00–08:00 in the business's timezone (the signed mockup's regulated-
    firm words: "stamped messages that hit quiet hours queue and dispatch
    at 08:00 — the stamp is yours, the timing is policy"), overridable per
    business in `businesses.settings.quiet_hours`, null disables. Law 11
    (timeScale) governs durations; a clock window has nothing to scale —
    tests inject the clock. Constants in `quiet-hours.ts`.

92. **The WhatsApp 24h session window runs in real time** — provider law,
    the decision 44 class (like the claim lease), never TIME_SCALE data.
    Enforced in the readiness pre-flight: free-form WhatsApp without a
    customer inbound inside a real 24h cannot be approved; a Meta-approved
    template reference (`attributes.wa_template`) passes any time.

93. **Dispatch events attribute to the business's workflow actor** — the
    Session 6 engine-actor precedent: carriage is platform automation; the
    human authority is already on the row as `approved_by_actor_id` and in
    the `communication.approved` event. Exactly one workflow actor per
    account; ambiguity is a loud failure.

94. **Stub-era approved rows never dispatch** — Session 3/6 demo drafts
    approved in the stub era carry `communication.send_stubbed` events and
    the dispatcher permanently walks past them; they leave with the
    go-live demo-data purge.

95. **`meta_webhook_events` carries no business envelope** — platform
    infrastructure, the stripe_events/allowed_emails precedent: RLS on
    with no policies (service-role only), idempotency on Meta's leadgen
    id, the tenant resolved during processing and recorded in `outcome`.

96. **Auto-close distinguishes the two silences (decision 15, landed)** —
    closing as Unresponsive requires ≥1 nudge with sent/delivered/read
    status (PROVISIONAL, `AUTO_CLOSE_POLICY` in auto-close.ts, tuned from
    live ledger data post-go-live); nudges that died unstamped NEVER close
    an enquiry — the step skips on the ledger with its reason
    (`workflow.auto_close_refused`) and the enquiry stays open for a
    human. Cadence remains workflow data.

Entries 97–99 are the founder's rulings from the witnessed-circuit close
pass (messages of 20 July 2026, quoted in the Session 10 handover addendum),
recorded in-session per §8.

97. **The greeting is neutral by default** — "Hello {{first_name}}," on
    `intro_v1` (live re-issued as v2, never rewritten; seed copy matches).
    Behaviour-driven warmth personalisation waits for the memory era, and
    demographic inference is never used (LIGHT-OPERATING-DOCTRINE).

98. **Client-facing subject law** (founder-caught on the first witnessed
    send): an outbound email's subject is the message's own rendered
    template subject, carried on the row; the thread's subject — which may
    be an internal label — is only a fallback for hand-written replies on
    subject-titled threads. The internal label never titles client mail.

99. **Shadow mode on real leads** — until the founder exits shadow mode
    (a GO-LIVE tick), real Meta leads are handled by the existing Brevo
    pipeline; Barakah ingests them fully (contact, enquiry, thread, run,
    draft) and the founder rejects the drafts with the stated reason. The
    parallel running is the point: the "before" pipeline operates while the
    "after" pipeline proves itself on the same traffic.

## Session 11 (24 July 2026) — First Light and template installation, all approved

Entries 100–112 are the session's thirteen Lane B calls, approved verbatim in
the founder's message at close ("All thirteen Lane B calls approved"), with
the founder's annotations on 100, 103, 110 and 111 recorded in place.
JUDGMENT comments at each site.

100. **The Session 11 prompt's rulings are recorded in the template doc by
     builder addendum** — the committed v3 doc lacked the Contacted
     stage-semantics block and the transition law the prompt referenced, so
     both were appended as dated builder bookkeeping quoting the prompt (the
     §8 quoted-approval pattern). **Founder annotation:** the addendum
     stands as canonical; the founder's amended revision matches it in
     substance; no re-commit.

101. **Stage reconciliation** — the installed v3 set replaces the Session 1
     seed set with retained keys keeping their deterministic ids;
     `contact_attempted` and `in_conversation` archived (soft, never
     deleted); `contacted` and `won` join with new ids; `instructed` goes
     non-terminal with `won` as the won-terminal; labels "New", "Contacted",
     "Lost" per the doc. Verified before live apply: zero enquiries occupied
     the retiring stages.

102. **The per-business `templates` row is an INSTALL POINTER, upgraded in
     place and evented** (`template.installed`) — a new row would orphan the
     active workflow definition, whose `template_id` is immutable behind the
     workflow door; the re-issue-never-rewrite law binds the DEFINITION
     store (`template_definitions` and the doc), not the install.

103. **"Delivered" reads as provider-accepted `sent`** — no delivery
     receipts exist for either channel yet. **Founder annotation:** when
     delivery receipts arrive, the transition trigger TIGHTENS to
     delivered-status; the condition tightens, never the law.

104. **The Contacted transition lives in the send pipeline, not its own
     slice** (ruled at pre-flight as the prompt invited): a trigger inside
     the communications `sent` transition, moving through the gated
     `move_engagement_stage()` as the account's workflow actor; when the
     machinery is absent (no `contacted` stage, no unique workflow actor)
     it NO-OPS — a bookkeeping gap must never block carriage of a stamped
     message; the dispatcher events the move (law 11 — SQL never writes
     the ledger).

105. **The migration fence covers the nurture stamps** — `reminder_3d_sent_at`
     and `nurture_unsubscribed_at` on `accounts` are read as within
     "template storage + predicate needs": scope item 6 (nurture days 3/7,
     unsubscribe on all three) requires both to exist, and accounts is
     their only honest home.

106. **Activation creates the workflow engine actor + its enquiries grant**
     — decision 93's one-actor attribution and the Contacted transition
     both require exactly one workflow actor per account; 0020 created
     none, so a fresh tenant's first dispatch would have failed loudly on
     attribution.

107. **`template_definitions` is platform infrastructure** — no business
     envelope (the stripe_events precedent); RLS on with an authenticated
     SELECT policy (the definition is product content signed-in surfaces
     render from) and NO write policy for any role: a definition changes
     only by re-issue migration with a version bump.

108. **Optional-row skip semantics** (the 0020 deferral, landed): skipping
     an optional First Light row cancels its task with a stated reason and
     events `first_light.row_skipped`; the predicate stays honestly
     unsatisfied — the tick was never earned; skipped optional rows do not
     block retirement (decision 83's condition: every row earned or
     explicitly skipped).

109. **Mockup copy claiming a live crawl was adapted to honest wording**
     (per the prompt's no-fabricated-provenance instruction) — the
     dashboard empty state points at First Light instead of "Light is
     reading your website", and basics provenance lines say plainly that
     nothing has been read ("entered by you — no crawl has read your site
     yet"). Decision 84's honesty rule outranks mockup pixels.

110. **Context-in-card renders only what the database holds** — contact
     channels with per-channel consent, source attribution, whitelisted
     engagement attributes; full Meta form answers are not persisted
     anywhere today and the card says so. **Founder annotation:** storing
     full form answers is DEFERRED to the query-aware drafting session,
     where it becomes necessary and gets its own ruling — data minimisation
     is a feature for a regulated firm, not a gap: we persist what we use,
     when we use it.

111. **The nurture copy ships builder-drafted** — the day-3 product story
     and the day-7 founder's note (signed as the founder) per the template
     doc's themes and the honest-claims law. **Founder annotation:**
     acknowledged; the founder's own rewrite lands before any real signup
     ages past day 3 — the GO-LIVE line holds until then.

112. **`first-light:drive` is the sanctioned service-side flip driver, on
     The Record both ways** — connect predicates are demonstrated by
     creating a REAL integration actor + grant and letting the ordinary
     evaluator earn the tick; pending-arrival rows flip only via an
     explicit `demo-flip` whose ledger event states "driven, not earned";
     driven artefacts carry their own GO-LIVE purge item.

## Session 12 (30 July 2026) — bulk rejection, law ordered in-prompt

Entry 113 was ordered verbatim in the Session 12 prompt ("LAW (DECISIONS line
at close)"); it is recorded on that in-prompt authority, the Session 7
precedent. Entries 114–116 are the session's three Lane B calls, approved in
the founder's message at close ("merged, three calls approved").

113. **Bulk REJECTION exists; bulk APPROVAL never does.** The Approval
     Inbox's selection mode (checkboxes + select-all-visible) attaches only
     to Reject: one shared reason, applied by looping the single
     `reject_communication` pipeline per draft, so every refusal lands as
     its own `communication.rejected` event with the reason on its row and
     The Record — identical in shape to a single rejection. Approvals are
     individual stamps by constitution; no select-all behaviour may ever
     attach to Approve, in any surface, ever.

114. **The bulk refusal is the single refusal looped — no batch RPC, no
     migration.** `bulkRejectAction` calls `reject_communication` per draft
     in concurrent chunks of 8, so ~78 refusals fit in one server action;
     a failure in one draft (e.g. it stopped being pending meanwhile) never
     stops the rest, and the tally reports honestly ("N rejected · M
     failed", first error shown). No new write path exists.

115. **The standing shadow-mode chip serves both reject dialogs** — bulk
     and single-card. The prompt named the chip without confining it to the
     bulk dialog, and the reason is the same act wherever the refusal is
     entered; the wording lives in one module (`standing-reason.ts`).

116. **Only communications are selectable** — content and task rows carry
     no checkbox until their rejection pipeline exists (their cards already
     say they are read-only). A control that cannot act is never offered —
     decision 19's unearned-tick rule applied to controls.

## Session 13 (30 July 2026) — the per-row basics law, approved at close

Entry 117 consolidates the session's three Lane B calls, approved in the
founder's close order ("Merged. Close session 13: DECISIONS line for
per-row basics semantics").

117. **Basics-confirm is per-row, and the required set is never empty.**
     The basics predicate satisfies ONLY when every required row is
     individually addressed — confirmed, corrected, or explicitly marked
     not applicable. The required set resolves through one shared resolver
     (`resolveBasicsRequiredKeys`): the installed template's
     `standard_keys`, else the canonical six (0022 v3's exact set) — and
     the evaluator additionally FAILS CLOSED on an empty set, so "cannot
     name the rows" can never again read as "nothing missing" (the Jurists
     root cause, now a permanent regression test). Facets: not-applicable
     is an explicit act restricted to free-text rows holding no value,
     recorded on the stamp store and as its own ledger line, rendered
     neutral, never green; "Confirm all remaining" reaches only rows
     already holding a visible value and is the per-row confirm looped —
     one act, one ledger line each; a tick recorded in error is struck via
     `unearnFirstLightPredicate` — the strike carries its reason and the
     struck flip's event id BEFORE the row clears, attributed to the
     workflow actor when one exists, else the owner's human actor.

## Chores (30 July 2026) — founder rulings between sessions

118. **WYSIWYS — a draft that may dispatch via an approved template shows
     the template's exact wording at stamp time; the stamp never approves
     words the client won't receive.** Recorded verbatim on the founder's
     ruling (the WhatsApp template-mapping chore: Meta's approved
     `enquiry_nudge` body differs from the seeded draft copy). The seed
     draft bodies re-issue to the approved templates' exact wording
     wherever the template path may carry the send — the nudge now, the
     intro if drifted. This law binds the query-aware drafting session.

119. **WYSIWYS is per-channel — template versions carry channel-specific
     bodies; the stamped draft renders the body of the channel it will
     dispatch on.** Founder-ruled on the flagged caveat: the email intro is
     NOT aligned to WhatsApp's approved text — split instead.
     Schema-light shape: `attributes.bodies` ({ channel → body }) within
     the existing template row; the whatsapp entry is the Meta-approved
     template text VERBATIM (read off WABA 270272332844358 — name verified
     "Test WhatsApp Business Account" — all three templates APPROVED,
     en_GB, variable counts matching decision-118's params ruling); email
     keeps its own copy in the body column; the drafter picks the channel
     FIRST, then renders that channel's body (`resolveTemplateBody`), and a
     blank channel entry never blanks a draft. Re-issued live as new
     version rows (intro_v1 v3, nurture_t2_v1 v2 — never rewritten), which
     also repaired a latest-version gap the re-issue inspection surfaced:
     the mapping chore and params fix had landed on superseded version
     rows while the drafter reads the latest. This shape binds the
     query-aware drafting session: generated drafts are per-channel from
     birth.

120. **Superseded template versions are read-only history — enforced in the
     database (0023).** Founder-ordered hardening after the decision-119
     re-issue surfaced the class of bug (a mapping/params fix landing on a
     version row the drafter no longer reads); the order allowed
     "structurally impossible or loudly detected" — the trigger lane is
     chosen per the standing principle. Any UPDATE on a message_templates
     row with a newer live version of the same key is refused, whatever
     code carries the write; archival-state changes stay legal on any
     version, and a row whose newer siblings are all archived is the
     effective latest again. The lawful change remains a NEW version row:
     re-issue, never rewrite.

## Session 14 (31 July 2026) — egress diet + auth forensics, cadence ruled in-prompt

121. **The workflow cron runs every 5 minutes, not every minute.**
     Founder-approved in the Session 14 prompt ("CADENCE ruling
     (founder-approved): cron drops from per-minute to every 5 minutes").
     Dispatch already fires inline on the stamp (`outbound.ts`,
     `onlyCommunicationId`) — the cron is backstop + timers, and 5-minute
     granularity is invisible at business-day timescales. Recorded
     consequences: quiet-hours releases and due-timer checks now land
     within 5 minutes of their moment instead of within 1 — accepted.
     Context: Supabase free-tier egress at 6.62GB/5GB; one tick measured
     at 1.29MB/412 requests before the Session 14 diet, ~42KB/9 requests
     after; cadence cut is the second factor of the recovery
     (1,852MB/day → ~12MB/day projected).

Entries 122–125 are the close-message approvals, recorded verbatim on the
founder's ruling ("Lane B 1–3: all approved… Bikayga ruling: approved as
recommended").

122. **DispatchReport `skipped` counts only what the sweep actually walked
     past** — future-scheduled rows are excluded server-side by the egress
     diet and no longer appear in the count; stub-era, no-carrier and
     no-contact rows still do. Informational field; approved at Session 14
     close.

123. **Empirical verification may create-and-delete a synthetic auth user
     on live when a DoD orders the proof** — the Session 14
     provider-disable check (admin createUser 200 / public signup 400
     email_provider_disabled) was made with a throwaway user deleted in the
     same script, never allowlisted. Approved at close: "empirical proof
     was the right call and the DoD ordered it."

124. **A backend session may push main mid-session when the DoD requires
     the change live on production** — Session 14's cadence DoD ("cron at
     5 min on production") lands only via deploy. Approved at close.

125. **The Bikayga test tenant: sign-in door closed now, tenant purged at
     go-live** — the allowed_emails row for bikaygapl@gmail.com is archived
     through the evented path (reversible; "Ahsan can be re-allowed in one
     motion if he ever becomes a real tester"), and the tenant + admin-API
     auth user fold into the Pilot-Test purge pattern at go-live. Executed
     at close via `allowlist:archive` (new evented chore script); ledger
     event `019fb7d1-f883-7c80-9f44-7b0004f33c33`
     (`account.allowlist_archived`, platform scope, no personal data in
     the payload).

## Session 15 (31 July 2026) — query-aware drafting, pre-rulings recorded on in-prompt authority

Entries 126, 127, 129, 130 are the founder pre-rulings PR-1..PR-4, "approved
in this prompt — record each as a DECISIONS candidate at close, quoting this
prompt per the §8 quoted-approval pattern; do not re-ask" (Session 15 prompt,
31 July 2026). Entry 131 is pre-flight ruling C-2, approved in the founder's
rulings message of the same day. Entry 128 is the PR-2 premise correction,
recorded as Lane B on the founder's quoted confirmation. The session's
remaining Lane B calls await sign-off in the close report and are NOT
recorded here.

126. **Knowledge entries are CONTENT, not a new table (PR-1).** Quoted from
     the prompt: "Each entry is a content_items row, content_type
     `knowledge_entry` (template vocab), state draft|published (published
     entries are what retrieval reads), category held in declared attributes
     (field_definitions rows scoped to the template) drawn from v3's
     category list … Route-scoped entries (service descriptions) declare
     attributes.visa_route from the same declared vocabulary the enquiry
     rows use. Versioning via the existing content_versions; edits create
     versions, evented. RLS applies as it already does to content. The
     migration DECLARES (vocab, field definitions, any index retrieval
     needs) — it does not create a parallel store." Landed as 0024 + the
     Settings → Knowledge tab (the one-door law: the ONLY place pack
     entries are edited).

127. **Meta form answers persist on the engagement at ingest (PR-2).**
     Quoted from the prompt: "engagements.attributes.form_answers = ordered
     array of {name, label, value} preserving Meta's field names verbatim,
     declared in field_definitions … Ingest path (Session 10 webhook)
     writes it from this session on. BACKFILL in-session … a one-off
     evented chore script … Read payloads ONCE each (egress discipline);
     report the count. Form answers render in the Approval Inbox
     context-in-card." This closes decision 110's founder-annotated
     deferral: data minimisation persisted what drafting uses, when it
     began using it.

128. **The PR-2 premise correction (Lane B, founder-confirmed):** the 0021
     `meta_webhook_events` payloads retain ids only — Session 10 fetched
     field data live and never persisted it — so the backfill replays the
     STORED LEADGEN IDS and re-fetches each lead's field data from Graph
     once (`fetchMetaLead`, the live-path adapter), reading the payload
     column zero times. Idempotent per the C-3 amendment (skips enquiries
     already holding form_answers; runs twice — in-session and post-merge).
     Founder approval quoted (31 July 2026): "Proceed in this order: 1. Run
     npm run backfill:form-answers — report the count and confirm zero
     payload-column reads." In-session run: 104 marks scanned, 103
     backfilled and evented, 1 visible failure (a lead Graph no longer
     serves).

129. **Anthropic is the drafting provider; routing per the doctrine
     (PR-3).** Quoted from the prompt: "ANTHROPIC_API_KEY env var only
     (Vercel + .env.local), never committed, never logged … Router floors
     per doctrine: Standard floor = current Haiku-class model; escalation
     tier = current Sonnet-class; both model ids live in ONE config module
     (model-agnosticism = one-line swap). Escalation is earned by recorded
     trigger — no-go proximity in the lead's question, multi-route
     situation, assembled context beyond floor budget — and the reason
     lands on the credit line. Every draft's credit line records: model
     tier, escalation reason (or 'floor'), and context budget used (tokens
     assembled vs cap)." The module is
     `packages/db/src/model-router.ts`; the credit line lives on the row
     (attributes.credit_line) and is priced on The Record
     (`light.draft_generated` with the events.cost block — its first
     producer).

130. **Refine feedback lives in `draft_feedback` (PR-4).** Quoted from the
     prompt: "communication_id, template_id, kind edit|rejection,
     body_before, body_after (null for rejection), reason, pack entry ids
     the draft used, actor, created_at. Append-only; evented on The Record.
     Queryable by template for the future training loop — this session
     just stops throwing the signal away." Landed as 0025; edits and
     rejections (single and bulk) write it from the Approval Inbox.

131. **The compliance gate binds the machine (ruling C-2).** Quoted from
     the founder's rulings message (31 July 2026): "The compliance
     requirement binds agent-drafted communications created after the
     migration: heuristics + generation-time attestation both required for
     green on those rows, fail closed. Human-authored communications
     (including decision-21 insert-at-approved) and pre-migration drafts
     remain under the existing deterministic check set — decision-21
     behaviour unchanged. … v3's no-go rules govern Light's words, not the
     firm's own; the compliance gate binds the machine." Landed as 0026:
     `compliance_required` stamped at birth from the drafter's actor type
     and immutable; checks recorded append-only through the server-only
     `run_compliance_check()`; the readiness pre-flight fails closed on a
     missing, stale, breaching or unattested check, and a breach names its
     rule on the RED chip.

132. **The Session 15 Lane B calls, all eleven approved** ("LANE B SIGN-OFF:
     1–11 ALL APPROVED as recommended. Record in DECISIONS quoting this
     approval" — founder review message, 31 July 2026). The calls, with the
     founder's riders recorded in place:
     (1) 0024 declarations land as per-install field_definitions rows, not
     a template_definitions v4 re-issue (decision 79 pins "v3 applies");
     (2) category/route vocabularies ride field_definitions.validation.allowed
     per install; (3) the 0026 heuristics deterministically implement v3
     rules 1 and 3, rules 2 and 4 enforced in-prompt + attestation —
     **rider:** rule 4 becomes partially deterministic when contact
     classification exists (future tightening, not this scope); (4) the fee
     check reads rule 3 as "Light quotes only amounts published in the
     pack" — **rider:** deliberately broader than rule 3 as written;
     (5) draft_feedback.template_id nullable; (6) the generative path is
     email-only this session — WhatsApp always takes the approved-template
     path (118/119) and attests as `approved_template`; (7) a template
     subject wins when present (decision 98 stability), and the doctrine
     retry-once runs post-insert against recorded heuristics, both checks
     retained, attempts on the credit line; (8) transient provider failures
     leave the step for lease retry, permanent ones (including a missing
     key) fail the step visibly with both events; (9) rejection feedback is
     captured for agent-drafted rows only, and edit authority is checked
     app-side (owner or approvals.comms) with the DB gates untouched;
     (10) Meta form-answer labels are the verbatim field names humanised
     deterministically (Graph carries no separate label); (11) the official
     @anthropic-ai/sdk dependency — **rider:** recorded explicitly as a
     departure from the raw-fetch house pattern (graph.ts/whatsapp.ts);
     its typed error classes drive the transient/permanent split.
     **Edited-body attestation semantics, on the record at the founder's
     instruction:** an edit re-runs the compliance check on the EXACT
     edited words — heuristics re-screen deterministically, the
     generation-time attestation carries forward, no new model call; green
     = clean heuristics + carried attestation, so an edited draft is
     approvable the moment the re-check lands clean (WYSIWYS holds; C-2's
     both-required rule is satisfied by the carried attestation, which
     truthfully attests the generation that produced the base draft).

133. **DEFERRED RULING — the inbound-supersede engine (next session's
     headline; gates shadow-exit; NOT built in Session 15).** Founder-ruled
     at the Session 15 close review, recorded so the repo carries the fence:
     (a) one live pending outbound draft per engagement per channel; a new
     inbound regenerates against full thread context, the old draft moves
     to a superseded, evented state, and the card shows "supersedes earlier
     draft · N new messages since"; (b) the settle window is configurable
     in Settings — instant / 1 / 3 / 5 minutes, default 3 — with
     per-conversation override; (c) a human reply sent while a draft pends
     auto-supersedes the draft, evented — the human always wins, and no
     orphan draft survives them; (d) **founder-ruled revised:**
     Conversations drafts PROACTIVELY by default — every settled inbound
     burst yields one draft under the same settle and supersede laws;
     "Ask Light to draft" is the manual trigger; the per-conversation
     toggle PAUSES auto-draft, it does not enable it — the product is
     Light drafting everything, with the economics carried by the settle
     window, supersede, floor routing and task-scoped assembly, not by
     drafting less; (e) sign-off gains an "approver, resolved at stamp"
     option, WYSIWYS-preserving — the opened card shows the approver's
     name before stamping; (f) the supersede engine's drafting calls use
     provider prompt caching — the stable prefix (no-go register,
     register/tone, selected pack entries) is cache-marked so
     regenerations bill cached-input rates, and cache usage lands on the
     credit line.

134. **The waiting clock is the client's, immutable across edits** (Session
     15 click-review fix, founder-ruled 31 July 2026: "'waiting since' and
     the inbox sort key derive from the original submission-to-pending
     time, never reset by an edit. An edit changes the words, not the age.
     The edited card must hold its queue position and its true waiting
     time."). Landed as 0027: `communications.submitted_at`, stamped by
     trigger on the transition INTO pending_approval, forced immutable on
     every other write (an explicit write is overwritten back), absent from
     the API roles' update grants; the approval_inbox view (re-issued from
     its four-arm 0019 definition) keys awaiting_since to it, with
     updated_at only as the fallback for pre-0027 rows the ledger could
     not date; existing rows backfilled from their earliest
     `communication.submitted` event. A re-submission after rejection
     lawfully restarts the clock — that queue period is genuinely new. The
     companion click-review fix needs no ruling: an edited pending body
     wears an "edited by <name> · <time>" chip read from draft_feedback —
     a fact in neutral chrome, never gold, red or green.

## Session 16 (1 August 2026) — inbound supersede engine + live inbox, pre-rulings recorded on in-prompt authority

Entries 135–141 are the founder pre-rulings PR-A..PR-G, "approved in this
prompt; record as DECISIONS candidates quoting it; do not re-ask" (Session 16
prompt, 1 August 2026 — the §8 quoted-approval pattern; each elaborates a limb
of decision 133). The session's Lane B calls await sign-off in the close
report and are NOT recorded here.

135. **Inbound capture is the prerequisite and is in scope (PR-A).** Quoted
     from the prompt: "(i) WhatsApp inbound via the existing Cloud API
     webhook → communications rows (direction inbound, thread-matched by
     phone/wa id, consent refreshed per Meta's 24h service window rules —
     record the window state on the thread); (ii) email inbound via
     Microsoft Graph for the connected tenant mailbox — poll on the existing
     5-min cron this session (subscription webhooks are a future tightening,
     note on GO-LIVE), matched to threads by references/in-reply-to headers
     and sender address, unmatched inbound creating a new thread on the
     contact. Every inbound is evented. If Graph polling needs a new scope
     or admin consent, STOP and hand me the exact console steps (Lane C
     credentials-at-need)." Landed as 0028 + inbound.ts +
     /api/whatsapp/webhook + the Graph poll on the tick; the Mail.Read
     console steps are on GO-LIVE (the anticipated Lane C).

136. **Supersede mechanics (PR-B; decision 133a/c made structural).** Quoted
     from the prompt: "At most ONE pending outbound draft per engagement per
     channel — enforce in the database (partial unique index on pending
     status), not app behaviour … the old draft transitions to status
     `superseded` (enum extension — migration; superseded is terminal,
     evented, visible in Approval Inbox History, never deletable); the new
     draft carries fresh pre-flight, fresh compliance check, fresh credit
     line, and its card reads 'supersedes an earlier draft · N new messages
     since'. A HUMAN outbound sent on the thread while a draft pends
     auto-supersedes the pending draft immediately (no settle wait), evented
     with reason human_replied. The client clock (D134): a superseding draft
     INHERITS the original submitted_at." Landed as 0029/0030: the guard
     indexes, the terminal/frozen/never-deleted trigger, the service-only
     supersede_communication pipeline (atomic retire → submit through the
     0017 door → clock inheritance via a transaction-local value only the
     pipeline sets), and the same-transaction auto-supersede trigger on any
     outbound reaching approved/sent.

137. **The settle window (PR-C; decision 133b).** Quoted from the prompt:
     "Business-level setting in Settings (instant / 1 min / 3 min / 5 min,
     DEFAULT 3) with per-conversation override; the window restarts on each
     new inbound in the burst; timer state lives on the workflow/thread row
     server-side (durable, cron-evaluated — same pattern as nudge timers),
     never client-side. Copy states the trade honestly ('faster drafts may
     answer an unfinished thought')." Landed as comm_threads settle columns
     (0030), the timeScale-scaled arming on every inbound, the cron sweep
     with optimistic claims, and the Settings → General + per-conversation
     controls.

138. **Proactive Conversations drafting (PR-D; decision 133d).** Quoted from
     the prompt: "Every settled inbound burst on an active thread yields ONE
     draft, per the same laws, regardless of whether a workflow step asked
     for it — Conversations is now a drafting surface, not only a viewing
     one. 'Ask Light to draft' button = manual trigger that bypasses the
     remaining settle wait. Per-conversation toggle PAUSES auto-draft (it
     never enables — on is the default). Drafts born from inbound replies
     follow the reply register: answer what the inbound actually asked
     (generalities lawful, case-specific advice never — no-go rule 2),
     consultation invited only where the answer genuinely needs one … Reply
     drafts appear in BOTH Approval Inbox and inline in the Conversation
     thread (same row, two views, one stamp)."

139. **Prompt caching (PR-E; decision 133f).** Quoted from the prompt: "Use
     Anthropic prompt caching via the SDK: mark the stable prefix (no-go
     register, register laws, tone exemplars, selected pack entries) as
     cached; thread tail and fresh inbound stay uncached. Cache read/write
     tokens land on the credit line ('cache: X read / Y written'). Verify
     with the SDK's usage fields; if the API rejects cache_control for any
     reason, fall back to uncached with a recorded reason — never fail a
     draft over caching."

140. **Sign-off, approver option (PR-F; decision 133e).** Quoted from the
     prompt: "businesses.settings.email_sign_off gains mode: firm_name
     (default, shipped) | approver. In approver mode the PENDING body
     carries the firm name; when a holder of stamp authority OPENS the card,
     the rendered body resolves the sign-off to THEIR display name before
     their eyes (WYSIWYS: what they see at stamp is what sends — the
     resolution happens at render+stamp server-side as one act, and the
     dispatched body records the resolved name). If this render-resolve
     cannot be made WYSIWYS-clean, STOP and say so (Lane C) rather than
     shipping a body that changes after the stamp." Landed WYSIWYS-clean by
     construction: render and stamp share one deterministic resolver over
     the STORED body; the stamp act re-runs the compliance check on the
     exact resolved words with the carried attestation (decision 132) and is
     withheld on any failure.

141. **Live inbox (PR-G).** Quoted from the prompt: "Supabase Realtime
     subscription on the approval-pending count and list for the signed-in
     business: new pending drafts appear without refresh; the sidebar count
     updates live; a single subtle notification sound on arrival
     (user-toggleable in Settings → Appearance, default ON; respect the
     browser's autoplay/interaction rules honestly — no sound before first
     user interaction is fine and expected). No polling loops; Realtime
     only. Same treatment for Conversations thread view (new inbound appears
     live)." Landed as 0031 (communications joins the supabase_realtime
     publication; authorisation is RLS) + the shell-mounted single
     subscription that re-renders server-side.

## Session 18 (1 August 2026) — canonical URL + register chores, rulings recorded on in-prompt authority

Entry 142 is the founder pre-ruling from the Session 18 prompt ("record as
DECISIONS candidate quoting this prompt", 1 August 2026 — the §8
quoted-approval pattern). Entry 143 quotes the founder's mid-session ruling
of the same day, issued at the Lane C stop when Session 17's parallel work
appeared in Session 18's working tree. The session's Lane B calls await
sign-off in the close report and are NOT recorded here.

142. **No em or en dashes in client-facing drafted copy (the register
     rule).** Quoted from the Session 18 prompt (1 August 2026): "no em
     dashes or en dashes in client-facing drafted copy. The generation
     prompt instructs commas and full stops instead; add a register check
     to the composition smoke (a drafted body containing an em or en dash
     fails the harness). Scope: generated client-facing bodies (email +
     WhatsApp free-form). Do NOT add a pre-flight blocking check for
     human-authored text; humans may punctuate as they wish." Landed as
     the register punctuation line in BOTH generation prompts
     (intro/nudge and reply) and a composition-layer output screen beside
     the braces check in `packages/db/src/drafting.ts`
     (`findRegisterBreach`), refusal-tested in the harness. Machine-drafted
     bodies only; human-authored text (including decision-21
     insert-at-approved and client inbound) is never screened.

143. **Parallel sessions require parallel checkouts — one folder is one
     session.** Quoted from the founder's mid-session ruling (1 August
     2026, at Session 18's Lane C stop): "The collision is a founder-side
     process error: two sessions were started in one folder. The law is now
     set and will be recorded: parallel sessions require parallel checkouts
     (worktree or second clone); one folder is one session." Context: the
     Session 17 marketing session, declared as running on its own branch,
     materialised `apps/marketing/` and hunks in `turbo.json` and
     `.env.example` inside Session 18's working folder mid-flight; Session
     18 stopped per §3.2, the founder stopped Session 17 until Session 18's
     close and merge, declared the foreign paths expected-dirty, and
     granted explicit say-so for hunk-scoped staging (Session 17's hunks
     left uncommitted in place, never `git add -A`). This strengthens the
     §3.2 single-session rule from "separate worktrees, each granted in its
     prompt" to a standing checkout law.

## Hotfix (1 August 2026) — WhatsApp webhook public-path exclusion, ordered on founder authority

144. **A webhook's middleware exclusion is part of its definition of done.**
     Quoted from the founder's hotfix order (1 August 2026): "the holding-page
     middleware rewrites cookie-less requests to /construction, and
     /api/whatsapp/webhook (Session 16) was never added to the public-path
     exclusions — Meta's webhook verification receives the construction page
     instead of the challenge echo. … Record the defect + fix as a DECISIONS
     candidate (the exclusion list is part of the webhook's definition of
     done — a webhook that cannot be verified was never shipped)." Fix:
     `/api/whatsapp/webhook` joins PUBLIC_PATHS (the route itself fails
     closed without META_APP_SECRET, signature before parse — Session 16's
     doors unchanged). The ordered audit swept every cookie-less external
     route: the signup trio (prefix-covered), Stripe webhook, Meta leads,
     cron tick and health were already excluded; the WhatsApp webhook was
     the only gap; nothing else was loosened. Standing rule, recorded in the
     middleware comment: a session that ships a cookie-less external route
     adds its exclusion in the same session.

## Session 19 (1 August 2026) — multi-touch workflow + HTML email, pre-rulings recorded on in-prompt authority

Entries 145–148 are the founder pre-rulings PR-i..iv, "approved here; record
as DECISIONS candidates quoting this prompt" (Session 19 prompt, 1 August
2026 — the §8 quoted-approval pattern). Entry 149 quotes the founder's
mid-session ruling of the same day (the consent fold-in). The session's Lane
B calls await sign-off in the close report and are NOT recorded here.

145. **Attachments on workflow drafts (PR-i).** Quoted from the prompt:
     "Workflow draft steps gain config for attachments: template-declared
     per-route documents (e.g. a Spouse Visa guide PDF) stored as files rows
     linked via file_links to a content_items row of a template-declared
     kind (route_guide), uploaded/managed in Settings → Knowledge alongside
     pack entries (one door: knowledge is knowledge, documents are entries
     with a file). The drafting engine attaches the route-matched guide to
     the intro email when one is PUBLISHED; the ATTACHMENTS pre-flight check
     verifies the file exists and is linked before the stamp. No guide
     published = no attachment, never a placeholder. Graph send carries the
     attachment (size-sane: refuse >8MB with a visible config error)."
     Landed as 0032 (route_guide joins the declared knowledge_category
     vocabulary; comm_preflight v4 verifies declared attachments —
     existence, linkage, 8MB ceiling), the Settings → Knowledge upload door
     (PDF ≤8MB, bytes in the private Supabase Storage `files` bucket under
     files.storage_key), the drafter's route-matched attach + file_links
     row, and Graph carriage (≤3MB inline under Mail.Send; 3–8MB via the
     upload-session flow behind the Mail.ReadWrite GO-LIVE consent).

146. **Multi-touch intro (PR-ii).** Quoted from the prompt: "The
     meta_lead_to_consultation workflow's intro step becomes config-driven
     multi-channel: email intro (with guide when published) AND, where a
     WhatsApp consent + template mapping exists, the approved enquiry_intro
     template send — two drafts, two individual stamps (113: bulk approve
     never), each WYSIWYS per its channel (118/119). Nudges unchanged. If
     the business has no WhatsApp configured, email-only, silently
     correct." Landed as step-config `companion_channels` (the executor
     drafts the WhatsApp companion from the approved template text verbatim
     where whatsapp-channel consent + the wa_template mapping exist; the
     run still blocks on the EMAIL stamp alone — decisions 48/51 hold), the
     0029 guard permitting exactly one pending per channel, and the
     `chore:install-multitouch-intro` re-issue (a NEW definition version
     through the pipeline — decision 40, never editing the active one).

147. **HTML email dress (PR-iii).** Quoted from the prompt: "Outbound
     emails gain a minimal, honest HTML wrapper: firm display name,
     regulated-status footer line rendered from Settings (v3 template), the
     body as clean typographic HTML generated from the plain-text body
     (paragraphs, links, nothing else: no marketing chrome, no images, no
     tracking pixels ever). WYSIWYS holds: the stamp view shows the
     rendered HTML the client will receive (or a faithful preview of it)
     and the plain-text alternative is generated from the same body.
     body_format moves to html for these sends; The Record stores what was
     sent. Template-rendered, never hardcoded per vertical." Landed as one
     deterministic renderer (email-html.ts) shared by the stamp preview,
     the dispatcher and the parity smoke; after a successful send the row
     records the exact dispatched document (body = the sent HTML,
     body_format = html, attributes.plain_body preserving the approved
     plain source; the compliance-check row already pins it); reading
     surfaces show the words, with an "as sent (HTML)" sandboxed view.

148. **Booking link config (PR-iv).** Quoted from the prompt:
     "businesses.settings gains booking_url. When set, [link] substitution
     in client-facing messages resolves to it (X Law will point it at its
     existing booking page); when unset, current signup-resume behaviour
     stands (the s10 JUDGMENT honoured). One door: Settings → General. The
     nurture [link] (platform-side) is NOT this and stays as-is." Landed as
     booking-link.ts (substitution at composition, so the STORED body
     carries the real URL — WYSIWYS), the generation prompts inviting the
     token only when configured, a fail-fast refusal wherever [link]
     survives with no URL configured (a client never receives a literal
     token), and the owner-gated Settings → General field. The platform
     nurture [link] is untouched.

149. **An inbound message on a channel is transactional consent to be
     answered on that channel (founder-ruled fold-in).** Quoted from the
     founder's mid-session ruling (1 August 2026): "inbound WhatsApp ingest
     creates-or-refreshes a TRANSACTIONAL consent row on the whatsapp
     channel for that contact (source: inbound_message) — transactional
     only, marketing consent untouched. Backfill the same for any existing
     inbound-bearing contacts … 'an inbound message on a channel is
     transactional consent to be answered on that channel.'" Context: found
     live — a lead-form contact's inbound WhatsApp passed the WA WINDOW
     check while the CONSENT check refused the reply draft's stamp; two
     checks disagreeing about the same fact. Landed as the pure
     whatsAppInboundConsent() merge (transactional only, prior marketing
     values pass through untouched) applied by ingest scoped to the matched
     contact, the evented `backfill:wa-consent` chore for existing
     inbound-bearing contacts, and the defect-then-law smoke.

## Hotfix (1 Aug 2026) — upload transport + guide-on-any-route-entry, ordered mid-Session-20 on founder authority

Entry 150 quotes the founder's ruling verbatim; entry 151 records the
delegated call under the same order's "Fix with judgment … your call,
stated" authority. Both landed on the s20-doors branch as the standalone
hotfix commit `ec1d8e9` (cherry-pickable onto main ahead of the session
merge); proofs ride the s20 smokes commit. Session 20's own Lane B calls
await sign-off in its close report and are NOT recorded here.

150. **A guide document rides ANY route-scoped knowledge entry — the
     matching reads route + published + file, never the category.** Quoted
     from the founder's order (1 Aug 2026): "the founder attaches guide
     PDFs to EXISTING route entries (one Spouse entry carrying text AND
     document) rather than separate route_guide rows. Ruling: the intro's
     attachment matching accepts a published, route-matched knowledge entry
     bearing a file — any category — not only category route_guide. One
     entry per route is the preferred curation shape; route_guide remains
     valid but optional. Add/adjust the smoke accordingly." Landed as the
     pure `rankGuideCandidates` (category filter removed; route priority
     then newest-first within a route, so the founder's latest curation
     carries the send — JUDGMENT at site on the tie-break, awaiting
     sign-off), the Settings → Knowledge door offering the optional PDF on
     service descriptions (route_guide still REQUIRES its document), and
     the harness proofs.

151. **The server-action transport is raised to 10mb — the 8MB attachment
     law was unreachable behind Next's 1MB default.** The founder's order
     (1 Aug 2026) reported the defect ("Body exceeded 1 MB limit", 413 on a
     1.3MB PDF) and delegated the shape: "Fix with judgment — either (a)
     raise serverActions.bodySizeLimit … or (b) … uploading from the client
     directly to Supabase Storage … Pick one, state why in one line." The
     call: (a) — the enforced law is the app's 8MB ceiling (0032 pre-flight,
     upload door, dispatch); one transport line makes it reachable tonight,
     while (b)'s signed-URL rewiring is the right shape at scale and is
     recorded as the future tightening. A harness tripwire now fails
     check-local if the transport ever again caps below the ceiling.
     *Session 21 (chore 2) confirmed this entry as the recorded future shape
     for file uploads — client-direct signed-URL upload; nothing further to
     record.*

## Session 21 (1 August 2026) — small chores sweep, the withdraw ruling recorded on in-prompt authority

Entry 152 quotes the founder's ruling in the Session 21 prompt (1 August 2026,
"founder-ruled" — the §8 quoted-approval pattern). The session's Lane B calls
await sign-off in the close report and are NOT recorded here.

152. **An owner may withdraw a pending workflow definition — terminal,
     evented, never deletable.** Quoted from the Session 21 prompt: "The
     approve/reject pipeline for workflow_definition items doesn't exist
     yet; build the minimal honest exit only: an owner may WITHDRAW a
     definition at pending_approval — terminal state, evented with a
     recorded reason, visible in Approval Inbox History, never deletable
     (the Record never purges). The inbox card for a pending definition
     gains the single Withdraw control (Approve stays absent — the full
     definition-approval pipeline remains its own later session; decision
     116: no control that cannot act)." Landed as 0034 (the `withdrawn`
     terminal state; the withdrawal triple on the row — who/when/why,
     all-or-none; the extended definition door: frozen, never deletable, no
     row born withdrawn, every 0019 refusal unchanged; the owner-only,
     reason-required `withdraw_workflow_definition()` pipeline), the
     `withdrawWorkflowDefinition` wrapper putting
     `workflow.definition_withdrawn` (key, version, reason in the payload)
     on The Record, the card's single Withdraw control gated by the pure
     `canWithdrawWorkflowDefinition` (pending + owner, the one render
     truth), and the History withdrawn arm. The dangling
     meta_lead_to_consultation v2 was NOT withdrawn by the builder — the
     founder's witnessed withdrawal through the UI is the DoD (GO-LIVE).

## Session 22 (1 August 2026) — Phase 2 completion, pre-rulings recorded on in-prompt authority

Entries 153–156 quote the founder pre-rulings for the four workstreams,
"approved in this prompt; record each as a DECISIONS candidate quoting it; do
not re-ask" (Session 22 prompt, 1 August 2026 — the §8 quoted-approval
pattern). Entry 157 quotes the founder's mid-session Workstream 5 ruling of
the same night. The session's Lane B calls await sign-off in the close report
and are NOT recorded here.

153. **The Meta Conversions loop (WS1, rulings 1a–1e).** Quoted from the
     prompt: "Outcome events to Meta via the Conversions API using the
     existing META_ACCESS_TOKEN and the lead's leadgen id (stored on the
     engagement from ingest). Event mapping, founder-ruled: stage transition
     to consultation_booked → Meta 'Schedule'; transition to instructed →
     Meta 'Purchase' with value = the engagement's recorded fee if a money
     row exists, else no value field (never invent an amount); terminal
     disqualified with junk reason → no event (we do not teach Meta our
     triage). Events fire from stage_history writes via the workflow/event
     layer — server side, never client. … SHA-256 normalised email/phone
     only; raw PII never leaves the database; the payload is recorded on The
     Record (event kind meta.conversion_sent) with the hashed fields as
     sent. … spend_records … a daily cron pull of ad spend per campaign via
     the Marketing API IF the existing token's scopes allow it; if the token
     lacks ads_read, build fail-closed with the visible skip naming the
     missing scope … (do not mint new credentials). … Settings → Integrations
     gains a Conversions row (one door): on/off toggle (default OFF until I
     flip it), test event code field … connection state honestly read.
     Everything evented. … conversions fire only for engagements whose source
     is Meta and whose business has the toggle on. A send failure is a
     recorded, visible, retryable event — never blocks the stage transition
     itself." Landed as conversions.ts (the ruled mapping in one named
     place, the tick-riding sweep + the fire_conversion executor going real —
     the Session 6 meta.signal_stubbed STUB retires), pullMetaSpend
     (spend_records' first producer), and the Conversions row.

154. **Billing & usage + credit caps (WS2, rulings 2a–2c).** Quoted from the
     prompt: "The Billing & usage page goes real: monthly metered spend from
     events.cost (the s15 producer), by day and by action kind, the tile
     reading the same truth. Pricing display in the business's currency at
     our recorded cost — no margin invented; pilot pricing is a founder
     decision later, so label the figures 'metered cost' honestly. …
     businesses.settings.ai_budget gains soft_cap and hard_cap (monthly,
     owner-set, both optional). Soft cap crossed = a visible banner on
     dashboard + Billing and an event; hard cap crossed = generation refuses
     with a visible failed/blocked step naming the cap (the s15
     provider-failure lane — never a silent stub), workflow sends that need
     no generation continue, and the approval gate is untouched. Enforcement
     server-side in the drafting path (the doctrine's budget line), not
     client. … No payment collection here — the meter and caps only." Landed
     as the priced cost block (model-router pricing beside the model ids,
     both generation producers), ai-budget.ts (guardGenerationBudget in both
     drafting callers; billing.soft_cap_crossed once per month), the real
     Billing page and the caps door.

155. **The Light performance tile (WS3).** Quoted from the prompt: "one
     dashboard tile reading existing truth only: drafts generated this week,
     approval rate (stamped vs rejected), edit-before-stamp rate, compliance
     refusals count, mean tokens per draft, spend this week — all derivable
     from events + draft_feedback + communications statuses. No new stores,
     no model calls, honest empty states. This tile is my shadow-exit
     calibration instrument." Landed as light-performance.ts (pure, proven
     against a constructed fixture) + the dashboard tile with counts from
     COUNT aggregates.

156. **The mobile/responsive sweep (WS4).** Quoted from the prompt:
     "solicitors stamp from phones. Scope: Approval Inbox (cards, credit
     line, compliance chip, Approve/Edit/Reject usable one-handed),
     Conversations (thread view, composer, drafting register), Dashboard
     (tiles stack), Settings (tabs usable), sign-in. Breakpoint discipline
     per the existing design system; no feature changes, no new components
     beyond responsive variants; the master-mockup remains design authority —
     where it shows no mobile answer, follow its spirit and mark a JUDGMENT.
     … list any surface deliberately left desktop-only with reason (The
     Record's dense ledger may be one — say so rather than mangling it)."
     Landed as thumb-height responsive variants on the button/tab
     primitives, the one-handed stamp row, and the stacking already carried
     by the shell's sub-880px drawer; The Record's dense ledger is the
     declared desktop-only surface.

157. **The read-layer diet (WS5, founder-ruled mid-session), and THE LAW
     (5e).** Quoted from the founder's message (1 August 2026): "5a. Approval
     Inbox: server-side pagination, oldest-wait-first (submitted_at per
     D134), default 20, selector 10/20/50. The bulk-reject path must operate
     on the full filtered set server-side, not the visible page … 5b. The
     Record: windowed reverse-chronological infinite scroll, day-anchored, no
     page numbers; each window a bounded query. 5c. Conversations: thread
     list windowed; within a thread load the recent tail and fetch older on
     upward scroll … 5d. Contacts, Enquiries pipeline lists, Approval
     History: server-side pagination, default 20. 5e. THE LAW (record as
     DECISIONS candidate): any count shown anywhere (sidebar badges,
     dashboard tiles, performance tile) derives from count aggregates, never
     from fetching rows to count them; and no list surface fetches unbounded
     rows. Add a smoke pinning the inbox query's bound." Landed: 5a, 5d and
     5e this session (read-policy.ts is the policy's one home; the harness
     pins the inbox bound with a file tripwire; the bulk refusal gained the
     server-side full-set scope). 5b and 5c were NOT built — closed honestly
     at the last complete piece per the same ruling; their pre-ruled shapes
     stand for their own session.

## Session 23 close (2 August 2026) — deferred ruling recorded on founder authority

Entry 158 quotes the founder's post-close message verbatim ("RECORD AS
DEFERRED RULING (next product session's opening workstream; found live by
founder test)") — the decision 133 shape: recorded so the repo carries the
fence; NOT built in Session 23. The session's own Lane B calls remain in the
close report awaiting sign-off and are not recorded here.

158. **DEFERRED RULING — RETURNING LEADS (the next product session's opening
     workstream; found live by founder test).** Current behaviour: a lead
     submission resolving to an existing contact whose trigger was already
     consumed produces nothing visible — correct as replay protection (the
     0038 consumption law), wrong as product: a resubmission is the
     highest-intent signal in the funnel and must never be silent. Quoted
     from the founder's ruling (2 August 2026):
     "(a) A form submission resolving to an existing contact posts a system
     marker message into that contact's existing thread (neutral chrome — it
     is a fact): form name, date, submitted details, changed fields
     highlighted; thread to top, unread badge, arrival sound.
     (b) The consumption frontier's unit is refined: consumption blocks
     RE-PROCESSING OF THE SAME SUBMISSION (same leadgen id), never a NEW
     submission by a known contact — a new leadgen id on a known contact is
     a returning-lead event, always processed.
     (c) Light drafts a returning-lead reply on the existing thread (settle
     window + stamp as ever) with returning context in the prompt:
     acknowledge prior contact, reference their route, no cold-intro
     re-send, no duplicate booklet.
     (d) Enquiry linkage: open enquiry → resubmission events onto it;
     closed/unresponsive enquiry → new enquiry created and linked to the
     predecessor, visible on both timelines.
     No auto-send anywhere; the marker is internal, the reply is stamped."

## Post-close rulings (2 August 2026) — attachment honesty, enquiry
## truth-timing, route classification — recorded on founder authority

Entries 159–161 quote the founder's post-close message verbatim ("RULINGS
from live testing (record now, build next session, alongside DECISION 158's
returning-leads workstream)") — the §8 post-close pattern, the D133/D158
deferred-ruling shape: recorded so the repo carries the fence; NOT built
here. They join D158 as the next product session's opening workstreams.

159. **DEFERRED RULING — ATTACHMENT HONESTY CHECK (pre-flight tightening,
     deterministic, prophylactic — no live breach observed, the risk is
     structural).** Quoted from the founder's ruling (2 August 2026): "a
     draft body referencing an attachment ('attached', 'enclosed',
     'attachment' pattern register) while the communication carries no
     attachment FAILS pre-flight with the mismatch named. Generation
     prompt additionally instructed: reference an attachment only when
     one is attached. Attachment-present-but-unmentioned is fine."

160. **DEFERRED RULING — ENQUIRY PAGE TRUTH-TIMING.** Quoted from the
     founder's ruling (2 August 2026): "the enquiry detail rendered
     'Route not yet classified' and a draft body WITHOUT surfacing that
     the draft carried an attachment, minutes after the inbox card showed
     both route-matched pack retrieval and the attached PDF. Diagnose: is
     route classification asynchronous to ingest (and the page honest but
     early), or was the page stale? Fix whichever is true: the enquiry
     timeline's draft entry must show attachment state, and if
     classification is async, the page says 'classifying' rather than
     'not yet classified' while a run is in flight."

161. **DEFERRED RULING — ROUTE CLASSIFICATION, COMPLETE SHAPE.** Context,
     founder re-checked post-draft: enquiry 019fc32a still reads "Route
     not yet classified" while the draft retrieved the Spouse pack and
     attached the Spouse guide — retrieval matched by text relevance, not
     the route field. Quoted from the founder's ruling (2 August 2026):
     "Build the full ladder, with provenance recorded on the field
     (source: human | form_answer | light | form_default) and precedence
     human > form_answer > light > form_default:
     (a) PER-FORM DEFAULT: Settings gains per-form-id default route
     mapping; a form with no route question ingests its default. The
     live Spouse Visa 23/04/2024 form defaults to spouse.
     (b) LIGHT CLASSIFIES: when the route is unset or default-sourced
     and Light's drafting context gives it a confident read (form name,
     form answers, the person's own words), Light SETS the route —
     evented with its stated reason on The Record, gold chip on the
     enquiry ('route: Spouse · set by Light — "form and enquiry text
     reference spouse visa"'). Light never overwrites a human- or
     form-answer-sourced route. No extra model call: the classification
     rides the existing drafting call's output.
     (c) HUMAN RECLASSIFY: the enquiry detail's route field becomes
     editable by any team member with enquiry access — dropdown of the
     template's routes, change evented with optional reason ('caller
     actually needs ILR'). A human-set route is final against machine
     writes. Reclassification does NOT retro-edit past drafts; future
     retrieval follows the new route.
     (d) Verify from the ledger WHY the classifier never wrote the field
     for 019fc32a while you are in there; if a distinct bug sits beneath
     (never ran vs ran and abstained), name it."
162. communication.send_failed joins the Approval Inbox History event set. History is events-based; failed dispatch is a decided fact and renders red with recorded reason. No parallel query.

163. Retry of a stamped-but-failed communication resets scheduled_for to null. Dispatch policy (quiet hours, Send-now override) re-applies fresh at retry time. WYSIWYS freezes the body and stamp, never carriage timing.

164. Draft-refusal surfacing splits by entity: comm_thread refusals render in the conversation flow; workflow_run refusals render on the enquiry timeline only. A run refusal names no channel — pinning it to a thread would misattribute it.

165. "Ask Light to draft again" is a live control only on comm_thread refusals. workflow_run refusals carry no control (per 116 — no dead controls).

166. Only a standing (flow-closing) refusal offers the manual re-draft door. A transient refusal states that Light retries automatically — no door, no duplicate-draft invitation.

167. Automatic register retry-once applies to initial composition only. A register breach during post-insert compliance retry leaves attempt 1's recorded breach standing visible, per the existing lane.

## Session 26 (3 August 2026) — strategy amendment, recorded on in-prompt authority

Entry 168 is quoted verbatim from the Session 26 prompt (3 August 2026 — the
§8 quoted-approval pattern, the entry-113 in-prompt-authority precedent:
"this ruling is quoted verbatim and founder-approved; you may and must write
it").

168. Go-to-market re-sequenced; the paid-pilot-firms phase is
     withdrawn. The order is now: (1) the founder's own projects run
     live on the platform; (2) friends' firms onboard at a minimal
     price; (3) general availability. Build-out continues before
     external opening, and the previously pilot-gated workstreams
     (MCP server over Barakah, website auditing + publish gate,
     Studio media generation, payment gate) move onto the pre-world
     build path. Each gate between phases opens on explicit
     GO-LIVE-style criteria recorded in advance — never on feel. The
     friends-phase entry criteria and pricing are ruled before that
     phase begins, not during it. Autonomous outreach remains refused
     permanently; the approval gate and D113 are untouched by this
     re-sequencing.

## Session 26 close rulings (3 August 2026)

Entries 169–171 are the founder-approved wordings from the Session 26 close
review, appended by docs chore on in-prompt authority (the entry-113
quoted-approval precedent).

169. The nudge ladder is re-ruled (3 Aug 2026): nudge 1 T+1d WhatsApp
     (email fallback), nudge 2 T+3d email, nudge 3 T+6d final email, close
     wait 3d — auto-close ≈T+9d. Waits sequential after the intro stamp and
     cancel-on-reply; the decision 96 refusal untouched. Landed as a
     re-issue through the definition pipeline (40/102) via
     chore:reissue-nudge-ladder — v5 active under the founder's stamp; the
     first chore run's v4 staging was withdrawn as superseded after npm
     swallowed the approval flag. Nurture step keys rename to their true
     T-offsets; message-template keys are stable identities and keep the
     approved wa_template binding.

170. The unset-business quiet-hours default resolves from the installed
     template's declared business_identity.defaults.quiet_hours — one
     source; vertical content renders from the template, never product
     chrome. QUIET_HOURS_DEFAULT remains only as the last-resort fallback
     for install-less businesses. A firm-set window always wins; explicit
     null disables; a malformed declaration falls to the constant, never
     disables the hold. The dispatch hold and Settings → General read one
     resolver.

171. A Record row's click target expands the entry in place; where an
     entry leads is a labelled button inside the expansion, never the row's
     click target. The expansion shows the entry's register facts —
     recorded instant, entry id, concerned entity, cost, payload verbatim —
     in the ledger's own face.

## Session 27 close rulings (4 August 2026)

Entries 172–173 are the founder-approved wordings from the Session 27 close
review, appended by docs chore on in-prompt authority (the entry-113
quoted-approval precedent).

172. RECORDED FACT — the D160/D161(d) diagnosis: enquiry 019fc32a's route
     field was never written because no classifier existed; nothing in the
     codebase wrote visa_route before Session 27 — every surface only read
     it. The intro draft's route-matched appearance was matchRoutes()
     text-matching for retrieval and guide selection, living only on the
     credit line. The page was neither stale nor early: it honestly
     rendered a field no machinery would populate. Additionally recorded:
     before Session 27, a new leadgen id from a known contact created a
     duplicate contact, enquiry and thread — the returning-leads engine
     replaces exactly that path.

173. Session 27's eight Lane B calls, approved as one entry: (a) the
     closed fork's returning draft IS the successor run's intro step
     composed with returning context — the run drives, no cold intro may
     compose, nudges anchor on its stamp (48); (b) ambiguous contact
     matches resolve to no one — email exact then phone, two-plus contacts
     behind a channel falls through, still-ambiguous processes as a fresh
     lead; identities never merge on a guess; (c) "the contact's existing
     thread" resolves as the target enquiry's ingest-created email thread
     first, else the contact's most recently active thread; (d) open-fork
     form_answers move to the newest submission; the ledger event keeps
     the previous values; (e) the WhatsApp companion stands down for
     returning leads — it carries the approved cold-intro template
     verbatim (118/119); recorded in the step outcome (146); (f) the
     marker rides the 0008 internal direction with no schema change;
     predecessor_engagement_id is a first-class column; route provenance
     rides attributes.visa_route_source guarded by trigger, value key
     unchanged; (g) "while a run is in flight" reads as "while a
     classification may still arrive" — a run that drafted and abstained
     shows "not yet classified", never an indefinite "classifying";
     (h) D161(a)'s "spouse" maps to the declared key spouse_family — the
     installed vocabulary wins over the ruling's shorthand.

174. **Returning-lead channel handling, refined.** In-prompt authority,
     the entry-113 precedent — founder-ruled 4 August 2026, quoted
     verbatim: "(a) resolution keys on channel values (email, phone)
     only — the submitted name is never consulted and a changed name
     never blocks resolution; the marker highlights it as a changed
     field. (b) A returning match on one channel that presents a NEW
     value on the other channel adds that value to the matched contact
     as an additional channel — consent carried from the form, evented
     with provenance — and the conversation continues on the existing
     thread; successful resolution never opens a new thread. (c) A
     cross-channel conflict — the email resolving to one contact and
     the phone to a different contact — is ambiguity and resolves to no
     one: fresh lead, identities never merged on a guess (173b). (d) A
     new value belonging to no contact is enrichment (b); a new value
     belonging to another contact is conflict (c)."

## Session 28 close ruling (5 August 2026)

175. Session 28's Lane B calls, approved as one entry: (a) D174(d)
     reads literally — a new channel value belonging to one OR
     several other contacts is conflict; only an unknown value or
     one the matched contact already holds leaves the match
     standing; (b) enrichment rows insert is_primary false — the
     ruling grants an additional channel; primacy stays a human
     call; (c) search legs cap at 50 surfaced matches each (WS4f
     precedent) — the entire set is always queried, the cap bounds
     only the page. Additionally recorded: Conversations carries
     the same page-local search defect (found at s28 pre-close,
     Lane C); queued, not fixed here.

176. Close bookkeeping, amended (5 August 2026): a session prompt
     may carry standing authority for the builder to append ONE
     consolidated DECISIONS entry at close recording that session's
     Lane B judgement calls, worded as the close report's
     recommendations and marked "(provisional — the founder's merge
     is the stamp, D152 pattern)". The founder reads the close
     report, amends or strikes any call, and the hand-merge
     finalises the entry; an unmerged provisional entry has no
     force. Entries carrying founder rulings made in chat continue
     to require quoted in-prompt authority (the entry-113
     precedent). The direction of authority is unchanged: nothing
     becomes a ruling without the founder's hand.

## Session 30 (6 August 2026) — thread-list, rejection, contact and
## enquiry controls — recorded on in-prompt authority

177. **Thread-list, rejection, contact and enquiry controls, ruled.**
     In-prompt authority, the entry-113 precedent — founder-ruled
     6 August 2026, quoted verbatim: "(a) a Conversations thread row
     carrying a draft awaiting the stamp shows a GOLD pending-stamp
     indicator, distinct from the accent unread badge for client
     inbounds — a glance distinguishes 'a client waits on you' from
     'Light waits on you'; both may coexist on one row. (b) A rejected
     draft renders its rejection wherever the draft appears — thread
     bubble and enquiry timeline — in the stamp red with the recorded
     reason ('Rejected by [name] · [reason]'); rejection is the stamp
     withheld and wears the stamp's colour. (c) Contacts gain an
     ARCHIVE control — owner-only for now, evented with optional
     reason; an archived contact leaves resolution and its channels
     leave consent, while its history stands untouched; deletion does
     not exist (append-only). (d) Disqualifying an enquiry CANCELS its
     live workflow run — drafts stop being generated, not merely
     blocked at pre-flight. (e) The enquiry timeline renders NEWEST
     FIRST — the timeline answers 'what just happened'; the opening
     events belong at the bottom once history exists. (f) The enquiry
     stage becomes HUMAN-MOVABLE: the enquiry page gains a stage
     control — any team member with enquiry access moves the stage,
     evented with optional reason; the vocabulary is the installed
     template's stages plus its terminal states (disqualified with
     reason among them). A human move is a recorded fact the workflow
     respects; machine stage moves continue as today and never
     overwrite a later human move."

178. Session 30's Lane B calls, consolidated (provisional — the
     founder's merge is the stamp, D152 pattern): (a) the
     Conversations search's channel leg includes 'whatsapp' beside
     email and phone — Conversations is the surface where a
     WhatsApp-held number IS the identity (inbound matching already
     treats whatsapp+phone as one family); the s28 Contacts legs
     stay email/phone. (b) 177f's "never overwrite a later human
     move" reads as WHO SPOKE LAST: when the engagement's latest
     stage move was made by a human hand, a machine move_stage/close
     step stands down (skipped, its reason on the step outcome —
     the decision-15 visibility); enforced in the engine because the
     rule weighs the machine's intent against the human's recorded
     act — the 0016 door and 0015 grant check stay the database
     truth beneath; the 0022 contacted trigger is untouched (it
     moves only new_lead→contacted). (c) 177c's owner-only gate is
     app-level for now (pure canArchiveContact + the action's
     membershipRole check — the 0037 manager-gate precedent);
     archived_at cascades to every live channel row so every
     resolver and the 0043 consent pre-flight exclude the contact
     with zero query changes; a database door for the owner gate is
     a natural later hardening if ordered. (d) the WhatsApp
     env-provenance state wears the green connected chip reading
     "connected · env" — a real, working connection earned by a
     live credential-presence read (boolean, never a value — the
     s20 wiring-state law); a grant, when one exists, outranks env
     as the named provenance. (e) in Conversations, an explicitly
     opened thread stays open across a search change; a new query
     restarts the list at page 1 (the s28 pattern). (f) the stage
     control renders for any signed-in member (the D161c
     route-control precedent on the same page — the 0015 grant
     check refuses ungranted actors regardless); the vocabulary is
     the full installed set, moves out of a terminal stage
     permitted wherever the 0016 door permits them. (g) WS B4 swept
     two adjacent stale two-theme lines in the same files
     (ui-system frontmatter and "both themes"; the handover
     template's theme checkbox) under the same decision-62
     authority.

## Session 31 (6 August 2026) — drafting quality: fees out, follow-up
## nudges, route-coherent retrieval — recorded on in-prompt authority

179. **Drafting quality, ruled.** In-prompt authority, the entry-113
     precedent — founder-ruled 6 August 2026, quoted verbatim: "(a) FEES
     NEVER APPEAR in machine-drafted client-facing messages — no
     consultation prices, no service fees, no 'from £X'. Drafts invite
     the next step ('if you would like to speak to our legal team, the
     next step is booking a consultation') with the booking link; fees
     live on the booking page and in human-written messages only. The
     generation prompts forbid it, the templates carry no figure, and a
     deterministic pre-flight screen refuses a draft body containing a
     currency-amount pattern, mismatch named. (b) NUDGES ARE FOLLOW-UPS,
     not re-introductions: nudge composition receives a summary of what
     the thread has already been sent and is instructed — never
     re-introduce the firm, shorter than the intro, acknowledge we wrote
     before. (c) RETRIEVAL AND ATTACHMENTS FOLLOW THE RESOLVED ROUTE:
     route resolution (including Light's confident read over an unset or
     form_default source, per 161) completes BEFORE composition;
     knowledge-pack retrieval and booklet selection key on the resolved
     route, never on raw text-matching alone. When the route is unset
     and Light's read is not confident, no route-specific booklet
     attaches and the draft stays route-neutral — a missing booklet is
     recoverable; a wrong one is not."
     Builder bookkeeping (dated 6 August 2026): the Session 31 prompt
     numbered this ruling 178; entry 178 was already occupied by Session
     30's provisional entry, finalised by the founder's merge, so the
     ruling is recorded here as 179 — the ruling's text is untouched.

## Session 32 (6 August 2026) — Light's Memory — recorded on in-prompt
## authority

180. Session 31's Lane B calls, approved as one entry: (a) the
     drafting-quality ruling records as 179 (178 occupied); (b) the
     pre-compose route read is its own floor-tier call, superseding
     161b's ride-along clause — evented, priced, budget-guarded,
     firing only over unset/form_default; (c) a form_default route
     with an unconfident read stands; (d) published_fees is withdrawn
     from retrieval; the lagging installed no-go rule 3 re-issue is
     queued; (e) a fee breach takes the register retry-once lane;
     (f) the runtime fee screen scopes to generated bodies,
     founder-authored templates guarded by the pinned harness sweep;
     the nudge sent-summary reads engagement-wide across channels.

181. **LIGHT'S MEMORY, ruled (6 August 2026):** everything Light knows
     that is not a database fact is a MEMORY ENTRY — readable,
     editable, evented; nothing about how Light behaves lives
     hardcoded. Memory has two parts:
     (a) FACTS (proactive): business facts — opening hours, phone,
     booking link, address and their kin — each carrying a declared
     SURFACES LIST naming where the fact appears in the world:
     in-platform surfaces Light can reach (message templates,
     knowledge entries, and later the website) and external
     surfaces it cannot (Google Business Profile, directories).
     Editing a fact triggers the RIPPLE SWEEP: for every
     in-platform surface carrying the stale value, Light drafts
     the correction into the Approval Inbox — stamped as ever,
     never auto-applied; for every external surface, a task is
     raised naming the manual change owed. The sweep is evented as
     one act ("hours changed: N corrections proposed, M manual
     tasks raised"). A connected external surface later moves from
     the task column to the draft column; the model is unchanged.
     (b) BEHAVIOUR: standing instructions (tone, rules, signature)
     and learned observations. Active instructions ride every
     composition; the credit line records WHICH memory entries
     rode, so The Record answers "why did Light say that" by name.
     Rejection reasons surface in Memory as observations; PROMOTION
     to a standing instruction is a human act, one click, evented —
     Light never self-writes an instruction.
     Memory edits take effect on the next draft — no build, no
     re-issue. Memory history is append-only: an edit supersedes,
     never overwrites. Standing instructions carry a token ceiling
     (800 tokens ruled; the surface shows the count and refuses
     past the cap rather than silently degrading every draft).
     Knowledge packs remain route knowledge; Memory is behaviour
     and facts, beside them.

182. Session 32's Lane B calls, consolidated (provisional — the
     founder's merge is the stamp, D152/D176 pattern): (a) fact
     identity rides attributes.fact_key, with ONE ACTIVE fact per key
     per business enforced by a partial unique index — two active
     booking-link facts would be two homes, the drift the laws forbid;
     (b) the supersede performs flip-first (deactivate the predecessor,
     insert the successor, chain once) because the fact index and the
     instruction ceiling both count the predecessor while it stands; a
     failure after the flip leaves the entry retired with its wording
     in history and the error saying so; reactivation does not exist —
     restoration is a fresh superseding entry; (c) a rejection
     observation is authored by the REJECTING HUMAN (the reason is
     theirs, verbatim) with the draft_feedback row as structured
     provenance — only instructions are human-gated in the database;
     (d) promotion SUPERSEDES the observation with the instruction it
     became, so one chain records the graduation; (e) a sweep
     correction drafted against version N refuses to apply over any
     other version (re-issued template, edited entry), both versions
     named — applying blind would overwrite work the stamp never saw;
     (f) a declined correction lands content state `unpublished` (no
     new enum) with the rejection triple recorded and evented, the
     surface untouched; (g) sweep corrections and tasks are CREATED BY
     Light (the ruling's own grammar — the inbox card wears the gold
     drafted-by chip) and tasks are ASSIGNED to the human who edited
     the fact; declared website surfaces defer visibly on the sweep
     event, raising nothing; (h) the seed skips any identity key that
     has EVER existed (a founder's later edit or deactivation is never
     argued with), reports valueless facts as visible skips, formats
     opening hours en-dash-free ("09:00 to 17:00 (Europe/London)") so
     the fact can ride drafts under D142, and seeds hours only when
     firm-set — the shipped default window is dispatch policy, not a
     client-facing fact; (i) the Settings faces write memory FIRST and
     then retire the legacy settings copies on every save (a stale
     copy would resurface through the transitional fallback); clearing
     the booking link deactivates its fact; (j) the s18/s31 harness
     compose fixtures now carry the seeded memory, so the existing
     D179a/D142 prompt pins prove the memory-riding path the product
     actually runs; (k) on the Memory surface observations and the
     Promote act wear GOLD (Light's channel — Light's bookkeeping of
     human refusals); no stamp lives on that screen, so red would
     overclaim — sweep corrections take their red-adjacent stamp in
     the Approval Inbox.

## Docs chore (8 August 2026) — bookkeeping pair, recorded on
## in-prompt authority

Entry 183 is quoted verbatim from the docs-chore prompt (8 August 2026 —
in-prompt authority, the entry-113 precedent; founder-approved 7 August
2026). It fills the gap the s33 append recorded as unassigned for the
founder's pen.

183. Bookkeeping pair, ruled: (a) PLAYBOOK §7's protected-structures
     list gains the Session 32 memory enforcement — the
     memory_entries append-only supersede chain, the human-author
     gate on instructions, and the 800-token active-instruction
     ceiling (0044). (b) The canonical judgment mark is the exact
     string "JUDGMENT:" — variants (e.g. "JUDGMENT (Lane B):")
     evade the pre-close collector and are non-marks; the collector
     greps the canonical string only. Recorded after a session-30
     mark was missed for this reason.

## Session 33 (7 August 2026) — quiet hours: the choice at the stamp —
## recorded on in-prompt authority

Entry 184 is quoted verbatim from the Session 33 prompt (7 August 2026 —
the §8 quoted-approval pattern, the entry-113 in-prompt-authority
precedent: founder-ruled, quoted verbatim). Builder bookkeeping (dated
7 August 2026): the prompt numbers this ruling 184; no entry 183 exists at
the time of writing — the number is recorded as ordered and 183 stays
unassigned for the founder's pen.

184. Quiet hours, re-ruled: (a) RECORDED FACT — drafting is never
     gated by quiet hours and never was; the hold binds dispatch
     only, after the stamp. (b) Quiet hours can be TURNED OFF
     entirely: Settings → General offers "No quiet hours" as a
     first-class choice (the 170 explicit-null path), owner-set,
     evented — a firm working deportation cases at midnight sends
     at midnight. (c) THE CHOICE AT THE STAMP: approving a
     communication while the destination's quiet window is active
     surfaces a dialogue naming the window ("Quiet hours until
     08:00") with two acts: SEND NOW (the stamp plus the evented
     override, as the s24 override today) or APPROVE AND SCHEDULE
     (a time picker defaulting to the window's end, any future
     time allowed; the stamp lands with scheduled_for set; dispatch
     carries it at the chosen time). Nothing silent: the silent
     hold-until-window is retired in favour of the explicit choice;
     WYSIWYS holds — the scheduled body is the stamped body;
     rejection needs no dialogue. (d) The thread's inline approve
     and the inbox card share the one dialogue; bulk approve
     continues not to exist.

185. Session 33's Lane B calls, consolidated (provisional — the
     founder's merge is the stamp, D152/D176 pattern): (a) D163 at the
     marker: the 0040 retry door nulls scheduled_for but leaves
     attributes untouched, so a pre-retry Send-now/schedule marker
     would dodge the hold forever — "policy re-applies fresh at retry
     time" is implemented as pure dispatcher logic
     (honourQuietHoursOverride): a quiet_hours_override marker older
     than the row's latest send_retry is SPENT, and a marker that
     cannot prove it postdates the retry fails towards the hold; no
     migration, both markers stand verbatim on the record. (b) The
     schedule choice's write rides the SERVICE client immediately
     after the DB-enforced stamp by the same actor (the dispatcher's
     own hold-write lane): scheduled_for plus the 0039-shaped marker
     ({by_actor_id, at, scheduled_for}) — ONE marker vocabulary, so
     the dispatcher has one rule; timing only, the 0021 doors remain
     the only status movers; evented as communication.scheduled (a
     new TS kind under the decision 89d registry). (c) The D184c gate
     sits BEFORE the sign-off resolution, so a withheld stamp writes
     NOTHING — not even the fresh compliance check. (d) AMENDED by
     founder fix-request at click-review (7 August 2026), superseding
     the builder's original call: "No quiet hours" is a DISPATCH
     choice only — it must NOT retire the client-facing opening-hours
     memory fact; a firm may dispatch any hour and still open 9–5.
     The fact ripples to Google Business Profile and stands until
     edited or retired in Light's Memory itself; only the reset lane
     retires it (the shipped default window is dispatch policy, not a
     client-facing fact). The Settings row states both truths ("Quiet
     hours off — stamped mail dispatches immediately, any hour ·
     Opening hours unchanged: [fact value]").
     (e) "The silent hold is retired" reads as retired ON THE STAMP
     SURFACES: the dispatcher's hold branch remains the policy
     backstop for rows arriving approved without a choice — retries
     re-entering policy per D163, and any non-UI approval path — and
     the s24 held-card (with its Send now) stays as the fallback for
     the race where the window becomes active between the gate and
     the inline dispatch.

## Micro-fix (7 August 2026) — WhatsApp channel at ingest, recorded on
## in-prompt authority

Entry 186 is quoted verbatim from the micro-fix prompt (7 August 2026 —
in-prompt authority, the entry-113 precedent; number taken from the file's
tail as instructed).

186. WhatsApp consent at ingest, ruled: a Meta lead-form
     submission creates a WHATSAPP channel beside phone and email,
     consented (transactional + marketing), consent source
     meta_lead_form — on the founder's recorded basis that the
     form's privacy-policy gate is explicit consent to be
     contacted and a submission cannot arrive without it. Ingest
     is idempotent against an existing whatsapp channel for the
     same value. Consent remains per channel; nothing else about
     the consent model moves.

## Chore (7 August 2026) — WhatsApp channel backfill, recorded on
## in-prompt authority

Entry 187 is quoted verbatim from the chore prompt (7 August 2026 —
in-prompt authority, the entry-113 precedent; number taken from the
file's tail as instructed).

187. The D186 WhatsApp-at-ingest ruling extends retroactively by
     one-off evented backfill: every live contact holding a
     consented phone channel with consent source meta_lead_form
     and no whatsapp channel gains a whatsapp channel for the same
     value, same consent shape, source meta_lead_form, with
     provenance naming the backfill and the original grant date.
     The basis is D186's: these contacts all arrived through the
     same form whose privacy-policy gate is explicit consent.
     Contacts whose phone consent has any other source are NOT
     touched — the basis does not cover them.
