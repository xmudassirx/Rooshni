-- 0023: superseded message-template versions are read-only history
-- (founder hardening ask, 30 Jul 2026 — decision 120). The class of bug this
-- kills STRUCTURALLY rather than by vigilance: a mapping/params fix lands on
-- a version row the drafter no longer reads (it reads the latest
-- non-archived version by key) and nobody notices — the WYSIWYS re-issue
-- found exactly that on intro_v1 v2 (empty attributes while v1 carried the
-- mapping). From here, any UPDATE on a superseded row is refused at the
-- database, whatever code carries the write; the lawful change is a NEW
-- version row — re-issue, never rewrite.
--
-- JUDGMENT: the founder's ask allowed "structurally impossible OR loudly
-- detected"; the trigger lane is chosen per the standing principle
-- (anything that must be true is enforced in the database). Archival-state
-- changes stay legal on any version — history keeps its housekeeping — and
-- a row whose newer versions are all archived becomes the effective latest
-- again, so its updates are lawful.

create or replace function private.message_templates_refuse_superseded_update()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1
    from public.message_templates newer
    where newer.business_id = old.business_id
      and newer.key = old.key
      and newer.version > old.version
      and newer.archived_at is null
  ) then
    -- Only the archival state may change (updated_at rides along on every
    -- write via set_updated_at); any other difference is a write landing
    -- on history.
    if to_jsonb(new) - 'archived_at' - 'updated_at'
       is distinct from
       to_jsonb(old) - 'archived_at' - 'updated_at' then
      raise exception
        'message_templates: "%" v% is superseded — superseded versions are read-only history; issue a new version (re-issue, never rewrite)',
        old.key, old.version;
    end if;
  end if;
  return new;
end;
$$;

create trigger message_templates_refuse_superseded
  before update on public.message_templates
  for each row execute function private.message_templates_refuse_superseded_update();
