-- NNNN: <domain> (<Spec reference>) — <one line: what this table is for>.
--
-- Skeleton for a new-table migration. Copy, renumber to the next free
-- number, and replace every <placeholder>. Everything a new table must
-- carry ships in this one file (migration-discipline non-negotiable 3):
-- UUIDv7 pk, the Spec 1 envelope columns, RLS with business-membership
-- policies, and NO user DELETE policy. If the spec adds enforcement
-- (append-only, closed columns), the trigger/revocation ships here too —
-- a table without its enforcement is an unfinished migration.
--
-- Lint before committing:
--   node .claude/skills/migration-discipline/scripts/check_migration.mjs <this file>

create table public.<table_name> (
  -- The Spec 1 envelope — identical on every domain table; do not reorder.
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '[]'::jsonb,

  -- Domain columns below the envelope.
  -- JUDGMENT: <only if Lane B — the spec is silent or has a small additive
  -- gap and this column/rename/index fills it. One comment per call, at the
  -- site. Example from decision 1: spec column name `order` is a reserved
  -- keyword; using sort_order. Delete this comment if no call was made.>
  <column_name> <type> not null
);

create index <table_name>_business_id_idx on public.<table_name> (business_id);

create trigger <table_name>_set_updated_at
  before update on public.<table_name>
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: business-membership isolation, in the same migration as the table.
-- select/insert/update for members; NO DELETE policy for users, ever —
-- hard delete is a Level 3+ service-role act (Spec 1 §2.8, PLAYBOOK §7).
-- For an append-only table, drop the update policy as well and ship the
-- append-only trigger here (0004_events.sql is the pattern).
-- ---------------------------------------------------------------------------

alter table public.<table_name> enable row level security;

create policy <table_name>_select on public.<table_name>
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));

create policy <table_name>_insert on public.<table_name>
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));

create policy <table_name>_update on public.<table_name>
  for update to authenticated
  using (business_id in (select private.actor_business_ids()))
  with check (business_id in (select private.actor_business_ids()));
