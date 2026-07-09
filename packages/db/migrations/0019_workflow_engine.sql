-- 0019: the workflow engine (Spec 4 §2–3, Session 6).
--
-- Workflows are data, not code (§2.1): a workflow is rows — definition,
-- steps, runs, per-step executions — plus message templates. The runner
-- (packages/db/src/workflow.ts) executes; these tables are the truth. Every
-- step execution lands on the ledger via emitEvent() in the app layer — no
-- event inserts happen in this file or in any function it creates.
--
-- Enforcement travels with the tables (the 0016/0017 precedent):
--   * the definition door — a definition reaches 'active' only with a human
--     stamp holding workflow-approval authority (§2.4: editing a workflow is
--     itself a gated act); once out of draft, a definition and its steps are
--     immutable — a change of behaviour is a new version (the grants
--     immutability precedent, decision 11);
--   * the run state machine — completed/cancelled are terminal; pause,
--     resume and cancel are gated acts through pipeline functions only;
--   * runs and step executions cannot appear or move by direct write: insert
--     and the state columns are closed to every API role, and the engine's
--     own transitions go through security-definer functions.
--
-- Standing principle: anything that must be true is enforced in the
-- database; the app being well-behaved is not a control.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.workflow_definition_status as enum
  ('draft', 'pending_approval', 'active', 'paused');
create type public.workflow_run_status as enum
  ('running', 'waiting', 'blocked', 'completed', 'cancelled', 'paused');
create type public.step_run_status as enum
  ('scheduled', 'running', 'awaiting_approval', 'completed', 'skipped', 'failed', 'cancelled');
create type public.workflow_step_kind as enum
  ('draft_comm', 'create_task', 'wait', 'move_stage', 'branch', 'close', 'fire_conversion', 'notify');

-- ---------------------------------------------------------------------------
-- workflow_definitions (§3) — envelope + key, version, template_id, trigger,
-- status, description_plain.
-- JUDGMENT: added approved_by_actor_id so the §2.4 gate is structural — the
-- human stamp on activation lives on the row (the decision 4/17 class of
-- addition: a column the enforcement needs that the spec's list omits).
-- ---------------------------------------------------------------------------
create table public.workflow_definitions (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '[]'::jsonb,

  key text not null,
  version int not null default 1 check (version >= 1),
  template_id uuid not null references public.templates (id),
  -- event pattern, e.g. {"action": "engagement.created", "source": "meta"}
  trigger jsonb not null default '{}'::jsonb,
  status public.workflow_definition_status not null default 'draft',
  -- The plain-English summary shown at its approval gate and in the
  -- Automation tab (§3). A definition that cannot be described cannot be
  -- honestly gated, so it must not be empty.
  description_plain text not null check (btrim(description_plain) <> ''),
  approved_by_actor_id uuid references public.actors (id),

  constraint workflow_definitions_key_version_uniq unique (business_id, key, version)
);

create index workflow_definitions_business_idx on public.workflow_definitions (business_id);
create index workflow_definitions_status_idx on public.workflow_definitions (business_id, status);

create trigger workflow_definitions_set_updated_at
  before update on public.workflow_definitions
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- workflow_steps (§3) — definition_id, key, order, kind, config, gate_level.
-- JUDGMENT: spec column name `order` is a reserved SQL keyword; using
-- sort_order (the decision 1 precedent, stage_definitions).
-- ---------------------------------------------------------------------------
create table public.workflow_steps (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '[]'::jsonb,

  definition_id uuid not null references public.workflow_definitions (id),
  key text not null,
  sort_order int not null,
  kind public.workflow_step_kind not null,
  -- template ref, channel, assignee, wait duration, branch conditions (§3).
  -- Wait durations are REAL-WORLD durations; the runner scales them through
  -- timeScale() at scheduling time. Never a pre-scaled number in data.
  config jsonb not null default '{}'::jsonb,
  -- Resolved per Spec 3 — informational cache; enforcement stays in the
  -- action itself (§3): a draft_comm step produces a normally-gated draft.
  gate_level smallint check (gate_level between 0 and 4),

  constraint workflow_steps_key_uniq unique (definition_id, key),
  constraint workflow_steps_order_uniq unique (definition_id, sort_order)
);

create index workflow_steps_definition_idx on public.workflow_steps (definition_id, sort_order);

create trigger workflow_steps_set_updated_at
  before update on public.workflow_steps
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- workflow_runs (§3) — definition_id, engagement_id, status, current_step,
-- started_at, context.
-- ---------------------------------------------------------------------------
create table public.workflow_runs (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '[]'::jsonb,

  definition_id uuid not null references public.workflow_definitions (id),
  engagement_id uuid not null references public.engagements (id),
  status public.workflow_run_status not null default 'waiting',
  current_step uuid references public.workflow_steps (id),
  started_at timestamptz not null default now(),
  context jsonb not null default '{}'::jsonb
);

create index workflow_runs_business_idx on public.workflow_runs (business_id);
create index workflow_runs_engagement_idx on public.workflow_runs (engagement_id);
create index workflow_runs_live_idx on public.workflow_runs (status)
  where status not in ('completed', 'cancelled');

-- JUDGMENT: two idempotency keys the spec implies but does not name.
-- One live run per (definition, engagement): a lead is never worked by the
-- same workflow twice at once (a cron retry must not double-start).
create unique index workflow_runs_one_live_uniq
  on public.workflow_runs (definition_id, engagement_id)
  where status not in ('completed', 'cancelled');
-- A triggering event is consumed at most once, ever: replaying the ledger
-- (or a webhook retry emitting nothing new) can never start a second run.
create unique index workflow_runs_trigger_event_uniq
  on public.workflow_runs (definition_id, ((context ->> 'trigger_event_id')::uuid))
  where context ? 'trigger_event_id';

create trigger workflow_runs_set_updated_at
  before update on public.workflow_runs
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- step_runs (§3) — per-step execution record: timings, outcome, the
-- communication/task ids it produced, scheduled_for (the durable-timer
-- intent, stored on our side first — §2.5).
-- ---------------------------------------------------------------------------
create table public.step_runs (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '[]'::jsonb,

  run_id uuid not null references public.workflow_runs (id),
  step_id uuid not null references public.workflow_steps (id),
  status public.step_run_status not null default 'scheduled',
  scheduled_for timestamptz not null,
  started_at timestamptz,
  finished_at timestamptz,
  -- communication/task ids produced, skip reasons, stub-send event ids…
  outcome jsonb not null default '{}'::jsonb
);

create index step_runs_run_idx on public.step_runs (run_id, created_at);
create index step_runs_due_idx on public.step_runs (scheduled_for)
  where status in ('scheduled', 'running', 'awaiting_approval');

create trigger step_runs_set_updated_at
  before update on public.step_runs
  for each row execute function private.set_updated_at();

-- Spec 1 reserved tasks.workflow_run_id for this moment (0007).
alter table public.tasks
  add constraint tasks_workflow_run_fkey
  foreign key (workflow_run_id) references public.workflow_runs (id);

-- ---------------------------------------------------------------------------
-- message_templates (§3) — key, channel, subject, body (with {{variables}}),
-- locale, version. Editable content; drafts rendered from them are still
-- stamped individually at send time.
-- ---------------------------------------------------------------------------
create table public.message_templates (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '[]'::jsonb,

  key text not null,
  channel public.comm_channel not null,
  subject text,
  body text not null check (btrim(body) <> ''),
  locale text not null default 'en-GB',
  version int not null default 1 check (version >= 1),

  constraint message_templates_key_version_uniq unique (business_id, key, version)
);

create index message_templates_business_idx on public.message_templates (business_id, key);

create trigger message_templates_set_updated_at
  before update on public.message_templates
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- The workflow-approval tool. Approving a workflow definition is a Level 3
-- configuration change (§2.4) and approving is itself a tool (Spec 3 §4);
-- approvals.* stays structurally unholdable by non-humans (0014).
-- JUDGMENT: decision 8 fixed the Phase 1 registry; Spec 4 §2.4 creates the
-- need for this row — additive, same approvals category and level.
-- ---------------------------------------------------------------------------
insert into public.tools (key, label, category, default_level, surface) values
  ('approvals.workflows', 'Approve workflow changes', 'approvals', 3, 'inbox');

-- ---------------------------------------------------------------------------
-- The definition door. Status and the activation stamp move only through the
-- pipeline functions below (a transaction-local gate proves the caller came
-- through them); activation — including insert-at-active by an authorised
-- human, the decision 21 precedent — requires a human stamp with
-- approvals.workflows (or the owner). Once out of draft, the behavioural
-- surface (key, version, trigger, template, description) is frozen.
-- ---------------------------------------------------------------------------
create or replace function private.assert_workflow_stamp(p_actor uuid, p_business uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_type public.actor_type;
begin
  if p_actor is null then
    raise exception 'Activating a workflow requires a human stamp — approved_by_actor_id is missing';
  end if;
  select a.actor_type into v_type from public.actors a where a.id = p_actor;
  if v_type is distinct from 'human' then
    raise exception 'Workflow definitions are approved only by a HUMAN actor — the AI cannot hold the stamp';
  end if;
  if not private.is_business_owner_actor(p_actor, p_business)
     and not private.consume_grant(p_actor, p_business, 'approvals.workflows', 'execute') then
    raise exception 'Approver % does not hold approvals.workflows (execute) — changing what the machine does on its own is a stamped act', p_actor;
  end if;
end;
$$;

create or replace function private.enforce_workflow_definition_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status in ('active', 'paused') then
      perform private.assert_workflow_stamp(new.approved_by_actor_id, new.business_id);
    elsif new.approved_by_actor_id is not null then
      raise exception 'approved_by_actor_id belongs only to an activated definition';
    end if;
    return new;
  end if;

  -- UPDATE: behaviour is frozen outside draft — a change is a new version.
  if old.status <> 'draft'
     and (new.key is distinct from old.key
          or new.version is distinct from old.version
          or new.template_id is distinct from old.template_id
          or new.trigger is distinct from old.trigger
          or new.description_plain is distinct from old.description_plain) then
    raise exception 'A workflow definition is immutable once it leaves draft — a change of behaviour is a new version (the grants precedent: re-issue, never rewrite)';
  end if;

  if new.status is distinct from old.status
     or new.approved_by_actor_id is distinct from old.approved_by_actor_id then
    if current_setting('rooshni.workflow_definition_gate', true) is distinct from new.id::text then
      raise exception 'Workflow definition status moves only through submit/approve/reject/pause/resume_workflow_definition()';
    end if;
    if new.status in ('active', 'paused') and old.status = 'pending_approval' then
      perform private.assert_workflow_stamp(new.approved_by_actor_id, new.business_id);
    end if;
  end if;
  return new;
end;
$$;

create trigger workflow_definitions_door
  before insert or update on public.workflow_definitions
  for each row execute function private.enforce_workflow_definition_rules();

-- Steps are part of the definition's behaviour: frozen with it.
create or replace function private.enforce_workflow_steps_frozen()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.workflow_definition_status;
  v_definition uuid := coalesce(new.definition_id, old.definition_id);
begin
  select d.status into v_status from public.workflow_definitions d where d.id = v_definition;
  if v_status is distinct from 'draft' then
    raise exception 'The steps of a non-draft workflow definition are immutable — draft a new version to change behaviour';
  end if;
  return coalesce(new, old);
end;
$$;

create trigger workflow_steps_frozen
  before insert or update or delete on public.workflow_steps
  for each row execute function private.enforce_workflow_steps_frozen();

-- ---------------------------------------------------------------------------
-- The run state machine. completed/cancelled are terminal for everyone,
-- forever. The runner (service role) moves runs freely between its working
-- states; entering paused or cancelled, and leaving paused, happen only
-- through the gated functions below — proven by the transaction-local gate.
-- ---------------------------------------------------------------------------
create or replace function private.enforce_workflow_run_transitions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_gated boolean;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if old.status in ('completed', 'cancelled') then
    raise exception 'Workflow run % is % — terminal states are never left', old.id, old.status;
  end if;

  v_gated := current_setting('rooshni.workflow_run_gate', true) = new.id::text;
  if (new.status in ('paused', 'cancelled') or old.status = 'paused') and not v_gated then
    raise exception 'Pausing, resuming and cancelling a workflow run are gated acts — use pause/resume/cancel_workflow_run()';
  end if;
  return new;
end;
$$;

create trigger workflow_runs_state_machine
  before update on public.workflow_runs
  for each row execute function private.enforce_workflow_run_transitions();

-- ---------------------------------------------------------------------------
-- Close the direct-write doors (the 0016/0017 precedent). Runs and step
-- executions are created and moved only by the engine functions; the gated
-- columns of definitions move only through the definition pipeline.
-- ---------------------------------------------------------------------------
revoke insert, update on public.workflow_definitions from anon, authenticated, service_role;
grant insert (
  id, business_id, created_by, attributes, external_refs,
  key, version, template_id, trigger, status, description_plain, approved_by_actor_id
) on public.workflow_definitions to authenticated, service_role;
grant update (
  attributes, external_refs, archived_at, key, version, template_id, trigger, description_plain
) on public.workflow_definitions to authenticated, service_role;

revoke insert, update, delete on public.workflow_runs from anon, authenticated, service_role;
grant update (attributes, external_refs, archived_at) on public.workflow_runs to authenticated, service_role;

revoke insert, update, delete on public.step_runs from anon, authenticated, service_role;
grant update (attributes, external_refs, archived_at) on public.step_runs to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The definition pipeline (submit → approve/reject; pause/resume). Mirrors
-- the communications pipeline (0017): signed-in callers act as their own
-- actor in their own business; the stamp is checked structurally either way.
-- ---------------------------------------------------------------------------
create or replace function public.submit_workflow_definition(p_def uuid, p_actor uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
begin
  select d.business_id, d.status, d.created_by into v
  from public.workflow_definitions d
  where d.id = p_def and d.archived_at is null
  for update;
  if not found then
    raise exception 'Workflow definition % not found (or archived)', p_def;
  end if;
  perform private.assert_pipeline_caller(p_actor, v.business_id);
  if p_actor is distinct from v.created_by then
    raise exception 'Submission is the proposer''s act — % did not draft this definition', p_actor;
  end if;
  if v.status <> 'draft' then
    raise exception 'Only draft definitions can be submitted — % is "%"', p_def, v.status;
  end if;
  perform set_config('rooshni.workflow_definition_gate', p_def::text, true);
  update public.workflow_definitions set status = 'pending_approval' where id = p_def;
  return p_def;
end;
$$;

create or replace function public.approve_workflow_definition(p_def uuid, p_approver uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
begin
  select d.business_id, d.status into v
  from public.workflow_definitions d
  where d.id = p_def and d.archived_at is null
  for update;
  if not found then
    raise exception 'Workflow definition % not found (or archived)', p_def;
  end if;
  perform private.assert_pipeline_caller(p_approver, v.business_id);
  if v.status <> 'pending_approval' then
    raise exception 'Only stamp-awaiting definitions can be approved — % is "%"', p_def, v.status;
  end if;
  -- assert_workflow_stamp runs again inside the door trigger; calling it here
  -- too gives the caller the precise refusal before any write is attempted.
  perform private.assert_workflow_stamp(p_approver, v.business_id);
  perform set_config('rooshni.workflow_definition_gate', p_def::text, true);
  update public.workflow_definitions
  set status = 'active', approved_by_actor_id = p_approver
  where id = p_def;
  return p_def;
end;
$$;

create or replace function public.reject_workflow_definition(p_def uuid, p_rejected_by uuid, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'Rejection requires a reason — it is recorded for the proposer and the ledger';
  end if;
  select d.business_id, d.status into v
  from public.workflow_definitions d
  where d.id = p_def and d.archived_at is null
  for update;
  if not found then
    raise exception 'Workflow definition % not found (or archived)', p_def;
  end if;
  perform private.assert_pipeline_caller(p_rejected_by, v.business_id);
  if v.status <> 'pending_approval' then
    raise exception 'Only stamp-awaiting definitions can be rejected — % is "%"', p_def, v.status;
  end if;
  -- Refusing the stamp is exercising stamp authority (decision 18).
  perform private.assert_workflow_stamp(p_rejected_by, v.business_id);
  perform set_config('rooshni.workflow_definition_gate', p_def::text, true);
  update public.workflow_definitions set status = 'draft' where id = p_def;
  return p_def;
end;
$$;

create or replace function public.pause_workflow_definition(p_def uuid, p_actor uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
begin
  select d.business_id, d.status into v
  from public.workflow_definitions d
  where d.id = p_def and d.archived_at is null
  for update;
  if not found then
    raise exception 'Workflow definition % not found (or archived)', p_def;
  end if;
  perform private.assert_pipeline_caller(p_actor, v.business_id);
  if v.status <> 'active' then
    raise exception 'Only active definitions can be paused — % is "%"', p_def, v.status;
  end if;
  perform private.assert_workflow_stamp(p_actor, v.business_id);
  perform set_config('rooshni.workflow_definition_gate', p_def::text, true);
  update public.workflow_definitions set status = 'paused' where id = p_def;
  return p_def;
end;
$$;

create or replace function public.resume_workflow_definition(p_def uuid, p_actor uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
begin
  select d.business_id, d.status into v
  from public.workflow_definitions d
  where d.id = p_def and d.archived_at is null
  for update;
  if not found then
    raise exception 'Workflow definition % not found (or archived)', p_def;
  end if;
  perform private.assert_pipeline_caller(p_actor, v.business_id);
  if v.status <> 'paused' then
    raise exception 'Only paused definitions can be resumed — % is "%"', p_def, v.status;
  end if;
  perform private.assert_workflow_stamp(p_actor, v.business_id);
  perform set_config('rooshni.workflow_definition_gate', p_def::text, true);
  update public.workflow_definitions
  set status = 'active', approved_by_actor_id = p_actor
  where id = p_def;
  return p_def;
end;
$$;

-- ---------------------------------------------------------------------------
-- The run pipeline: pause / resume / cancel as gated acts. Controlling what
-- the machine does to an enquiry is Level 2 work: the actor needs enquiries
-- (execute) — or is the owner. JUDGMENT: Spec 4 names these acts but not
-- their gate; enquiries execute is the Level 2 tool every other enquiry
-- mutation already consumes.
-- ---------------------------------------------------------------------------
create or replace function private.assert_run_authority(p_actor uuid, p_business uuid, p_engagement uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.assert_pipeline_caller(p_actor, p_business);
  if not private.is_business_owner_actor(p_actor, p_business)
     and not private.consume_grant(p_actor, p_business, 'enquiries', 'execute', p_engagement) then
    raise exception 'Actor % does not hold enquiries (execute) — controlling a workflow run is Level 2 work', p_actor;
  end if;
end;
$$;

create or replace function public.pause_workflow_run(p_run uuid, p_actor uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
begin
  select r.business_id, r.status, r.engagement_id into v
  from public.workflow_runs r
  where r.id = p_run and r.archived_at is null
  for update;
  if not found then
    raise exception 'Workflow run % not found (or archived)', p_run;
  end if;
  perform private.assert_run_authority(p_actor, v.business_id, v.engagement_id);
  if v.status not in ('running', 'waiting', 'blocked') then
    raise exception 'Only a live run can be paused — run % is "%"', p_run, v.status;
  end if;
  perform set_config('rooshni.workflow_run_gate', p_run::text, true);
  update public.workflow_runs
  set status = 'paused',
      context = context || jsonb_build_object('paused_by_actor_id', p_actor, 'paused_from', v.status)
  where id = p_run;
  return p_run;
end;
$$;

create or replace function public.resume_workflow_run(p_run uuid, p_actor uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
begin
  select r.business_id, r.status, r.engagement_id into v
  from public.workflow_runs r
  where r.id = p_run and r.archived_at is null
  for update;
  if not found then
    raise exception 'Workflow run % not found (or archived)', p_run;
  end if;
  perform private.assert_run_authority(p_actor, v.business_id, v.engagement_id);
  if v.status <> 'paused' then
    raise exception 'Only a paused run can be resumed — run % is "%"', p_run, v.status;
  end if;
  perform set_config('rooshni.workflow_run_gate', p_run::text, true);
  update public.workflow_runs
  set status = coalesce((context ->> 'paused_from')::public.workflow_run_status, 'waiting'),
      context = (context - 'paused_by_actor_id') - 'paused_from'
  where id = p_run;
  return p_run;
end;
$$;

create or replace function public.cancel_workflow_run(p_run uuid, p_actor uuid, p_reason text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
begin
  select r.business_id, r.status, r.engagement_id into v
  from public.workflow_runs r
  where r.id = p_run and r.archived_at is null
  for update;
  if not found then
    raise exception 'Workflow run % not found (or archived)', p_run;
  end if;
  perform private.assert_run_authority(p_actor, v.business_id, v.engagement_id);
  if v.status in ('completed', 'cancelled') then
    raise exception 'Run % is already % — terminal states are never left', p_run, v.status;
  end if;
  perform set_config('rooshni.workflow_run_gate', p_run::text, true);
  update public.workflow_runs
  set status = 'cancelled',
      context = context || jsonb_strip_nulls(jsonb_build_object(
        'cancelled_by_actor_id', p_actor,
        'cancelled_reason', nullif(btrim(coalesce(p_reason, '')), '')))
  where id = p_run;
  -- The run's outstanding intents die with it.
  update public.step_runs
  set status = 'cancelled', finished_at = now()
  where run_id = p_run and status in ('scheduled', 'running', 'awaiting_approval');
  return p_run;
end;
$$;

-- ---------------------------------------------------------------------------
-- The engine functions — the runner's only write path for run state. Server
-- only: a signed-in browser session is refused, and execute is granted to
-- service_role alone. The TS runner computes scaled timestamps (timeScale())
-- and evaluates step conditions; these functions own the transactional state
-- moves so no crash can half-advance a run.
-- ---------------------------------------------------------------------------
create or replace function private.assert_engine_caller()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null then
    raise exception 'Engine functions run only in trusted server code — not from a signed-in session';
  end if;
end;
$$;

create or replace function public.start_workflow_run(
  p_definition uuid,
  p_engagement uuid,
  p_actor uuid,
  p_trigger_event uuid default null,
  p_context jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_def record;
  v_eng record;
  v_first_step uuid;
  v_run uuid;
begin
  perform private.assert_engine_caller();

  select d.business_id, d.status into v_def
  from public.workflow_definitions d
  where d.id = p_definition and d.archived_at is null;
  if not found then
    raise exception 'Workflow definition % not found (or archived)', p_definition;
  end if;
  if v_def.status <> 'active' then
    raise exception 'Only an active definition can start runs — % is "%"', p_definition, v_def.status;
  end if;

  select e.business_id into v_eng
  from public.engagements e
  where e.id = p_engagement and e.archived_at is null;
  if not found then
    raise exception 'Engagement % not found (or archived)', p_engagement;
  end if;
  if v_eng.business_id <> v_def.business_id then
    raise exception 'Engagement % belongs to a different business than definition %', p_engagement, p_definition;
  end if;

  select s.id into v_first_step
  from public.workflow_steps s
  where s.definition_id = p_definition and s.archived_at is null
  order by s.sort_order
  limit 1;
  if v_first_step is null then
    raise exception 'Definition % has no steps — nothing to run', p_definition;
  end if;

  insert into public.workflow_runs (business_id, created_by, definition_id, engagement_id, status, current_step, context)
  values (
    v_def.business_id, p_actor, p_definition, p_engagement, 'waiting', v_first_step,
    p_context || case when p_trigger_event is null then '{}'::jsonb
                      else jsonb_build_object('trigger_event_id', p_trigger_event) end
  )
  returning id into v_run;

  insert into public.step_runs (business_id, created_by, run_id, step_id, scheduled_for)
  values (v_def.business_id, p_actor, v_run, v_first_step, now());

  return v_run;
end;
$$;

-- Claims due work atomically: a second overlapping tick (cron retry, deploy
-- overlap) cannot claim the same step. JUDGMENT: the p_lease default is an
-- execution lease — how long a claimed step may sit 'running' before a later
-- tick assumes the claimant crashed and reclaims it. It is infrastructure
-- recovery time, not a workflow timer, so it is not TIME_SCALE data.
create or replace function public.claim_due_step_runs(
  p_now timestamptz default now(),
  p_limit int default 20,
  p_lease interval default interval '5 minutes'
)
returns setof public.step_runs
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  perform private.assert_engine_caller();
  return query
  update public.step_runs sr
  set status = 'running', started_at = p_now
  where sr.id in (
    select c.id
    from public.step_runs c
    join public.workflow_runs r on r.id = c.run_id
    where r.status in ('running', 'waiting')
      and r.archived_at is null
      and (
        (c.status = 'scheduled' and c.scheduled_for <= p_now)
        or (c.status = 'running' and c.started_at < p_now - p_lease)
      )
    order by c.scheduled_for
    limit p_limit
    for update of c skip locked
  )
  returning sr.*;
end;
$$;

-- A step whose effect awaits a human stamp parks the run at 'blocked' —
-- visibly waiting on the Approval Inbox, exactly as Spec 4 §3 intends the
-- status to read.
create or replace function public.mark_step_awaiting_approval(p_step_run uuid, p_outcome jsonb default '{}'::jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
begin
  perform private.assert_engine_caller();
  select sr.run_id, sr.status, sr.step_id into v
  from public.step_runs sr where sr.id = p_step_run for update;
  if not found then
    raise exception 'Step run % not found', p_step_run;
  end if;
  if v.status <> 'running' then
    raise exception 'Only a running step can await approval — step run % is "%"', p_step_run, v.status;
  end if;
  update public.step_runs
  set status = 'awaiting_approval', outcome = outcome || p_outcome
  where id = p_step_run;
  update public.workflow_runs
  set status = 'blocked', current_step = v.step_id
  where id = v.run_id and status in ('running', 'waiting');
  return p_step_run;
end;
$$;

-- Completes (or skips/fails) one step execution and advances the run in the
-- same transaction: next step scheduled, or the run completed when there is
-- no next. The TS runner picks the next step (condition evaluation) and its
-- scheduled_for (timeScale()-scaled waits); this function makes the move
-- atomic and validates the step belongs to the same definition.
create or replace function public.complete_step_run(
  p_step_run uuid,
  p_status public.step_run_status,
  p_outcome jsonb default '{}'::jsonb,
  p_next_step uuid default null,
  p_next_scheduled_for timestamptz default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
  v_run record;
  v_next_def uuid;
  v_next_run uuid;
begin
  perform private.assert_engine_caller();
  if p_status not in ('completed', 'skipped', 'failed') then
    raise exception 'complete_step_run finishes a step: status must be completed, skipped or failed (got %)', p_status;
  end if;

  select sr.run_id, sr.status, sr.business_id, sr.created_by into v
  from public.step_runs sr where sr.id = p_step_run for update;
  if not found then
    raise exception 'Step run % not found', p_step_run;
  end if;
  if v.status not in ('running', 'awaiting_approval') then
    raise exception 'Step run % is "%" — only running or awaiting_approval steps can finish', p_step_run, v.status;
  end if;

  select r.id, r.status, r.definition_id into v_run
  from public.workflow_runs r where r.id = v.run_id for update;

  update public.step_runs
  set status = p_status, finished_at = now(), outcome = outcome || p_outcome
  where id = p_step_run;

  if p_status = 'failed' then
    -- A failed step parks the run visibly; a human decides what happens next.
    update public.workflow_runs set status = 'blocked' where id = v.run_id
      and status in ('running', 'waiting', 'blocked');
    return null;
  end if;

  if p_next_step is not null then
    select s.definition_id into v_next_def
    from public.workflow_steps s where s.id = p_next_step and s.archived_at is null;
    if v_next_def is null or v_next_def <> v_run.definition_id then
      raise exception 'Next step % does not belong to this run''s definition', p_next_step;
    end if;
    insert into public.step_runs (business_id, created_by, run_id, step_id, scheduled_for)
    values (v.business_id, v.created_by, v.run_id, p_next_step, coalesce(p_next_scheduled_for, now()))
    returning id into v_next_run;
    update public.workflow_runs
    set status = 'waiting', current_step = p_next_step
    where id = v.run_id;
    return v_next_run;
  end if;

  update public.workflow_runs set status = 'completed' where id = v.run_id;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Pending workflow definitions join the Approval Inbox (decision 20 said the
-- union grows as pipelines arrive; §2.4 says a definition change is shown at
-- its gate in plain English — description_plain is the preview).
-- ---------------------------------------------------------------------------
create or replace view public.approval_inbox
with (security_invoker = true)
as
select
  'communication'::text as item_type,
  c.id as item_id,
  c.business_id,
  c.engagement_id,
  coalesce(c.contact_id, th.contact_id) as contact_id,
  c.channel::text as channel,
  coalesce(th.subject, left(c.body, 80)) as title,
  left(c.body, 200) as preview,
  coalesce(c.drafted_by_actor_id, c.created_by) as drafted_by_actor_id,
  a.display_name as drafted_by,
  a.actor_type::text as drafted_by_type,
  c.updated_at as awaiting_since,
  c.scheduled_for,
  p.pf as preflight,
  (p.pf ->> 'pass')::boolean as preflight_pass
from public.communications c
join public.comm_threads th on th.id = c.thread_id
left join public.actors a on a.id = coalesce(c.drafted_by_actor_id, c.created_by)
cross join lateral (select public.preflight_communication(c.id) as pf) p
where c.status = 'pending_approval' and c.archived_at is null
union all
select
  'content'::text,
  ci.id,
  ci.business_id,
  null::uuid,
  null::uuid,
  null::text,
  ci.title,
  ci.content_type,
  ci.created_by,
  a.display_name,
  a.actor_type::text,
  ci.updated_at,
  null::timestamptz,
  null::jsonb,
  null::boolean
from public.content_items ci
left join public.actors a on a.id = ci.created_by
where ci.state = 'pending_approval' and ci.archived_at is null
union all
select
  'task'::text,
  t.id,
  t.business_id,
  t.engagement_id,
  null::uuid,
  null::text,
  t.title,
  t.description,
  t.created_by,
  a.display_name,
  a.actor_type::text,
  t.updated_at,
  t.due_at,
  null::jsonb,
  null::boolean
from public.tasks t
left join public.actors a on a.id = t.created_by
where t.status = 'awaiting_approval' and t.archived_at is null
union all
select
  'workflow_definition'::text,
  wd.id,
  wd.business_id,
  null::uuid,
  null::uuid,
  null::text,
  (wd.key || ' v' || wd.version) as title,
  wd.description_plain,
  wd.created_by,
  a.display_name,
  a.actor_type::text,
  wd.updated_at,
  null::timestamptz,
  null::jsonb,
  null::boolean
from public.workflow_definitions wd
left join public.actors a on a.id = wd.created_by
where wd.status = 'pending_approval' and wd.archived_at is null
order by awaiting_since;

-- ---------------------------------------------------------------------------
-- Row-Level Security. Members see their business's workflow surface (the
-- Automation tab reads these); writes go through the doors above (runs,
-- executions, definition status) or service code (definition/step/template
-- authoring — no authenticated write policies until a gated UI flow exists).
-- Templates are editable content: members may write them. No DELETE policy
-- for users anywhere, as always.
-- ---------------------------------------------------------------------------
alter table public.workflow_definitions enable row level security;
create policy workflow_definitions_select on public.workflow_definitions
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));

alter table public.workflow_steps enable row level security;
create policy workflow_steps_select on public.workflow_steps
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));

alter table public.workflow_runs enable row level security;
create policy workflow_runs_select on public.workflow_runs
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));

alter table public.step_runs enable row level security;
create policy step_runs_select on public.step_runs
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));

alter table public.message_templates enable row level security;
create policy message_templates_select on public.message_templates
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));
create policy message_templates_insert on public.message_templates
  for insert to authenticated
  with check (business_id in (select private.actor_business_ids()));
create policy message_templates_update on public.message_templates
  for update to authenticated
  using (business_id in (select private.actor_business_ids()))
  with check (business_id in (select private.actor_business_ids()));

-- ---------------------------------------------------------------------------
-- Function privileges: pipelines for the API roles; engine for server only.
-- ---------------------------------------------------------------------------
revoke execute on function public.submit_workflow_definition(uuid, uuid) from public;
revoke execute on function public.approve_workflow_definition(uuid, uuid) from public;
revoke execute on function public.reject_workflow_definition(uuid, uuid, text) from public;
revoke execute on function public.pause_workflow_definition(uuid, uuid) from public;
revoke execute on function public.resume_workflow_definition(uuid, uuid) from public;
revoke execute on function public.pause_workflow_run(uuid, uuid) from public;
revoke execute on function public.resume_workflow_run(uuid, uuid) from public;
revoke execute on function public.cancel_workflow_run(uuid, uuid, text) from public;
revoke execute on function public.start_workflow_run(uuid, uuid, uuid, uuid, jsonb) from public;
revoke execute on function public.claim_due_step_runs(timestamptz, int, interval) from public;
revoke execute on function public.mark_step_awaiting_approval(uuid, jsonb) from public;
revoke execute on function public.complete_step_run(uuid, public.step_run_status, jsonb, uuid, timestamptz) from public;

grant execute on function public.submit_workflow_definition(uuid, uuid) to authenticated, service_role;
grant execute on function public.approve_workflow_definition(uuid, uuid) to authenticated, service_role;
grant execute on function public.reject_workflow_definition(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.pause_workflow_definition(uuid, uuid) to authenticated, service_role;
grant execute on function public.resume_workflow_definition(uuid, uuid) to authenticated, service_role;
grant execute on function public.pause_workflow_run(uuid, uuid) to authenticated, service_role;
grant execute on function public.resume_workflow_run(uuid, uuid) to authenticated, service_role;
grant execute on function public.cancel_workflow_run(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.start_workflow_run(uuid, uuid, uuid, uuid, jsonb) to service_role;
grant execute on function public.claim_due_step_runs(timestamptz, int, interval) to service_role;
grant execute on function public.mark_step_awaiting_approval(uuid, jsonb) to service_role;
grant execute on function public.complete_step_run(uuid, public.step_run_status, jsonb, uuid, timestamptz) to service_role;
