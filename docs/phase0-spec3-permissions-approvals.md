# Phase 0 — Spec 3: Permissions and Approvals

**Product:** Create You AI (working title)
**Status:** Draft v0.2 for founder sign-off
**Date:** 7 July 2026
**Changes in v0.2 (founder click-through of the inbox mockup):** readiness pre-flight — the Approve control must be earned (§6); inbox scope clarified — stamp-awaiting items only, incoming mail is Conversations (§6); Admin preset + per-person permission matrix page (§7); decisions 11–12.
**Depends on:** Master context §3.3 (grant schema, approval levels), §3.15 (vigilance never bypasses gates); Spec 1 v0.5 (actors, memberships, events, human-approval enforcement); Spec 2 v0.2 (export gating, assembly scope)
**Feeds into:** Spec 4 (gates on workflow steps); the Approval Inbox, Settings → Team, and grant-conversation mockups

---

## 1. Purpose and scope

This document defines the rulebook of who may do what: the **grant** (a scoped permission held by an actor), the **approval levels** 0–4 (how risky an action is and what it therefore requires), how grants are asked for and given **conversationally**, and how the same machinery governs **human employees** and **AI agents identically** — the product promise locked in Spec 1, decision 13.

Out of scope: workflow gate *placement* (Spec 4 decides where gates sit in the lead-to-consultation flow; this spec defines what a gate *is*) and the agency/white-label admin layer (Phase 3).

## 2. Design principles

1. **One system for humans and AI.** A grant does not know or care whether its holder breathes. "Sara can draft but not send" and "Light can draft but not send" are the same row shape. This is simpler to build, easier to audit, and it is the honest marketing line: your AI staff and human staff are governed identically.

2. **No grant without explicit scope.** If a request's scope is unspecified, the system must ask — conversationally — before granting. "Access to the calendar" is not grantable; "read/write on the X Law calendar, standing" is.

3. **Deny gracefully, never silently.** An actor lacking access says so and offers the paths forward: "I don't have access to invoicing — grant it, or tell me how you'd like to proceed?" Blocked work parks as `pending access` (the sibling of `pending credits`), never fails silently.

4. **Least privilege by default; convenience by presets.** New actors (human or AI) start with nothing. Role presets (§7) make generosity easy — but presets are bundles of grants, not a parallel roles system in the schema.

5. **Approval is structural where it matters most.** Levels are enforced in code paths (the send pipeline's human-approver check, Spec 1 decision 7), not in prompts. A jailbroken model cannot send an email, because the database refuses, not because it was asked nicely.

6. **Everything is evented.** Grant issued, used, expired, revoked; gate passed, refused; level overridden — every one writes to the ledger. "Who could do what, when, and who said so" is always answerable.

## 3. The `grants` table

Spec 1 common envelope applies (id, business_id, created_at/by, archived_at).

| Column | Type | Notes |
|---|---|---|
| `grantee_actor_id` | uuid | FK → actors. Human, agent, workflow, or integration |
| `tool` | text | Key into the tool registry (§3a): `comms.email`, `comms.whatsapp`, `enquiries`, `content.website`, `money.invoicing`, `calendar`, `memory.export`, `settings.team`… |
| `access` | enum | `view` \| `draft` \| `execute` — see level interplay, §4 |
| `scope` | jsonb | `{level: account\|business\|engagement, ref: uuid}` — no null scopes, ever (§2.2) |
| `duration` | enum | `this_task` \| `until` \| `standing` |
| `expires_at` | timestamptz, nullable | Set for `this_task`/`until`; sweep-enforced |
| `granted_by_actor_id` | uuid | Must be human, and must themselves hold `settings.team` execute (or be owner) |
| `via` | enum | `chat` \| `voice` \| `dashboard` |
| `revoked_at`, `revoked_by_actor_id` | nullable | One-tap revoke; row kept for audit |
| `last_used_at`, `use_count` | | Written on each authorised action — powers the "unused grant" review, §8 |

**3a. Tool registry** (`tools` config table): `key`, `label`, `category`, `default_level` (the risk floor for `execute`, §4), `surface` (which tab it corresponds to — this is how tab-level employee restriction works: no grant on a tool, no tab in the sidebar). Verdict: tools are platform-defined with template additions; tenants cannot invent tools, only grant them.

## 4. Approval levels — the canonical table

Levels describe **actions**, not actors. A grant lets you *attempt* an action; the action's level decides what the attempt requires.

| Level | Name | Meaning | Examples |
|---|---|---|---|
| 0 | Advise | Say things, suggest things | Vigilance suggestions, analyses, answers |
| 1 | Draft | Create internal-only artefacts | Draft emails, draft pages, notes, memory proposals |
| 2 | Safe execute | Act, reversibly, inside the walls | Move a stage, create a task, link a note, log a call |
| 3 | Human stamp | Act with external or irreversible effect — requires a human approver with the right grant | Send any external message, publish, issue an invoice, spend money, fire a Meta conversion, export memory, delete |
| 4 | Forbidden | Never, for anyone, through this system | Actions outside template no_go_rules (e.g. advice beyond IAA Level 1 scope), impersonating the human, self-granting |

**Level resolution** for an attempted action = `max(tool default_level, template no_go escalation, tenant override)`. Tenants may raise levels, never lower below the platform floor: "sending external comms is always Level 3+" is not tenant-configurable. **Spend gates** are Level 3 applied to money: any single AI action estimated above the configured threshold (default: $2) pauses for approval with its price shown — "this costs ~$4, proceed?" — and per-business credit caps (master context 3.8) sit above that as the hard ceiling.

`access` interplay, so there is no ambiguity: `view` = read the surface; `draft` = create Level 0–1 artefacts on it; `execute` = perform Level 2 actions and *submit* Level 3 actions into the approval queue. **Approving a Level 3 action is itself a tool** (`approvals.<category>` execute) — held by the owner by default, grantable to senior staff, never holdable by a non-human actor (structurally: the approver check requires `actor_type = human`).

## 5. The grant conversation

Grants are negotiated in language, recorded in structure:

> **Light:** To chase Bilal on WhatsApp I need send access to X Law's WhatsApp. Grant it for this task, or standing?
> **You:** Standing, but only WhatsApp.
> **Light:** Done — recorded: WhatsApp send, X Law scope, standing, granted by you just now, via chat. It's on the ledger; revoke any time in Settings → Team.

Rules of the conversation: the request must name **tool, access, and scope** (Light fills in its best proposal, you adjust); an unspecified scope is asked about, never assumed; voice grants read the recorded grant back aloud before confirming; the graceful-denial script (§2.3) is universal. Every grant conversation writes `grant.requested` and `grant.issued` events with the transcript reference.

## 6. The Approval Inbox — contract for the mockup

One queue, the heart of daily use. Contents: **only stamp-awaiting items** — drafts by AI or staff in `pending_approval`, spend gates, and grant requests. Incoming mail never appears here (it belongs to Conversations); the badge counts stamps owed, nothing else.

Each item is **openable to its full content** — complete message, attachments, or diff for edits to published things — before any stamping. Each shows: what it is, who drafted it (gold tag), its cost, which standard/skill produced it, and its pre-flight checklist.

**Readiness pre-flight — the Approve control must be earned.** Before Approve renders, deterministic checks run: a referenced attachment is actually attached; links resolve; the channel has consent; no-go rules pass; required fields (fee amounts, dates) are present. Any failure → the item shows a **Blocked** state naming the failure, with a fix action ("Ask Light to attach the letter") instead of a stamp. Approving broken things is impossible, not discouraged. (Origin: founder caught an engagement letter referencing an unattached document with a live Approve button — the exact failure this rule forbids.)

Actions: one-tap **Approve / Refine / Reject** — Refine opens the edit that feeds the learning loop (Spec 2); rejections record a reason to the ledger. Batch approval within same-kind groups only. Pending items have their own SLA (default 4 business hours) escalated by vigilance to the dashboard. Approving from an enquiry timeline is the same act on the same row; the inbox is a *view*, not a place things live.

## 7. Employees: memberships, grants, and presets

The flow: **invite** (creates the human actor + membership) → **preset or custom grants** → they log into app.\* and see exactly the tabs their grants name (§3a `surface` mapping), with field-level visibility inside each tab already governed by `field_definitions.surface_visibility` (Spec 1). **Shipped presets:** *Owner* (implicit full set), *Admin* (settings.team + approvals.\* — can manage others' access), *Manager* (approvals.comms + operational execute), and template presets — for X Law: *Caseworker* (enquiries + conversations + notes + calendar: execute; money: none), *Marketing* (content: draft; enquiries: view) — plus *AI COO* as Light's default bundle. Presets are applied-then-editable bundles: applying one writes individual grant rows, so removing one grant later doesn't fight a role system, because there isn't one.

**The permission matrix page:** clicking a team member opens their full-page matrix — every tool down the side, view/draft/execute toggles across — the complete, flippable truth of what they can do. Editable by anyone holding Admin rights (the §3 rule: granting requires `settings.team`); every flip is a grant row created or revoked, evented. The owner is simply the account's first human with an implicit full grant set — visible like everyone else's, revocable for everyone but themselves.

## 8. Revocation, expiry, and hygiene

One-tap revoke from Settings → Team (evented, immediate — the next action attempt fails gracefully). Expiry sweep runs on the workflow engine; work blocked by a lapsed grant parks as `pending access` with a nudge to the granter. Vigilance reviews **unused grants** (standing, untouched for 90 days → "Sara hasn't used invoicing in 3 months — keep or revoke?") — the permissions system gets the same decay-question treatment as memory, and for the same reason: accumulated stale power is the security equivalent of the 4,000-note landfill.

## 9. Phase boundaries

**Phase 1:** grants engine live with two humans' worth of machinery but one human (you) + Light; approval inbox for comms and spend gates; grant conversations via chat; the ledger view of all of it. **Phase 2:** employee invites, presets, Settings → Team UI, approval delegation (`approvals.*` grants), pending-approval SLAs, batch approve. **Phase 3:** agency-tier admin (agency staff grants across client businesses), per-persona agent grants, voice-channel grant conversations.

## 10. Decisions made in this document (founder sign-off)

1. **One grant system for humans and AI** — grants don't know if their holder breathes; presets are bundles, not schema roles. (§2.1, §7)
2. **Grant anatomy:** grantee + tool + access (view/draft/execute) + explicit scope + duration; no null scopes; granted only by humans holding team rights. (§3)
3. **Tool registry is platform-defined** (+ template additions); tools map to surfaces — which is how tab-level employee restriction works with zero extra machinery. (§3a)
4. **Levels 0–4 canonical**, resolved as max(tool floor, template escalation, tenant override); tenants can raise, never lower; external/irreversible = Level 3 always. (§4)
5. **Approving is itself a tool** (`approvals.*`), grantable to senior humans, structurally unholdable by non-humans. (§4)
6. **Spend gates:** single-action estimate above threshold (default $2) pauses with price shown; business credit caps sit above as hard ceiling. (§4)
7. **The grant conversation** must name tool/access/scope, asks when unspecified, reads back on voice, and is fully evented with transcript reference. (§5)
8. **The approval inbox is a view** over pending states everywhere + spend gates + grant requests; Approve/Refine/Reject with same-kind batch only; pending items have their own SLA and escalate via vigilance. (§6)
9. **Blocked work parks, never fails:** `pending access` mirrors `pending credits`. (§2.3, §8)
10. **Grant hygiene:** expiry sweeps + unused-grant review at 90 days — permissions decay-question mechanics mirror memory's. (§8)
11. **Readiness pre-flight:** the Approve control renders only after deterministic checks pass (attachments present, links valid, consent held, no-go clear); failures show Blocked + fix action. The inbox contains only stamp-awaiting items; incoming mail is Conversations; the badge counts stamps owed. (§6)
12. **Preset set:** Owner / Admin / Manager / Caseworker / Marketing / AI COO; clicking a member opens their full permission matrix (tools × view/draft/execute), editable by Admin holders, every flip evented. (§7)

## 11. Explicitly deferred

- Gate placement within the MVP workflow → Spec 4.
- Agency-tier cross-business grants and white-label admin → Phase 3.
- Client-portal identity (contacts logging in) → Phase 2/3 with the portal surface; portal users are contacts with narrow grants, not memberships — noted here so the model anticipates it.
- Anomaly detection on grant usage (impossible-hours activity, bulk-action spikes) → Phase 3 vigilance extension.
