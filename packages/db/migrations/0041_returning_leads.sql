-- 0041: returning-leads structures (Session 27, D158 — founder-ruled 2 Aug
-- 2026, quoted in DECISIONS.md entry 158).
--
-- The ruled frontier unit: "consumption blocks RE-PROCESSING OF THE SAME
-- SUBMISSION (same leadgen id), never a NEW submission by a known contact —
-- a new leadgen id on a known contact is a returning-lead event, always
-- processed." The same-submission block already exists structurally (the
-- 0021 meta_webhook_events unique claim on the leadgen id + the engagement
-- external_refs idempotency guard) and is UNTOUCHED here. What this
-- migration adds is the returning half's schema:
--
--   1. a lookup index on contact_channels so the ingest path can resolve a
--      submission to a known contact deterministically (exact value match,
--      business-scoped) without a scan;
--   2. engagements.predecessor_engagement_id — D158(d)'s linkage: a new
--      enquiry opened for a returning contact whose previous enquiry is
--      closed carries its predecessor, visible on both timelines.
--
-- JUDGMENT: the system marker (D158a) needs NO schema change — the 0008
-- comm_direction enum already carries 'internal', and the marker rides a
-- communications row (direction internal, kind in attributes). The session
-- prompt anticipated a "marker kind" migration; the enum already suffices,
-- so none is written (an unnecessary migration is not discipline).
--
-- JUDGMENT: predecessor_engagement_id is a first-class column, not an
-- attributes key — linkage is read by both timelines and the workflow
-- drafter (returning-context intro), and a JSONB key would invite drift.
-- The decision 4/17 class of addition: a needed fact gains a column.

-- 1. Known-contact resolution: exact-value lookup, business-scoped.
create index contact_channels_lookup_idx
  on public.contact_channels (business_id, channel, value)
  where archived_at is null;

-- 2. The enquiry linkage (closed/unresponsive fork).
alter table public.engagements
  add column predecessor_engagement_id uuid references public.engagements (id);

create index engagements_predecessor_idx
  on public.engagements (predecessor_engagement_id)
  where predecessor_engagement_id is not null;

-- A successor can never be its own predecessor.
alter table public.engagements
  add constraint engagements_no_self_predecessor
  check (predecessor_engagement_id is null or predecessor_engagement_id <> id);
