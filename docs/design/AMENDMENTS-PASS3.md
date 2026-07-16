# Design Pass 3 — Amendments & Decisions (signed: Mudassir)
Master mockup v2 is the design authority for all Phase 2 surfaces. Mock one
phase ahead of build, never more; Phase 3+ screens inside it are marked
SIGNED EXCEPTION and are not build targets.

## Surfaces settled in pass 3
- Notes: no folders; structure generated from entity_links + grants; Inbox =
  unlinked; capture-with-Light with stated-link mismatch detection and
  correction cascade (relink, never delete).
- Website group: Pages / page detail (WP-style sticky rail, draggable +
  collapsible rail cards) / Templates / Analytics / Settings (8 tabs).
  Scorecard radar: SEO/GEO/AEO/FRESH/COMP with per-axis breakdowns.
  Multiple scoped header/footer sets; locked compliance lines.
- Templates gallery: shell-wide, free + premium, search + category filter,
  Write/Code/Ask-Light creation. MARKETPLACE SEED — PHASE 4.
- Campaigns: segments = saved views; saved blocks library (header, footer +
  feedback module with locked unsubscribe, CTA); any block built in a
  campaign can be saved back.
- Social group: Home / Calendar / Posts / Studio / Analytics + composer +
  Preferences modal. Studio: image|video modes with mode-specific providers
  (img: GPT Image, Imagen; vid: Flow/Veo, Higgsfield, Omni), optional first
  frame on video, brand tokens ride along, per-generation spend gate.
  NOTE: founder not fully satisfied with Social layouts — enhance in a
  later pass; function is settled, composition is not.
- Tasks: week view with strict columns (task | TIME | HAND-OFF), per-task
  full "✦ Hand to Light" buttons, empty weekends, + New task; modal has
  view/edit modes, description, calendar popover (any month), alarm-style
  HH:MM picker, search-filtered enquiry link. Every task has a day → syncs
  to connected calendar (timed = event, untimed = all-day).
- Light page: first nav item; chat is a FRONT DOOR, not a system of record —
  everything lands in gated surfaces. "Who can talk to Light" = grants.
- Client portal (PHASE 3 · SIGNED EXCEPTION): magic-link; stage bar;
  Documents / Messages / Appointments / Payments (own block) / feedback.
  Configure-portal modal: draggable+renamable stages, block toggles,
  per-visa templates + save-as-template.
- Feedback (grant-gated surface): email-footer thumbs link to a site FORM
  PAGE (form archetype) at /feedback; answers write into Feedback and onto
  the contact thread when known; Light clusters recurring themes.
- Finance (PHASE 3 · SIGNED EXCEPTION): money primitive's face; invoices
  linked to engagements; DUE-AT-STAGE pattern; overdue → chase task with
  Light-drafted reminder; portal Payments = client-visible slice.
- Agent roles: agent renamed Minha → Noor → AMAL. Role = skill + knowledge
  pack + grants + routing rule. Voice & model panel: brain (LLM via model
  router; Light Standard/Pro or BYO) separate from mouth (ElevenLabs-class
  voice provider; voice models with per-minute tiers, English/multilingual).

## Laws locked in pass 3
1. Connections live ONCE, in Settings → Integrations; providers are actors
   with grants (media models connect over MCP). Surfaces keep only
   behaviour preferences (small Preferences panel) — no per-surface
   settings tabs, ever.
2. VIDEO STORAGE LAW: never our bytes. Provider CDN via signed URL; poster
   + provenance (provider, prompt, cost) in the library only; Meta hosts
   published copies; images → R2 (zero egress); unpinned assets expire
   after 30 days. Supabase stores rows, not media.
3. STAGE SYNC: stages ARE engagement.stage — one vocabulary across
   pipeline, contact, conversations, workflows, portal. A stage move is one
   proposed change, stamped once, reflected everywhere; stage moves can
   trigger due-at-stage invoices and portal updates in the same act.
4. COLOUR TAXONOMY LAW: ACCENT = chrome & kinds (active states, primary
   buttons, table headers, focus rings, data bars, kind chips) and follows
   the user's accent. PRISM|GOLD = Light's channel only (acts, chips,
   response mesh, avatars) — user-selectable in Appearance, prism default.
   GREEN = done/published and RED = stamp/overdue NEVER move, any theme.
5. Themes: default = Frost + blue accent + prism Light. Frost defines its
   own paper/paper-deep/rule variables (no cream leakage). Mono theme =
   white/black luxury. Seven accents. Semantic colours invariant.

## Carried open items
- Social layout composition — enhance next design pass.
- Decision 15 (auto-close logic) falls due in Session 8.
- Sequential enquiry references — schema backlog.
- Templates marketplace mechanics — Phase 4.
