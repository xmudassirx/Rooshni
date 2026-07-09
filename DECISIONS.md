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
    of both conditions failing (Deployment Protection comes OFF production at
    this session's sign-off). See decision 24.

## Session 5 (9 July 2026) — authentication (pending Mudassir's sign-off)

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

26. **Auth events on the ledger: sign-ins yes, denials not yet.**
    `auth.signed_in` (at the OAuth callback) and `auth.signed_out` (before
    the session is destroyed — a signed-out client can write nothing) are
    emitted via emitEvent, attributed to the signer's own actor in their own
    business. A DENIED sign-in writes nothing: events require a business_id
    and an actor_id, and a stranger belongs to no business — recording
    denials would need a platform-level system actor and a home business,
    which is a schema-level call deferred to Mudassir (flagged at this
    session's hand-off).
