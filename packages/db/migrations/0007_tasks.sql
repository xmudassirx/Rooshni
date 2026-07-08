-- 0007: tasks domain (Spec 1 §4.3) — what must be done.

create type public.task_status as enum ('open', 'in_progress', 'blocked', 'awaiting_approval', 'done', 'cancelled');
create type public.task_priority as enum ('low', 'normal', 'high', 'urgent');

create table public.tasks (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '[]'::jsonb,

  engagement_id uuid references public.engagements (id),
  title text not null,
  description text,
  status public.task_status not null default 'open',
  -- A human OR an agent: this one column makes the employee task board and
  -- the orchestrator's to-do list the same surface (§4.3).
  assignee_actor_id uuid not null references public.actors (id),
  due_at timestamptz,
  priority public.task_priority not null default 'normal',
  -- FK to workflow_runs is added when Spec 4's engine tables land (Session 4).
  workflow_run_id uuid,
  approval_level smallint check (approval_level between 0 and 4),
  parent_task_id uuid references public.tasks (id)
);

create index tasks_business_id_idx on public.tasks (business_id);
create index tasks_engagement_idx on public.tasks (engagement_id) where engagement_id is not null;
create index tasks_assignee_idx on public.tasks (assignee_actor_id) where status not in ('done', 'cancelled');
create index tasks_parent_idx on public.tasks (parent_task_id) where parent_task_id is not null;

create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function private.set_updated_at();
