-- 0003: template configuration tables (Spec 1 §5.3)
-- Templates configure; they never mutate schema (§2.2). One physical schema
-- for every client; verticals are rows here.

create type public.engagement_outcome as enum ('won', 'lost', 'unresponsive', 'disqualified');

-- One row per vertical template version installed for a business.
create table public.templates (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  vertical text not null,
  version int not null default 1,
  no_go_rules jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (business_id, vertical, version)
);

create trigger templates_set_updated_at
  before update on public.templates
  for each row execute function private.set_updated_at();

-- Now templates exists, close the circular reference from businesses.
alter table public.businesses
  add constraint businesses_template_id_fkey
  foreign key (template_id) references public.templates (id);

-- "case", "Skilled Worker visa", "enrolment"…
create table public.engagement_types (
  id uuid primary key default public.uuid_generate_v7(),
  template_id uuid not null references public.templates (id),
  key text not null,
  label text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (template_id, key)
);

create trigger engagement_types_set_updated_at
  before update on public.engagement_types
  for each row execute function private.set_updated_at();

-- Pipeline stages per engagement type. Column note: the spec names the
-- ordering column `order`, a reserved SQL keyword — implemented as sort_order.
create table public.stage_definitions (
  id uuid primary key default public.uuid_generate_v7(),
  engagement_type_id uuid not null references public.engagement_types (id),
  key text not null,
  label text not null,
  sort_order int not null,
  is_terminal boolean not null default false,
  terminal_outcome public.engagement_outcome,
  sla_hours numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (engagement_type_id, key),
  constraint stage_definitions_terminal_outcome_only_when_terminal
    check (terminal_outcome is null or is_terminal)
);

create trigger stage_definitions_set_updated_at
  before update on public.stage_definitions
  for each row execute function private.set_updated_at();

-- The whitelist for the `attributes` envelope column (§2.3): every key that
-- appears in attributes must correspond to a row here. Implementation note:
-- the spec's column list omits an attachment point; template_id added for
-- consistency with the sibling config tables.
create table public.field_definitions (
  id uuid primary key default public.uuid_generate_v7(),
  template_id uuid not null references public.templates (id),
  entity text not null,
  key text not null,
  label text not null,
  data_type text not null,
  validation jsonb not null default '{}'::jsonb,
  surface_visibility jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (template_id, entity, key)
);

create trigger field_definitions_set_updated_at
  before update on public.field_definitions
  for each row execute function private.set_updated_at();

-- Page shapes a generated website page follows (§5.3, master context 3.12).
create table public.content_archetypes (
  id uuid primary key default public.uuid_generate_v7(),
  template_id uuid not null references public.templates (id),
  key text not null,
  label text not null,
  section_structure jsonb not null default '[]'::jsonb,
  skill_ref text,
  audit_profile jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (template_id, key)
);

create trigger content_archetypes_set_updated_at
  before update on public.content_archetypes
  for each row execute function private.set_updated_at();

-- "engagement" -> "case"/"enquiry": surfaces and Light's language read this.
create table public.vocabulary (
  id uuid primary key default public.uuid_generate_v7(),
  template_id uuid not null references public.templates (id),
  term_key text not null,
  label text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (template_id, term_key)
);

create trigger vocabulary_set_updated_at
  before update on public.vocabulary
  for each row execute function private.set_updated_at();
