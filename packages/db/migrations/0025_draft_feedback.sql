-- 0025: draft_feedback (Session 15 — query-aware drafting; founder
-- pre-ruling PR-4, session prompt of 31 July 2026).
--
-- The refine loop's seed: an edit-before-stamp or a rejection reason is a
-- training signal the system previously threw away. Each lands here as an
-- append-only row — body before, body after (edits only), the reason, and
-- the knowledge-pack entry ids the draft was composed from — queryable by
-- template for the future training loop. Evented on The Record by the app
-- layer via emitEvent() (law 11 — SQL never writes the ledger).

create table public.draft_feedback (
  -- The Spec 1 envelope.
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '[]'::jsonb,

  -- PR-4's columns, verbatim: communication_id, template_id, kind
  -- edit|rejection, body_before, body_after (null for rejection), reason,
  -- pack entry ids the draft used, actor (= created_by above), created_at.
  communication_id uuid not null references public.communications (id),
  -- JUDGMENT: template_id (the per-business install the draft was made
  -- under) is nullable — a rejection can land on a draft that predates the
  -- install pointer or was hand-authored; the signal is still worth keeping.
  template_id uuid references public.templates (id),
  kind text not null,
  body_before text not null,
  body_after text,
  reason text,
  -- The knowledge-pack entry ids assembled into the draft (uuid strings).
  pack_entry_ids jsonb not null default '[]'::jsonb,

  constraint draft_feedback_kind check (kind in ('edit', 'rejection')),
  -- An edit records the after-wording; a rejection records no after-wording
  -- and must state its reason (mirrors the 0017 rejection-reason law).
  constraint draft_feedback_shape check (
    (kind = 'edit' and body_after is not null)
    or (kind = 'rejection' and body_after is null
        and reason is not null and btrim(reason) <> '')
  )
);

create index draft_feedback_business_id_idx on public.draft_feedback (business_id);
create index draft_feedback_communication_idx on public.draft_feedback (communication_id);
-- "Queryable by template for the future training loop" (PR-4).
create index draft_feedback_template_idx on public.draft_feedback (template_id) where template_id is not null;

-- ---------------------------------------------------------------------------
-- Append-only: the signal is history the moment it lands. Triggers refuse
-- UPDATE and DELETE for every role including service (the 0004 pattern);
-- privileges revoked as well — belt and braces. No set_updated_at trigger:
-- nothing may update.
-- ---------------------------------------------------------------------------
create trigger draft_feedback_append_only
  before update or delete on public.draft_feedback
  for each row execute function private.raise_append_only();

revoke update, delete on public.draft_feedback from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- RLS: business-membership isolation. Select + insert for members; no
-- update/delete policies (append-only above; hard delete is Level 3+).
-- ---------------------------------------------------------------------------
alter table public.draft_feedback enable row level security;

create policy draft_feedback_select on public.draft_feedback
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));

create policy draft_feedback_insert on public.draft_feedback
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));
