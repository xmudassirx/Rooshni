-- 0031: the live inbox (Session 16, PR-G) — communications joins the
-- supabase_realtime publication so the Approval Inbox count, the inbox list
-- and the Conversations thread view update WITHOUT polling: the browser
-- holds one Realtime subscription and re-renders server-side when the
-- database says something changed. Authorisation is RLS — Realtime serves a
-- signed-in subscriber only the rows their SELECT policies allow, the same
-- wall every query answers to.
--
-- Defensive shape: hosted Supabase ships the publication; the check-local
-- harness (PGlite) does not — create it when absent so the migration is one
-- truth everywhere.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end
$$;

alter publication supabase_realtime add table public.communications;
