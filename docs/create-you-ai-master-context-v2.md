# Create You AI — Master Context (Source of Truth)

**Status:** Vision and strategy LOCKED. Current phase: **Phase 0 — Blueprint, ENDGAME.** All four specs complete and signed off (Spec 1 v0.5 · Spec 2 v0.2 · Spec 3 v0.2 · Spec 4 v1.0 — timers provisional pending lead log). Phase 1 mockup complete: 11 clickable screens, 2 themes × 3 accents, in `mockup-pass1-shell-pipeline-case.html`. **Remaining to close Phase 0:** (1) the two-week lead log — pull arrivals/sources from Brevo + GHL exports, annotate founder-minutes and touch-by-touch outcomes; (2) founder visual check of all mockup screens; (3) platform accounts: Supabase, Vercel, Meta developer app (Lead Ads API + WhatsApp Business — review queues take weeks), Google/Outlook calendar API.
**Last updated:** 7 July 2026.
**How to use this doc:** Every new chat reads this first. Locked decisions are settled unless Mudassir explicitly reopens them. When new decisions are made, this doc gets updated — chat history is never the source of truth.

---

## 1. The product in one paragraph (locked)

Create You AI is a model-agnostic AI operating system where a person or company owns structured, project-scoped **memory**, a **context assembly engine** that feeds each task exactly the right slice of that memory, scoped **permissions** negotiated conversationally, **approval gates** on every risky action, and a full **audit trail** — with commodity business tools (website, CRM, LMS, portal, invoicing) **generated as configurable template surfaces over one shared database**, external networks (Meta, calendars, payments) **connected** via APIs/MCP, and an orchestrating agent ("**Light**") acting as an **AI COO**: it runs operations, the human runs the business. Positioning line: *own the context, rent the intelligence.* Between Lovable (generates apps, no brain) and GoHighLevel (bundled tools, no brain): **one database with many generated faces, and a brain that knows all of it.** And unlike both, it is **as personal as it is business** (3.11): one brain that runs your ventures and knows you.

## 2. Founder context

- Mudassir runs **X Law** (UK immigration advisory, IAA Level 1, Salam Law Chambers, Manchester) and **BarakahX IT Company** (likely corporate vehicle for this product).
- X Law is **customer zero**. First vertical: UK immigration/small law firms.
- Known real pain (stated unprompted): ~80% of Facebook leads are junk; the gap between lead arrival and booked consultation is the bleeding point.
- Working style: decisions are made by clicking concrete things, not reading abstractions — hence the design-before-wiring process (3.14).

## 3. Locked decisions

### 3.1 Architecture stack (bottom → top; MVP = everything below the boundary)
1. **Model connection layer** — MCP-native, model-agnostic, with a **model router**: per-skill/per-agent model choice (registry of models, default routing table: cheap model for triage, strong for drafting, real-time for voice; user override).
2. **Memory store** — cards with lifecycle (see 3.2).
3. **Context assembly engine** — selects the right memory slice per task. This is the moat. Separate layer from storage.
4. **Permissions engine** — scoped grants (see 3.3).
5. **Skills + standards** — methods and quality bars.
6. **Workflows + approval gates** — approval lives here (gates on actions at steps).
   — **MVP boundary** —
7. **Agent roles** (Phase 2) — workflows + scoped permissions per persona, coordinated by the **orchestrator** (Light as AI COO: reads events, routes to workflows, delegates, escalates at gates).
8. **Voice interface** (Phase 3+) — another input surface into the same engines. Voice never bypasses approval levels.
**Audit trail spans everything** — built first, every layer writes to it, readable by non-technical users.

### 3.2 Memory lifecycle
- **Working memory** (auto-captured, session-level) → expires unless promoted.
- **Core memory cards** → promoted by user confirmation or observed repetition.
- **Skills** → facts/preferences stay as cards; *methods* graduate into skills.
- Every card is **scoped**: account-level ("Global" — this is the personal-preferences scope, 3.11) or per-business. Conflict detection runs only within a scope; cross-business differences are by design. Conflict fix = one-tap re-scope.
- Cards carry **provenance** (where/when it came from) and **trust level** (authoritative → outdated/rejected).
- Cards are visible, editable, deletable, addable, exportable (card UI in dashboard).
- Full model specified in **Phase 0 Spec 2**.

### 3.3 Permissions and approvals
- Grant schema: `{tool, access (read/write/…), duration (this-task/standing), scope (account/business/engagement), granted-at, via (chat/voice/dashboard)}`.
- **No grant without explicit scope** — if unspecified, the AI must ask (conversationally, including by voice). Graceful denial: "I don't have access — grant it, or tell me how to proceed?"
- Approval levels 0–4 (advise-only → draft-only → safe execution → human approval required → forbidden). Always Level 3+: sending external comms, publishing, spending money, deleting, deploying.
- **AI spend runs through approval too** — significant credit burns trigger a gate ("this costs ~$4 — proceed?").
- **Grants apply to human employees identically** (locked 6 Jul): tenant-employee access = the same grant schema, attached via memberships. One permission system for human and AI staff — a product promise.

### 3.4 Surfaces taxonomy
- **Generated surfaces** (template + constrained configuration, NEVER free-form codegen; one maintained codebase per template wearing per-client config): website/blog/funnels (3.12), CRM/Enquiries views, unified Conversations inbox (3.13), notes (3.10), basic LMS, client portal, employee task boards, invoicing UI, simple internal chat. Hosted on the platform.
- **Connected surfaces** (network effects / heavy infra): Meta & Google ads (free APIs), **WhatsApp AND Messenger via Meta APIs**, Google/Outlook calendar, Stripe, email *delivery* pipes, full accounting/tax (Xero) beyond generated invoicing, external practice management (Clio/Leap — only ever connected, see 3.13).
- **Email, clarified (locked 7 Jul):** **1:1 emails** (nurture, booking) send via the firm's connected Gmail/Outlook — Phase 1. **Bulk campaigns** (Phase 2/3) send through bundled pipes (SES-class) under our generated campaign UI: segments are views over contacts, sends/opens land in communications, Level 3 approval on every campaign, per-channel consent enforced at the door. Deliverability (per-tenant SPF/DKIM guided setup, warm-up, hygiene) is owned engineering. BYO-ESP exists only as a buried advanced option. Rationale: Mailchimp-style connections create a second synced contact store and sever opens/clicks from the thread — forbidden.
- **Native core** (the brain's own face): dashboard, approval inbox, audit views ("The Ledger"), memory card UI.
- Rule for going native: only if no good tool exists, OR the surface is the brain's face, OR AI-native is 10x.
- LMS never needs "its own backend" — enrolments are engagements (Spec 1, decision 6).

### 3.5 One shared database — six primitives
**Contacts, engagements, tasks, communications, content, money.** All generated surfaces are views over these. No syncing anywhere. Vertical templates = vocabulary + pipeline stages + no-go rules + skill pack over the same six primitives. Full schema: **Phase 0 Spec 1 (v0.5, complete)** — six domains ≈ twenty tables + cross-cutting (accounts, businesses, domains, actors, events, template config, files, entity_links). One *physical* PostgreSQL database for the whole platform; tenancy walls are Row-Level Security, not separate databases. Scale path when metrics demand: indexes → replicas → partitioning — standard SaaS ladder, no schema change.

### 3.6 Feedback loops (how the product improves with use)
- Every AI output carries **Approve / Refine / Train**. Refine-diffs are analysed and proposed as memory/standard updates. Train = show an example, extract a skill. Onboarding = learning by being corrected during real work.
- **Dashboard is AI-curated by attention**: checked daily → promoted; ignored → decays. Same promotion/decay mechanics as memory. Manual pinning always available.
- **Meta Conversions API feedback**: deal marked won → configurable cooling timer (default 24h) → if not reversed, outcome + value fires to Meta automatically; reversal cancels. Junk outcomes also fed back. This closed loop (spend→lead→outcome→spend) is a moat.
- **Nurture funnel** (workflow engine, ships early): missed call → retry later same day → missed-call email → WhatsApp follow-ups → sequenced touches → auto-close after N failures.

### 3.7 Voice agent (Phase 3, premium bolt-on)
Outbound qualification/booking calls; live transfer or booking offers; email summary + booking confirmation after every call. Per-minute priced with the rate visible up front (router-driven voice/model/language choice under tier abstraction, 3.16).
**Adopted from GHL study (7 Jul), built better:** during-call actions (transfer, booking) are *granted tools* — booking reads real availability (3.17) because the agent holds calendar execute; **AI-call disclosure is mandatory at template level**, not optional (legal requirement + law-firm brand); post-call triggers ride the normal workflow engine; the agent prompt is a versioned **voice skill** (seed: Mudassir's existing "Minha" prompt).
**The anti-silo rule:** the voice agent is *Light on the phone* — no separate knowledge base, logs, or analytics. Context assembly briefs every call; every call lands as a communications row with transcript (column reserved since Spec 1); grants and approval levels apply identically. GHL's separate Voice-AI silo is the disease, not the pattern.

### 3.8 Pricing and billing (locked structure, numbers TBD)
- **~$99/mo platform fee** + **metered AI credits** with visible meter and spend approval gates.
- **Tier structure (locked 7 Jul):** Solo ~$99 = up to 3 businesses (**Personal space free, uncounted**); Agency ~$297+ = high/unlimited businesses + white-label (Phase 3). Business-count limits enforced via `accounts.plan` at business creation. Platform fee gates structure; **credits capture scale** — an agency with 100 clients burns 100 clients' worth of credits.
- **Credit controls (Phase 2):** account wallet + per-business caps (businesses.settings); Light alerts at thresholds; at cap, AI work pauses to "pending credits", never silent failure.
- **Agency top-ups (Phase 3):** client businesses self-serve credit top-ups *through the platform at agency-set prices*; auto-split (we take wholesale + fee, agency keeps margin). Clients never buy from us directly behind an agency — no channel conflict.
- **Plug-and-play is the default**: platform holds provider accounts (voice, telephony, image gen, email delivery) and rebills per-unit with margin. **BYOK** = buried advanced option.
- Sales line: replaces a $300–500/mo tool stack.
- **Infra billing ramp:** free tiers (Supabase Free, Vercel Hobby) during build; upgrade to paid (~$45/mo) the day real X Law leads flow through the system — not when the first tenant signs. Vercel Hobby prohibits commercial use and hard-pauses at limits.

### 3.9 Tenancy, stack and domains (locked 6 July 2026)
- **Account structure (GHL-shaped):** signup creates an *account*; an account contains many *businesses* (sub-accounts). Phase 1 = one account (Mudassir) containing X Law + BarakahX (second business keeps scoping honest). Agency *features* remain Phase 3; the *structure* is built now.
- **Stack:** Supabase (PostgreSQL + RLS + pgvector + Auth + Storage) · Next.js App Router + TypeScript on Vercel · Turborepo monorepo · shadcn/ui + Tailwind (no Refine — generated surfaces render from template config) · Trigger.dev for durable workflow timers (executes only; all state lives in Supabase) · Vercel AI SDK under our model router + MCP TypeScript SDK.
- **Why Supabase over Firebase:** six primitives are relational; RLS is the tenancy/permissions substrate; pgvector serves the context assembly engine; open-source Postgres = exit door unlocked. Schema-change fear resolved: migrations are AI-written and branch-tested; everyday field additions are configuration rows, not schema changes.
- **Domain map:** `www.[name].com` marketing (Phase 2) · `app.[name].com` the product — all users of all tenants log in here, identity determines view · `console.[name].com` platform god-view (internal) · tenant public surfaces (website, portal) on the tenant's own domain via wildcard/custom domains. No per-tenant dashboard domains outside the Phase 3 white-label tier.

### 3.10 Notes surface (locked 7 July 2026)
- **Notes are content, not a new primitive:** content_items of type `note` (structured blocks; checklist blocks = native Keep-style lists) + `visibility` (private default / team) + generic `entity_links` (any record → any record; Light-proposed links confirmed by humans).
- **No manual folders, ever.** Sidebar is *generated*: Inbox (unlinked captures; Light proposes links) · engagement groupings from entity_links ∩ viewer's grants · saved views (stored searches) as pseudo-folders. Notes born from a task/case arrive pre-linked; one note can appear under many projects.
- **Lifecycle mirrors memory:** fleeting notes fade; useful ones promoted (Light proposes) — one-tap promote to task, memory card, or content draft.
- **Pattern rule:** structure derived from links + grants, not manual filing — the model for every generated surface.
- **Phasing:** surface ships Phase 2; from Phase 1 day one the `internal_note` comms channel covers case-level notes.

### 3.11 The personal dimension (locked 7 July 2026)
- **The account is the person; businesses are the ventures.** A "Personal" space is a business row with no vertical template — usable from Phase 2. A polished personal *template* (lists-first dashboard, family sharing) is Phase 3+ marketplace item.
- **Personal preferences are account-scoped memory** (tone, language, answer style) — defined in Spec 2, live in Phase 1, applied by Light across every business.
- **HARD RULE — no cross-space leakage:** business context never appears in personal output and vice versa; only account-level preference cards cross spaces. A trust promise, enforced by scoping, stated to users.

### 3.12 Website surface, skills-from-prompts, and content scoring (locked 7 July 2026)
- **Website admin (Phase 2):** pages list = view over content_items; "create new page" = pick a content_archetype → Light runs its generation skill → draft → Level 3 publish gate. Archetypes ship with the vertical template.
- **Principle — founder prompts are proto-skills:** polished prompt documents written for X Law (e.g. the UK immigration funnel-page document, saved to project knowledge as `skill-seed-uk-immigration-funnel-page.pdf`) become named, versioned skills in the vertical's skill pack — improvable via Refine/Train, distributable via the Phase 4 marketplace. Their compliance instructions feed template no_go_rules.
- **Content scoring:** every page carries a scorecard — SEO / GEO-AEO / compliance, each 0–100 with red/amber/green — cached on the page, history in events. On-page scoring is generated (deterministic checks + cheap-model audit; Phase 2 — the demo moment). Off-page data (rankings, backlinks — Search Console first) is a connected surface, Phase 3. Compliance scoring against the firm's no_go_rules is what SEMrush structurally cannot do.

### 3.13 Conversations, vocabulary, and the matters rule (locked 7 July 2026)
- **Conversations surface:** unified per-contact inbox across WhatsApp, Messenger, email, SMS — a *view* over the channel-unified communications table; channel badges on every message here and in enquiry timelines.
- **X Law vocabulary:** pre-instruction engagement = "**enquiry**" (pipeline tab: Enquiries). "**Case/matter**" is reserved for instructed clients.
- **Matters module (Phase 3+, HARD RULE):** winning an enquiry opens a new engagement of type *matter* for the same contact **in the same database**. The Clio/Leap-style module is a separate planning effort and surface, NEVER a separate database or store behind an API seam. External practice-management tools may only be *connected* surfaces with our database as source of truth. The unbroken client thread is the moat.

### 3.14 Design system and process (locked 7 July 2026)
- **Design-before-wiring:** Phase 0 concludes with clickable mockups of all Phase 1 screens; specs 2–4 are settled *through* mockup click-throughs (mockup first, spec as the record). Mockups mirror the MVP boundary strictly.
- **Theming:** design-token system from day one (same engine as tenant website branding). Phase 1 catalogue: 2 themes (Ledger, Frost) × 3 accents (green/cool/warm) × 4 font choices (theme/serif/sans/round) × 3 sizes — per-user settings. **Semantic colours are invariant everywhere: gold = Light acted, red = human stamp, green = done; the monospace register face never changes.** New themes added rarely; each is a permanent QA surface. Default theme: TBD by founder after living with both.
- Phase 1 mockup inventory: app shell · dashboard · approval inbox · Enquiries pipeline · enquiry detail · Conversations · contacts · memory cards · The Ledger (audit) · settings. Pass 1 delivered: shell + pipeline + enquiry detail + theme system.

### 3.15 Light's vigilance model (locked 7 July 2026)
- Always-awake = event-driven, not always-running: the events ledger is the nervous system; deterministic triggers (stage SLA breaches, unanswered inbound, unprepared meetings, credit thresholds, closing Meta windows) + a heartbeat sweep on the cheap triage model, escalating to strong models only on suspicion. Cost-disciplined; all watching is metered and evented.
- Suggestions surface as advise-only (Level 0) dashboard items; proposed *actions* climb the normal approval ladder. Vigilance never bypasses a gate.
- Phase 1: watchful-lite (workflow timers, SLA alerts, morning digest). Phase 2: full orchestrator vigilance. Specced in detail in Spec 4.

### 3.16 Intelligence tiers and the quality floor (locked 7 July 2026)
- Users buy **tiers (Light Standard / Light Pro)**, never models; the routing table mapping tiers → models is ours to maintain and swap. Model names appear only in buried advanced settings. Light is not the model: memory, skills, permissions, audit are ours; the model is a swappable rented engine.
- **Certification floor:** skills carry a minimum capability class; compliance, vigilance-escalation and approval-adjacent lanes refuse uncertified models. BYOK below the floor voids performance guarantees, stated plainly.
- **Pricing:** no separate Light fee — tier intelligence is priced through credit consumption rates (Pro burns credits faster; margin travels with model cost).
- Context-switching costs are structurally small: assembly feeds curated slices (memory cards ≈ compression), routing is per-task; provider cache resets on switch are accepted noise.

### 3.17 Calendars and booking (locked 7 July 2026)
- Every human actor connects their own calendar (Outlook/Google — connected surfaces). Availability = connected free/busy ∩ working hours and time-off set in their profile. Booking flows (links, Light-made bookings) offer only genuinely free slots for the selected person; a blocked calendar shows no slots.
- Phase 1: owner's calendar (already in the MVP workflow). Phase 2: per-employee calendars + choose-a-person booking. Phase 3: round-robin/team booking.

### 3.18 Approval inbox integrity (locked 7 July 2026)
- **The Approve control must be earned:** deterministic pre-flight checks run before it renders (referenced attachment present, links valid, channel consent exists, no-go rules clear). Failing items show a Blocked state with a fix action — approving broken things is impossible, not discouraged.
- **The inbox contains only stamp-awaiting items** (AI/staff drafts, spend gates, grant requests). Incoming mail never appears here — it belongs to Conversations. The badge counts stamps owed, nothing else.
- Every inbox item is openable to full content (attachments, diffs) before stamping.

### 3.19 Memory import/export & employee access timeline (locked 7 July 2026)
- **Import (Phase 2 onboarding):** paste text / drop screenshots from Claude, ChatGPT, or anywhere → Light parses into individual *proposed* cards (trust: observed, provenance: import), confirmed per-card via the Proposals tray. Never straight to core. A switching weapon.
- **Export governance:** no export on the memory screen. Owner-only in Settings → Data, Level 3 gated, ledger-evented. Console offers admin-assisted bulk export for company/agency requests (also evented).
- **Employee access:** engine Phase 1 (same grant schema as Light); management UI Phase 2 — invites, presets (Owner / Admin / Manager / Caseworker / Marketing / AI COO), and the per-person **permission matrix page** (all tools × view/draft/execute toggles); editable by anyone holding Admin (settings.team). Within-tab granularity via field_definitions.surface_visibility.

### 3.20 HR-lite, social posting, and visible automation (locked 7 July 2026)
- **HR-lite (Phase 3, by reuse):** staff profiles (actors + memberships), availability/time-off (3.17), onboarding checklists (workflows), staff documents (files), and **leave requests as approval-inbox items** (request → manager stamp → calendar blocked → booking slots vanish). Payroll/appraisals/HR compliance stay *connected* (Xero payroll class) — we do not become an HR company.
- **Social posting:** composition is ours — `social_post` content type, drafted by Light with the same content skills, scheduled, **publishing = Level 3** (batch-stamp a week's calendar in the inbox). Delivery is connected: Meta Pages/Instagram **Phase 2** (rides existing Meta plumbing); LinkedIn/TikTok/YouTube/X **Phase 3**. Engagement metrics land in events — the organic twin of the ads loop.
- **Visible automation:** workflows are data (Spec 4). Phase 1: template-shipped workflows, timers/toggles tweakable. **Phase 2: every automation opens as a generated visual flow** — canvas rendered from workflow rows (nodes, branches), with enrolment counts and execution logs (views over workflow_runs + events); editing via forms + **Light-proposed automations** (Level 3 config changes → Approval Inbox, plain English). **Phase 3: the same canvas becomes drag-and-drop editable.** Folders/grouping for workflow lists ride entity_links/saved views like notes.

### 3.21 Knowledge packs and sub-agents (locked 7 July 2026)
- **Knowledge packs:** curated, versioned bundles of facts + standards + articles (rows in the one database: memory cards + content of type knowledge_article, grouped via entity_links) referenced by skills. One source, every mouth: update the spouse-visa fee once → the voice agent says it right on the next call, drafts state it right, and dependent website pages are flagged for refresh. The GHL-style per-tool KB silo is explicitly rejected.
- **Sub-agents = Phase 2 agent roles:** skill (e.g. spouse-visa intake script — Minha prompt is the seed) + knowledge pack + grants (record/book/transfer, never advise — no_go enforced) + routing rule (enquiry type → agent). Voice embodiment of these roles is the Phase 3 bolt-on; the roles themselves work on chat/email channels from Phase 2.
- Intake calls by sub-agents ARE Spec 4 steps 2–5 with voice swapped in — the junk-filtering business case for the voice tier.

### 3.22 The knowledge ripple, voice call flow, and sites doctrine (locked 7 July 2026)
- **Voice call flow (Phase 3):** routing rule (enquiry type → sub-agent) → context assembly briefs the call (enquiry facts + knowledge pack + preferences + no-go rules) → mandatory disclosure → scripted intake, one question at a time → during-call tools by grant only (book from real availability, transfer to a named human, answer *from the pack*; advice requests deflect to booking — Level 4) → transcript + summary land as a communications row; extracted answers become proposed facts (observed trust); stage move proposed through normal gates; per-minute cost on the ledger. The sub-agent IS Light wearing one skill and one knowledge filter.
- **The knowledge ripple:** knowledge change detected (human edit, or Phase 3 vigilance monitoring GOV.UK) → proposed update → Inbox stamp → the fact is current everywhere instantly (same database — agents are never "told"). Light then walks entity_links to dependent content (funnel pages, blogs, templates) → drafts refreshes → batch of Level 3 updates in the Inbox; until stamped, affected pages' scorecards flag "stale fact" in amber. One approved change, every mouth, each public step stamped.
- **Sites doctrine (vs GHL's 13-tab Sites menu):** funnels/blogs/websites = content archetypes in ONE Website surface; **native web forms = an archetype writing into contacts/enquiries (Phase 2 — the website as a lead source beside Meta, zero new tables)**; surveys/quizzes = the form archetype later; chat widget = a front door into Conversations answered by Light with the same knowledge packs (Phase 3 — the text twin of the voice agent); QR codes = page utility (Phase 3); client portal = its own generated surface (already in taxonomy); stores/webinars = not our vertical, declined under the vertical rule. We sell one system that knows everything, not tab count.

## 4. Roadmap (locked)

- **Phase 0 — Blueprint (now):** Four spec documents: (1) six-primitive data schema — **COMPLETE v0.5**, (2) memory card model — in progress, (3) permission grant schema + approval table, (4) lead-to-booked-consultation workflow gate by gate. Plus clickable Phase 1 mockups (3.14). **Founder homework:** log every X Law lead for two weeks — Phase 1's acceptance test; validates the proposed Enquiries stages.
- **Phase 1 — The brain runs X Law (months 1–3):** MVP stack below the boundary + the one workflow, wired to real Meta lead forms, Microsoft Graph email + calendar (X Law is M365; provider-agnostic connector interface, Google Workspace added Phase 2), WhatsApp drafting. One generated surface: Enquiries pipeline view. One user: Mudassir. Success = more consultations booked per lead, faster, with less founder time than the Phase 0 log.
- **Phase 2 — Prove it's not just you (months 3–6):** Refine/Train buttons, Meta conversions loop, generated website surface (3.12: archetype create-flow + on-page scorecard v1), notes surface (3.10), Conversations inbox, bulk email campaigns (3.4), billing + credit caps (3.8). 3–5 **paying** pilot firms (immigration/small law via IAA network; low price, never free).
- **Phase 3 — Platform (months 6–12):** Generation engine proper (portal, invoicing, LMS), model router UI, voice agent bolt-on, agency tier (white-label, agency-priced top-ups), connected search data, matters-module planning. Funding/hiring decision based on Phase 2 numbers; BarakahX as vehicle.
- **Phase 4 — Vertical domination (12+ months):** Templates marketplace. Rule: **be the undisputed best for UK immigration firms before touching the next vertical.**

## 5. MVP workflow (locked): lead-to-booked-consultation for X Law
Facebook lead → shared contacts table → orchestrator triggers nurture sequence → drafted emails/WhatsApp through approval inbox → booking onto calendar → auto-close + outcome logging for dead leads → outcomes fed back to Meta. Exercises: memory, permissions, approvals, audit, one generated surface (Enquiries view), two connected surfaces (Meta, calendar). Fully walked through against the schema in Spec 1 §7.

## 6. Open decisions (not yet made)
1. Build tooling for Phase 1: Mudassir + Claude Code solo, vs. + one contract developer.
2. ~~Hosting/tech stack~~ → **CLOSED**, see 3.9.
3. Exact pricing numbers and credit rates (structure locked, 3.8).
4. Final product name — under research; "Lightwork" shortlisted but not chosen; agent name "Light" settled. Working title remains "Create You AI".
5. Voice agent stack/provider (Phase 3 decision).
6. Default theme (Ledger vs Frost) — founder to pick after living with both.

## 7. Design-phase reasoning worth remembering
- "Build vs connect" was resolved by a third option: **generate**. The expensive tools are exactly the generatable ones; the un-generatable networks are mostly free APIs.
- Lovable's failure mode (orphaned generated code) is avoided by templates + configuration — at the data layer too (one schema, per-client config rows).
- "AI CEO" was renamed **AI COO** deliberately: the human keeps judgment; the whole trust architecture depends on that promise. Structurally enforced: the send pipeline physically refuses outbound comms without a human approver (Spec 1, decision 7).
- The architecture absorbed every stress test (voice, generation, funnels, model choice, industries, notes, personal use, agencies, email marketing, practice management) without restructuring — only extending. That's why it's locked.
- Two recurring principles that answered multiple questions independently: **the thread must never be cut** (email, matters, conversations) and **the platform fee gates structure while credits capture scale** (pricing, agencies).

## Addendum — decisions landed 8–9 July 2026 (build ops chat)

INFRASTRUCTURE (all live):
- Supabase: project "Rooshni", region eu-west-2 London (UK data residency is a selling point vs GHL); new-style API keys (publishable/secret), auto-expose OFF, automatic RLS ON. Multi-region = separate deployments per region at Phase 4; never one global DB.
- GitHub: private repo xmudassirx/Rooshni — the repo is the memory; specs live in docs/.
- Vercel: project rooshni-web, root apps/web, Standard Protection (production domain OPEN, previews walled — production was never behind Vercel's wall; recorded as decision 23 amendment).
- Azure: app registration "Rooshni", Graph delegated Mail.Send/Mail.ReadWrite/Calendars.ReadWrite/offline_access/User.Read, admin consent granted, 730-day secret (move to cert-based auth on Phase 2 pre-flight list).
- Meta: X Law business VERIFIED; Marketing API + WhatsApp use cases on; App Review submission waits for a working demo (mid-Phase 1); build on Marketing API v25.0+ only; Tech Provider "Access verification" required at Phase 2.
- Google Cloud: OAuth client for Supabase Auth Google sign-in (published consent screen, basic scopes).

ARCHITECTURE AMENDMENTS:
- Phase 1 email + calendar = Microsoft Graph (X Law is M365), NOT Gmail; provider-agnostic connector interface from day one; Google Workspace = second provider, Phase 2 (Barakah).
- Auth arrived early (its own trigger clause: first second user / public reachability): Supabase Auth + Google, allowed_emails allowlist, middleware on all routes, nameless holding page, quiet-surface rule (product name appears nowhere in publicly served HTML; the vercel.app subdomain is the accepted exception until a custom domain).
- Domain: deferred with product naming (Phase 2 decision); rooshni.barakahx.com pattern approved if needed sooner; OAuth redirects use wildcard branch-alias pattern.

BUILD METHOD (now also encoded in docs/PLAYBOOK.md + CLAUDE.md + skills):
- Numbered sessions, fresh context each; scope + definition of done + rules block per session.
- Repo is the memory: DECISIONS.md (judgment calls recorded only after founder sign-off), GO-LIVE.md (accumulating checklist), protected-structures list.
- check-local (PGlite, refusal-first smoke tests) green before anything touches live.
- UI sessions on branches with Vercel preview; founder click-review is the merge gate; backend sessions on main. Branch protection on main goes on before real leads (GO-LIVE item).
- Long sessions batch judgment calls (proceed on spec-faithful reading, present all at end); stop mid-run only at locked doors or credentials.
- Model strategy post-Fable (12 Jul): Opus 4.8 for structural sessions (schema, engine, connectors, locked doors); Sonnet 5 for contained sessions (UI over existing APIs, docs, seeds). Playbook exists to move sessions from the first column to the second.
- Three parallel chats, one cabinet: Build Ops / Design (mockup pass 2) / Playbook. Chats never read each other; anything decided must land in project knowledge or the repo to exist.
-Build-order amendment (12 Jul): full-face UI completion precedes integration wiring — Session 7 = all remaining screens on Fable (design-before-wiring at full scale); Session 8 = send pipeline/webhook/cron on Opus 4.8. Rationale: Fable's edge is holistic product judgment; integration is contract-shaped work the playbook hardens for cheaper models.

PRODUCT DECISIONS:
- Ledger is the default theme; "The Record" is the UI label for the events ledger.
- The mockup-review six (editable inbox drafts + manual attach + hand-back; Conversations drag divider; reply toggle client-direct vs brief-Light; Contacts simple/advanced + separate linked detail pages; The Record rename; tabbed Settings) — statuses as of 9 Jul: 4/5/6 built, 1/2/3 pending their sessions.
- Inbox layout: stacked full-width cards (mockup pass 1 authority), master-detail rejected.
- UI never renders an unearned tick: unchecked pre-flight categories show as Pending, never green.
- One engagement type "enquiry" with visa_route as a declared custom field; visa routes are attributes, not lifecycles; "matter" is a future separate type.
- Human-friendly sequential enquiry references (#0114 style): schema backlog, near-term session.

BUILD STATE (end 9 Jul): migrations 0001–0019 live; Sessions 1–6 closed + parallel UI session merged pending; 107 smoke tests green; auth live on production; workflow engine + MVP workflow rehearsed end-to-end at TIME_SCALE=1440 with STUB send/Meta executors. Remaining before real leads: send pipeline (Graph + WhatsApp behind the locked door), real Meta lead webhook, Vercel cron + CRON_SECRET, plus GO-LIVE checklist (TIME_SCALE=1, purge demo data, branch protection, real sends replace STUBs, infra off free tiers).