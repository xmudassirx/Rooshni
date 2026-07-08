# Approval Inbox Implementation Plan (Session 3)

**Goal:** The Approval Inbox as a *view* over Spec 4's pending states (Spec 3 §6, decisions 8 and 11): communications and content in `pending_approval` plus tasks in `awaiting_approval`; deterministic readiness pre-flight so the Approve control is earned, never assumed; approve/reject as gated Level 3 acts through a closed pipeline, evented via `emitEvent()`; rejection requires a reason, recorded.

**Architecture:** One migration (`0017_approval_inbox.sql`) following the Session 2 stage-door precedent (DECISIONS.md 12): `communications.status`, `approved_by_actor_id` and the new rejection columns are closed to direct UPDATE for every API role; the single paths are `public.submit_communication()`, `public.approve_communication()` and `public.reject_communication()` — security definer, caller-identity checked, with every existing trigger (human stamp, grants, and the new pre-flight) still firing inside. `public.approval_inbox` is a `security_invoker` view — RLS of the underlying tables decides visibility; the inbox is a view, not a place things live. Events are emitted by the TS layer (`@rooshni/db` helpers) through `emitEvent()` only — no DB-trigger event writes, per CLAUDE.md.

**Design reference:** `docs/mockup-pass1-shell-pipeline-case.html`, Approval Inbox screen — pre-flight line (consent/standards/compliance ticks), Blocked state with a fix action, drafted-by gold tag, openable preview.

## Global constraints (unchanged)

- One database, many faces — the inbox is a view over the same rows (Spec 3 §6: "the inbox is a *view*, not a place things live").
- Approval is structural; the ledger is append-only; RLS on every table; events only via `emitEvent()`.
- Migrations immutable once applied — new file `0017` only.
- British English in user-facing strings (exception messages count).
- check-local green before anything touches live.

## Judgment calls to present for sign-off (do NOT write DECISIONS.md until approved)

1. **The approval door is closed like the stage door.** Direct UPDATE of `communications.status`, `approved_by_actor_id`, and the rejection columns is revoked for every API role; transitions run through `submit_communication` / `approve_communication` / `reject_communication`. Consequence noted: marking `approved → sent` will need its own pipeline function when the send pipeline is built — that session inherits a locked door, not a gap.
2. **Rejection is recorded on the row and the ledger.** Three columns added to `communications` (`rejected_at`, `rejected_by_actor_id`, `rejection_reason` — all-or-none constraint); Spec 1 §4.4 did not enumerate them, same class of addition as `content_versions.business_id` (DECISIONS.md 4). Reject returns the item to `draft` — Light's queue state — and the reason also travels to the ledger via `communication.rejected` (emitEvent).
3. **Rejecting requires the same authority as approving** (human + `approvals.comms` execute, or owner): refusing the stamp is exercising stamp authority. Spec 3 §6 lists Reject among the approver's one-tap actions.
4. **Phase 1 pre-flight check set** — everything deterministically checkable in the database today: (a) body present; (b) no unresolved `{{…}}` template variables; (c) per-channel consent on file (email→email, whatsapp→whatsapp, sms/call→phone; meeting/portal have no consent dimension yet); (d) a body that references an attachment (attach/enclos…) must actually have one (`file_links`). Link resolution and no-go/standards compliance are not deterministically checkable in SQL — they arrive with the app layer/Light; the mockup's STANDARDS/COMPLIANCE ticks are theirs. Enforcement is a trigger on any transition into `approved`/`sent` — approving broken things is impossible, not discouraged (Spec 3 decision 11).
5. **Inbox contents Phase 1** = pending communications + pending content + awaiting-approval tasks. Spend gates and grant requests (Spec 3 §6) join the view when the spend pipeline and the grant-request flow exist — nothing about the view shape blocks that.
6. **Insert-at-approved stays legal** for an authorised human (drafting and approving your own message in one act — e.g. Mudassir writing an email from Conversations); every trigger, pre-flight included, fires on that insert. The closure is on UPDATE transitions, where an approval identity could otherwise be smuggled onto someone else's draft.
7. **Seed demonstrates the full trail in dev**: Light drafts three messages through the real pipeline; one stays pending (the inbox demo), one is approved as Mudassir, one is rejected as Mudassir with a reason — exercising rpc + `emitEvent` + `approval_event_id` end to end. Dev-only demonstration data, on the go-live purge list.

## Tasks

### Task 1 (RED): check-local — failing inbox tests
- Fixture: consent-bearing email channel on the test contact (pre-flight will demand it at insert-into-`sent` too); a no-consent contact + thread; Session 3 test section: view membership (draft out, pending in), column closure under both API roles, pipeline happy path (submit → approve by owner), refusals (agent approver, non-pending item, ungranted human rejecter), pre-flight blocks (consent, attachment, placeholders) each with its fix-action resolution, reject-requires-reason, content + task rows in the view, stranger sees an empty inbox.
- Run: fails on missing view/functions. Existing tests stay green.

### Task 2 (GREEN): migration `0017_approval_inbox.sql`
- Rejection columns + all-or-none constraint.
- `private.comm_preflight(business, contact, channel, body, comm)` → jsonb checklist; `public.preflight_communication(comm uuid)` wrapper (member-checked); `communications_preflight` trigger on transitions into `approved`/`sent` (outbound only).
- Column privileges: revoke UPDATE on `communications`, re-grant everything except `status`, `approved_by_actor_id`, `rejected_*`.
- Pipeline functions (security definer, `set search_path = ''`, caller-identity checks per `move_engagement_stage`).
- `public.approval_inbox` view (`security_invoker = true`), one row shape across the three sources, pre-flight jsonb inlined for comms.
- Run: all green. Commit.

### Task 3: seed + TS helpers + verify
- `src/approvals.ts`: `submitCommunication` / `approveCommunication` / `rejectCommunication` — rpc then `emitEvent` (`communication.submitted|approved|rejected`), approve also stamps `approval_event_id`; types for the inbox row and pre-flight result.
- Seed: thread + intro draft for lead 1 (stays pending — the inbox demo); thread + two drafts for lead 2 (approved / rejected-with-reason as Mudassir). Idempotent on fixed ids. 80-word standard, British English, no advice, no fee promises.
- `verify.ts`: print the approval inbox and the communication trail from the ledger.
- GO-LIVE.md: purge seed/demo data before real leads flow.

### Task 4: gates + live
- `npm run check-local` green → `npm run typecheck` → `migrate` → `seed` → `verify` live.
- Report with judgment calls for sign-off; DECISIONS.md only after approval.
