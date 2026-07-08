-- 0016: close the stage door (Session 2 sign-off). A direct update of
-- engagements.stage_id was an unlocked door beside the gated stage_history
-- path — an app promise, not a control. Column-level privileges now refuse
-- it for every API role, and stage changes run through one pipeline:
-- public.move_engagement_stage() — grant check, stage_history append and
-- engagement update in a single transaction.
--
-- Standing principle: anything that must be true is enforced in the
-- database; the app being well-behaved is not a control.

-- Postgres column privileges are additive, so the table-wide UPDATE from
-- 0013 is revoked and re-granted column by column — everything except
-- stage_id and stage_entered_at (stage timing stays honest too; both are
-- written only by the pipeline). updated_at needs no grant: the envelope
-- trigger maintains it.
revoke update on public.engagements from anon, authenticated, service_role;
grant update (
  title, template_type_id, outcome, outcome_at, value_estimate,
  attributes, external_refs, attribution, owner_actor_id, archived_at
) on public.engagements to authenticated, service_role;

create or replace function public.move_engagement_stage(
  p_engagement uuid,
  p_to_stage uuid,
  p_moved_by uuid,
  p_moved_at timestamptz default now()
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_business uuid;
  v_from uuid;
  v_type uuid;
  v_terminal boolean;
  v_outcome public.engagement_outcome;
  v_history uuid;
begin
  select e.business_id, e.stage_id, e.template_type_id
  into v_business, v_from, v_type
  from public.engagements e
  where e.id = p_engagement and e.archived_at is null
  for update;
  if v_business is null then
    raise exception 'Engagement % not found (or archived)', p_engagement;
  end if;

  -- Signed-in callers act as themselves, inside their own businesses. Server
  -- code (service role: no JWT subject) may act for any actor — the grant
  -- check below still decides whether that actor may move stages.
  if (select auth.uid()) is not null then
    if not exists (
      select 1 from public.actors a
      where a.id = p_moved_by
        and a.user_id = (select auth.uid())
        and a.archived_at is null
    ) then
      raise exception 'moved_by must be the calling user''s own actor';
    end if;
    if not exists (
      select 1 from public.memberships m
      where m.user_id = (select auth.uid())
        and m.business_id = v_business
        and m.archived_at is null
    ) then
      raise exception 'Caller is not a member of this business';
    end if;
  end if;

  select s.is_terminal, s.terminal_outcome
  into v_terminal, v_outcome
  from public.stage_definitions s
  where s.id = p_to_stage
    and s.engagement_type_id = v_type
    and s.archived_at is null;
  if v_terminal is null then
    raise exception 'Stage % does not belong to this engagement''s type', p_to_stage;
  end if;

  -- The grant check lives on stage_history's trigger (0015): an actor
  -- without enquiries execute aborts the whole transaction right here —
  -- the engagement is left untouched.
  insert into public.stage_history (business_id, engagement_id, from_stage, to_stage, moved_at, moved_by)
  values (v_business, p_engagement, v_from, p_to_stage, p_moved_at, p_moved_by)
  returning id into v_history;

  update public.engagements
  set stage_id = p_to_stage,
      stage_entered_at = p_moved_at,
      outcome = case when v_terminal then v_outcome else outcome end,
      outcome_at = case when v_terminal then p_moved_at else outcome_at end
  where id = p_engagement;

  return v_history;
end;
$$;

revoke execute on function public.move_engagement_stage(uuid, uuid, uuid, timestamptz) from public;
grant execute on function public.move_engagement_stage(uuid, uuid, uuid, timestamptz) to authenticated, service_role;
