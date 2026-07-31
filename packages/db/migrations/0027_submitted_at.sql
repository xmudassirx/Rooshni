-- 0027: the waiting clock is the CLIENT's, immutable across edits (Session
-- 15 click-review fix 1, founder-ruled 31 July 2026: "'waiting since' and
-- the inbox sort key derive from the original submission-to-pending time,
-- never reset by an edit. An edit changes the words, not the age.").
--
-- Root cause: the 0017 approval_inbox view read c.updated_at as
-- awaiting_since — any row touch (an edit-before-stamp, an attribute merge)
-- reset the clock and dropped the card down the queue, so the inbox lied
-- about how long a lead had been waiting.
--
-- The fix is a database fact, not view arithmetic: communications gains
-- submitted_at, stamped by trigger on the transition INTO pending_approval
-- and forced immutable on every other write. A rejection returns the row to
-- draft, so a later re-submission lawfully re-stamps — that wait genuinely
-- restarts; an edit does not touch status and therefore cannot touch the
-- clock. The column is deliberately absent from the 0017 update grant list,
-- so no API role can write it directly.

alter table public.communications
  add column submitted_at timestamptz;

create or replace function private.stamp_submitted_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'pending_approval' then
      new.submitted_at := now();
    end if;
    return new;
  end if;
  if new.status = 'pending_approval' and old.status is distinct from new.status then
    new.submitted_at := now();
  else
    -- Immutable on every other write, whatever code carries it.
    new.submitted_at := old.submitted_at;
  end if;
  return new;
end;
$$;

create trigger communications_stamp_submitted_at
  before insert or update on public.communications
  for each row execute function private.stamp_submitted_at();

-- Backfill from the ledger: the submission moment is already on The Record
-- as communication.submitted — the earliest such event per row is the truth.
-- Additive data repair, no destructive touch; rows with no submitted event
-- (never submitted, or insert-at-approved) honestly stay null.
update public.communications c
set submitted_at = e.first_submitted
from (
  select entity_id, min(occurred_at) as first_submitted
  from public.events
  where action = 'communication.submitted' and entity_id is not null
  group by entity_id
) e
where e.entity_id = c.id
  and c.submitted_at is null;

-- ---------------------------------------------------------------------------
-- The approval_inbox view, re-issued (0019 fix-forward — the FOUR-arm
-- definition including pending workflow definitions, decision 45): the
-- communications arm's awaiting_since becomes the immutable submission
-- stamp, with updated_at only as the fallback for any pre-0027 row the
-- ledger could not date. Content, task and workflow-definition arms are
-- unchanged. Same columns, same order — create or replace is lawful.
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
  coalesce(c.submitted_at, c.updated_at) as awaiting_since,
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
