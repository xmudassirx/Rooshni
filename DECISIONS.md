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
