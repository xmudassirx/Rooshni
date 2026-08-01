-- 0030: the supersede engine (Session 16, PR-B/PR-C; decision 133 a–c).
--
-- The laws this migration makes structural:
--   1. At most ONE pending outbound draft per engagement per channel —
--      a partial unique index, not app behaviour.
--   2. `superseded` is terminal and frozen: status never leaves it, the
--      body it carried never changes, the row is never deletable (the 0023
--      superseded-template precedent applied to drafts).
--   3. A human outbound reaching approved/sent on a thread auto-supersedes
--      every OTHER pending draft on that thread, in the same transaction —
--      no orphan draft can survive a human's reply (decision 133c).
--   4. A superseding draft INHERITS the original submitted_at — the client
--      has been waiting since their first unmet message (decision 134,
--      PR-B); the inheritance path is a service-only pipeline function, and
--      the 0027 clock stays closed to every API role.
--   5. Settle-window timer state lives on the thread row, server-side,
--      cron-evaluated (decision 133b) — never client-side.
--
-- Standing principle: anything that must be true is enforced in the
-- database; the app being well-behaved is not a control.

-- ---------------------------------------------------------------------------
-- Data normalisation BEFORE the guard indexes: live shadow-mode data may
-- hold several pending drafts on one engagement+channel (nurture nudges
-- pending together). The NEWEST submission stays pending; older ones become
-- superseded with a marker the evented chore (`npm run supersede:normalise`)
-- reads to put each transition on The Record (SQL never writes the ledger —
-- law 11; the 0027-backfill class of in-migration data repair, no deletes).
-- JUDGMENT: normalisation keyed on coalesce(engagement, thread) + channel,
-- newest-by-submission-wins — the ruling names the guard, not the repair;
-- keeping the newest matches the engine's own behaviour (the latest
-- regeneration is the living draft).
-- ---------------------------------------------------------------------------
with ranked as (
  select
    id,
    row_number() over (
      partition by coalesce(engagement_id, thread_id), channel
      order by coalesce(submitted_at, created_at) desc, id desc
    ) as rn
  from public.communications
  where status = 'pending_approval'
    and direction = 'outbound'
    and archived_at is null
)
update public.communications c
set status = 'superseded',
    attributes = c.attributes || jsonb_build_object(
      'superseded', jsonb_build_object(
        'reason', 'migration_normalisation',
        'superseded_at', now(),
        'needs_event', true
      )
    )
from ranked r
where r.id = c.id
  and r.rn > 1;

-- ---------------------------------------------------------------------------
-- The guard (decision 133a): one pending outbound draft per engagement per
-- channel — and, for engagement-less threads, per thread per channel.
-- JUDGMENT: the ruling names the engagement; the thread-keyed twin covers
-- pre-qualification threads whose engagement_id is null (0008 allows them) —
-- additive protection, same law, listed for sign-off.
-- ---------------------------------------------------------------------------
create unique index communications_one_pending_per_engagement_channel
  on public.communications (engagement_id, channel)
  where status = 'pending_approval'
    and direction = 'outbound'
    and archived_at is null
    and engagement_id is not null;

create unique index communications_one_pending_per_thread_channel
  on public.communications (thread_id, channel)
  where status = 'pending_approval'
    and direction = 'outbound'
    and archived_at is null
    and engagement_id is null;

-- ---------------------------------------------------------------------------
-- Terminal and frozen (the 0023 precedent applied to drafts): a superseded
-- row is history. Status never leaves it; the words it carried never change;
-- only archival state and attributes (event bookkeeping) may move. No row
-- may be BORN superseded — the state exists only as the end of a pending
-- draft's life. DELETE is refused outright (History keeps its record; the
-- go-live purge is a superuser act that disables triggers deliberately).
-- ---------------------------------------------------------------------------
create or replace function private.enforce_superseded_terminal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'superseded' then
      raise exception 'Superseded drafts are history — they are never deleted (Approval Inbox History renders them)';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.status = 'superseded' then
      raise exception 'A communication cannot be born superseded — the state exists only as the end of a pending draft''s life';
    end if;
    return new;
  end if;
  -- UPDATE
  if old.status = 'superseded' then
    if new.status is distinct from 'superseded' then
      raise exception 'Superseded is terminal — communication % cannot leave it', old.id;
    end if;
    if new.body is distinct from old.body
       or new.channel is distinct from old.channel
       or new.thread_id is distinct from old.thread_id
       or new.direction is distinct from old.direction then
      raise exception 'A superseded draft is frozen history — its words and placement never change';
    end if;
    return new;
  end if;
  if new.status = 'superseded' and old.status is distinct from 'pending_approval' then
    raise exception 'Only a PENDING draft can be superseded — communication % is "%"', old.id, old.status;
  end if;
  return new;
end;
$$;

create trigger communications_superseded_terminal
  before insert or update or delete on public.communications
  for each row execute function private.enforce_superseded_terminal();

-- ---------------------------------------------------------------------------
-- The clock inheritance door (decision 134 + PR-B): stamp_submitted_at is
-- re-issued (0027 fix-forward) to honour a transaction-local inheritance
-- value that ONLY the service-only supersede pipeline below can set. The
-- column stays absent from every API role's update grant; PostgREST exposes
-- no set_config surface — a browser still cannot touch the clock.
-- ---------------------------------------------------------------------------
create or replace function private.stamp_submitted_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inherit text;
begin
  if tg_op = 'INSERT' then
    if new.status = 'pending_approval' then
      v_inherit := nullif(current_setting('rooshni.inherit_submitted_at', true), '');
      if v_inherit is not null then
        new.submitted_at := v_inherit::timestamptz;
        perform set_config('rooshni.inherit_submitted_at', '', true);
      else
        new.submitted_at := now();
      end if;
    end if;
    return new;
  end if;
  if new.status = 'pending_approval' and old.status is distinct from new.status then
    -- The transition INTO pending: a fresh submission stamps now(); the
    -- supersede pipeline's transaction-local inheritance value (consumed
    -- exactly once) hands the ORIGINAL clock to a superseding draft instead.
    v_inherit := nullif(current_setting('rooshni.inherit_submitted_at', true), '');
    if v_inherit is not null then
      new.submitted_at := v_inherit::timestamptz;
      perform set_config('rooshni.inherit_submitted_at', '', true);
    else
      new.submitted_at := now();
    end if;
  else
    -- Immutable on every other write, whatever code carries it (0027).
    new.submitted_at := old.submitted_at;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- The supersede pipeline (service-only, the 0021 send-door pattern): the
-- ONLY path that retires a pending draft as superseded and hands its waiting
-- clock to the successor. A signed-in session is refused — superseding is
-- Light's bookkeeping, not a stamp act; humans retire drafts by rejecting
-- (with a reason) or by replying (the trigger below).
-- ---------------------------------------------------------------------------
-- The ordering the guard forces is the function's shape: old and successor
-- can never PEND together on one engagement+channel, so the act is atomic —
-- retire the old draft, submit the successor through the existing 0017 door
-- (same drafter law, same grant consumption), and hand the original clock
-- across via the transaction-local inheritance value. A crash anywhere rolls
-- the whole act back; the books cannot end half-superseded.
create or replace function public.supersede_communication(
  p_comm uuid,
  p_reason text,
  p_successor uuid default null,
  p_drafter uuid default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_old record;
  v_succ record;
begin
  if (select auth.uid()) is not null then
    raise exception 'supersede_communication is a service pipeline — a signed-in session cannot call it';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'Superseding requires a reason — it is recorded on the row and The Record';
  end if;

  select c.id, c.status, c.direction, c.thread_id, c.engagement_id, c.channel,
         c.submitted_at, c.attributes, c.business_id
  into v_old
  from public.communications c
  where c.id = p_comm and c.archived_at is null
  for update;
  if not found then
    raise exception 'Communication % not found (or archived)', p_comm;
  end if;
  if v_old.direction <> 'outbound' or v_old.status <> 'pending_approval' then
    raise exception 'Only a PENDING outbound draft can be superseded — communication % is % %',
      p_comm, v_old.direction, v_old.status;
  end if;

  if p_successor is not null then
    if p_drafter is null then
      raise exception 'A successor needs its drafter — submission stays the drafter''s act (0017)';
    end if;
    select c.id, c.status, c.direction, c.thread_id, c.engagement_id, c.channel, c.submitted_at
    into v_succ
    from public.communications c
    where c.id = p_successor and c.archived_at is null
    for update;
    if not found then
      raise exception 'Successor communication % not found (or archived)', p_successor;
    end if;
    if v_succ.direction <> 'outbound' or v_succ.status <> 'draft' then
      raise exception 'The successor must be an outbound DRAFT — the guard admits it to pending only after the old draft retires';
    end if;
    if v_succ.channel is distinct from v_old.channel
       or coalesce(v_succ.engagement_id, v_succ.thread_id) is distinct from coalesce(v_old.engagement_id, v_old.thread_id) then
      raise exception 'A successor must answer the same engagement and channel as the draft it supersedes';
    end if;
  end if;

  update public.communications
  set status = 'superseded',
      attributes = attributes || jsonb_build_object(
        'superseded', jsonb_build_object(
          'reason', btrim(p_reason),
          'superseded_at', now(),
          'successor_id', p_successor
        )
      )
  where id = p_comm;

  if p_successor is not null then
    -- Decision 134 / PR-B: the client has been waiting since their FIRST
    -- unmet message — the successor inherits the earlier clock (a null
    -- pre-0027 clock honestly stamps fresh).
    if v_old.submitted_at is not null then
      perform set_config('rooshni.inherit_submitted_at', v_old.submitted_at::text, true);
    end if;
    perform public.submit_communication(p_successor, p_drafter);
  end if;
  return p_comm;
end;
$$;

revoke execute on function public.supersede_communication(uuid, text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.supersede_communication(uuid, text, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- The human always wins (decision 133c), structurally: when an outbound
-- communication on a thread reaches approved/sent, every OTHER pending
-- outbound draft on that thread is superseded IN THE SAME TRANSACTION — app
-- code cannot forget it, and no orphan draft survives a human's reply. The
-- marker carries needs_event: the app layer puts each transition on The
-- Record (law 11 — SQL never writes the ledger), and the cron sweep events
-- any marker a crash left behind.
-- JUDGMENT: the reason is human_replied when the winning row was authored
-- by a human actor, outbound_dispatched otherwise (the guard index makes the
-- second case near-unreachable); the ruling names only the human case.
-- ---------------------------------------------------------------------------
create or replace function private.supersede_on_human_outbound()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_human boolean;
  v_reason text;
begin
  if new.direction <> 'outbound' or new.status not in ('approved', 'sent') then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.status in ('approved', 'sent') then
    return null; -- already past the threshold; approved → sent re-fires nothing
  end if;

  select exists (
    select 1 from public.actors a
    where a.id = coalesce(new.drafted_by_actor_id, new.created_by)
      and a.actor_type = 'human'
  ) into v_human;
  v_reason := case when v_human then 'human_replied' else 'outbound_dispatched' end;

  update public.communications c
  set status = 'superseded',
      attributes = c.attributes || jsonb_build_object(
        'superseded', jsonb_build_object(
          'reason', v_reason,
          'superseded_at', now(),
          'superseded_by_communication_id', new.id,
          'needs_event', true
        )
      )
  where c.thread_id = new.thread_id
    and c.id <> new.id
    and c.direction = 'outbound'
    and c.status = 'pending_approval'
    and c.archived_at is null;

  return null;
end;
$$;

create trigger communications_supersede_on_outbound
  after insert or update on public.communications
  for each row execute function private.supersede_on_human_outbound();

-- ---------------------------------------------------------------------------
-- Settle-window timer state on the thread (decision 133b, PR-C): durable,
-- server-side, cron-evaluated — the exact nudge-timer pattern, never
-- client-side. draft_settle_due_at is when the current inbound burst
-- settles (restarted by each new inbound); settle_override_seconds is the
-- per-conversation override (null = the business-level setting);
-- auto_draft_paused is PR-D's per-conversation PAUSE (on-by-default is the
-- product — the column can only pause, never enable).
-- ---------------------------------------------------------------------------
alter table public.comm_threads
  add column draft_settle_due_at timestamptz,
  add column settle_override_seconds integer,
  add column auto_draft_paused boolean not null default false;

create index comm_threads_settle_due_idx
  on public.comm_threads (draft_settle_due_at)
  where draft_settle_due_at is not null;
