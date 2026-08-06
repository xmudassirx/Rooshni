-- 0044: Light's Memory (D181, Session 32 — founder-ruled 6 August 2026).
--
-- Everything Light knows that is not a database fact is a MEMORY ENTRY —
-- readable, editable, evented; nothing about how Light behaves lives
-- hardcoded. Three kinds:
--   fact        — a business fact (opening hours, phone, booking link,
--                 signature) carrying a declared SURFACES LIST naming where
--                 it appears in the world;
--   instruction — a standing instruction that rides every composition,
--                 bounded by the 800-token ceiling (D181);
--   observation — a learned note (today: rejection reasons), promotable to
--                 an instruction by a human hand only.
--
-- Memory history is append-only: an edit SUPERSEDES (a new row naming its
-- predecessor), never overwrites. The only lawful UPDATE is the supersede/
-- deactivate transition: active true -> false, optionally setting
-- superseded_by_entry_id (null -> value, once). Everything else is
-- immutable; DELETE does not exist for any role. Entries are evented by the
-- app layer via emitEvent() (law 11 — SQL never writes the ledger); this
-- migration carries schema + enforcement only, no data (the seed backfill
-- is a TS door so the seeds event).

create table public.memory_entries (
  -- The Spec 1 envelope — identical on every domain table; do not reorder.
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '[]'::jsonb,

  -- D181's shape: kind, the entry itself, the active flag, the supersede
  -- chain, provenance, and the fact's surfaces list.
  kind text not null,
  title text not null,
  body text not null,
  active boolean not null default true,
  superseded_by_entry_id uuid references public.memory_entries (id),
  -- Provenance: WHO is created_by, WHEN is created_at; WHY is stated here
  -- ("seeded from settings at migration 0044", "promoted from observation",
  -- "rejection reason on communication …"). Structured provenance
  -- (fact_key, law, promoted_from, feedback ids) rides `attributes`.
  why text,
  -- The declared surfaces list (facts only): [{surface, label, ref,
  -- in_platform}] — in-platform surfaces the ripple sweep drafts
  -- corrections for; external surfaces it raises tasks for.
  surfaces jsonb not null default '[]'::jsonb,

  constraint memory_entries_kind check (kind in ('fact', 'instruction', 'observation')),
  constraint memory_entries_title_present check (btrim(title) <> ''),
  constraint memory_entries_surfaces_shape check (jsonb_typeof(surfaces) = 'array'),
  -- Only facts carry surfaces — an instruction or observation appears
  -- nowhere in the world by itself.
  constraint memory_entries_surfaces_facts_only check (kind = 'fact' or surfaces = '[]'::jsonb)
);

create index memory_entries_business_id_idx on public.memory_entries (business_id);
create index memory_entries_lookup_idx on public.memory_entries (business_id, kind, active);

-- JUDGMENT: facts need identity (which fact IS the booking link?) for the
-- single-home reads ruled at pre-flight (Q1, option A) — identity rides
-- attributes.fact_key (the declared "structured provenance in attributes"),
-- and ONE ACTIVE fact per key per business is enforced here: two active
-- booking-link facts would be two homes, the exact drift the laws forbid.
create unique index memory_entries_active_fact_key_uniq
  on public.memory_entries (business_id, (attributes ->> 'fact_key'))
  where kind = 'fact' and active and attributes ? 'fact_key';

create trigger memory_entries_set_updated_at
  before update on public.memory_entries
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Append-only content: the ONLY lawful update is the supersede/deactivate
-- transition. An edit is an INSERT of the successor plus this one flip on
-- the predecessor; history never rewrites.
-- ---------------------------------------------------------------------------
create or replace function private.memory_entries_guard_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind        is distinct from old.kind
     or new.title       is distinct from old.title
     or new.body        is distinct from old.body
     or new.why         is distinct from old.why
     or new.surfaces    is distinct from old.surfaces
     or new.attributes  is distinct from old.attributes
     or new.external_refs is distinct from old.external_refs
     or new.business_id is distinct from old.business_id
     or new.created_by  is distinct from old.created_by
     or new.created_at  is distinct from old.created_at
     or new.archived_at is distinct from old.archived_at
  then
    raise exception 'memory_entries: entry % is append-only — an edit supersedes (insert a successor), never overwrites', old.id;
  end if;

  if old.active = false and new.active = true then
    raise exception 'memory_entries: entry % cannot reactivate — supersede it with a fresh entry instead', old.id;
  end if;

  if new.superseded_by_entry_id is distinct from old.superseded_by_entry_id then
    if old.superseded_by_entry_id is not null then
      raise exception 'memory_entries: entry % is already superseded — the chain never rewrites', old.id;
    end if;
    if new.active then
      raise exception 'memory_entries: a superseded entry cannot stay active — entry %', old.id;
    end if;
  end if;

  return new;
end;
$$;

create trigger memory_entries_guard_update
  before update on public.memory_entries
  for each row execute function private.memory_entries_guard_update();

-- Deletion does not exist (the 0004/0025 pattern): trigger for every role
-- including service, plus the privilege revoked — belt and braces.
create trigger memory_entries_append_only_delete
  before delete on public.memory_entries
  for each row execute function private.raise_append_only();

revoke delete on public.memory_entries from anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Light never self-writes an instruction (D181): an instruction's author is
-- a HUMAN actor, physically — the 0009 human-publisher pattern. Observations
-- and facts may be machine-written (a rejection reason arrives by Light's
-- bookkeeping; promotion to an instruction is the human act).
-- ---------------------------------------------------------------------------
create or replace function private.memory_entries_instruction_human_author()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind = 'instruction' then
    if not exists (
      select 1 from public.actors a
      where a.id = new.created_by and a.actor_type = 'human'
    ) then
      raise exception 'memory_entries: a standing instruction is written by a HUMAN hand only — Light never self-writes an instruction (D181)';
    end if;
  end if;
  return new;
end;
$$;

create trigger memory_entries_instruction_human_author
  before insert on public.memory_entries
  for each row execute function private.memory_entries_instruction_human_author();

-- ---------------------------------------------------------------------------
-- The 800-token ceiling (D181): the business's ACTIVE standing instructions
-- never exceed 800 tokens — the refusal names the count rather than
-- silently degrading every draft. Token estimate = ceil(char_length / 4),
-- the exact SQL mirror of estimateTokens (model-router.ts); the two doors
-- must never disagree. Insert-time check suffices: body and active->true
-- are unreachable by UPDATE (guard above), so the active set only grows
-- through this door. The business row is locked to serialise concurrent
-- inserts.
-- ---------------------------------------------------------------------------
create or replace function private.memory_entries_instruction_ceiling()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_existing integer;
  v_new integer;
begin
  if new.kind = 'instruction' and new.active then
    perform 1 from public.businesses where id = new.business_id for update;
    select coalesce(sum(ceil(char_length(body) / 4.0)), 0)::integer
      into v_existing
      from public.memory_entries
      where business_id = new.business_id
        and kind = 'instruction'
        and active;
    v_new := ceil(char_length(new.body) / 4.0)::integer;
    if v_existing + v_new > 800 then
      raise exception 'memory_entries: active standing instructions would total % tokens — the ceiling is 800 (D181); shorten or deactivate an instruction first', v_existing + v_new;
    end if;
  end if;
  return new;
end;
$$;

create trigger memory_entries_instruction_ceiling
  before insert on public.memory_entries
  for each row execute function private.memory_entries_instruction_ceiling();

-- ---------------------------------------------------------------------------
-- RLS: business-membership isolation. Select/insert/update for members
-- (update is only the guarded supersede transition above); NO DELETE policy
-- for users, ever.
-- ---------------------------------------------------------------------------
alter table public.memory_entries enable row level security;

create policy memory_entries_select on public.memory_entries
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));

create policy memory_entries_insert on public.memory_entries
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));

create policy memory_entries_update on public.memory_entries
  for update to authenticated
  using (business_id in (select private.actor_business_ids()))
  with check (business_id in (select private.actor_business_ids()));
