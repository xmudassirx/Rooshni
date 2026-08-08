-- 0045: the MCP read door (Session 34, D188) — Barakah's Model Context
-- Protocol server, read-only, grant-scoped through the Spec 3 model.
--
-- The shape (D188a): the server acts as its OWN machine actor ("Claude via
-- MCP"), never service-role authority, never raw tables. Every tool is a
-- security-definer READ DOOR in this migration: it authenticates the
-- presented credential, re-derives actor and business inside the database,
-- consumes the Spec 3 grant (the 0015 pattern — the grant check is the
-- authorisation, not the route), and returns compact JSON filtered to that
-- business. Read-only is a database fact: no door writes domain data, and
-- the app-side registry tripwire proves the tool list carries no write path.
--
-- Credentials (D188c): minted per business in Settings → Integrations,
-- hashed at rest (SHA-256), never logged, revocable there. OAuth tokens
-- (founder rider, 8 Aug 2026) are short-lived, bound to the credential row,
-- and die on revoke.
--
-- JUDGMENT: the credential arrives at every door as its SHA-256 hex digest,
-- computed at the app edge — pgcrypto is not in the extension set and the
-- Gate 1 harness (PGlite) cannot load it, so the database stores and
-- compares digests only. The raw credential never enters SQL, which also
-- keeps it out of statement logs (D188c: never logged).

-- ---------------------------------------------------------------------------
-- OAuth client registrations (RFC 7591 dynamic client registration).
-- JUDGMENT: platform-scoped (no business_id) — a client registers before any
-- business is known, and the row carries no tenant data (redirect URIs and a
-- display name only). RLS on with NO policies: service-role only, the 0028
-- claim-table pattern.
-- ---------------------------------------------------------------------------
create table public.mcp_clients (
  id uuid primary key default public.uuid_generate_v7(),
  client_id text not null unique,
  client_name text,
  redirect_uris jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.mcp_clients enable row level security;
revoke delete on public.mcp_clients from authenticated;

-- ---------------------------------------------------------------------------
-- The minted credential — one live per business, hashed at rest.
-- ---------------------------------------------------------------------------
create table public.mcp_credentials (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '[]'::jsonb,

  -- The machine actor every authenticated call acts as (D188a).
  actor_id uuid not null references public.actors (id),
  label text not null,
  token_hash text not null unique,
  revoked_at timestamptz,
  revoked_by_actor_id uuid references public.actors (id),
  last_used_at timestamptz,

  constraint mcp_credentials_hash_shape check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint mcp_credentials_label_present check (btrim(label) <> '')
);

create index mcp_credentials_business_id_idx on public.mcp_credentials (business_id);
-- One live credential per business: mint again only after revoke (the
-- Settings row is a single mint/revoke door, D58/D188c).
create unique index mcp_credentials_one_live_uniq
  on public.mcp_credentials (business_id)
  where revoked_at is null and archived_at is null;

create trigger mcp_credentials_set_updated_at
  before update on public.mcp_credentials
  for each row execute function private.set_updated_at();

-- Mint rules, structural: the minter is a HUMAN holding team rights (the
-- 0014 granter law); the actor is a MACHINE (integration) belonging to the
-- business's account — the server can never be a person, and the stamp
-- tools stay structurally unholdable by it (0014).
create or replace function private.enforce_mcp_credential_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_minter_type public.actor_type;
  v_actor record;
  v_account uuid;
begin
  select a.actor_type into v_minter_type
  from public.actors a where a.id = new.created_by;
  if v_minter_type is distinct from 'human' then
    raise exception 'mcp_credentials.created_by must reference a HUMAN actor — only humans mint credentials';
  end if;
  if not private.is_business_owner_actor(new.created_by, new.business_id)
     and not private.consume_grant(new.created_by, new.business_id, 'settings.team', 'execute') then
    raise exception 'Minter % does not hold settings.team (execute) for this business — only team-rights holders mint MCP credentials', new.created_by;
  end if;

  select a.actor_type, a.account_id, a.archived_at
  into v_actor
  from public.actors a where a.id = new.actor_id;
  if v_actor.actor_type is distinct from 'integration' then
    raise exception 'mcp_credentials.actor_id must reference an INTEGRATION actor — the MCP server is a machine, never a person (D188a)';
  end if;
  if v_actor.archived_at is not null then
    raise exception 'mcp_credentials.actor_id references an archived actor';
  end if;
  select b.account_id into v_account
  from public.businesses b where b.id = new.business_id;
  if v_actor.account_id is distinct from v_account then
    raise exception 'mcp_credentials.actor_id must belong to the business''s account';
  end if;

  return new;
end;
$$;

create trigger mcp_credentials_structural_rules
  before insert on public.mcp_credentials
  for each row execute function private.enforce_mcp_credential_rules();

-- Credential terms are immutable after mint; only revocation (permanent,
-- human, team-rights) and the last-used stamp may touch a row — the grants
-- immutability law (0014), applied to the credential.
create or replace function private.enforce_mcp_credential_immutability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.business_id <> old.business_id
     or new.actor_id <> old.actor_id
     or new.label <> old.label
     or new.token_hash <> old.token_hash
     or new.created_by <> old.created_by
     or new.created_at <> old.created_at then
    raise exception 'MCP credential terms are immutable — revoke and mint a new credential instead';
  end if;

  if old.revoked_at is not null
     and (new.revoked_at is distinct from old.revoked_at
          or new.revoked_by_actor_id is distinct from old.revoked_by_actor_id) then
    raise exception 'revocation is permanent — a revoked MCP credential cannot be altered';
  end if;

  if new.revoked_at is not null and old.revoked_at is null then
    if new.revoked_by_actor_id is null then
      raise exception 'revocation must name revoked_by_actor_id';
    end if;
    if not exists (
      select 1 from public.actors a
      where a.id = new.revoked_by_actor_id and a.actor_type = 'human'
    ) then
      raise exception 'mcp_credentials.revoked_by_actor_id must reference a HUMAN actor';
    end if;
    if not private.is_business_owner_actor(new.revoked_by_actor_id, new.business_id)
       and not private.consume_grant(new.revoked_by_actor_id, new.business_id, 'settings.team', 'execute') then
      raise exception 'Revoker % does not hold settings.team (execute) for this business', new.revoked_by_actor_id;
    end if;
  end if;

  return new;
end;
$$;

create trigger mcp_credentials_terms_immutable
  before update on public.mcp_credentials
  for each row execute function private.enforce_mcp_credential_immutability();

-- RLS: members see their business's credential state; every write runs
-- through the service-side mint/revoke door (no authenticated write policy).
alter table public.mcp_credentials enable row level security;
create policy mcp_credentials_select on public.mcp_credentials
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));

-- The hash never reaches a browser: column privileges re-granted without it.
revoke select on public.mcp_credentials from authenticated;
grant select (
  id, business_id, created_at, updated_at, created_by, archived_at,
  attributes, external_refs, actor_id, label, revoked_at,
  revoked_by_actor_id, last_used_at
) on public.mcp_credentials to authenticated;
revoke insert, update, delete on public.mcp_credentials from authenticated;
revoke delete on public.mcp_credentials from service_role;

-- ---------------------------------------------------------------------------
-- OAuth artefacts: authorisation codes, access tokens, refresh tokens —
-- every one hashed at rest, bound to its credential, expiring (founder
-- rider 1: a token that lives forever quietly weakens the revoke door).
-- JUDGMENT: no Spec 1 envelope — these are transport security artefacts,
-- not domain rows (the 0028 claim-table precedent); service-role only.
-- ---------------------------------------------------------------------------
create table public.mcp_tokens (
  id uuid primary key default public.uuid_generate_v7(),
  credential_id uuid not null references public.mcp_credentials (id),
  business_id uuid not null references public.businesses (id),
  kind text not null,
  token_hash text not null unique,
  client_id text,
  redirect_uri text,
  code_challenge text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz,

  constraint mcp_tokens_kind check (kind in ('authorization_code', 'access_token', 'refresh_token')),
  constraint mcp_tokens_hash_shape check (token_hash ~ '^[0-9a-f]{64}$')
);

create index mcp_tokens_credential_idx on public.mcp_tokens (credential_id);
create index mcp_tokens_lookup_idx on public.mcp_tokens (token_hash) where consumed_at is null;

-- A token row's identity never changes; only one-time consumption lands.
create or replace function private.enforce_mcp_token_immutability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.credential_id <> old.credential_id
     or new.business_id <> old.business_id
     or new.kind <> old.kind
     or new.token_hash <> old.token_hash
     or new.client_id is distinct from old.client_id
     or new.redirect_uri is distinct from old.redirect_uri
     or new.code_challenge is distinct from old.code_challenge
     or new.expires_at <> old.expires_at
     or new.created_at <> old.created_at then
    raise exception 'MCP token rows are immutable — issue a new token instead';
  end if;
  if old.consumed_at is not null and new.consumed_at is distinct from old.consumed_at then
    raise exception 'MCP token consumption is one-time and permanent';
  end if;
  return new;
end;
$$;

create trigger mcp_tokens_immutable
  before update on public.mcp_tokens
  for each row execute function private.enforce_mcp_token_immutability();

alter table public.mcp_tokens enable row level security;
revoke select, insert, update, delete on public.mcp_tokens from authenticated;

-- ---------------------------------------------------------------------------
-- Tool registry additions (Spec 3 §3a — platform-defined; tenants grant
-- tools, never invent them). Three read surfaces had no tool key: The
-- Record, the workflow engine, and Light's Memory. `memory.export` (Level 3)
-- remains the export act; `memory` is the read surface beside it.
-- ---------------------------------------------------------------------------
insert into public.tools (key, label, category, default_level, surface) values
  ('record', 'The Record', 'record', 2, 'record'),
  ('workflows', 'Automation', 'workflows', 2, 'automation'),
  ('memory', 'Memory', 'memory', 2, 'memory');

-- ---------------------------------------------------------------------------
-- Authentication: resolve a presented digest to a live credential. Accepts
-- the digest of an unexpired access token (the OAuth path) or of the minted
-- credential itself (direct bearer — the inspector/CLI path). Stamps
-- last_used_at: the Settings row's connection state is EARNED by this stamp,
-- never assumed.
-- ---------------------------------------------------------------------------
create or replace function private.mcp_resolve_credential(p_token_sha256 text)
returns table (credential_id uuid, actor_id uuid, business_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
begin
  select c.id, c.actor_id, c.business_id
  into v
  from public.mcp_credentials c
  where c.token_hash = p_token_sha256
    and c.revoked_at is null
    and c.archived_at is null;

  if v.id is null then
    select c.id, c.actor_id, c.business_id
    into v
    from public.mcp_tokens t
    join public.mcp_credentials c on c.id = t.credential_id
    where t.token_hash = p_token_sha256
      and t.kind = 'access_token'
      and t.consumed_at is null
      and t.expires_at > now()
      and c.revoked_at is null
      and c.archived_at is null;
  end if;

  if v.id is null then
    raise exception 'MCP credential not recognised, expired, or revoked — mint or reconnect in Settings -> Integrations';
  end if;

  update public.mcp_credentials set last_used_at = now() where id = v.id;

  credential_id := v.id;
  actor_id := v.actor_id;
  business_id := v.business_id;
  return next;
end;
$$;

-- The route's auth surface: who is this credential? Used once per request
-- for authentication, rate-limit keying and the mcp.tool_called event's
-- actor — the doors below still re-derive identity themselves, so the route
-- cannot lie to a door about who is calling.
create or replace function public.mcp_whoami(p_token_sha256 text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
  v_label text;
  v_actor text;
begin
  select r.credential_id, r.actor_id, r.business_id into v
  from private.mcp_resolve_credential(p_token_sha256) r;

  select c.label into v_label from public.mcp_credentials c where c.id = v.credential_id;
  select a.display_name into v_actor from public.actors a where a.id = v.actor_id;

  return jsonb_build_object(
    'credential_id', v.credential_id,
    'actor_id', v.actor_id,
    'actor_name', v_actor,
    'business_id', v.business_id,
    'label', v_label
  );
end;
$$;

-- The 0015 pattern, applied to reads: authenticate, then consume the named
-- grant at view. The refusal names the missing grant (D188g, the fail-loud
-- grammar).
create or replace function private.mcp_require(p_token_sha256 text, p_tool text)
returns table (actor_id uuid, business_id uuid)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
begin
  select r.actor_id, r.business_id into v
  from private.mcp_resolve_credential(p_token_sha256) r;

  if not private.consume_grant(v.actor_id, v.business_id, p_tool, 'view') then
    raise exception 'Actor % does not hold % (view) for this business — grant it, or tell us how you''d like to proceed', v.actor_id, p_tool;
  end if;

  actor_id := v.actor_id;
  business_id := v.business_id;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- The ten read doors (D188f), one per ruled tool. Every door: authenticate,
-- consume the grant, read THIS business only, return compact JSON with ISO
-- timestamps. No door writes domain data.
-- ---------------------------------------------------------------------------

create or replace function public.mcp_enquiries_list(
  p_token_sha256 text,
  p_limit int default 25,
  p_offset int default 0,
  p_stage text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
  v_limit int := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_items jsonb;
  v_total bigint;
begin
  select r.actor_id, r.business_id into v from private.mcp_require(p_token_sha256, 'enquiries') r;

  select count(*) into v_total
  from public.engagements e
  left join public.stage_definitions s on s.id = e.stage_id
  where e.business_id = v.business_id
    and e.archived_at is null
    and (p_stage is null or s.key = p_stage);

  select coalesce(jsonb_agg(item), '[]'::jsonb) into v_items
  from (
    select jsonb_build_object(
      'id', e.id,
      'title', e.title,
      'stage', s.key,
      'stage_label', s.label,
      'stage_entered_at', to_jsonb(e.stage_entered_at),
      'created_at', to_jsonb(e.created_at),
      'outcome', e.outcome,
      'value_estimate', e.value_estimate,
      'visa_route', e.attributes ->> 'visa_route',
      'participants', coalesce((
        select jsonb_agg(c.display_name order by c.display_name)
        from public.engagement_participants ep
        join public.contacts c on c.id = ep.contact_id
        where ep.engagement_id = e.id and ep.archived_at is null
      ), '[]'::jsonb)
    ) as item
    from public.engagements e
    left join public.stage_definitions s on s.id = e.stage_id
    where e.business_id = v.business_id
      and e.archived_at is null
      and (p_stage is null or s.key = p_stage)
    order by e.created_at desc
    limit v_limit offset v_offset
  ) rows;

  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', v_offset);
end;
$$;

create or replace function public.mcp_enquiry_timeline(
  p_token_sha256 text,
  p_enquiry uuid
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
  v_enquiry jsonb;
  v_stages jsonb;
  v_comms jsonb;
  v_events jsonb;
  v_tasks jsonb;
begin
  select r.actor_id, r.business_id into v from private.mcp_require(p_token_sha256, 'enquiries') r;

  select jsonb_build_object(
    'id', e.id,
    'title', e.title,
    'stage', s.key,
    'stage_label', s.label,
    'stage_entered_at', to_jsonb(e.stage_entered_at),
    'created_at', to_jsonb(e.created_at),
    'outcome', e.outcome,
    'value_estimate', e.value_estimate,
    'visa_route', e.attributes ->> 'visa_route',
    'visa_route_source', e.attributes ->> 'visa_route_source',
    'participants', coalesce((
      select jsonb_agg(c.display_name order by c.display_name)
      from public.engagement_participants ep
      join public.contacts c on c.id = ep.contact_id
      where ep.engagement_id = e.id and ep.archived_at is null
    ), '[]'::jsonb)
  ) into v_enquiry
  from public.engagements e
  left join public.stage_definitions s on s.id = e.stage_id
  where e.id = p_enquiry
    and e.business_id = v.business_id
    and e.archived_at is null;

  if v_enquiry is null then
    raise exception 'Enquiry % not found in this business', p_enquiry;
  end if;

  select coalesce(jsonb_agg(item order by (item ->> 'moved_at')), '[]'::jsonb) into v_stages
  from (
    select jsonb_build_object(
      'from_stage', sf.key,
      'to_stage', st.key,
      'moved_at', to_jsonb(h.moved_at),
      'moved_by', a.display_name
    ) as item
    from public.stage_history h
    left join public.stage_definitions sf on sf.id = h.from_stage
    left join public.stage_definitions st on st.id = h.to_stage
    left join public.actors a on a.id = h.moved_by
    where h.engagement_id = p_enquiry and h.business_id = v.business_id
  ) rows;

  -- JUDGMENT: the timeline carries comm PREVIEWS (240 chars) under the
  -- enquiries grant; full bodies live behind threads_read and its
  -- comms.<channel> grant — responses carry what the grants permit (D188g).
  select coalesce(jsonb_agg(item order by (item ->> 'occurred_at') desc), '[]'::jsonb) into v_comms
  from (
    select jsonb_build_object(
      'id', c.id,
      'thread_id', c.thread_id,
      'channel', c.channel,
      'direction', c.direction,
      'status', c.status,
      'occurred_at', to_jsonb(c.occurred_at),
      'preview', left(coalesce(c.attributes ->> 'plain_body', c.body, ''), 240),
      'drafted_by', a.display_name
    ) as item
    from public.communications c
    left join public.actors a on a.id = coalesce(c.drafted_by_actor_id, c.created_by)
    where c.engagement_id = p_enquiry
      and c.business_id = v.business_id
      and c.archived_at is null
      and c.channel <> 'internal_note'
    limit 200
  ) rows;

  select coalesce(jsonb_agg(item order by (item ->> 'occurred_at') desc), '[]'::jsonb) into v_events
  from (
    select jsonb_build_object(
      'action', ev.action,
      'occurred_at', to_jsonb(ev.occurred_at),
      'actor', a.display_name,
      'payload', ev.payload
    ) as item
    from public.events ev
    left join public.actors a on a.id = ev.actor_id
    where ev.business_id = v.business_id
      and ((ev.entity_type = 'engagement' and ev.entity_id = p_enquiry)
           or ev.payload ->> 'engagement_id' = p_enquiry::text)
    order by ev.occurred_at desc
    limit 100
  ) rows;

  select coalesce(jsonb_agg(item), '[]'::jsonb) into v_tasks
  from (
    select jsonb_build_object(
      'id', t.id,
      'title', t.title,
      'status', t.status,
      'due_at', to_jsonb(t.due_at),
      'assignee', a.display_name
    ) as item
    from public.tasks t
    left join public.actors a on a.id = t.assignee_actor_id
    where t.engagement_id = p_enquiry
      and t.business_id = v.business_id
      and t.archived_at is null
  ) rows;

  return jsonb_build_object(
    'enquiry', v_enquiry,
    'stage_history', v_stages,
    'communications', v_comms,
    'events', v_events,
    'tasks', v_tasks
  );
end;
$$;

-- Threads are read where their channel is granted: the permitted-channel
-- set is computed once per call from the comms.* registry, and the list
-- carries only threads on granted channels (D188g).
create or replace function private.mcp_permitted_channels(p_actor uuid, p_business uuid)
returns text[]
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_channels text[] := '{}';
  v_tool record;
begin
  for v_tool in
    select t.key, substring(t.key from 7) as channel
    from public.tools t
    where t.key like 'comms.%' and t.archived_at is null
  loop
    if private.consume_grant(p_actor, p_business, v_tool.key, 'view') then
      v_channels := v_channels || v_tool.channel;
    end if;
  end loop;
  return v_channels;
end;
$$;

create or replace function public.mcp_threads_list(
  p_token_sha256 text,
  p_limit int default 25,
  p_offset int default 0
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
  v_limit int := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_channels text[];
  v_items jsonb;
  v_total bigint;
begin
  select r.actor_id, r.business_id into v
  from private.mcp_resolve_credential(p_token_sha256) r;

  v_channels := private.mcp_permitted_channels(v.actor_id, v.business_id);
  if coalesce(array_length(v_channels, 1), 0) = 0 then
    raise exception 'Actor % does not hold any comms.<channel> (view) grant for this business — grant a channel, or tell us how you''d like to proceed', v.actor_id;
  end if;

  select count(*) into v_total
  from public.comm_threads th
  where th.business_id = v.business_id
    and th.archived_at is null
    and th.channel::text = any (v_channels);

  select coalesce(jsonb_agg(item), '[]'::jsonb) into v_items
  from (
    select jsonb_build_object(
      'id', th.id,
      'channel', th.channel,
      'subject', th.subject,
      'contact', c.display_name,
      'engagement_id', th.engagement_id,
      'created_at', to_jsonb(th.created_at),
      'last_activity_at', to_jsonb(greatest(th.updated_at, coalesce((
        select max(cm.occurred_at) from public.communications cm
        where cm.thread_id = th.id and cm.archived_at is null
      ), th.updated_at)))
    ) as item
    from public.comm_threads th
    join public.contacts c on c.id = th.contact_id
    where th.business_id = v.business_id
      and th.archived_at is null
      and th.channel::text = any (v_channels)
    order by th.updated_at desc
    limit v_limit offset v_offset
  ) rows;

  return jsonb_build_object(
    'items', v_items, 'total', v_total,
    'channels_granted', to_jsonb(v_channels),
    'limit', v_limit, 'offset', v_offset
  );
end;
$$;

create or replace function public.mcp_threads_read(
  p_token_sha256 text,
  p_thread uuid,
  p_limit int default 50
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
  v_thread record;
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_items jsonb;
begin
  select r.actor_id, r.business_id into v
  from private.mcp_resolve_credential(p_token_sha256) r;

  select th.id, th.channel, th.subject, th.engagement_id, c.display_name as contact
  into v_thread
  from public.comm_threads th
  join public.contacts c on c.id = th.contact_id
  where th.id = p_thread
    and th.business_id = v.business_id
    and th.archived_at is null;
  if v_thread.id is null then
    raise exception 'Thread % not found in this business', p_thread;
  end if;

  if not private.consume_grant(v.actor_id, v.business_id, 'comms.' || v_thread.channel::text, 'view') then
    raise exception 'Actor % does not hold comms.% (view) for this business — grant it, or tell us how you''d like to proceed', v.actor_id, v_thread.channel;
  end if;

  select coalesce(jsonb_agg(item order by (item ->> 'occurred_at')), '[]'::jsonb) into v_items
  from (
    select jsonb_build_object(
      'id', cm.id,
      'direction', cm.direction,
      'status', cm.status,
      'occurred_at', to_jsonb(cm.occurred_at),
      'body', coalesce(cm.attributes ->> 'plain_body', cm.body),
      'drafted_by', a.display_name,
      'approved_by', ap.display_name
    ) as item
    from public.communications cm
    left join public.actors a on a.id = coalesce(cm.drafted_by_actor_id, cm.created_by)
    left join public.actors ap on ap.id = cm.approved_by_actor_id
    where cm.thread_id = p_thread
      and cm.business_id = v.business_id
      and cm.archived_at is null
    order by cm.occurred_at desc
    limit v_limit
  ) rows;

  return jsonb_build_object(
    'thread', jsonb_build_object(
      'id', v_thread.id, 'channel', v_thread.channel, 'subject', v_thread.subject,
      'contact', v_thread.contact, 'engagement_id', v_thread.engagement_id
    ),
    'messages', v_items
  );
end;
$$;

-- Stamp-awaiting items, filtered to the arms the grants permit: the
-- communication arm by channel grant, the content arm by content.website,
-- the task arms by enquiries. approvals.* stays structurally unholdable by
-- the machine actor (0014) — the MCP server sees the queue, never stamps it.
create or replace function public.mcp_drafts_awaiting_stamp(
  p_token_sha256 text,
  p_limit int default 50
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_channels text[];
  v_content boolean;
  v_tasks boolean;
  v_items jsonb;
begin
  select r.actor_id, r.business_id into v
  from private.mcp_resolve_credential(p_token_sha256) r;

  v_channels := private.mcp_permitted_channels(v.actor_id, v.business_id);
  v_content := private.consume_grant(v.actor_id, v.business_id, 'content.website', 'view');
  v_tasks := private.consume_grant(v.actor_id, v.business_id, 'enquiries', 'view');

  if coalesce(array_length(v_channels, 1), 0) = 0 and not v_content and not v_tasks then
    raise exception 'Actor % holds no view grant on any stamp-awaiting arm (comms.<channel>, content.website, enquiries) — grant one, or tell us how you''d like to proceed', v.actor_id;
  end if;

  select coalesce(jsonb_agg(item), '[]'::jsonb) into v_items
  from (
    select jsonb_build_object(
      'item_type', ai.item_type,
      'item_id', ai.item_id,
      'channel', ai.channel,
      'title', ai.title,
      'preview', ai.preview,
      'drafted_by', ai.drafted_by,
      'drafted_by_type', ai.drafted_by_type,
      'awaiting_since', to_jsonb(ai.awaiting_since),
      'scheduled_for', to_jsonb(ai.scheduled_for),
      'preflight_pass', ai.preflight_pass
    ) as item
    from public.approval_inbox ai
    where ai.business_id = v.business_id
      and (
        (ai.item_type = 'communication' and ai.channel::text = any (v_channels))
        or (ai.item_type = 'content' and v_content)
        or (ai.item_type in ('task', 'task_cancellation') and v_tasks)
      )
    order by ai.awaiting_since asc
    limit v_limit
  ) rows;

  return jsonb_build_object(
    'items', v_items,
    'arms_granted', jsonb_build_object(
      'comms_channels', to_jsonb(v_channels),
      'content', v_content,
      'tasks', v_tasks
    )
  );
end;
$$;

create or replace function public.mcp_record_read(
  p_token_sha256 text,
  p_action text default null,
  p_entity_type text default null,
  p_entity_id uuid default null,
  p_since timestamptz default null,
  p_until timestamptz default null,
  p_limit int default 50,
  p_before_at timestamptz default null,
  p_before_id uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_items jsonb;
  v_count int;
begin
  select r.actor_id, r.business_id into v from private.mcp_require(p_token_sha256, 'record') r;

  select coalesce(jsonb_agg(item), '[]'::jsonb), count(*) into v_items, v_count
  from (
    select jsonb_build_object(
      'id', ev.id,
      'action', ev.action,
      'occurred_at', to_jsonb(ev.occurred_at),
      'actor', a.display_name,
      'actor_type', a.actor_type,
      'entity_type', ev.entity_type,
      'entity_id', ev.entity_id,
      'payload', ev.payload,
      'approval', ev.approval,
      'cost', ev.cost
    ) as item
    from public.events ev
    left join public.actors a on a.id = ev.actor_id
    where ev.business_id = v.business_id
      and (p_action is null or ev.action = p_action)
      and (p_entity_type is null or ev.entity_type = p_entity_type)
      and (p_entity_id is null or ev.entity_id = p_entity_id)
      and (p_since is null or ev.occurred_at >= p_since)
      and (p_until is null or ev.occurred_at < p_until)
      and (p_before_at is null or (ev.occurred_at, ev.id) < (p_before_at, p_before_id))
    order by ev.occurred_at desc, ev.id desc
    limit v_limit + 1
  ) rows;

  return jsonb_build_object(
    'items', case when v_count > v_limit then v_items - (v_count - 1) else v_items end,
    'has_more', v_count > v_limit
  );
end;
$$;

create or replace function public.mcp_workflow_definitions(
  p_token_sha256 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
  v_items jsonb;
begin
  select r.actor_id, r.business_id into v from private.mcp_require(p_token_sha256, 'workflows') r;

  select coalesce(jsonb_agg(item), '[]'::jsonb) into v_items
  from (
    select jsonb_build_object(
      'id', d.id,
      'key', d.key,
      'version', d.version,
      'status', d.status,
      'description', d.description_plain,
      'trigger', d.trigger,
      'created_at', to_jsonb(d.created_at),
      'steps', coalesce((
        select jsonb_agg(jsonb_build_object(
          'key', s.key, 'sort_order', s.sort_order,
          'kind', s.kind, 'gate_level', s.gate_level
        ) order by s.sort_order)
        from public.workflow_steps s
        where s.definition_id = d.id and s.archived_at is null
      ), '[]'::jsonb)
    ) as item
    from public.workflow_definitions d
    where d.business_id = v.business_id
      and d.archived_at is null
    order by d.key, d.version desc
  ) rows;

  return jsonb_build_object('items', v_items);
end;
$$;

create or replace function public.mcp_workflow_runs(
  p_token_sha256 text,
  p_status text default null,
  p_limit int default 25,
  p_offset int default 0
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
  v_limit int := least(greatest(coalesce(p_limit, 25), 1), 100);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_items jsonb;
  v_total bigint;
begin
  select r.actor_id, r.business_id into v from private.mcp_require(p_token_sha256, 'workflows') r;

  select count(*) into v_total
  from public.workflow_runs wr
  where wr.business_id = v.business_id
    and wr.archived_at is null
    and (p_status is null or wr.status::text = p_status);

  select coalesce(jsonb_agg(item), '[]'::jsonb) into v_items
  from (
    select jsonb_build_object(
      'id', wr.id,
      'definition_key', d.key,
      'definition_version', d.version,
      'engagement_id', wr.engagement_id,
      'status', wr.status,
      'current_step', s.key,
      'started_at', to_jsonb(wr.started_at),
      'created_at', to_jsonb(wr.created_at)
    ) as item
    from public.workflow_runs wr
    join public.workflow_definitions d on d.id = wr.definition_id
    left join public.workflow_steps s on s.id = wr.current_step
    where wr.business_id = v.business_id
      and wr.archived_at is null
      and (p_status is null or wr.status::text = p_status)
    order by wr.created_at desc
    limit v_limit offset v_offset
  ) rows;

  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', v_offset);
end;
$$;

-- The Light performance ingredients for the current UTC week (Monday-start,
-- the s22 clock). The door returns counts and cost blocks; the TS layer
-- computes the tile's derived numbers through the SAME pure function the
-- dashboard uses (packages/db/src/light-performance.ts) — one truth for the
-- arithmetic.
create or replace function public.mcp_light_performance(
  p_token_sha256 text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
  v_start timestamptz := date_trunc('week', now() at time zone 'utc') at time zone 'utc';
  v_end timestamptz;
  v_drafts int;
  v_stamped int;
  v_rejected int;
  v_edits int;
  v_breaches int;
  v_costs jsonb;
begin
  select r.actor_id, r.business_id into v from private.mcp_require(p_token_sha256, 'record') r;
  v_end := v_start + interval '7 days';

  select count(*) into v_drafts from public.events
  where business_id = v.business_id and action = 'light.draft_generated'
    and occurred_at >= v_start and occurred_at < v_end;
  select count(*) into v_stamped from public.events
  where business_id = v.business_id and action = 'communication.approved'
    and occurred_at >= v_start and occurred_at < v_end;
  select count(*) into v_rejected from public.events
  where business_id = v.business_id and action = 'communication.rejected'
    and occurred_at >= v_start and occurred_at < v_end;
  select count(*) into v_edits from public.draft_feedback
  where business_id = v.business_id and kind = 'edit'
    and created_at >= v_start and created_at < v_end;
  select count(*) into v_breaches from public.events
  where business_id = v.business_id and action = 'communication.compliance_checked'
    and payload ->> 'result' = 'breach'
    and occurred_at >= v_start and occurred_at < v_end;

  select coalesce(jsonb_agg(ev.cost), '[]'::jsonb) into v_costs
  from (
    select cost from public.events
    where business_id = v.business_id and action = 'light.draft_generated'
      and occurred_at >= v_start and occurred_at < v_end
    order by occurred_at desc
    limit 5000
  ) ev;

  return jsonb_build_object(
    'week_start', to_jsonb(v_start),
    'week_end', to_jsonb(v_end),
    'drafts_generated', v_drafts,
    'stamped', v_stamped,
    'rejected', v_rejected,
    'edit_signals', v_edits,
    'compliance_refusals', v_breaches,
    'cost_blocks', v_costs
  );
end;
$$;

create or replace function public.mcp_memory_entries(
  p_token_sha256 text,
  p_kind text default null,
  p_active boolean default null,
  p_limit int default 50,
  p_offset int default 0
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_items jsonb;
  v_total bigint;
begin
  select r.actor_id, r.business_id into v from private.mcp_require(p_token_sha256, 'memory') r;

  select count(*) into v_total
  from public.memory_entries m
  where m.business_id = v.business_id
    and m.archived_at is null
    and (p_kind is null or m.kind = p_kind)
    and (p_active is null or m.active = p_active);

  select coalesce(jsonb_agg(item), '[]'::jsonb) into v_items
  from (
    select jsonb_build_object(
      'id', m.id,
      'kind', m.kind,
      'title', m.title,
      'body', m.body,
      'active', m.active,
      'fact_key', m.attributes ->> 'fact_key',
      'surfaces', m.surfaces,
      'superseded_by', m.superseded_by_entry_id,
      'created_at', to_jsonb(m.created_at)
    ) as item
    from public.memory_entries m
    where m.business_id = v.business_id
      and m.archived_at is null
      and (p_kind is null or m.kind = p_kind)
      and (p_active is null or m.active = p_active)
    order by m.created_at desc
    limit v_limit offset v_offset
  ) rows;

  return jsonb_build_object('items', v_items, 'total', v_total, 'limit', v_limit, 'offset', v_offset);
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: the doors are the MCP route's ONLY database surface, callable
-- by server code alone. No signed-in session, no anon caller, ever.
-- ---------------------------------------------------------------------------
revoke execute on function private.mcp_resolve_credential(text) from public;
revoke execute on function private.mcp_require(text, text) from public;
revoke execute on function private.mcp_permitted_channels(uuid, uuid) from public;
revoke execute on function public.mcp_whoami(text) from public;
revoke execute on function public.mcp_enquiries_list(text, int, int, text) from public;
revoke execute on function public.mcp_enquiry_timeline(text, uuid) from public;
revoke execute on function public.mcp_threads_list(text, int, int) from public;
revoke execute on function public.mcp_threads_read(text, uuid, int) from public;
revoke execute on function public.mcp_drafts_awaiting_stamp(text, int) from public;
revoke execute on function public.mcp_record_read(text, text, text, uuid, timestamptz, timestamptz, int, timestamptz, uuid) from public;
revoke execute on function public.mcp_workflow_definitions(text) from public;
revoke execute on function public.mcp_workflow_runs(text, text, int, int) from public;
revoke execute on function public.mcp_light_performance(text) from public;
revoke execute on function public.mcp_memory_entries(text, text, boolean, int, int) from public;

grant execute on function public.mcp_whoami(text) to service_role;
grant execute on function public.mcp_enquiries_list(text, int, int, text) to service_role;
grant execute on function public.mcp_enquiry_timeline(text, uuid) to service_role;
grant execute on function public.mcp_threads_list(text, int, int) to service_role;
grant execute on function public.mcp_threads_read(text, uuid, int) to service_role;
grant execute on function public.mcp_drafts_awaiting_stamp(text, int) to service_role;
grant execute on function public.mcp_record_read(text, text, text, uuid, timestamptz, timestamptz, int, timestamptz, uuid) to service_role;
grant execute on function public.mcp_workflow_definitions(text) to service_role;
grant execute on function public.mcp_workflow_runs(text, text, int, int) to service_role;
grant execute on function public.mcp_light_performance(text) to service_role;
grant execute on function public.mcp_memory_entries(text, text, boolean, int, int) to service_role;
