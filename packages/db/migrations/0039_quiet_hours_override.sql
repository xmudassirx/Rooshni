-- 0039: the quiet-hours SEND NOW override (defect-trio hotfix, 2 Aug 2026,
-- item 2 — founder-ruled: "the held message gains a SEND NOW override for
-- stamp-holders (their stamp, their timing — the override is evented with
-- the actor, so choosing to message a client at 22:00 is a recorded human
-- decision)").
--
-- A message stamped inside quiet hours is held by the dispatcher
-- (scheduled_for = the window's end; communication.queued_quiet_hours on The
-- Record). This door lets a STAMP-HOLDER collapse the hold: scheduled_for
-- rewinds to now() and the row carries the override marker the dispatcher
-- honours (it must not re-hold the message it is being told to carry).
--
-- Enforced here, not in app code (the standing law): the caller must be a
-- HUMAN actor of this business holding stamp authority (owner, or
-- approvals.comms execute — the reject_communication authority block,
-- decision 18: refusing, editing, approving and now re-timing are the same
-- authority), and only an APPROVED row actually held for later qualifies.
-- The 0021 door is untouched: this function changes TIMING only, never
-- status — approved -> sent still moves solely through
-- mark_communication_sent with every trigger re-running inside it.
--
-- The ledger line (communication.quiet_hours_overridden, the human actor)
-- is emitted app-side via emitEvent() — law 11: SQL never writes the ledger.

create or replace function public.override_quiet_hours_hold(p_comm uuid, p_actor uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
  v_type public.actor_type;
begin
  select c.business_id, c.status, c.engagement_id, c.scheduled_for
  into v
  from public.communications c
  where c.id = p_comm and c.archived_at is null
  for update;
  if not found then
    raise exception 'Communication % not found (or archived)', p_comm;
  end if;

  perform private.assert_pipeline_caller(p_actor, v.business_id);

  if v.status <> 'approved' or v.scheduled_for is null or v.scheduled_for <= now() then
    raise exception 'Only an approved message held for later can be sent now — communication % is not held', p_comm;
  end if;

  select a.actor_type into v_type from public.actors a where a.id = p_actor;
  if v_type is distinct from 'human' then
    raise exception 'The quiet-hours override is a HUMAN act — their stamp, their timing';
  end if;
  if not private.is_business_owner_actor(p_actor, v.business_id)
     and not private.consume_grant(p_actor, v.business_id, 'approvals.comms', 'execute', v.engagement_id) then
    raise exception 'Actor % does not hold approvals.comms (execute) — re-timing a held message is exercising stamp authority', p_actor;
  end if;

  -- JUDGMENT: the override marker rides attributes (the plain_body /
  -- wa_template precedent) rather than new columns — the append-only ledger
  -- event is the audit truth; the marker is the dispatcher's mechanical
  -- "do not re-hold" flag, carrying who and when for the row's own story.
  update public.communications
  set scheduled_for = now(),
      attributes = coalesce(attributes, '{}'::jsonb)
        || jsonb_build_object(
             'quiet_hours_override',
             jsonb_build_object('by_actor_id', p_actor, 'at', now())
           )
  where id = p_comm;
  return p_comm;
end;
$$;

grant execute on function public.override_quiet_hours_hold(uuid, uuid) to authenticated, service_role;
