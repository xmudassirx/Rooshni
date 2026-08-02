-- 0035: thread unread state (Session 23, WS1c — founder-ruled in the session
-- prompt: "a new inbound message sets thread unread state; Conversations
-- sidebar item gains an unread count badge (aggregate, counts law); …
-- Opening the thread clears unread").
--
-- Shape: unread is DERIVED, never stored as a flag that can drift —
--   a thread is unread when last_inbound_at (0028, maintained by the ingest
--   paths) is newer than last_opened_at (this migration, stamped when a
--   member opens the thread). No new table, no new store.
--
-- JUDGMENT: unread is THREAD-level, not per-user — the ruling's own shape
-- ("a new inbound message sets thread unread state; opening the thread
-- clears unread"); any member opening the thread clears it for the
-- business. Per-user read state remains a future session's column, as the
-- Conversations surface has said since Session 8.
--
-- JUDGMENT: opening a thread stamps last_opened_at WITHOUT a ledger event —
-- reading correspondence is not an act on the world (the History tab reads
-- The Record without eventing, same class). Writes ride the existing
-- member-RLS UPDATE policy on comm_threads (the settle/pause controls'
-- path); no new privilege, no new door.

alter table public.comm_threads
  add column last_opened_at timestamptz,
  -- Derived IN THE DATABASE (generated, stored): the flag cannot drift from
  -- the two timestamps it derives from, and PostgREST can count it directly
  -- (a column-vs-column filter is not expressible over the API).
  add column is_unread boolean generated always as (
    last_inbound_at is not null
    and (last_opened_at is null or last_inbound_at > last_opened_at)
  ) stored;

-- The sidebar badge is a COUNT aggregate (D157 5e); this partial index makes
-- the unread count a cheap index-only read.
create index comm_threads_unread_idx
  on public.comm_threads (business_id)
  where is_unread;
