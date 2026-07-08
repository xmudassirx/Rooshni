-- 0006: engagements domain (Spec 1 §4.2) — the container of work over time.
-- X Law renames it "enquiry" pre-instruction; "case/matter" is reserved for
-- instructed clients (§6).

create table public.engagements (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '[]'::jsonb,

  template_type_id uuid not null references public.engagement_types (id),
  title text not null,
  stage_id uuid not null references public.stage_definitions (id),
  stage_entered_at timestamptz not null default now(),
  outcome public.engagement_outcome,
  outcome_at timestamptz,
  value_estimate numeric,
  attribution jsonb not null default '{}'::jsonb,
  -- Accountable human, never an agent — the trust architecture (§4.2).
  owner_actor_id uuid not null references public.actors (id)
);

create index engagements_business_id_idx on public.engagements (business_id);
create index engagements_stage_id_idx on public.engagements (stage_id);
create index engagements_owner_idx on public.engagements (owner_actor_id);

create trigger engagements_set_updated_at
  before update on public.engagements
  for each row execute function private.set_updated_at();

-- The accountable owner must be a human actor (Spec 1 §4.2).
create or replace function private.enforce_human_engagement_owner()
returns trigger
language plpgsql
as $$
begin
  if not exists (
    select 1 from public.actors a
    where a.id = new.owner_actor_id and a.actor_type = 'human'
  ) then
    raise exception 'engagements.owner_actor_id must reference a human actor — the accountable owner is never an agent';
  end if;
  return new;
end;
$$;

create trigger engagements_owner_is_human
  before insert or update of owner_actor_id on public.engagements
  for each row execute function private.enforce_human_engagement_owner();

create table public.engagement_participants (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '[]'::jsonb,

  engagement_id uuid not null references public.engagements (id),
  contact_id uuid not null references public.contacts (id),
  -- template vocab: client, dependant, sponsor, student, opposing_party…
  role text not null,
  unique (engagement_id, contact_id, role)
);

create index engagement_participants_engagement_idx on public.engagement_participants (engagement_id);
create index engagement_participants_contact_idx on public.engagement_participants (contact_id);

create trigger engagement_participants_set_updated_at
  before update on public.engagement_participants
  for each row execute function private.set_updated_at();

-- §4.2 stage_history — append-only record of every stage transition. The CRM
-- pipeline surface and conversion analytics read this table.
create table public.stage_history (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),

  engagement_id uuid not null references public.engagements (id),
  from_stage uuid references public.stage_definitions (id),
  to_stage uuid not null references public.stage_definitions (id),
  moved_at timestamptz not null default now(),
  moved_by uuid not null references public.actors (id)
);

create index stage_history_engagement_idx on public.stage_history (engagement_id, moved_at);
create index stage_history_business_idx on public.stage_history (business_id);

create trigger stage_history_append_only
  before update or delete on public.stage_history
  for each row execute function private.raise_append_only();

revoke update, delete on public.stage_history from anon, authenticated, service_role;
