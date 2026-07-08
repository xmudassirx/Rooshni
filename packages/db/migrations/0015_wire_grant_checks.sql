-- 0015: grant enforcement wired into every path that exists so far (Spec 3
-- §4 access interplay). The Session 1 human-stamp triggers answer "is the
-- approver human?"; these answer "does the actor hold the tool at all?".
-- Deny gracefully, never silently (§2.3): every refusal names the missing
-- grant and the way forward.

-- ---------------------------------------------------------------------------
-- Outbound communications: the drafter needs comms.<channel> (draft access
-- for drafts, execute to submit into the queue and beyond); the approver
-- additionally needs approvals.comms — approving is itself a tool (§4).
-- ---------------------------------------------------------------------------
create or replace function private.enforce_comm_grants()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tool text;
  v_actor uuid;
  v_needed public.grant_access;
begin
  if new.direction <> 'outbound' then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.status = old.status
     and new.approved_by_actor_id is not distinct from old.approved_by_actor_id then
    return new;
  end if;

  v_tool := 'comms.' || new.channel::text;
  if not exists (
    select 1 from public.tools t where t.key = v_tool and t.archived_at is null
  ) then
    raise exception 'No tool "%" is registered — this channel cannot carry outbound messages', v_tool;
  end if;

  v_actor := coalesce(new.drafted_by_actor_id, new.created_by);
  v_needed := case when new.status = 'draft'
                   then 'draft'::public.grant_access
                   else 'execute'::public.grant_access end;
  if not private.consume_grant(v_actor, new.business_id, v_tool, v_needed, new.engagement_id) then
    raise exception 'Actor % does not hold % (%) for this business — grant it, or tell us how you''d like to proceed', v_actor, v_tool, v_needed;
  end if;

  if new.approved_by_actor_id is not null
     and new.status in ('approved', 'sent', 'delivered', 'read') then
    if not private.consume_grant(new.approved_by_actor_id, new.business_id, 'approvals.comms', 'execute', new.engagement_id) then
      raise exception 'Approver % does not hold approvals.comms (execute) — approving is itself a tool', new.approved_by_actor_id;
    end if;
  end if;

  return new;
end;
$$;

create trigger communications_grant_check
  before insert or update on public.communications
  for each row execute function private.enforce_comm_grants();

-- ---------------------------------------------------------------------------
-- Content publishing: the publisher must hold approvals.content (execute) on
-- top of the Session 1 human check. Drafting stays ungated in Phase 1 (notes
-- are Level 1 and carry no Phase 1 tool).
-- ---------------------------------------------------------------------------
create or replace function private.enforce_content_publish_grant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state = 'published'
     and (tg_op = 'INSERT' or old.state is distinct from new.state)
     and new.published_by_actor_id is not null then
    if not private.consume_grant(new.published_by_actor_id, new.business_id, 'approvals.content', 'execute') then
      raise exception 'Publisher % does not hold approvals.content (execute) — publishing needs the approvals grant', new.published_by_actor_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger content_items_publish_grant
  before insert or update on public.content_items
  for each row execute function private.enforce_content_publish_grant();

-- ---------------------------------------------------------------------------
-- Level 2 (safe execute) inside the walls: creating contacts, engagements,
-- stage moves and tasks all require the enquiries tool at execute. The actor
-- column and optional engagement-scope column arrive as trigger arguments.
-- ---------------------------------------------------------------------------
create or replace function private.enforce_level2_grant()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_actor uuid := (v_row ->> tg_argv[0])::uuid;
  v_engagement uuid := case when tg_nargs > 1 then nullif(v_row ->> tg_argv[1], '')::uuid end;
begin
  if not private.consume_grant(v_actor, new.business_id, 'enquiries', 'execute', v_engagement) then
    raise exception 'Actor % does not hold enquiries (execute) for this business — creating or moving work is Level 2; grant it, or tell us how you''d like to proceed', v_actor;
  end if;
  return new;
end;
$$;

create trigger contacts_enquiries_grant
  before insert on public.contacts
  for each row execute function private.enforce_level2_grant('created_by');
create trigger engagements_enquiries_grant
  before insert on public.engagements
  for each row execute function private.enforce_level2_grant('created_by', 'id');
create trigger stage_history_enquiries_grant
  before insert on public.stage_history
  for each row execute function private.enforce_level2_grant('moved_by', 'engagement_id');
create trigger tasks_enquiries_grant
  before insert on public.tasks
  for each row execute function private.enforce_level2_grant('created_by', 'engagement_id');
