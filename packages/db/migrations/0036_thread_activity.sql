-- 0036: thread last-activity bookkeeping (Session 23, WS2 — the Messenger
-- rebuild + the s22 5c deferral landing: "Conversations: thread list
-- windowed; within a thread load the recent tail and fetch older on upward
-- scroll", decision 157).
--
-- The windowed thread list needs an ordering key that is TRUE for every
-- carriage path (inbound ingest, stamped dispatch, direct sends, drafts).
-- last_inbound_at (0028) covers only one direction and is app-maintained;
-- last_activity_at is maintained by a TRIGGER on communications so no
-- present or future write path can forget it (the enforcement principle
-- applied to bookkeeping the read layer depends on).
--
-- JUDGMENT: last_activity_at is additive bookkeeping the spec's column list
-- omits (the 0028 last_inbound_at class); trigger-maintained rather than
-- app-maintained because FOUR paths write communications today and the
-- windowed list is only honest if none can drift.

alter table public.comm_threads
  add column last_activity_at timestamptz;

create or replace function private.touch_thread_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.thread_id is not null and new.occurred_at is not null then
    update public.comm_threads
       set last_activity_at = greatest(coalesce(last_activity_at, '-infinity'::timestamptz), new.occurred_at)
     where id = new.thread_id;
  end if;
  return new;
end;
$$;

create trigger communications_touch_thread_activity
  after insert or update of occurred_at on public.communications
  for each row execute function private.touch_thread_activity();

-- Backfill from the truth the column summarises.
update public.comm_threads t
   set last_activity_at = c.max_at
  from (
    select thread_id, max(occurred_at) as max_at
      from public.communications
     group by thread_id
  ) c
 where c.thread_id = t.id;

-- The windowed list read: newest activity first within the business.
create index comm_threads_activity_idx
  on public.comm_threads (business_id, last_activity_at desc)
  where archived_at is null;
