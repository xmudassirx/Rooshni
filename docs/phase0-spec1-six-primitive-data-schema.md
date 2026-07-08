# Phase 0 — Spec 1: The Six-Primitive Data Schema

**Product:** Create You AI (working title; final name — open decision, under research)
**Status:** Draft v0.5 for founder sign-off
**Date:** 7 July 2026
**Changes in v0.5:** X Law vocabulary amended — pre-instruction engagement = "enquiry"; "case/matter" reserved for instructed clients (§6); unified Conversations view noted (§4.4); matters-module hard rule recorded — same database, never a separate one (decision 17).
**Changes in v0.4:** website surface made schema-ready — `content_archetypes` added to template configuration (§5.3), `audit` scorecard column on content_items (§4.5); founder's funnel document preserved as the seed of the Phase 2 funnel-page skill (decision 16).
**Changes in v0.3:** notes surface made schema-ready — `note` content type + `visibility` field (§4.5), generic `entity_links` table (§5.5); personal dimension noted — a "Personal" space is an untemplated business under the account, no schema change required (§9, decision 15).
**Changes in v0.2:** absorbed locked decisions from master context §3.9 — accounts → businesses tenancy hierarchy (new §5.0), Supabase/Postgres stack confirmed (§1, §10), tenant custom domains (`domains` table, §5.0), tenant-employee access noted as a Spec 3 concern (§5.1, §8).
**Depends on:** Master context §3.5 (one shared database), §3.4 (surfaces taxonomy), §3.9 (tenancy, stack and domains), §5 (MVP workflow)
**Feeds into:** Spec 2 (memory card model), Spec 3 (permission grants + approvals), Spec 4 (lead-to-booked-consultation workflow)

---

## 1. Purpose and scope

This document defines the logical data schema for the one shared database that every generated surface is a view over. It covers the six primitives — **contacts, engagements, tasks, communications, content, money** — plus the cross-cutting tables they all depend on (audit events, template configuration, actors, files).

It deliberately does **not** cover: the memory card model (Spec 2), the permission grant schema (Spec 3), or workflow/gate definitions (Spec 4). Where those specs will hang foreign keys off this schema, the touchpoint is named in §8 so nothing is designed in isolation.

The schema is a PostgreSQL logical model (tables, columns, types, relationships), implemented on **Supabase** — now a locked decision (master context §3.9). This is not incidental: Supabase's Row-Level Security is the enforcement mechanism for the tenancy rules in §2.8 and §5.0, pgvector serves the context assembly engine, and Supabase Branching gives us draft-copy testing of every schema change before it touches real data. Schema changes are routine, AI-written migrations — nothing in this document is hard to amend later; everyday field additions don't even touch the schema (§2.3).

**A clarification that governs everything below: six primitives does not mean six tables.** The primitives are six *domains*. Contacts is a domain of three tables; money is a domain of four. The promise the master context makes — "all generated surfaces are views over these, no syncing anywhere" — is kept at the domain level. Total: fifteen domain tables plus five cross-cutting tables.

## 2. Design principles

1. **One database, many faces.** Every generated surface (CRM view, portal, LMS, invoicing UI, website admin) reads and writes these tables directly. There is no per-surface store and no sync layer, ever. If a proposed surface seems to need its own tables, the correct response is a new *view* or a new *template configuration*, not a new store.

2. **Templates configure; they never mutate schema.** A vertical template (law, IT, accounting) supplies vocabulary, pipeline stages, and custom field definitions as *rows in configuration tables*. The physical schema is identical for every client. This is how we avoid Lovable's orphaned-codebase failure mode at the data layer: one schema, per-client configuration.

3. **Custom fields are typed and declared, not free-form.** Each record carries an `attributes` JSON column, but every key that appears in it must correspond to a row in `field_definitions` (name, type, validation, which surface shows it). The AI may *propose* a new field definition; creating one is a configuration change and goes through an approval gate. Undeclared keys are rejected at the API layer. This keeps generated surfaces renderable (they read field definitions, not guesswork) and keeps the context assembly engine able to reason about what a field means.

4. **Nothing below approval Level 3 hard-deletes.** Every table carries `archived_at`. Hard deletion is a Level 3+ gated action (master context §3.3) and even then the audit event survives. Generated surfaces filter `archived_at IS NULL` by default.

5. **Every row knows who made it.** `created_by` references the `actors` table, which covers humans, agents (Light and future personas), workflows, and integrations. This is non-negotiable: the audit trail, the approval system, and the trust promise ("the human runs the business") all depend on being able to answer "did a person or the AI do this?" for any row in the system.

6. **External systems are mirrored, never authoritative.** Meta lead IDs, Google Calendar event IDs, WhatsApp message IDs, Stripe payment intents live in `external_refs` (JSON: `{system, external_id, url, synced_at}`). Our row is the source of truth; the external ref is how we reconcile. If Meta and our database disagree, our database wins and the discrepancy is logged as an event.

7. **IDs are UUIDv7.** Time-ordered UUIDs: globally unique (safe for export, multi-tenant merge, offline generation) while remaining index-friendly. No auto-increment integers anywhere client-visible.

8. **Tenancy is two-level and mandatory (GHL-shaped).** Signup creates an **account**; an account contains many **businesses** (sub-accounts). All operational data carries `business_id`; RLS is enforced on it from day one, even while there is only one tenant, because retrofitting tenancy is how platforms die in Phase 2. The account level exists for cross-business concerns only: ownership, billing, account-scoped ("Global") memory, and the platform console's per-account view. Phase 1 = one account (Mudassir) containing X Law, plus BarakahX as a second business to keep cross-business scoping honest. Agency *features* (white-label, rebilling) remain Phase 3; the *structure* is built now.

## 3. The common envelope

Every domain table carries these columns. They are listed once here and omitted from the per-table definitions below.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid (v7) | Primary key |
| `business_id` | uuid | Tenant. FK → businesses (which belong to accounts, §5.0). RLS enforced |
| `created_at` | timestamptz | |
| `updated_at` | timestamptz | Trigger-maintained |
| `created_by` | uuid | FK → actors. Human, agent, workflow, or integration |
| `archived_at` | timestamptz, nullable | Soft delete. Hard delete is Level 3+ |
| `attributes` | jsonb | Template-defined custom fields only (see §2.3) |
| `external_refs` | jsonb | Array of `{system, external_id, url, synced_at}` |

## 4. The six primitives

### 4.1 Contacts — *who we know*

**`contacts`**

| Column | Type | Notes |
|---|---|---|
| `type` | enum | `person` \| `organisation` |
| `display_name` | text | Computed for persons (given + family), entered for orgs |
| `given_name`, `family_name` | text, nullable | Persons only |
| `org_id` | uuid, nullable | FK → contacts. A person's employer/sponsor org |
| `status` | enum | `active` \| `unresponsive` \| `do_not_contact` \| `junk` |
| `first_touch` | jsonb | First-ever attribution snapshot: `{source, campaign_id, adset_id, ad_id, form_id, occurred_at}` |
| `locale` | text | Language preference; drives comms drafting |
| `notes` | text | Free-form; distinct from memory cards |

Persons and organisations live in one table because law-firm reality mixes them constantly (individual applicant, sponsoring employer, opposing party's firm) and the CRM surface must show them in one pipeline. `junk` as a first-class contact status exists because ~80% of Facebook leads are junk and the Meta feedback loop needs to report exactly that.

**`contact_channels`** — a contact has many ways to be reached.

| Column | Type | Notes |
|---|---|---|
| `contact_id` | uuid | FK → contacts |
| `channel` | enum | `email` \| `phone` \| `whatsapp` \| `address` \| `social` |
| `value` | text | Normalised (E.164 for phones, lowercased email) |
| `is_primary` | boolean | One per channel type |
| `consent` | jsonb | `{marketing: bool, transactional: bool, granted_at, source}` — GDPR/PECR compliance is table stakes for UK firms |
| `verified_at` | timestamptz, nullable | |

Channels are separate rows (not columns on contact) because inbound communications are matched to contacts by channel value, people have multiple numbers/emails, and consent is legally *per channel*, not per person.

**`contact_relationships`** — typed edges between contacts.

| Column | Type | Notes |
|---|---|---|
| `from_contact_id`, `to_contact_id` | uuid | FKs → contacts |
| `relationship` | enum + template vocab | `spouse` \| `dependant` \| `employer` \| `referrer` \| `agent_of` … |

Immigration work is dense with dependants, sponsors and referrers; this table is what lets Light answer "who is this person to the case?"

### 4.2 Engagements — *the container of work over time*

The universal unit the vertical template renames: law → **case**, IT → **project**, accounting → **client-year**, LMS → **enrolment** (see verdict in §4.5).

**`engagements`**

| Column | Type | Notes |
|---|---|---|
| `template_type_id` | uuid | FK → engagement_types (template config): "Skilled Worker visa", "Spouse visa", "Course enrolment" |
| `title` | text | |
| `stage_id` | uuid | FK → stage_definitions (template config). Current pipeline stage |
| `stage_entered_at` | timestamptz | Powers "stuck in stage for N days" triggers |
| `outcome` | enum, nullable | `won` \| `lost` \| `unresponsive` \| `disqualified` — set at close |
| `outcome_at` | timestamptz, nullable | Starts the Meta cooling timer (§3.6 master context) |
| `value_estimate` | numeric, nullable | Expected fee; feeds Meta value reporting pre-invoice |
| `attribution` | jsonb | This engagement's source: `{source, campaign_id, adset_id, ad_id, form_id, lead_id}` |
| `owner_actor_id` | uuid | FK → actors. Accountable human (never an agent — trust architecture) |

Attribution lives on the **engagement**, not only the contact: a returning client who comes back via a new campaign is a new engagement with new attribution, and the spend→lead→outcome loop must credit the right campaign. `first_touch` on the contact is a convenience copy of their first engagement's attribution.

**`engagement_participants`**

| Column | Type | Notes |
|---|---|---|
| `engagement_id` | uuid | FK → engagements |
| `contact_id` | uuid | FK → contacts |
| `role` | template vocab | `client` \| `dependant` \| `sponsor` \| `student` \| `opposing_party` … |

**`stage_history`** — append-only record of every stage transition (`engagement_id, from_stage, to_stage, moved_at, moved_by`). The CRM pipeline surface, conversion analytics, and the Phase 1 acceptance test ("faster than the Phase 0 log") all read this table. Stage moves also emit audit events, but stage_history is the queryable form.

### 4.3 Tasks — *what must be done*

**`tasks`**

| Column | Type | Notes |
|---|---|---|
| `engagement_id` | uuid, nullable | Most tasks belong to an engagement; business-admin tasks may not |
| `title` | text | |
| `description` | text | |
| `status` | enum | `open` \| `in_progress` \| `blocked` \| `awaiting_approval` \| `done` \| `cancelled` |
| `assignee_actor_id` | uuid | FK → actors — a human **or an agent**. This one column is what makes the employee task board and the orchestrator's to-do list the same surface |
| `due_at` | timestamptz, nullable | |
| `priority` | enum | `low` \| `normal` \| `high` \| `urgent` |
| `workflow_run_id` | uuid, nullable | FK → workflow_runs (Spec 4). Set when a workflow spawned this task |
| `approval_level` | smallint, nullable | 0–4 per master context §3.3, stamped when the task involves a gated action |
| `parent_task_id` | uuid, nullable | Subtasks |

`awaiting_approval` as a task status is the join between this schema and the approval inbox: the inbox is a generated view over tasks (and communications) in approval-pending states — not a separate store.

### 4.4 Communications — *every message, in and out, on every channel*

**`comm_threads`** — groups messages (`engagement_id` nullable, `contact_id`, `channel`, `subject`). Pre-qualification enquiries attach to a contact before any engagement exists.

**`communications`**

| Column | Type | Notes |
|---|---|---|
| `thread_id` | uuid | FK → comm_threads |
| `contact_id` | uuid, nullable | Counterparty (null for internal notes) |
| `engagement_id` | uuid, nullable | Denormalised from thread for fast per-case views |
| `channel` | enum | `email` \| `whatsapp` \| `sms` \| `call` \| `meeting` \| `portal_message` \| `internal_note` |
| `direction` | enum | `inbound` \| `outbound` \| `internal` |
| `status` | enum | `draft` \| `pending_approval` \| `approved` \| `sent` \| `delivered` \| `read` \| `failed` \| `received` |
| `body` | text | Canonical text content |
| `body_format` | enum | `plain` \| `markdown` \| `html` |
| `drafted_by_actor_id` | uuid, nullable | The agent that drafted it |
| `approved_by_actor_id` | uuid, nullable | The human that released it — must be human for Level 3 sends |
| `approval_event_id` | uuid, nullable | FK → events. Direct pointer from message to its audit record |
| `scheduled_for` | timestamptz, nullable | Nurture-sequence timing |
| `occurred_at` | timestamptz | Sent/received time (or call start) |
| `duration_seconds` | int, nullable | Calls/meetings; voice agent (Phase 3) fills this too |
| `transcript` | text, nullable | Calls; voice agent writes here, changing nothing structural |

The status ladder `draft → pending_approval → approved → sent` is the schema-level enforcement of the master context's hardest rule: **sending external comms is always Level 3+**. The send pipeline physically refuses any outbound message whose `approved_by_actor_id` is not a human actor. Attachments are rows in `files` (§5.4) linked via `file_links`.

**The unified Conversations surface** (GHL/Brevo-style) is a *view*, not a structure: group communications by contact across all channels, newest first, each message carrying its channel badge. A contact who arrived via Facebook, was booked by email and chatted on WhatsApp reads as one continuous thread — because it always was one thread in this table. Messenger arrives through the same Meta connected-surface work as WhatsApp.

### 4.5 Content — *everything published or teachable*

**`content_items`**

| Column | Type | Notes |
|---|---|---|
| `content_type` | template vocab | `page` \| `blog_post` \| `funnel_page` \| `email_template` \| `whatsapp_template` \| `course` \| `module` \| `lesson` \| `document_template` \| `note` |
| `parent_id` | uuid, nullable | Hierarchy: course → module → lesson; funnel → pages |
| `title`, `slug` | text | Slug unique per business per surface; auto-generated for notes |
| `body` | jsonb | Structured blocks (portable across templates), not raw HTML. Checklist blocks make lists (grocery-style) a native note capability |
| `visibility` | enum | `private` \| `team` — default `private` for notes (quick capture stays the author's until promoted); other content types default `team` |
| `state` | enum | `draft` \| `pending_approval` \| `published` \| `unpublished` |
| `surface_binding` | jsonb, nullable | Which generated surface renders it and where: `{surface: "website", path: "/services/skilled-worker"}` |
| `published_at`, `published_by_actor_id` | | Publishing is Level 3+; same human-approval enforcement as comms |
| `version` | int | Simple integer versioning; prior versions retained in `content_versions` (id, content_id, version, body, saved_at) |
| `archetype_id` | uuid, nullable | FK → content_archetypes (§5.3). Which page shape this was generated from |
| `audit` | jsonb, nullable | Cached latest scorecard: `{seo: 0-100, geo_aeo: 0-100, compliance: 0-100, rag: green|amber|red, audited_at, event_id}` — full history lives in `events` (`content.audited`) |

**Verdict on the LMS:** the master context is right that "enrolments are rows in the shared database" — and the right rows are **engagements**. An enrolment is an engagement of template type `enrolment` with the student as participant (role `student`) and stages like *enrolled → in progress → completed → lapsed*. Course structure is content; a student's journey through it is an engagement; their lesson-completion ticks are `stage_history` plus lightweight `events`. No enrolments table, no LMS backend, and every CRM feature (pipelines, tasks, comms, nurture sequences) works on students for free. This is the schema paying rent.

**Notes (Phase 2 surface, schema-ready now):** a note is a `content_items` row of type `note`, linked to any entity — contact, engagement, task, invoice — via `entity_links` (§5.5). The notes surface has **no manual folders**: its sidebar is *generated* — an Inbox of unlinked captures (Light proposes links), engagement groupings derived from `entity_links` filtered by the viewer's grants, and saved views (stored searches) as pseudo-folders. Structure comes from links and grants, not filing — a pattern every generated surface reuses. Interim from Phase 1 day one: the `internal_note` communications channel covers case-level notes with zero extra build.

### 4.6 Money — *what is owed, paid, and spent*

**`invoices`** — `engagement_id` (nullable), `contact_id` (bill-to), `number` (per-business sequence), `status` (`draft | pending_approval | issued | paid | partially_paid | overdue | void`), `currency`, `issued_at`, `due_at`, `total` (computed). Issuing an invoice is a Level 3 action (it is an external communication of a demand for money).

**`invoice_lines`** — `invoice_id`, `description`, `quantity`, `unit_amount`, `tax_rate`. Line-level tax because UK VAT treatment varies by service.

**`payments`** — `invoice_id` (nullable — supports on-account payments), `contact_id`, `amount`, `currency`, `method` (`stripe | bank_transfer | cash | other`), `received_at`, `reconciled` (boolean). Stripe webhooks create these rows via an integration actor; reconciliation against invoices can be AI-proposed, human-approved.

**`spend_records`** — imported cost data: `source` (`meta_ads | google_ads | platform_credits | other`), `campaign_id`, `adset_id`, `ad_id`, `period_start`, `period_end`, `amount`, `currency`. This table is the missing half of the moat loop: spend_records (money out) + engagement attribution (lead in) + invoices/payments (money in) = full spend→lead→outcome→spend ROI inside one database, which no standalone tool has. Platform AI-credit consumption is *also* mirrored here (source `platform_credits`) so the business sees AI cost next to ad cost in the same P&L view — while the authoritative credit ledger remains platform-level billing, outside this tenant schema.

Full double-entry accounting stays **connected** (Xero), per the surfaces taxonomy. This domain records operational money truth, not the general ledger.

## 5. Cross-cutting tables

### 5.0 Platform structure — `accounts`, `businesses`, `domains`

These sit *above* the six primitives and are the physical form of master context §3.9.

**`accounts`** — one row per signup. `name`, `owner_user_id`, `plan`, `billing_status`, `settings` jsonb. The platform console (console.\*) is a view over this table and its children. The agency tier (Phase 3) adds features here — white-label config, sub-account rebilling — without structural change.

**`businesses`** — one row per operating business (sub-account). `account_id` (FK → accounts), `name`, `template_id` (which vertical template is installed), `settings` jsonb, `timezone`, `default_locale`. Every domain table's `business_id` points here. X Law is row one; BarakahX row two.

**`domains`** — tenant-connected custom domains for *public* generated surfaces (the tenant's website, later their client portal). `business_id`, `hostname` ("xlaw.co.uk"), `surface` (`website | portal`), `verification_status`, `verified_at`, `ssl_status`. A `content_items.surface_binding` resolves to a hostname through this table. Note what is deliberately absent: there are no per-tenant *dashboard* domains — all users of all tenants log into the single product app (app.\*), and identity determines the view. Dashboard-on-your-own-domain is the Phase 3 white-label feature, not the default architecture.

### 5.1 `actors` — humans, agents, workflows, integrations

| Column | Type | Notes |
|---|---|---|
| `actor_type` | enum | `human` \| `agent` \| `workflow` \| `integration` |
| `display_name` | text | "Mudassir", "Light", "Nurture sequence v2", "Meta lead sync" |
| `user_id` | uuid, nullable | FK → platform auth users (humans only) |
| `agent_role_id` | uuid, nullable | Phase 2 personas; Light is the first row |

Every `created_by`, `assignee_actor_id`, `approved_by_actor_id` in the system points here. Approval enforcement is one check: `actors.actor_type = 'human'`.

Human actors are joined to businesses via **`memberships`** (`user_id`, `business_id`, `role`: `owner | member`). Membership answers "may this person log into this business at all?"; *what they may do inside it* — which tools, which access levels — is not modelled here. That is deliberately the same permissions engine that governs agents (Spec 3): an owner granting an employee "CRM read/write, no invoicing, no publishing" uses the identical grant schema (`tool, access, duration, scope`) as a grant to Light. One permission system for human and AI staff alike — this is a product promise, not just an implementation convenience.

### 5.2 `events` — the audit trail (built first)

Append-only. No updates, no deletes, ever.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid v7 | Doubles as strict time ordering |
| `business_id` | uuid | |
| `actor_id` | uuid | Who did it |
| `action` | text | Namespaced verb: `contact.created`, `engagement.stage_changed`, `communication.approved`, `communication.sent`, `grant.issued`, `credits.consumed`, `meta.conversion_fired`, `meta.conversion_cancelled` |
| `entity_type`, `entity_id` | text, uuid | What it happened to |
| `payload` | jsonb | Before/after diff or action-specific detail |
| `approval` | jsonb, nullable | `{level, gate_id, approved_by, decided_at}` when the action passed a gate |
| `cost` | jsonb, nullable | `{credits, provider, model, tokens}` — AI spend is audited per action, which is what makes the spend-gate ("this costs ~$4 — proceed?") possible |
| `occurred_at` | timestamptz | |

The master context says the audit trail must be "readable by non-technical users": that is a rendering obligation on the native audit surface (verb + actor + entity → plain English sentence), not a schema obligation. The schema's job is to never lose the facts. The Meta cooling timer is implemented on this table: `meta.conversion_pending` event at outcome, a scheduled check after the timer, then either `meta.conversion_fired` or `meta.conversion_cancelled`.

### 5.3 Template configuration tables

**`templates`** — one row per vertical template version installed for a business (`vertical`, `version`, `no_go_rules` jsonb).
**`engagement_types`** — `template_id`, `key`, `label` ("case", "Skilled Worker visa", "enrolment").
**`stage_definitions`** — `engagement_type_id`, `key`, `label`, `order`, `is_terminal`, `terminal_outcome` (maps terminal stages to `won/lost/unresponsive/disqualified`), `sla_hours` (powers "stuck" alerts).
**`field_definitions`** — `entity` (which primitive), `key`, `label`, `data_type`, `validation` jsonb, `surface_visibility` jsonb. The whitelist for `attributes` (§2.3).
**`content_archetypes`** — `template_id`, `key` (`funnel_page | service_page | blog_post | homepage | course_lesson`), `label`, `section_structure` jsonb (the ordered section plan a generated page follows), `skill_ref` (which skill generates it), `audit_profile` jsonb (which SEO/GEO-AEO/compliance checks apply and their weighting). The website admin's "create new page" button is: pick an archetype → Light runs its skill → draft page → publish gate. The founder's funnel-page document is the seed of the first `funnel_page` skill.
**`vocabulary`** — `template_id`, `term_key`, `label` ("engagement" → "case"). Generated surfaces and Light's language both read this, so the CRM says "cases" to X Law without a single schema difference from the IT template.

### 5.4 `files`

`storage_key`, `filename`, `mime_type`, `size_bytes`, `sha256`, `uploaded_by`. Linked to any record via **`file_links`** (`file_id`, `entity_type`, `entity_id`, `role`: `attachment | evidence | logo | lesson_asset`). Immigration casework is document-heavy from day one; this cannot be an afterthought.

### 5.5 `entity_links` — generic record-to-record links

| Column | Type | Notes |
|---|---|---|
| `from_entity_type`, `from_entity_id` | text, uuid | The linking record (e.g. a note) |
| `to_entity_type`, `to_entity_id` | text, uuid | The linked record (a contact, engagement, task, invoice…) |
| `role` | text | `about` \| `mentions` \| `derived_from` … |
| `proposed_by_actor_id` | uuid, nullable | Set when Light proposed the link; null when human-made |
| `confirmed_at` | timestamptz, nullable | Human confirmation of an AI-proposed link |

Born for the notes surface, useful everywhere: one note appearing under two projects, Light's auto-proposed linking (proposed → confirmed lifecycle), and any future "this relates to that" without new join tables. Sidebar "folders" in the notes surface are queries over this table intersected with the viewer's engagement grants.

## 6. X Law template mapping (customer zero)

| Generic | X Law configuration |
|---|---|
| engagement | **enquiry** pre-instruction (types: Skilled Worker, Spouse/Partner, Visit, Student, ILR, Citizenship, Ad-hoc advice). "**Case/matter**" is reserved for instructed clients — a *new* engagement of type `matter` opened for the same contact when an enquiry is won (matters module: Phase 3+, same database, decision 17) |
| Pipeline stages | New lead → Contact attempted → In conversation → Qualified → Consultation booked → Consultation held → Instructed (won) → Closed-lost / Unresponsive / Disqualified (junk) |
| Participant roles | client, dependant, sponsor, referrer |
| Custom fields (examples) | contact: `nationality`, `current_visa_status`, `visa_expiry`; engagement: `visa_route`, `urgency` |
| No-go rules | No immigration advice in outbound drafts beyond IAA Level 1 scope; no fee promises without human approval; regulated-advice phrasing blocklist |
| Terminal outcomes → Meta | Instructed → `won` + value; Disqualified → junk signal; Unresponsive after N touches → junk signal |

The stage list above is a **proposal to be validated by the founder homework**: the two-week lead log should confirm or amend these stages before Phase 1 code is written. If real leads don't move through these stages, the stages are wrong, not the leads.

## 7. Acceptance test: the MVP workflow as a schema walk-through

Every step of the locked Phase 1 workflow (master context §5) must be expressible as rows in this schema, with no auxiliary store. Walking it through:

1. **Facebook lead arrives.** Integration actor creates: `contacts` row (+ `contact_channels` for email/phone, consent from the lead form), `engagements` row (type: template default, stage: *New lead*, `attribution` from the Meta payload, `external_refs` holding the Meta `lead_id`), and a `contact.created` event.
2. **Orchestrator triggers nurture.** A `workflow_runs` record (Spec 4) is opened; `tasks` rows are spawned (`assignee_actor_id` = Light for drafting steps, = Mudassir for gated steps); `events` log the trigger.
3. **Drafted email/WhatsApp.** `communications` row, `status: draft → pending_approval`, `drafted_by_actor_id` = Light. It appears in the approval inbox because the inbox is a view over pending statuses.
4. **Human approves; message sends.** `approved_by_actor_id` = Mudassir (human check passes), `status: sent`, `communication.approved` and `communication.sent` events with the approval block populated. Retries, missed-call steps and sequenced touches are further `communications` rows with `scheduled_for`.
5. **Consultation booked.** Engagement moves to *Consultation booked* (`stage_history` row); calendar event stored in `external_refs`; confirmation comms as above.
6. **Dead lead auto-closes.** Engagement → terminal stage *Unresponsive*; `outcome: unresponsive`; contact `status: unresponsive`; all logged.
7. **Outcome feeds Meta.** `outcome_at` starts the cooling timer via a `meta.conversion_pending` event; after 24h unreversed, `meta.conversion_fired` with value (from `value_estimate` or the paid invoice). Reversal cancels. `spend_records` imported from Meta close the ROI loop.

Every arrow lands on a table defined above. The schema passes its own acceptance test; Phase 1's acceptance test remains the founder's two-week lead log.

## 8. Touchpoints with Specs 2–4 (contracts, not designs)

- **Spec 2 (memory cards):** cards may *reference* entities (`entity_type`, `entity_id`) — e.g. a preference card attached to a contact — but memory is a separate store with its own lifecycle. Cards are not rows in these tables; provenance on a card may point at an `events.id`.
- **Spec 3 (grants):** the grant schema's `scope` field resolves against the tenancy hierarchy in §5.0 — account (global), business, or an engagement/entity reference. Grants apply to **both agent and human actors**: tenant-employee access ("whatever the owner gives them") is the same grant schema as Light's permissions, attached via `memberships` (§5.1). Approval levels stamped on tasks/communications here must use Spec 3's canonical level table. Every grant issuance/expiry writes an `events` row (`grant.issued`, `grant.expired`).
- **Spec 4 (workflow):** introduces `workflow_definitions` and `workflow_runs`; this schema already reserves `tasks.workflow_run_id` and the `pending_approval` statuses that gates flip. Gate decisions write the `approval` block on events.

## 9. Decisions made in this document (founder sign-off)

1. **Six domains, ~20 tables** — not six literal tables. (§1)
2. **PostgreSQL on Supabase (locked, master context §3.9); UUIDv7 ids; RLS on `business_id` from day one.** (§1, §2.7–2.8)
3. **Custom fields = declared, typed `attributes` whitelisted by `field_definitions`;** creating a field definition is itself a gated configuration change. (§2.3)
4. **Persons and organisations share one `contacts` table;** channels and consent are per-channel rows. (§4.1)
5. **Attribution lives on the engagement** (with a first-touch copy on the contact) so the Meta loop credits the right campaign per engagement. (§4.2)
6. **LMS enrolments are engagements** of type `enrolment` — no enrolments table, no LMS backend. (§4.5)
7. **Approval enforcement is structural:** outbound comms, publishing and invoice issue physically require a human `approved_by_actor_id`; the approval inbox is a view over pending statuses, not a store. (§4.4, §5.1)
8. **`spend_records` added to the money domain** (ad spend + mirrored platform-credit consumption) to complete the spend→lead→outcome→spend loop in one database. (§4.6)
9. **Actors table unifies humans, agents, workflows and integrations;** every row in the system attributes to one. (§5.1)
10. **Events table is append-only with `cost` and `approval` blocks,** built first, and hosts the Meta cooling-timer mechanics. (§5.2)
11. **Proposed X Law pipeline stages** (§6) — explicitly provisional pending the two-week lead log.
12. **Two-level tenancy: `accounts` → `businesses` (GHL-shaped), plus `domains` for tenant public surfaces and `memberships` for human access** — structure built now, agency features Phase 3, no per-tenant dashboard domains outside the white-label tier. (§2.8, §5.0, §5.1)
13. **Tenant-employee permissions are Spec 3 grants, not schema roles** — memberships only gate login; the grant engine gates capability, identically for humans and agents. (§5.1, §8)
14. **Notes are content, not a new primitive** — `content_type: note` with `visibility` (private/team) + generic `entity_links`; sidebar structure is generated from links and grants, never manual folders; checklist blocks give Keep-style lists natively. Surface ships Phase 2; `internal_note` comms channel covers Phase 1. (§4.5, §5.5)
15. **The personal dimension requires zero schema** — a "Personal" space is a business row with no vertical template; personal preferences are account-scoped memory cards (Spec 2, Phase 1); cross-space leakage prohibition is a master-context hard rule. (§2.8, §5.0)
16. **Websites are archetype-generated, skill-driven, and scored** — `content_archetypes` define page shapes per template; skills (layer 5, Spec 2 territory) generate drafts; every page carries a cached `audit` scorecard (SEO / GEO-AEO / compliance, RAG + marks out of 100) with history in `events`. On-page scoring is generated (Phase 2); off-page rank/backlink data is a connected surface (Phase 3). (§4.5, §5.3)
17. **Enquiry → matter, one database forever** — winning an enquiry opens a new `matter`-type engagement for the same contact in the same database; the Clio/Leap-style matters module (Phase 3+) is a separate surface and planning effort, never a separate store; external practice-management tools may only ever be connected surfaces with our database as source of truth. (§6)

## 10. Explicitly deferred

- ~~Physical stack, hosting~~ → CLOSED: Supabase + Vercel + Next.js/TypeScript + Turborepo + Trigger.dev (master context §3.9). Free tiers during build; paid (~$45/mo) the day real X Law leads flow through the system.
- Time tracking / billable hours, trust accounting (client money rules), full document assembly → not needed for the MVP workflow; revisit at Phase 2/3 with real demand.
- Multi-currency beyond a currency column, tax regimes beyond UK VAT → Phase 3+.
- Search/vector indexing (pgvector) of communications and content for the context assembly engine → specified in Spec 2's territory; the extension choice is settled by the Supabase decision.
- Final product name → open decision, under research; agent name "Light" unchanged.
