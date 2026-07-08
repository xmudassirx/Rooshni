-- 0005: contacts domain (Spec 1 §4.1) — who we know.
-- Envelope columns (§3) appear on every domain table: id, business_id,
-- created_at, updated_at, created_by, archived_at, attributes, external_refs.

create type public.contact_type as enum ('person', 'organisation');
create type public.contact_status as enum ('active', 'unresponsive', 'do_not_contact', 'junk');
create type public.contact_channel_type as enum ('email', 'phone', 'whatsapp', 'address', 'social');

create table public.contacts (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '[]'::jsonb,

  type public.contact_type not null,
  display_name text not null,
  given_name text,
  family_name text,
  org_id uuid references public.contacts (id),
  status public.contact_status not null default 'active',
  first_touch jsonb,
  locale text not null default 'en-GB',
  notes text
);

create index contacts_business_id_idx on public.contacts (business_id);
create index contacts_org_id_idx on public.contacts (org_id) where org_id is not null;

create trigger contacts_set_updated_at
  before update on public.contacts
  for each row execute function private.set_updated_at();

-- A contact has many ways to be reached; consent is legally per channel.
create table public.contact_channels (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '[]'::jsonb,

  contact_id uuid not null references public.contacts (id),
  channel public.contact_channel_type not null,
  value text not null,
  is_primary boolean not null default false,
  consent jsonb not null default '{}'::jsonb,
  verified_at timestamptz
);

create index contact_channels_contact_id_idx on public.contact_channels (contact_id);
-- Inbound communications are matched to contacts by channel value (§4.1).
create index contact_channels_value_idx on public.contact_channels (business_id, channel, value);
-- One primary per channel type per contact.
create unique index contact_channels_one_primary_per_type
  on public.contact_channels (contact_id, channel)
  where is_primary and archived_at is null;

create trigger contact_channels_set_updated_at
  before update on public.contact_channels
  for each row execute function private.set_updated_at();

-- Typed edges between contacts: dependants, sponsors, referrers…
-- relationship is enum + template vocab (§4.1), so text, not a fixed enum.
create table public.contact_relationships (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '[]'::jsonb,

  from_contact_id uuid not null references public.contacts (id),
  to_contact_id uuid not null references public.contacts (id),
  relationship text not null
);

create index contact_relationships_from_idx on public.contact_relationships (from_contact_id);
create index contact_relationships_to_idx on public.contact_relationships (to_contact_id);

create trigger contact_relationships_set_updated_at
  before update on public.contact_relationships
  for each row execute function private.set_updated_at();
