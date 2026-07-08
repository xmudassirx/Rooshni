-- 0013: explicit table privileges for the Supabase API roles.
--
-- This project (new-style API keys, automatic RLS) does not blanket-grant
-- data privileges on tables created over a direct connection, so we grant
-- them explicitly — which suits the spec's ethos anyway: nothing implicit.
--
-- The privilege layer answers "may this role touch this table at all";
-- RLS (0012) answers "which rows"; triggers (0004/0006/0008/0009) enforce
-- the structural rules no role may break.

grant usage on schema public to authenticated, service_role;

-- Trusted server code (integrations, seed, gated pipelines).
grant select, insert, update, delete on all tables in schema public to service_role;

-- Signed-in users: reads and writes are then filtered by RLS policies.
-- No DELETE: hard deletion is Level 3+ and runs through service-role
-- pipelines only.
grant select, insert, update on all tables in schema public to authenticated;

-- anon gets nothing in Phase 1: there is no public unauthenticated surface.

-- Append-only tables stay append-only for every API role (triggers block
-- UPDATE/DELETE regardless — belt and braces, as in 0004/0006).
revoke update, delete on public.events from authenticated, service_role;
revoke update, delete on public.stage_history from authenticated, service_role;
revoke update on public.content_versions from authenticated, service_role;

-- Future tables created by the migration role inherit the same shape.
alter default privileges for role postgres in schema public
  grant select, insert, update, delete on tables to service_role;
alter default privileges for role postgres in schema public
  grant select, insert, update on tables to authenticated;
