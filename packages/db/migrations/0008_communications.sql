-- 0008: communications domain (Spec 1 §4.4) — every message, in and out, on
-- every channel. Carries the schema-level enforcement of the hardest rule:
-- sending external comms is always Level 3+ and requires a human approver.

create type public.comm_channel as enum ('email', 'whatsapp', 'sms', 'call', 'meeting', 'portal_message', 'internal_note');
create type public.comm_direction as enum ('inbound', 'outbound', 'internal');
create type public.comm_status as enum ('draft', 'pending_approval', 'approved', 'sent', 'delivered', 'read', 'failed', 'received');
create type public.body_format as enum ('plain', 'markdown', 'html');

create table public.comm_threads (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '[]'::jsonb,

  -- Pre-qualification enquiries attach to a contact before any engagement exists.
  engagement_id uuid references public.engagements (id),
  contact_id uuid not null references public.contacts (id),
  channel public.comm_channel not null,
  subject text
);

create index comm_threads_contact_idx on public.comm_threads (contact_id);
create index comm_threads_engagement_idx on public.comm_threads (engagement_id) where engagement_id is not null;

create trigger comm_threads_set_updated_at
  before update on public.comm_threads
  for each row execute function private.set_updated_at();

create table public.communications (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '[]'::jsonb,

  thread_id uuid not null references public.comm_threads (id),
  contact_id uuid references public.contacts (id),
  engagement_id uuid references public.engagements (id),
  channel public.comm_channel not null,
  direction public.comm_direction not null,
  status public.comm_status not null default 'draft',
  body text not null,
  body_format public.body_format not null default 'plain',
  drafted_by_actor_id uuid references public.actors (id),
  approved_by_actor_id uuid references public.actors (id),
  approval_event_id uuid references public.events (id),
  scheduled_for timestamptz,
  occurred_at timestamptz not null default now(),
  duration_seconds int,
  transcript text
);

create index communications_thread_idx on public.communications (thread_id, occurred_at);
create index communications_contact_idx on public.communications (contact_id) where contact_id is not null;
create index communications_engagement_idx on public.communications (engagement_id) where engagement_id is not null;
-- The approval inbox is a view over pending statuses — not a separate store.
create index communications_pending_idx on public.communications (business_id, status)
  where status in ('draft', 'pending_approval');
create index communications_scheduled_idx on public.communications (scheduled_for)
  where scheduled_for is not null and status not in ('sent', 'failed');

create trigger communications_set_updated_at
  before update on public.communications
  for each row execute function private.set_updated_at();

-- THE structural rule (Spec 1 §4.4, decision 7; master context): the pipeline
-- physically refuses any outbound message that has no human approver. The AI
-- cannot hold the stamp — enforcement is a database trigger, not a prompt.
create or replace function private.enforce_human_comm_approval()
returns trigger
language plpgsql
as $$
begin
  if new.direction = 'outbound'
     and new.status in ('approved', 'sent', 'delivered', 'read') then
    if new.approved_by_actor_id is null then
      raise exception 'Outbound communication % cannot reach status "%" without approved_by_actor_id — sending external comms is always Level 3+', new.id, new.status;
    end if;
    if not exists (
      select 1 from public.actors a
      where a.id = new.approved_by_actor_id and a.actor_type = 'human'
    ) then
      raise exception 'communications.approved_by_actor_id must reference a HUMAN actor — the AI cannot hold the stamp';
    end if;
  end if;
  return new;
end;
$$;

create trigger communications_human_approval
  before insert or update on public.communications
  for each row execute function private.enforce_human_comm_approval();
