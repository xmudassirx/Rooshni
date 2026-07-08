-- 0011: files (Spec 1 §5.4) and generic links (§5.5).
-- Immigration casework is document-heavy from day one.

create table public.files (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,

  storage_key text not null unique,
  filename text not null,
  mime_type text not null,
  size_bytes bigint not null,
  sha256 text not null,
  uploaded_by uuid not null references public.actors (id)
);

create index files_business_idx on public.files (business_id);

create trigger files_set_updated_at
  before update on public.files
  for each row execute function private.set_updated_at();

-- Linked to any record: attachment | evidence | logo | lesson_asset.
create table public.file_links (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),

  file_id uuid not null references public.files (id),
  entity_type text not null,
  entity_id uuid not null,
  role text not null default 'attachment'
);

create index file_links_file_idx on public.file_links (file_id);
create index file_links_entity_idx on public.file_links (entity_type, entity_id);

-- §5.5 entity_links — generic record-to-record links. Born for the notes
-- surface, useful everywhere; Light-proposed links carry the
-- proposed -> confirmed lifecycle.
create table public.entity_links (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,

  from_entity_type text not null,
  from_entity_id uuid not null,
  to_entity_type text not null,
  to_entity_id uuid not null,
  -- about | mentions | derived_from …
  role text not null default 'about',
  proposed_by_actor_id uuid references public.actors (id),
  confirmed_at timestamptz
);

create index entity_links_from_idx on public.entity_links (from_entity_type, from_entity_id);
create index entity_links_to_idx on public.entity_links (to_entity_type, to_entity_id);
create index entity_links_business_idx on public.entity_links (business_id);
