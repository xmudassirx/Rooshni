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
