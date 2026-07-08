# Spec 3 Permissions Engine Implementation Plan (Session 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Spec 3 in full — approval levels 0–4 as data, the platform tool registry, the `grants` table with its structural meta-rules, grant enforcement wired into every DB path that exists so far, and Light's Phase 1 grants seeded.

**Architecture:** Two new migrations extend the Session 1 schema: `0014` builds the permissions engine (levels, tools, grants, helper functions, meta-rule triggers, RLS); `0015` wires grant checks into the existing enforcement paths (communications drafter/approver, content publisher, Level 2 enquiries actions). Enforcement is trigger-based — structural, not prompt-based — mirroring the Session 1 human-stamp triggers. The seed gains Light's and the Meta integration's grants, evented through `emitEvent()`.

**Tech Stack:** Postgres (Supabase), plpgsql triggers, PGlite for `check-local`, TypeScript seed via `@supabase/supabase-js`.

## Global Constraints

- RLS on every table (CLAUDE.md; Spec 1 decision 2).
- Events only through `emitEvent()` — no direct inserts, no DB-trigger event writes (CLAUDE.md).
- Events ledger and stage history are append-only (CLAUDE.md).
- Migrations are immutable once applied — new files only, numbered after `0013`.
- Approval is structural: send pipeline physically refuses without human `approved_by_actor_id` (CLAUDE.md; Spec 3 §2.5).
- No null grant scopes, ever (Spec 3 §2.2, §3).
- `approvals.*` tools structurally unholdable by non-humans (Spec 3 §4, decision 5).
- Granters must be human and hold `settings.team` execute or be the account owner (Spec 3 §3).
- Levels resolve as `max(tool floor, tenant override)`; tenants may raise, never lower (Spec 3 §4). Template no_go escalation is Spec 4 territory (gates) — deferred.
- British English in user-facing strings (exception messages count).
- All tests green in `check-local` before anything touches live.

## Judgment calls to present for sign-off (do NOT write DECISIONS.md until approved)

1. **Light's Phase 1 grant bundle** (Spec 3 names "AI COO as Light's default bundle" but never enumerates it): `enquiries` execute, `comms.email` execute, `comms.whatsapp` execute — business scope, standing, granted by Mudassir via chat. Execute (not draft) because §4 defines execute as "perform Level 2 actions and *submit* Level 3 actions into the approval queue" — draft-only would keep Light's drafts out of the approval inbox. The stamp stays impossible regardless (`approvals.*` unholdable + human-approver trigger).
2. **Meta integration grant**: `enquiries` execute (business scope, standing) — the integration actor creates contacts/engagements/stage history, which are Level 2 acts; Spec 3 §3 explicitly allows integration grantees.
3. **Phase 1 tool registry contents**: the §3 example keys + one `comms.<channel>` row per external channel + `approvals.comms|content|money`. `settings.team` default_level 2 (granting is in-system and reversible via revoke; Admin preset implies no stamp needed to manage access).
4. **`grants.business_id` not null**: envelope applies; an `account`-level scope is recorded on a business row with `ref` = the business's account (single-business Phase 1; revisit for multi-business).
5. **Duration/expiry coherence**: `standing` ⇔ `expires_at is null`; `this_task`/`until` require `expires_at` (the sweep is Spec 4's workflow engine; the check function enforces expiry at use time regardless).
6. **Grant terms are immutable** after insert — only revocation, usage stamps, and archive may change; a change of terms = revoke + new grant (keeps the audit honest).
7. **Level 2 wiring surface**: `contacts`/`engagements`/`stage_history`/`tasks` inserts require `enquiries` execute. Updates without actor attribution (e.g. `engagements.stage_id` direct update) can't be gated at DB level — the app layer writes `stage_history` (gated) alongside; noted as a known limitation until app paths exist.
8. **Content drafting ungated in Phase 1** (notes are Level 1 and have no Phase 1 tool); content *publishing* approver must hold `approvals.content` execute.
9. **Tenant level overrides** live in `businesses.settings->'tool_level_overrides'` read by `private.resolve_tool_level()` with `greatest()` so lowering is impossible.
10. **No self-granting** enforced as a check constraint (Level 4 example in §4).

---

### Task 1: Migration 0014 — permissions engine (levels, tools, grants, meta-rules)

**Files:**
- Create: `packages/db/migrations/0014_permissions_engine.sql`
- Modify: `packages/db/scripts/check-local.ts` (fixtures + engine tests)
- Test: `npm run check-local --workspace=@rooshni/db`

**Interfaces:**
- Produces: tables `public.permission_levels`, `public.tools`, `public.grants`; enums `grant_access|grant_duration|grant_via`; functions `private.is_business_owner_actor(uuid,uuid)`, `private.consume_grant(uuid,uuid,text,grant_access,uuid)`, `private.resolve_tool_level(uuid,text)`. Task 2's wiring calls `private.consume_grant`.

- [ ] **Step 1: Add failing engine tests to check-local** — new fixtures (second auth user + non-owner human actor + second agent) and a "Spec 3 — grants engine" section (full code in Task 3's consolidated test listing below; add the engine-only subset first: grant insert meta-rules g4–g11, levels seeded, resolve_tool_level).
- [ ] **Step 2: Run to verify failure** — `npm run check-local --workspace=@rooshni/db` fails on `public.grants` not existing.
- [ ] **Step 3: Write the migration** (content below).
- [ ] **Step 4: Run check-local — engine tests pass, everything else still green.**
- [ ] **Step 5: Commit** `feat(db): Spec 3 permissions engine — levels as data, tool registry, grants + meta-rules`

```sql
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
-- no_go escalation joins in Spec 4 when gates land.
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
-- unused-grant review). Owner-implicit passes leave no stamp — there is no row.
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
-- Meta-rules: rules about grants themselves (§3, §4).
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
```

### Task 2: Migration 0015 — wire grant checks into existing paths

**Files:**
- Create: `packages/db/migrations/0015_wire_grant_checks.sql`
- Modify: `packages/db/scripts/check-local.ts` (fixture grants for the test agent BEFORE domain inserts; wiring tests)

**Interfaces:**
- Consumes: `private.consume_grant(actor, business, tool, access, engagement)` from Task 1.
- Produces: triggers `communications_grant_check`, `content_items_publish_grant`, `{contacts,engagements,stage_history,tasks}_enquiries_grant`.

- [ ] **Step 1: Add failing wiring tests + fixture grants** (test agent gets `enquiries` execute + `comms.email` execute granted by the owner human, inserted immediately after the fixture CTE so the Session 1 tests keep passing).
- [ ] **Step 2: Run check-local** — wiring tests fail (no triggers yet); Session 1 tests still pass.
- [ ] **Step 3: Write the migration** (content below).
- [ ] **Step 4: Run check-local — all green.**
- [ ] **Step 5: Commit** `feat(db): wire Spec 3 grant checks into comms, content and Level 2 paths`

```sql
-- 0015: grant enforcement wired into every path that exists so far (Spec 3
-- §4 access interplay). The Session 1 human-stamp triggers answer "is the
-- approver human?"; these answer "does the actor hold the tool at all?".
-- Deny gracefully, never silently (§2.3): every refusal names the missing
-- grant and the way forward.

-- ---------------------------------------------------------------------------
-- Outbound communications: drafter needs comms.<channel> (draft to draft,
-- execute to submit/send); the approver additionally needs approvals.comms.
-- ---------------------------------------------------------------------------
create or replace function private.enforce_comm_grants()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tool text;
  v_actor uuid;
  v_needed public.grant_access;
begin
  if new.direction <> 'outbound' then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.status = old.status
     and new.approved_by_actor_id is not distinct from old.approved_by_actor_id then
    return new;
  end if;

  v_tool := 'comms.' || new.channel::text;
  if not exists (
    select 1 from public.tools t where t.key = v_tool and t.archived_at is null
  ) then
    raise exception 'No tool "%" is registered — this channel cannot carry outbound messages', v_tool;
  end if;

  v_actor := coalesce(new.drafted_by_actor_id, new.created_by);
  v_needed := case when new.status = 'draft'
                   then 'draft'::public.grant_access
                   else 'execute'::public.grant_access end;
  if not private.consume_grant(v_actor, new.business_id, v_tool, v_needed, new.engagement_id) then
    raise exception 'Actor % does not hold % (%) for this business — grant it, or tell us how you''d like to proceed', v_actor, v_tool, v_needed;
  end if;

  if new.approved_by_actor_id is not null
     and new.status in ('approved', 'sent', 'delivered', 'read') then
    if not private.consume_grant(new.approved_by_actor_id, new.business_id, 'approvals.comms', 'execute', new.engagement_id) then
      raise exception 'Approver % does not hold approvals.comms (execute) — approving is itself a tool', new.approved_by_actor_id;
    end if;
  end if;

  return new;
end;
$$;

create trigger communications_grant_check
  before insert or update on public.communications
  for each row execute function private.enforce_comm_grants();

-- ---------------------------------------------------------------------------
-- Content publishing: the publisher must hold approvals.content (execute) on
-- top of the Session 1 human check. Drafting stays ungated in Phase 1 (notes
-- are Level 1 and have no Phase 1 tool).
-- ---------------------------------------------------------------------------
create or replace function private.enforce_content_publish_grant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state = 'published'
     and (tg_op = 'INSERT' or old.state is distinct from new.state)
     and new.published_by_actor_id is not null then
    if not private.consume_grant(new.published_by_actor_id, new.business_id, 'approvals.content', 'execute') then
      raise exception 'Publisher % does not hold approvals.content (execute) — publishing needs the approvals grant', new.published_by_actor_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger content_items_publish_grant
  before insert or update on public.content_items
  for each row execute function private.enforce_content_publish_grant();

-- ---------------------------------------------------------------------------
-- Level 2 (safe execute) inside the walls: creating contacts, engagements,
-- stage moves and tasks all require the enquiries tool at execute. The actor
-- column and optional engagement-scope column come from trigger arguments.
-- ---------------------------------------------------------------------------
create or replace function private.enforce_level2_grant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_actor uuid := (v_row ->> tg_argv[0])::uuid;
  v_engagement uuid := case when tg_nargs > 1 then nullif(v_row ->> tg_argv[1], '')::uuid end;
begin
  if not private.consume_grant(v_actor, new.business_id, 'enquiries', 'execute', v_engagement) then
    raise exception 'Actor % does not hold enquiries (execute) for this business — creating or moving work is Level 2; grant it, or tell us how you''d like to proceed', v_actor;
  end if;
  return new;
end;
$$;

create trigger contacts_enquiries_grant
  before insert on public.contacts
  for each row execute function private.enforce_level2_grant('created_by');
create trigger engagements_enquiries_grant
  before insert on public.engagements
  for each row execute function private.enforce_level2_grant('created_by', 'id');
create trigger stage_history_enquiries_grant
  before insert on public.stage_history
  for each row execute function private.enforce_level2_grant('moved_by', 'engagement_id');
create trigger tasks_enquiries_grant
  before insert on public.tasks
  for each row execute function private.enforce_level2_grant('created_by', 'engagement_id');
```

### Task 3: check-local — complete grants test suite

**Files:**
- Modify: `packages/db/scripts/check-local.ts`

New fixtures (after the existing fixture CTE):
- second auth user `user2` + non-owner human actor `human2` (member membership), second agent `agent2` (no grants).
- fixture grants: test agent ← `enquiries` execute + `comms.email` execute, business scope, standing, granted by `human` (owner), via chat.

Test list ("Spec 3 — grants engine" + "Spec 3 — enforcement wiring" sections):
1. permission_levels holds exactly levels 0–4.
2. Ungranted agent2 refused at Level 2 (task insert) → `/enquiries \(execute\)/`.
3. Granted agent creates a task (Level 2) fine; `use_count` on its enquiries grant > 0.
4. Non-human granter refused → `/HUMAN actor/`.
5. Self-granting refused → `/grants_no_self_granting/`.
6. `approvals.comms` grant to an agent refused → `/unholdable/`.
7. human2 (no settings.team) cannot grant → `/settings.team/`.
8. Owner grants human2 `settings.team` execute; human2 can then grant agent2 `calendar` view.
9. Business-scope ref mismatch refused → `/its own business/`.
10. Scope missing `ref` refused → `/grants_scope_shape/`.
11. `standing` with `expires_at` refused → `/grants_duration_expiry/`.
12. Expired grant is dead: agent2 ← `comms.whatsapp` execute, `until`, expired yesterday → outbound WhatsApp draft refused.
13. Draft-level success (the Light path): granted agent inserts outbound email at `draft`.
14. Ungranted agent2 refused at outbound email draft → `/comms.email/`.
15. Draft-only actor cannot submit: agent2 ← `comms.sms` draft (standing); sms draft OK, `pending_approval` refused → `/execute/`.
16. Approver without `approvals.comms` refused: human2 approves → `/approvals.comms/`; owner grants human2 `approvals.comms` execute → approval succeeds.
17. Existing Session 1 tests keep passing (agent cannot approve; no approver = no send; human owner approver sends).
18. `comms.internal_note` outbound refused → `/No tool/`.
19. `resolve_tool_level`: `comms.email` = 3; override to 1 in `businesses.settings.tool_level_overrides` still resolves 3 (floors hold); `calendar` override to 3 resolves 3 (raising works).
20. Revocation: owner revokes agent's `comms.email` (sets `revoked_at`+`revoked_by_actor_id`); further outbound email drafts by agent refused; changing terms → `/immutable/`; touching a revoked row's revocation → `/permanent/`.
21. RLS: `grants` added to the stranger-sees-nothing loop.

Run: `npm run check-local --workspace=@rooshni/db` → all green. Commit with Task 2.

### Task 4: Seed Light's + Meta's Phase 1 grants; package types

**Files:**
- Modify: `packages/db/seed/index.ts`
- Modify: `packages/db/src/types.ts`

Seed (idempotent — insert only when the fixed id is absent; `grant.issued` event emitted only on first insert, actor = Mudassir):

```ts
const GRANTS = [
  { id: "01980000-0000-7000-8000-000000000401", grantee: IDS.actorLight, tool: "enquiries", access: "execute" },
  { id: "01980000-0000-7000-8000-000000000402", grantee: IDS.actorLight, tool: "comms.email", access: "execute" },
  { id: "01980000-0000-7000-8000-000000000403", grantee: IDS.actorLight, tool: "comms.whatsapp", access: "execute" },
  { id: "01980000-0000-7000-8000-000000000404", grantee: IDS.actorMeta, tool: "enquiries", access: "execute" },
] as const;
// each row: business_id: IDS.business, created_by: IDS.actorMudassir,
// scope: { level: "business", ref: IDS.business }, duration: "standing",
// granted_by_actor_id: IDS.actorMudassir, via: "chat"
// event: action "grant.issued", entity_type "grant", entity_id: row id,
// payload { grantee_actor_id, tool, access, scope, duration, via }
```

`seedGrants(db)` runs after `seedTenant`, before lead ingestion (the Meta actor now needs its grant to ingest).

Types added: `GrantAccess`, `GrantDuration`, `GrantVia`, `GrantScopeLevel`, `GrantScope`, `GrantRow`, `ToolRow`, `PermissionLevelRow`.

Steps: typecheck (`npm run typecheck --workspace=@rooshni/db`), check-local still green, commit `feat(db): seed Light and Meta integration Phase 1 grants + grant types`.

### Task 5: Live apply + verification + session report

- [ ] `npm run check-local --workspace=@rooshni/db` green (gate before live).
- [ ] `npm run migrate --workspace=@rooshni/db` → 0014, 0015 apply cleanly.
- [ ] `npm run seed --workspace=@rooshni/db` → grants + events land; leads skipped as already ingested.
- [ ] `npm run verify --workspace=@rooshni/db` → inspect ledger (extend to list grants if trivial).
- [ ] Report: what shipped, smoke-test evidence, the judgment calls above for sign-off. DECISIONS.md only after approval; GO-LIVE.md — nothing identified (no time-scaled or free-tier items introduced).

## Self-review notes

- Spec coverage: §3 grants table ✓ (Task 1), §3a registry ✓, §4 levels + resolution + access interplay ✓ (Tasks 1–2), §4 approvals-as-tool + unholdable ✓, §2.2 no null scopes ✓, §2.3 graceful denial in messages ✓ (parking as `pending access` = Spec 4 workflow state, deferred), §5 grant conversation = app-layer Phase 1 chat (events emitted by seed path; conversation UI later), §6 inbox = view over pending states (index exists from S1; UI later), §7 presets = Phase 2, §8 revocation ✓ / sweep = Spec 4 / 90-day review = vigilance later, §9 phase boundaries respected.
- Type consistency: `consume_grant` signature identical across 0014 (definition) and 0015 (call sites) ✓.
- No placeholders remain.
