-- 0038: trigger consumption per workflow KEY + the activation frontier
-- (Session 23, WS6 — founder-ruled after the 116-draft burst: "consumption
-- tracked per workflow KEY, not per definition version; a re-issue inherits
-- its predecessor's consumed history; activation starts runs only for
-- arrivals after the predecessor's consumption frontier; replays
-- structurally impossible").
--
-- The burst's mechanics, from the s22 ledger diagnostic: consumption was
-- recorded ONLY as workflow_runs rows under the 0019 partial unique index
-- (definition_id, trigger_event_id) — so a re-issued definition (a new id
-- for the same key) was blind to everything its predecessors consumed and
-- replayed the whole historical trigger backlog on activation.
--
-- Three structures land here:
--   1. workflow_trigger_consumptions — the KEY-scoped claim table. One row
--      per (business, workflow key, trigger event), unique. Backfilled from
--      the union of ALL versions' existing runs, deduplicated keep-earliest,
--      so every event any version ever consumed is claimed exactly once (no
--      double-count) and every run row stays untouched history (no orphan).
--   2. start_workflow_run re-issued (fix-forward): a triggered start CLAIMS
--      (business, key, event) in the same transaction as the run — the
--      unique constraint makes a replay STRUCTURALLY impossible, whatever
--      code calls the door. The 0019 per-definition index remains (narrower,
--      still true).
--   3. workflow_definitions.trigger_frontier_at + approve_workflow_definition
--      re-issued: activation stamps the KEY's consumption frontier (the
--      newest consumed trigger arrival, else the predecessors' recorded
--      frontier), and the scan starts runs only for arrivals after it.
-- JUDGMENT: a version with NO predecessor keeps a null frontier — the
-- ruling defines the frontier for re-issues; fresh-tenant behaviour is
-- unchanged (flagged at pre-flight).
--
-- The still-live replay-spawned runs on production are NOT touched by this
-- migration (a data migration cancelling live runs is not this file's
-- business): the evented chore `chore:cancel-replay-runs` is the founder-run
-- live step (the decision 55 demo-reset precedent — gated pipeline, evented,
-- nothing deleted), listed on GO-LIVE.

-- 1. The claim table. Engine infrastructure: RLS on with NO policies —
--    service-role only (the meta_webhook_events/stripe_events precedent);
--    the engine door functions are its only writers.
create table public.workflow_trigger_consumptions (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  workflow_key text not null,
  trigger_event_id uuid not null references public.events (id),
  run_id uuid not null references public.workflow_runs (id),
  consumed_at timestamptz not null default now(),
  unique (business_id, workflow_key, trigger_event_id)
);

create index workflow_trigger_consumptions_business_key_idx
  on public.workflow_trigger_consumptions (business_id, workflow_key);

alter table public.workflow_trigger_consumptions enable row level security;
-- No policies on purpose: no API role reads or writes claims directly.
revoke insert, update, delete on public.workflow_trigger_consumptions
  from anon, authenticated;

-- Backfill: every event any version ever consumed, claimed once —
-- keep-earliest per (business, key, event); later replay runs stay as
-- history rows without a claim of their own.
insert into public.workflow_trigger_consumptions
  (business_id, workflow_key, trigger_event_id, run_id, consumed_at)
select distinct on (r.business_id, d.key, (r.context ->> 'trigger_event_id')::uuid)
  r.business_id,
  d.key,
  (r.context ->> 'trigger_event_id')::uuid,
  r.id,
  r.created_at
from public.workflow_runs r
join public.workflow_definitions d on d.id = r.definition_id
where r.context ? 'trigger_event_id'
order by r.business_id, d.key, (r.context ->> 'trigger_event_id')::uuid, r.created_at asc;

-- 2. The frontier column. Not in the API roles' column-listed grants (0019),
--    so no signed-in session can write it; it moves only inside the gated
--    activation below.
alter table public.workflow_definitions
  add column trigger_frontier_at timestamptz;

-- 3. start_workflow_run, re-issued: a triggered start claims its event for
--    the KEY in the same transaction. A duplicate claim refuses the run —
--    replays are structurally impossible.
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

  select d.business_id, d.status, d.key into v_def
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

  -- WS6 (Session 23): the KEY-scoped claim — consumed at most once, ever,
  -- across every version of this workflow. The unique constraint is the law.
  if p_trigger_event is not null then
    insert into public.workflow_trigger_consumptions
      (business_id, workflow_key, trigger_event_id, run_id)
    values (v_def.business_id, v_def.key, p_trigger_event, v_run);
  end if;

  insert into public.step_runs (business_id, created_by, run_id, step_id, scheduled_for)
  values (v_def.business_id, p_actor, v_run, v_first_step, now());

  return v_run;
end;
$$;

-- 4. approve_workflow_definition, re-issued: activation stamps the KEY's
--    consumption frontier — the newest trigger arrival any version consumed,
--    else the predecessors' recorded frontier; null when neither exists
--    (a first version scans as it always has).
create or replace function public.approve_workflow_definition(p_def uuid, p_approver uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
  v_frontier timestamptz;
begin
  select d.business_id, d.status, d.key into v
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

  select greatest(
    (select max(e.occurred_at)
       from public.workflow_trigger_consumptions c
       join public.events e on e.id = c.trigger_event_id
      where c.business_id = v.business_id and c.workflow_key = v.key),
    (select max(d2.trigger_frontier_at)
       from public.workflow_definitions d2
      where d2.business_id = v.business_id and d2.key = v.key and d2.id <> p_def)
  ) into v_frontier;

  perform set_config('rooshni.workflow_definition_gate', p_def::text, true);
  update public.workflow_definitions
  set status = 'active', approved_by_actor_id = p_approver, trigger_frontier_at = v_frontier
  where id = p_def;
  return p_def;
end;
$$;
