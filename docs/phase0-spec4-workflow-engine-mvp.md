# Phase 0 — Spec 4: The Workflow Engine and the MVP Workflow

**Product:** Create You AI (working title)
**Status:** **v1.0 — SIGNED OFF by founder, 7 July 2026.** All §4 timers remain provisional pending the two-week lead log; the log amends numbers, not structure.
**Date:** 7 July 2026
**Depends on:** Master context §3.6 (nurture funnel), §3.15 (vigilance), §3.18 (inbox integrity), §3.20 (visible automation); Specs 1–3
**Feeds into:** Phase 1 build directly — this document is the build order for the thing that makes money

---

## 1. Purpose and scope

Two things, deliberately in one document because the second proves the first: the **workflow engine** (what a workflow *is* as data — the format every automation, including Light-proposed ones, will use forever), and the **lead-to-booked-consultation workflow** specced gate by gate — every trigger, timer, template, escalation and close condition for X Law's MVP.

Out of scope: the visual builder UI (Phase 3), the voice-agent call step (Phase 3 — it replaces one step in this workflow without restructuring it), and vertical workflows beyond X Law.

## 2. Design principles

1. **Workflows are data, not code.** A workflow is rows: definition, steps, transitions, gates. Light can read them (to explain "what happens next for Ayesha?"), propose them, and propose edits to them — none of which is possible if workflows are buried in code. Trigger.dev *executes*; Supabase *is the truth* (locked, 3.9).

2. **Every step is evented; every run is inspectable.** "Where is this enquiry in the sequence and why" must be answerable from the ledger and visible on the enquiry timeline.

3. **Gates use Spec 3 levels — workflows never smuggle authority.** A workflow step that sends a message produces a `pending_approval` communication like any other; readiness pre-flight (3.18) applies identically. Workflows are choreography, not permission.

4. **Editing a workflow is itself a gated act.** Creating or changing a definition = Level 3 configuration change → Approval Inbox, described in plain English. The machine grows new habits only on the record.

5. **Timers must survive anything.** Retries, restarts, deploys — a "call back at 4pm" that silently dies is a lost client. Durable scheduling via Trigger.dev with the scheduled intent stored on our side first.

6. **Every sequence ends.** No enquiry loops forever; every path reaches a terminal stage and an outcome that feeds Meta. Auto-close is a feature, not a failure.

## 3. Engine tables

**`workflow_definitions`** — envelope + `key`, `version`, `template_id`, `trigger` (jsonb: event pattern, e.g. `{action: "engagement.created", source: "meta"}`), `status` (`active | paused | draft | pending_approval`), `description_plain` (the human-readable summary shown at its approval gate and in the Automation tab).

**`workflow_steps`** — `definition_id`, `key`, `order`, `kind` (`draft_comm | create_task | wait | move_stage | branch | close | fire_conversion | notify`), `config` (jsonb: template ref, channel, assignee, wait duration, branch conditions), `gate_level` (resolved per Spec 3 — informational cache; enforcement stays in the action itself).

**`workflow_runs`** — `definition_id`, `engagement_id`, `status` (`running | waiting | blocked | completed | cancelled`), `current_step`, `started_at`, `context` (jsonb). Spec 1 already reserved `tasks.workflow_run_id`.

**`step_runs`** — per-step execution record: timings, outcome, the communication/task ids it produced, `scheduled_for` (the durable-timer intent, ours before Trigger.dev's).

**`message_templates`** — `key`, `channel`, `subject`, `body` (with variables), `locale`, `version`. The nurture messages below each reference one; templates are editable content, and editing one is a Level 2 change (drafts are still stamped individually at send time).

## 4. The MVP workflow — gate by gate

**Trigger:** `engagement.created` with Meta source (the Spec 1 §7 walk-through, step 1, already done by the integration).

| # | Step | What happens | Timer (PROVISIONAL) | Gate |
|---|---|---|---|---|
| 1 | **Instant acknowledgement** | Light drafts intro email (template `intro_v1`, the 80-word standard applies) → Approval Inbox | Draft within 60s of arrival; goal: stamped + sent < 15 min in business hours | L3 stamp |
| 2 | **Call task** | Task created, assignee: Mudassir — "Call [name], [type] enquiry" with context brief attached | Due within 2 business hours | L2 (task creation) |
| 3 | **Missed-call retry** | If task marked *no answer*: second call task same day | Retry at +4 hours (or 4pm if morning lead) | L2 |
| 4 | **Missed-call message** | Both calls failed → Light drafts "sorry we missed you" email + WhatsApp (if consented) → Inbox | Same day as failed retry | L3 stamp |
| 5 | **Reply handling** | Any inbound reply → Light parses against qualification criteria (template config: partner location, income, English, refusal history) → proposes stage move to *Qualified* or drafts clarifying questions → Inbox | Draft response within 15 min of inbound | L2 move / L3 send |
| 6 | **Booking** | Qualified → Light sends booking link (owner's calendar free/busy ∩ working hours, 3.17) → slot picked → stage *Consultation booked*, calendar event, confirmation message → Inbox | Booking link in the same message as qualification confirmation | L3 sends |
| 7 | **Reminder** | Consultation −24h: WhatsApp/email reminder drafted → Inbox. Consultation −2h: brief task for Mudassir auto-prepared by Light | Fixed offsets | L3 send / L1 brief |
| 8 | **Nurture loop** (no response at any waiting point) | Sequenced touches: T+2d WhatsApp nudge → T+5d email (value content: "what the financial requirement means") → T+9d final "shall we close your file?" message | Cadence 2/5/9 days — **the lead log's biggest question** | L3 each |
| 9 | **Auto-close** | After final touch + 3 days silence: stage *Unresponsive*, outcome set, contact marked, junk signal queued for Meta | Total sequence ≈ 12 days | L2 close; conversion fire has its own cooling gate |
| 10 | **Outcome feedback** | *Instructed* → 24h cooling timer → `meta.conversion_fired` with value; *Disqualified/Unresponsive* → junk signal; reversal cancels pending sends | Cooling: 24h (locked, 3.6) | L2 automated, evented |

**Branches:** obvious junk at step 1 (gibberish, no valid channel) → Light proposes *Disqualify* — a human confirms; junk is never auto-declared in Phase 1, because the 80% junk statistic is exactly what the workflow must *prove*, not assume. Reply arriving mid-nurture cancels remaining queued touches for that thread automatically (evented).

## 5. Vigilance-lite (Phase 1 scope of 3.15)

Deterministic monitors shipped with this workflow: enquiry breaching stage SLA (from `stage_definitions.sla_hours`); inbox item past its 4-business-hour approval SLA; consultation within 24h with reminder unstamped; call task overdue. Each raises a dashboard item (L0) and, if ignored past a second threshold, a direct notification. Plus the **morning digest**: one summary at 8:30 — new leads overnight, today's calls and consultations, stamps owed, anything stuck. No heartbeat model sweeps in Phase 1; triggers only.

## 6. Acceptance criteria — the workflow must beat the log

The two-week founder lead log is the control group. Phase 1 succeeds when, on the same lead mix: **time-to-first-touch** drops (log baseline → minutes), **contact rate** and **consultations-booked-per-lead** rise, and **founder minutes per lead** falls — measured from stage_history and events, not vibes. If the log shows the §4 stages or timers are wrong, the log wins and this spec is amended before build.

## 7. Decisions made in this document (founder sign-off)

1. **Workflows are data** in four engine tables + message templates; Trigger.dev executes, Supabase is truth; scheduled intent is stored ours-first. (§2.1, §2.5, §3)
2. **Workflows never smuggle authority** — steps produce normally-gated actions; pre-flight applies; editing a definition is itself Level 3 via the Inbox, with a plain-English description at the gate. (§2.3–2.4)
3. **The MVP sequence** is the ten steps of §4 with cadence 2/5/9 days and ≈12-day auto-close — every number provisional against the lead log. (§4)
4. **Junk is proposed, never auto-declared, in Phase 1.** (§4 branches)
5. **Inbound replies cancel queued touches** on that thread automatically. (§4 branches)
6. **Vigilance-lite** = the five deterministic monitors + the 8:30 morning digest; no model sweeps until Phase 2. (§5)
7. **Acceptance = beating the founder's own log** on time-to-first-touch, contact rate, bookings per lead, and founder minutes — from the ledger, not vibes. (§6)

## 8. Explicitly deferred

- Automation tab: Phase 2 ships the **generated visual flow view** (canvas rendered from workflow rows — nodes, branches, run counts, execution logs) with form-based editing + Light proposals; the same canvas becomes drag-and-drop editable in Phase 3. (Amended 7 Jul after GHL builder study.)
- Voice agent replacing/augmenting the call steps → Phase 3, same workflow shape.
- Multi-employee routing of call tasks and round-robin booking → Phase 2/3 with team features.
- Cross-workflow orchestration (workflows triggering workflows) → with the full orchestrator, Phase 2.
