-- 0034: the stuck-definition escape hatch (Session 21, founder-ruled).
--
-- The definition approve/reject pipeline has no UI yet, so a definition
-- stranded at pending_approval (the install chore's double-run artefact) has
-- no honest exit. This migration builds the MINIMAL exit only: an OWNER may
-- WITHDRAW a definition at pending_approval. Withdrawn is a terminal state —
-- frozen, evented (app layer, emitEvent — SQL never writes the ledger),
-- visible in Approval Inbox History, never deletable: the Record never
-- purges. The full definition-approval pipeline remains its own later
-- session; nothing here adds an approval path.
--
-- The workflow-definition door (0019, PLAYBOOK §7) is EXTENDED, never
-- loosened: every existing refusal stands, and the new state brings its own
-- (no row born withdrawn, no exit from withdrawn, no direct writes, no
-- delete).
--
-- JUDGMENT: the enum literal 'withdrawn' appears ONLY inside plpgsql bodies
-- in this file — the live migrator applies each file in one transaction, and
-- Postgres refuses a same-transaction use of a new enum value anywhere it is
-- resolved at DDL time (constraints, views, defaults); plpgsql bodies
-- resolve it at runtime, after commit.
alter type public.workflow_definition_status add value 'withdrawn';

-- ---------------------------------------------------------------------------
-- The withdrawal record lives on the row, mirroring the decision-17 rejection
-- columns on communications: who, when, why — all or none.
-- JUDGMENT: the column triple is the decision-4/17 class of addition (a state
-- the enforcement needs that Spec 4's column list predates); the all-or-none
-- check deliberately names only the columns (not the status — see the enum
-- note above); the status↔columns pairing is enforced in the door trigger.
-- ---------------------------------------------------------------------------
alter table public.workflow_definitions
  add column withdrawn_at timestamptz,
  add column withdrawn_by_actor_id uuid references public.actors (id),
  add column withdrawal_reason text,
  add constraint workflow_definitions_withdrawal_all_or_none check (
    (withdrawn_at is null) = (withdrawn_by_actor_id is null)
    and (withdrawn_at is null) = (withdrawal_reason is null)
    and (withdrawal_reason is null or btrim(withdrawal_reason) <> '')
  );

-- The new columns join no insert/update grant: 0019 revoked table-level
-- insert/update and granted named columns only, so every API role is already
-- unable to write these three directly. The pipeline function below is the
-- one door (security definer).

-- ---------------------------------------------------------------------------
-- The door trigger, re-issued with the withdrawn rules. Everything 0019
-- enforced is verbatim; the additions:
--   * DELETE of a withdrawn definition is refused — the Record never purges;
--   * a row is never BORN withdrawn, and withdrawal columns belong only to a
--     withdrawn row;
--   * withdrawn is terminal and frozen: no UPDATE of any kind leaves or
--     touches a withdrawn row (the decision-136 superseded precedent —
--     terminal, frozen, never deletable);
--   * the withdrawal columns move only through the pipeline gate, and only
--     together with the transition pending_approval → withdrawn.
-- ---------------------------------------------------------------------------
create or replace function private.enforce_workflow_definition_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'withdrawn' then
      raise exception 'A withdrawn workflow definition is never deleted — the Record never purges';
    end if;
    return old;
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'withdrawn' or new.withdrawn_at is not null then
      raise exception 'No workflow definition is born withdrawn — withdrawal is an owner''s act on a pending proposal';
    end if;
    if new.status in ('active', 'paused') then
      perform private.assert_workflow_stamp(new.approved_by_actor_id, new.business_id);
    elsif new.approved_by_actor_id is not null then
      raise exception 'approved_by_actor_id belongs only to an activated definition';
    end if;
    return new;
  end if;

  -- UPDATE: withdrawn is terminal and FROZEN — nothing on the row may change.
  if old.status = 'withdrawn' then
    raise exception 'Workflow definition % is withdrawn — a terminal state is never left and a withdrawn row never changes', old.id;
  end if;

  -- Behaviour is frozen outside draft — a change is a new version.
  if old.status <> 'draft'
     and (new.key is distinct from old.key
          or new.version is distinct from old.version
          or new.template_id is distinct from old.template_id
          or new.trigger is distinct from old.trigger
          or new.description_plain is distinct from old.description_plain) then
    raise exception 'A workflow definition is immutable once it leaves draft — a change of behaviour is a new version (the grants precedent: re-issue, never rewrite)';
  end if;

  if new.status is distinct from old.status
     or new.approved_by_actor_id is distinct from old.approved_by_actor_id
     or new.withdrawn_at is distinct from old.withdrawn_at
     or new.withdrawn_by_actor_id is distinct from old.withdrawn_by_actor_id
     or new.withdrawal_reason is distinct from old.withdrawal_reason then
    if current_setting('rooshni.workflow_definition_gate', true) is distinct from new.id::text then
      raise exception 'Workflow definition status moves only through submit/approve/reject/pause/resume/withdraw_workflow_definition()';
    end if;
    if new.status in ('active', 'paused') and old.status = 'pending_approval' then
      perform private.assert_workflow_stamp(new.approved_by_actor_id, new.business_id);
    end if;
    -- The status↔columns pairing: withdrawal facts travel only with the
    -- transition into withdrawn, and that transition carries all of them.
    if new.status = 'withdrawn' then
      if old.status <> 'pending_approval' then
        raise exception 'Only a stamp-awaiting definition can be withdrawn — % is "%"', old.id, old.status;
      end if;
      if new.withdrawn_at is null or new.withdrawn_by_actor_id is null or new.withdrawal_reason is null then
        raise exception 'A withdrawal records who, when and why — all three, always';
      end if;
    elsif new.withdrawn_at is not null then
      raise exception 'Withdrawal columns belong only to a withdrawn definition';
    end if;
  end if;
  return new;
end;
$$;

-- 0019's trigger covered insert/update; the delete refusal needs the row too.
drop trigger workflow_definitions_door on public.workflow_definitions;
create trigger workflow_definitions_door
  before insert or update or delete on public.workflow_definitions
  for each row execute function private.enforce_workflow_definition_rules();

-- ---------------------------------------------------------------------------
-- The withdraw pipeline — the ONE path into withdrawn. Founder-ruled: an
-- OWNER may withdraw a definition at pending_approval; the reason is
-- required and recorded on the row (the app layer puts the act on The
-- Record via emitEvent). Not the proposer's act, not a stamp act: the
-- approve/reject stamps stay absent until their own session.
-- ---------------------------------------------------------------------------
create or replace function public.withdraw_workflow_definition(p_def uuid, p_actor uuid, p_reason text)
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
    raise exception 'Withdrawal requires a reason — it is recorded on the row and the ledger';
  end if;
  select d.business_id, d.status into v
  from public.workflow_definitions d
  where d.id = p_def and d.archived_at is null
  for update;
  if not found then
    raise exception 'Workflow definition % not found (or archived)', p_def;
  end if;
  perform private.assert_pipeline_caller(p_actor, v.business_id);
  if v.status <> 'pending_approval' then
    raise exception 'Only a stamp-awaiting definition can be withdrawn — % is "%"', p_def, v.status;
  end if;
  if not private.is_business_owner_actor(p_actor, v.business_id) then
    raise exception 'Withdrawing a pending workflow definition is the owner''s act — actor % is not the owner', p_actor;
  end if;
  perform set_config('rooshni.workflow_definition_gate', p_def::text, true);
  update public.workflow_definitions
  set status = 'withdrawn',
      withdrawn_at = now(),
      withdrawn_by_actor_id = p_actor,
      withdrawal_reason = btrim(p_reason)
  where id = p_def;
  return p_def;
end;
$$;

revoke execute on function public.withdraw_workflow_definition(uuid, uuid, text) from public;
grant execute on function public.withdraw_workflow_definition(uuid, uuid, text) to authenticated, service_role;
