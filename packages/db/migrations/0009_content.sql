-- 0009: content domain (Spec 1 §4.5) — everything published or teachable.

create type public.content_visibility as enum ('private', 'team');
create type public.content_state as enum ('draft', 'pending_approval', 'published', 'unpublished');

create table public.content_items (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '[]'::jsonb,

  -- template vocab: page | blog_post | funnel_page | email_template |
  -- whatsapp_template | course | module | lesson | document_template | note
  content_type text not null,
  parent_id uuid references public.content_items (id),
  title text not null,
  slug text not null,
  -- Structured blocks, portable across templates — never raw HTML.
  body jsonb not null default '[]'::jsonb,
  -- Notes default private (quick capture stays the author's until promoted);
  -- other content defaults team — the seed/app layer sets it per type.
  visibility public.content_visibility not null default 'team',
  state public.content_state not null default 'draft',
  surface_binding jsonb,
  published_at timestamptz,
  published_by_actor_id uuid references public.actors (id),
  version int not null default 1,
  archetype_id uuid references public.content_archetypes (id),
  audit jsonb
);

create index content_items_business_idx on public.content_items (business_id);
create index content_items_parent_idx on public.content_items (parent_id) where parent_id is not null;
-- Slug unique per business per surface; archived rows free their slug.
create unique index content_items_slug_uniq
  on public.content_items (business_id, content_type, slug)
  where archived_at is null;

create trigger content_items_set_updated_at
  before update on public.content_items
  for each row execute function private.set_updated_at();

-- Publishing is Level 3+ — same human-approval enforcement as comms (§4.5).
create or replace function private.enforce_human_content_publish()
returns trigger
language plpgsql
as $$
begin
  if new.state = 'published' then
    if new.published_by_actor_id is null then
      raise exception 'Content % cannot be published without published_by_actor_id — publishing is Level 3+', new.id;
    end if;
    if not exists (
      select 1 from public.actors a
      where a.id = new.published_by_actor_id and a.actor_type = 'human'
    ) then
      raise exception 'content_items.published_by_actor_id must reference a HUMAN actor';
    end if;
  end if;
  return new;
end;
$$;

create trigger content_items_human_publish
  before insert or update on public.content_items
  for each row execute function private.enforce_human_content_publish();

-- Prior versions retained (§4.5): (id, content_id, version, body, saved_at).
-- business_id added for direct RLS; otherwise exactly the specced shape.
create table public.content_versions (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  content_id uuid not null references public.content_items (id),
  version int not null,
  body jsonb not null,
  saved_at timestamptz not null default now(),
  unique (content_id, version)
);

create index content_versions_content_idx on public.content_versions (content_id);
