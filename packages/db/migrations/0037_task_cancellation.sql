-- 0037: task cancellation (Session 23, WS4d — founder-ruled in the session
-- prompt: "owner/manager may CANCEL a task (terminal, evented, reason
-- optional); a non-manager gets REQUEST CANCELLATION which lands as an
-- approval item for the manager. Never delete; The Record never purges").
--
-- Two structures:
--   1. `cancelled` becomes STRUCTURALLY terminal — no write path may move a
--      task out of it (the 0030 superseded precedent applied to tasks).
--      Verified before shipping: nothing in the repo reopens a cancelled
--      task (the first-light unearn reopens from `done` only; the workflow
--      engine only cancels INTO the state).
--   2. A cancellation REQUEST is bookkeeping on the task row
--      (attributes.cancellation_request = { requested_by, requested_at,
--      reason }) and the approval_inbox view gains a `task_cancellation`
--      arm so the request lands in the manager's stamps-owed queue (the
--      decision 20 anticipated-arms shape; the D134 view re-issued from its
--      0027 definition with the one new arm).
--
-- JUDGMENT: "manager" resolves against the existing permission truth — the
-- OWNER, or a human holding `settings.team` at execute (decision 8: the
-- Admin preset's managing-access tool). No new tool row is minted. The
-- gate is enforced app-side for this ungated primitive (decision 74: tasks
-- write direct under member RLS, every act evented); the DATABASE enforces
-- what must be true structurally — terminality and the no-delete rule.

-- 1. Terminal: a cancelled task never leaves the state.
create or replace function private.enforce_task_cancelled_terminal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'cancelled' and new.status is distinct from 'cancelled' then
    raise exception 'A cancelled task is terminal — task % cannot leave "cancelled" (The Record never purges; create a new task instead)', old.id;
  end if;
  return new;
end;
$$;

create trigger tasks_cancelled_terminal
  before update on public.tasks
  for each row execute function private.enforce_task_cancelled_terminal();

-- 2. The approval_inbox view, re-issued from its 0027 definition with the
--    task_cancellation arm (a pending request on a live task).
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
-- Session 23 (WS4d): a member's cancellation request awaiting the manager.
select
  'task_cancellation'::text,
  t.id,
  t.business_id,
  t.engagement_id,
  null::uuid,
  null::text,
  t.title,
  coalesce(t.attributes -> 'cancellation_request' ->> 'reason', 'no reason given'),
  (t.attributes -> 'cancellation_request' ->> 'requested_by')::uuid,
  a.display_name,
  a.actor_type::text,
  coalesce(
    (t.attributes -> 'cancellation_request' ->> 'requested_at')::timestamptz,
    t.updated_at
  ),
  null::timestamptz,
  null::jsonb,
  null::boolean
from public.tasks t
left join public.actors a
  on a.id = (t.attributes -> 'cancellation_request' ->> 'requested_by')::uuid
where t.attributes ? 'cancellation_request'
  and t.status not in ('done', 'cancelled')
  and t.archived_at is null
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
