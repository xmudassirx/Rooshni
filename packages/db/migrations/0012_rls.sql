-- 0012: Row-Level Security on every table (Spec 1 §2.8, decision 2; Spec 3).
-- Tenancy walls are RLS, not separate databases. Enforced from day one, even
-- with one tenant, because retrofitting tenancy is how platforms die.
--
-- Session 1 scope: business-membership isolation. The Spec 3 grants engine
-- (tool/access/scope, Session 2) tightens WHAT a member may do; RLS here
-- answers WHETHER they may touch the business's rows at all. The service role
-- bypasses RLS and is used only by trusted server code (integrations, seed).
-- Hard deletes are Level 3+: no DELETE policy exists for authenticated users
-- anywhere — deletion happens only through gated service-role pipelines.

-- Helpers are SECURITY DEFINER in the private schema (not exposed via
-- PostgREST) so policies never recurse through RLS-protected tables.

create or replace function private.actor_business_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.business_id
  from public.memberships m
  where m.user_id = (select auth.uid())
    and m.archived_at is null;
$$;

create or replace function private.actor_account_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select a.id
  from public.accounts a
  where a.owner_user_id = (select auth.uid())
  union
  select b.account_id
  from public.businesses b
  join public.memberships m on m.business_id = b.id
  where m.user_id = (select auth.uid())
    and m.archived_at is null;
$$;

create or replace function private.is_account_owner(account uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.accounts a
    where a.id = account and a.owner_user_id = (select auth.uid())
  );
$$;

-- ---------------------------------------------------------------------------
-- Platform structure
-- ---------------------------------------------------------------------------

alter table public.accounts enable row level security;

create policy accounts_select on public.accounts
  for select to authenticated
  using (id in (select private.actor_account_ids()));

create policy accounts_update_owner on public.accounts
  for update to authenticated
  using (owner_user_id = (select auth.uid()))
  with check (owner_user_id = (select auth.uid()));

alter table public.businesses enable row level security;

create policy businesses_select on public.businesses
  for select to authenticated
  using (
    id in (select private.actor_business_ids())
    or private.is_account_owner(account_id)
  );

create policy businesses_insert_owner on public.businesses
  for insert to authenticated
  with check (private.is_account_owner(account_id));

create policy businesses_update_owner on public.businesses
  for update to authenticated
  using (private.is_account_owner(account_id))
  with check (private.is_account_owner(account_id));

alter table public.domains enable row level security;

create policy domains_select on public.domains
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));

create policy domains_write_owner on public.domains
  for insert to authenticated
  with check (
    business_id in (
      select b.id from public.businesses b
      where private.is_account_owner(b.account_id)
    )
  );

create policy domains_update_owner on public.domains
  for update to authenticated
  using (
    business_id in (
      select b.id from public.businesses b
      where private.is_account_owner(b.account_id)
    )
  );

alter table public.actors enable row level security;

-- Actor names render on every surface; platform-level actors (null account)
-- are visible to any signed-in user. Creating/archiving actors is a gated
-- flow — service role only, no write policies.
create policy actors_select on public.actors
  for select to authenticated
  using (
    account_id is null
    or account_id in (select private.actor_account_ids())
  );

alter table public.memberships enable row level security;

create policy memberships_select on public.memberships
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or business_id in (select private.actor_business_ids())
  );

-- ---------------------------------------------------------------------------
-- Events ledger: members read their business's ledger and may append to it.
-- No update/delete policies — and triggers + revoked privileges forbid them
-- for every role regardless.
-- ---------------------------------------------------------------------------

alter table public.events enable row level security;

create policy events_select on public.events
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));

create policy events_insert on public.events
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));

-- ---------------------------------------------------------------------------
-- Template configuration: scoped through templates.business_id.
-- ---------------------------------------------------------------------------

alter table public.templates enable row level security;

create policy templates_select on public.templates
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));

create policy templates_write on public.templates
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));

create policy templates_update on public.templates
  for update to authenticated
  using (business_id in (select private.actor_business_ids()));

alter table public.engagement_types enable row level security;

create policy engagement_types_select on public.engagement_types
  for select to authenticated
  using (
    exists (
      select 1 from public.templates t
      where t.id = template_id
        and t.business_id in (select private.actor_business_ids())
    )
  );

alter table public.stage_definitions enable row level security;

create policy stage_definitions_select on public.stage_definitions
  for select to authenticated
  using (
    exists (
      select 1
      from public.engagement_types et
      join public.templates t on t.id = et.template_id
      where et.id = engagement_type_id
        and t.business_id in (select private.actor_business_ids())
    )
  );

alter table public.field_definitions enable row level security;

create policy field_definitions_select on public.field_definitions
  for select to authenticated
  using (
    exists (
      select 1 from public.templates t
      where t.id = template_id
        and t.business_id in (select private.actor_business_ids())
    )
  );

alter table public.content_archetypes enable row level security;

create policy content_archetypes_select on public.content_archetypes
  for select to authenticated
  using (
    exists (
      select 1 from public.templates t
      where t.id = template_id
        and t.business_id in (select private.actor_business_ids())
    )
  );

alter table public.vocabulary enable row level security;

create policy vocabulary_select on public.vocabulary
  for select to authenticated
  using (
    exists (
      select 1 from public.templates t
      where t.id = template_id
        and t.business_id in (select private.actor_business_ids())
    )
  );

-- Template configuration changes are gated acts (Spec 1 §2.3, Spec 4 §2.4):
-- no insert/update policies on the child config tables — service role only,
-- through approval-gated pipelines from Session 2 onwards.

-- ---------------------------------------------------------------------------
-- Domain tables: business-member isolation, select/insert/update, no delete.
-- ---------------------------------------------------------------------------

-- contacts
alter table public.contacts enable row level security;
create policy contacts_select on public.contacts
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));
create policy contacts_insert on public.contacts
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));
create policy contacts_update on public.contacts
  for update to authenticated
  using (business_id in (select private.actor_business_ids()))
  with check (business_id in (select private.actor_business_ids()));

-- contact_channels
alter table public.contact_channels enable row level security;
create policy contact_channels_select on public.contact_channels
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));
create policy contact_channels_insert on public.contact_channels
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));
create policy contact_channels_update on public.contact_channels
  for update to authenticated
  using (business_id in (select private.actor_business_ids()))
  with check (business_id in (select private.actor_business_ids()));

-- contact_relationships
alter table public.contact_relationships enable row level security;
create policy contact_relationships_select on public.contact_relationships
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));
create policy contact_relationships_insert on public.contact_relationships
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));
create policy contact_relationships_update on public.contact_relationships
  for update to authenticated
  using (business_id in (select private.actor_business_ids()))
  with check (business_id in (select private.actor_business_ids()));

-- engagements
alter table public.engagements enable row level security;
create policy engagements_select on public.engagements
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));
create policy engagements_insert on public.engagements
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));
create policy engagements_update on public.engagements
  for update to authenticated
  using (business_id in (select private.actor_business_ids()))
  with check (business_id in (select private.actor_business_ids()));

-- engagement_participants
alter table public.engagement_participants enable row level security;
create policy engagement_participants_select on public.engagement_participants
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));
create policy engagement_participants_insert on public.engagement_participants
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));
create policy engagement_participants_update on public.engagement_participants
  for update to authenticated
  using (business_id in (select private.actor_business_ids()))
  with check (business_id in (select private.actor_business_ids()));

-- stage_history (append-only: select + insert only)
alter table public.stage_history enable row level security;
create policy stage_history_select on public.stage_history
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));
create policy stage_history_insert on public.stage_history
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));

-- tasks
alter table public.tasks enable row level security;
create policy tasks_select on public.tasks
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));
create policy tasks_insert on public.tasks
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));
create policy tasks_update on public.tasks
  for update to authenticated
  using (business_id in (select private.actor_business_ids()))
  with check (business_id in (select private.actor_business_ids()));

-- comm_threads
alter table public.comm_threads enable row level security;
create policy comm_threads_select on public.comm_threads
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));
create policy comm_threads_insert on public.comm_threads
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));
create policy comm_threads_update on public.comm_threads
  for update to authenticated
  using (business_id in (select private.actor_business_ids()))
  with check (business_id in (select private.actor_business_ids()));

-- communications
alter table public.communications enable row level security;
create policy communications_select on public.communications
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));
create policy communications_insert on public.communications
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));
create policy communications_update on public.communications
  for update to authenticated
  using (business_id in (select private.actor_business_ids()))
  with check (business_id in (select private.actor_business_ids()));

-- content_items
alter table public.content_items enable row level security;
-- Private notes stay the author's until promoted (§4.5): visibility gate on
-- top of the membership gate.
create policy content_items_select on public.content_items
  for select to authenticated
  using (
    business_id in (select private.actor_business_ids())
    and (
      visibility = 'team'
      or exists (
        select 1 from public.actors a
        where a.id = created_by and a.user_id = (select auth.uid())
      )
    )
  );
create policy content_items_insert on public.content_items
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));
create policy content_items_update on public.content_items
  for update to authenticated
  using (
    business_id in (select private.actor_business_ids())
    and (
      visibility = 'team'
      or exists (
        select 1 from public.actors a
        where a.id = created_by and a.user_id = (select auth.uid())
      )
    )
  )
  with check (business_id in (select private.actor_business_ids()));

-- content_versions (immutable history: select + insert only)
alter table public.content_versions enable row level security;
create policy content_versions_select on public.content_versions
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));
create policy content_versions_insert on public.content_versions
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));

-- invoices
alter table public.invoices enable row level security;
create policy invoices_select on public.invoices
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));
create policy invoices_insert on public.invoices
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));
create policy invoices_update on public.invoices
  for update to authenticated
  using (business_id in (select private.actor_business_ids()))
  with check (business_id in (select private.actor_business_ids()));

-- invoice_lines
alter table public.invoice_lines enable row level security;
create policy invoice_lines_select on public.invoice_lines
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));
create policy invoice_lines_insert on public.invoice_lines
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));
create policy invoice_lines_update on public.invoice_lines
  for update to authenticated
  using (business_id in (select private.actor_business_ids()))
  with check (business_id in (select private.actor_business_ids()));

-- payments
alter table public.payments enable row level security;
create policy payments_select on public.payments
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));
create policy payments_insert on public.payments
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));
create policy payments_update on public.payments
  for update to authenticated
  using (business_id in (select private.actor_business_ids()))
  with check (business_id in (select private.actor_business_ids()));

-- spend_records
alter table public.spend_records enable row level security;
create policy spend_records_select on public.spend_records
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));
create policy spend_records_insert on public.spend_records
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));
create policy spend_records_update on public.spend_records
  for update to authenticated
  using (business_id in (select private.actor_business_ids()))
  with check (business_id in (select private.actor_business_ids()));

-- files
alter table public.files enable row level security;
create policy files_select on public.files
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));
create policy files_insert on public.files
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));
create policy files_update on public.files
  for update to authenticated
  using (business_id in (select private.actor_business_ids()))
  with check (business_id in (select private.actor_business_ids()));

-- file_links
alter table public.file_links enable row level security;
create policy file_links_select on public.file_links
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));
create policy file_links_insert on public.file_links
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));

-- entity_links
alter table public.entity_links enable row level security;
create policy entity_links_select on public.entity_links
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));
create policy entity_links_insert on public.entity_links
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));
create policy entity_links_update on public.entity_links
  for update to authenticated
  using (business_id in (select private.actor_business_ids()))
  with check (business_id in (select private.actor_business_ids()));
