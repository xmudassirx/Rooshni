-- 0002: platform structure (Spec 1 §5.0) and actors/memberships (§5.1)

create type public.actor_type as enum ('human', 'agent', 'workflow', 'integration');
create type public.membership_role as enum ('owner', 'member');
create type public.domain_surface as enum ('website', 'portal');

-- §5.0 accounts — one row per signup. The account is the person (master context 3.11).
create table public.accounts (
  id uuid primary key default public.uuid_generate_v7(),
  name text not null,
  owner_user_id uuid references auth.users (id) on delete set null,
  plan text not null default 'solo',
  billing_status text not null default 'free_tier',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create trigger accounts_set_updated_at
  before update on public.accounts
  for each row execute function private.set_updated_at();

-- §5.0 businesses — one row per operating business (sub-account).
-- businesses.template_id FK is added in 0003 (templates table references businesses).
create table public.businesses (
  id uuid primary key default public.uuid_generate_v7(),
  account_id uuid not null references public.accounts (id),
  name text not null,
  template_id uuid,
  settings jsonb not null default '{}'::jsonb,
  timezone text not null default 'Europe/London',
  default_locale text not null default 'en-GB',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index businesses_account_id_idx on public.businesses (account_id);

create trigger businesses_set_updated_at
  before update on public.businesses
  for each row execute function private.set_updated_at();

-- §5.0 domains — tenant custom domains for public generated surfaces only.
create table public.domains (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  hostname text not null unique,
  surface public.domain_surface not null,
  verification_status text not null default 'pending',
  verified_at timestamptz,
  ssl_status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index domains_business_id_idx on public.domains (business_id);

create trigger domains_set_updated_at
  before update on public.domains
  for each row execute function private.set_updated_at();

-- §5.1 actors — humans, agents, workflows, integrations.
-- Every created_by / assignee_actor_id / approved_by_actor_id points here.
-- Implementation note (needs founder sign-off, documented in the session report):
-- Spec 1 gives actors no tenancy column, but RLS-on-every-table needs a scope,
-- so actors carry a nullable account_id — account-scoped actors (Mudassir, Light,
-- integrations) set it; a null means platform-level.
create table public.actors (
  id uuid primary key default public.uuid_generate_v7(),
  account_id uuid references public.accounts (id),
  actor_type public.actor_type not null,
  display_name text not null,
  user_id uuid references auth.users (id) on delete set null,
  agent_role_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  constraint actors_user_id_humans_only check (user_id is null or actor_type = 'human')
);

create index actors_account_id_idx on public.actors (account_id);
create unique index actors_user_id_uniq on public.actors (user_id) where user_id is not null;

create trigger actors_set_updated_at
  before update on public.actors
  for each row execute function private.set_updated_at();

-- §5.1 memberships — may this human log into this business at all?
-- Capability inside it is Spec 3's grant engine (Session 2), never roles here.
create table public.memberships (
  id uuid primary key default public.uuid_generate_v7(),
  user_id uuid not null references auth.users (id) on delete cascade,
  business_id uuid not null references public.businesses (id),
  role public.membership_role not null default 'member',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (user_id, business_id)
);

create index memberships_business_id_idx on public.memberships (business_id);

create trigger memberships_set_updated_at
  before update on public.memberships
  for each row execute function private.set_updated_at();
