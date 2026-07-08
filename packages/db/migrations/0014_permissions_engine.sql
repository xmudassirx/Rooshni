-- 0014: the Spec 3 permissions engine — approval levels as data, the platform
-- tool registry, and the grants table with its structural meta-rules.
--
-- One system for humans and AI (Spec 3 §2.1): a grant does not know whether
-- its holder breathes. Levels describe actions, not actors (§4). Enforcement
-- is structural — a jailbroken model cannot act, because the database refuses.

-- ---------------------------------------------------------------------------
-- §4 — approval levels 0–4, canonical, as data.
-- ---------------------------------------------------------------------------
create table public.permission_levels (
  level smallint primary key,
  key text not null unique,
  label text not null,
  meaning text not null
);

insert into public.permission_levels (level, key, label, meaning) values
  (0, 'advise', 'Advise', 'Say things, suggest things.'),
  (1, 'draft', 'Draft', 'Create internal-only artefacts.'),
  (2, 'safe_execute', 'Safe execute', 'Act, reversibly, inside the walls.'),
  (3, 'human_stamp', 'Human stamp', 'Act with external or irreversible effect — requires a human approver holding the right grant.'),
  (4, 'forbidden', 'Forbidden', 'Never, for anyone, through this system.');

-- ---------------------------------------------------------------------------
-- §3a — tool registry. Platform-defined; tenants grant tools, never invent
-- them. `surface` is how tab-level restriction works: no grant, no tab.
-- ---------------------------------------------------------------------------
create table public.tools (
  key text primary key,
  label text not null,
  category text not null,
  default_level smallint not null references public.permission_levels (level),
  surface text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create trigger tools_set_updated_at
  before update on public.tools
  for each row execute function private.set_updated_at();

insert into public.tools (key, label, category, default_level, surface) values
  ('comms.email', 'Email', 'comms', 3, 'conversations'),
  ('comms.whatsapp', 'WhatsApp', 'comms', 3, 'conversations'),
  ('comms.sms', 'SMS', 'comms', 3, 'conversations'),
  ('comms.call', 'Calls', 'comms', 3, 'conversations'),
  ('comms.meeting', 'Meetings', 'comms', 3, 'conversations'),
  ('comms.portal_message', 'Portal messages', 'comms', 3, 'conversations'),
  ('enquiries', 'Enquiries', 'enquiries', 2, 'enquiries'),
  ('calendar', 'Calendar', 'calendar', 2, 'calendar'),
  ('content.website', 'Website', 'content', 3, 'website'),
  ('money.invoicing', 'Invoicing', 'money', 3, 'money'),
  ('memory.export', 'Memory export', 'memory', 3, 'memory'),
  ('settings.team', 'Team settings', 'settings', 2, 'settings'),
  ('approvals.comms', 'Approve communications', 'approvals', 3, 'inbox'),
  ('approvals.content', 'Approve content and publishing', 'approvals', 3, 'inbox'),
  ('approvals.money', 'Approve money and spend', 'approvals', 3, 'inbox');

-- §4 level resolution: max(tool floor, tenant override); tenants may raise,
-- never lower (greatest() makes lowering structurally impossible). Template
-- no_go escalation joins in Spec 4 when workflow gates land.
create or replace function private.resolve_tool_level(p_business uuid, p_tool text)
returns smallint
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(
    t.default_level,
    least(4, coalesce((b.settings -> 'tool_level_overrides' ->> p_tool)::smallint, 0))
  )::smallint
  from public.tools t
  cross join public.businesses b
  where t.key = p_tool
    and b.id = p_business;
$$;

-- ---------------------------------------------------------------------------
-- §3 — the grants table. Spec 1 common envelope applies.
-- ---------------------------------------------------------------------------
create type public.grant_access as enum ('view', 'draft', 'execute');
create type public.grant_duration as enum ('this_task', 'until', 'standing');
create type public.grant_via as enum ('chat', 'voice', 'dashboard');

create table public.grants (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,

  grantee_actor_id uuid not null references public.actors (id),
  tool text not null references public.tools (key),
  access public.grant_access not null,
  -- {level: account|business|engagement, ref: uuid} — no null scopes, ever (§2.2).
  scope jsonb not null,
  duration public.grant_duration not null,
  expires_at timestamptz,
  granted_by_actor_id uuid not null references public.actors (id),
  via public.grant_via not null,
  revoked_at timestamptz,
  revoked_by_actor_id uuid references public.actors (id),
  last_used_at timestamptz,
  use_count int not null default 0,

  constraint grants_scope_shape check (
    scope ? 'level'
    and scope ->> 'level' in ('account', 'business', 'engagement')
    and (scope ->> 'ref') is not null
  ),
  constraint grants_duration_expiry check (
    (duration = 'standing' and expires_at is null)
    or (duration <> 'standing' and expires_at is not null)
  ),
  -- Self-granting is Level 4 (§4): forbidden, for anyone, structurally.
  constraint grants_no_self_granting check (grantee_actor_id <> granted_by_actor_id)
);

create index grants_lookup_idx
  on public.grants (business_id, grantee_actor_id, tool)
  where revoked_at is null and archived_at is null;
create index grants_expiry_idx
  on public.grants (expires_at)
  where expires_at is not null and revoked_at is null;

create trigger grants_set_updated_at
  before update on public.grants
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Helper functions (private schema: never exposed via PostgREST).
-- ---------------------------------------------------------------------------

-- §7: the owner is the account's first human with an implicit full grant set.
create or replace function private.is_business_owner_actor(p_actor uuid, p_business uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.actors a
    join public.businesses b on b.id = p_business
    join public.accounts acc on acc.id = b.account_id
    where a.id = p_actor
      and a.actor_type = 'human'
      and a.user_id is not null
      and a.user_id = acc.owner_user_id
      and a.archived_at is null
  );
$$;

-- The single authorisation check. Returns true when the actor may act, and
-- stamps last_used_at/use_count on the matched grant (§3: powers the
-- unused-grant review, §8). Owner-implicit passes leave no stamp — there is
-- no row to stamp; the owner's full grant set is implicit (§7).
create or replace function private.consume_grant(
  p_actor uuid,
  p_business uuid,
  p_tool text,
  p_access public.grant_access,
  p_engagement uuid default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_grant uuid;
begin
  if p_actor is null then
    return false;
  end if;
  if private.is_business_owner_actor(p_actor, p_business) then
    return true;
  end if;

  select g.id into v_grant
  from public.grants g
  where g.business_id = p_business
    and g.grantee_actor_id = p_actor
    and g.tool = p_tool
    and g.access >= p_access
    and g.revoked_at is null
    and g.archived_at is null
    and (g.expires_at is null or g.expires_at > now())
    and (
      g.scope ->> 'level' in ('account', 'business')
      or (
        g.scope ->> 'level' = 'engagement'
        and p_engagement is not null
        and (g.scope ->> 'ref')::uuid = p_engagement
      )
    )
  order by g.access desc
  limit 1;

  if v_grant is null then
    return false;
  end if;

  update public.grants
  set last_used_at = now(), use_count = use_count + 1
  where id = v_grant;
  return true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Meta-rules: the rules about grants themselves (§3, §4).
-- ---------------------------------------------------------------------------
create or replace function private.enforce_grant_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account uuid;
  v_granter_type public.actor_type;
  v_grantee_type public.actor_type;
begin
  select b.account_id into v_account
  from public.businesses b where b.id = new.business_id;

  select a.actor_type into v_granter_type
  from public.actors a where a.id = new.granted_by_actor_id;
  if v_granter_type is distinct from 'human' then
    raise exception 'grants.granted_by_actor_id must reference a HUMAN actor — only humans confer access';
  end if;

  if not private.is_business_owner_actor(new.granted_by_actor_id, new.business_id)
     and not private.consume_grant(new.granted_by_actor_id, new.business_id, 'settings.team', 'execute') then
    raise exception 'Granter % does not hold settings.team (execute) for this business — only team-rights holders may grant', new.granted_by_actor_id;
  end if;

  select a.actor_type into v_grantee_type
  from public.actors a where a.id = new.grantee_actor_id;
  if new.tool like 'approvals.%' and v_grantee_type is distinct from 'human' then
    raise exception 'approvals tools are structurally unholdable by non-human actors — the AI cannot hold the stamp';
  end if;

  case new.scope ->> 'level'
    when 'business' then
      if (new.scope ->> 'ref')::uuid <> new.business_id then
        raise exception 'business-scoped grant must reference its own business';
      end if;
    when 'account' then
      if (new.scope ->> 'ref')::uuid <> v_account then
        raise exception 'account-scoped grant must reference the business''s account';
      end if;
    when 'engagement' then
      if not exists (
        select 1 from public.engagements e
        where e.id = (new.scope ->> 'ref')::uuid
          and e.business_id = new.business_id
      ) then
        raise exception 'engagement-scoped grant must reference an engagement of the same business';
      end if;
  end case;

  return new;
end;
$$;

create trigger grants_structural_rules
  before insert on public.grants
  for each row execute function private.enforce_grant_rules();

-- Grant terms are immutable: a change of terms is revoke + new grant. Only
-- revocation, usage stamps and archiving may touch a row after issue.
create or replace function private.enforce_grant_immutability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.grantee_actor_id <> old.grantee_actor_id
     or new.tool <> old.tool
     or new.access <> old.access
     or new.scope <> old.scope
     or new.duration <> old.duration
     or new.expires_at is distinct from old.expires_at
     or new.granted_by_actor_id <> old.granted_by_actor_id
     or new.via <> old.via
     or new.business_id <> old.business_id
     or new.created_by <> old.created_by
     or new.created_at <> old.created_at then
    raise exception 'grant terms are immutable — revoke and issue a new grant instead';
  end if;

  if old.revoked_at is not null
     and (new.revoked_at is distinct from old.revoked_at
          or new.revoked_by_actor_id is distinct from old.revoked_by_actor_id) then
    raise exception 'revocation is permanent — a revoked grant cannot be altered';
  end if;

  if new.revoked_at is not null and old.revoked_at is null then
    if new.revoked_by_actor_id is null then
      raise exception 'revocation must name revoked_by_actor_id';
    end if;
    if not exists (
      select 1 from public.actors a
      where a.id = new.revoked_by_actor_id and a.actor_type = 'human'
    ) then
      raise exception 'grants.revoked_by_actor_id must reference a HUMAN actor';
    end if;
    if not private.is_business_owner_actor(new.revoked_by_actor_id, new.business_id)
       and not private.consume_grant(new.revoked_by_actor_id, new.business_id, 'settings.team', 'execute') then
      raise exception 'Revoker % does not hold settings.team (execute) for this business', new.revoked_by_actor_id;
    end if;
  end if;

  return new;
end;
$$;

create trigger grants_terms_immutable
  before update on public.grants
  for each row execute function private.enforce_grant_immutability();

-- ---------------------------------------------------------------------------
-- RLS + privileges. Config tables are read-only platform data for API roles;
-- grants are visible to business members, writable through the meta-rules,
-- never deletable (rows are kept for audit — §3).
-- ---------------------------------------------------------------------------
alter table public.permission_levels enable row level security;
create policy permission_levels_select on public.permission_levels
  for select to authenticated using (true);

alter table public.tools enable row level security;
create policy tools_select on public.tools
  for select to authenticated using (true);

alter table public.grants enable row level security;
create policy grants_select on public.grants
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));
create policy grants_insert on public.grants
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));
create policy grants_update on public.grants
  for update to authenticated
  using (business_id in (select private.actor_business_ids()))
  with check (business_id in (select private.actor_business_ids()));

revoke insert, update, delete on public.permission_levels from authenticated;
revoke insert, update, delete on public.tools from authenticated;
revoke delete on public.grants from authenticated, service_role;
