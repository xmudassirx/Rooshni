-- 0040: RETRY for stamped-but-failed sends (defect-pair hotfix, 2 Aug 2026,
-- item 2 — founder-ruled: "it gains RETRY (same body, same stamp — WYSIWYS
-- holds, transport re-attempts; evented communication.send_retried with
-- actor). Re-drafting is never required to recover from a transport
-- failure.")
--
-- A provider refusal lands the row at status 'failed' with the reason in
-- attributes.send_failure (0021). This door moves failed -> approved so the
-- dispatcher re-carries the SAME words under the SAME stamp:
--   * approved_by_actor_id is untouched — the original human stamp stands
--     (asserted below; the 0008 human-approval trigger re-verifies it on the
--     transition regardless);
--   * the body is untouched — WYSIWYS holds, the approved words re-attempt;
--   * the readiness pre-flight RE-RUNS structurally (the 0017/0026 trigger
--     fires on every transition into 'approved') — a retry that is no
--     longer deliverable (e.g. an expired WhatsApp window) is refused by
--     the database with the failure named, never silently re-queued;
--   * attributes.send_failure REMAINS on the row — it did fail once, and
--     the record keeps saying so; status is the render truth.
--
-- Authority: a HUMAN stamp-holder of this business (owner, or
-- approvals.comms execute — the decision 18 block, as 0039): re-attempting
-- carriage of a stamped message is exercising stamp authority over its
-- delivery, not a new approval. The ledger line
-- (communication.send_retried, the human actor) is emitted app-side via
-- emitEvent() — law 11: SQL never writes the ledger.

create or replace function public.retry_failed_communication(p_comm uuid, p_actor uuid)
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
  select c.business_id, c.status, c.engagement_id, c.approved_by_actor_id
  into v
  from public.communications c
  where c.id = p_comm and c.archived_at is null
  for update;
  if not found then
    raise exception 'Communication % not found (or archived)', p_comm;
  end if;

  perform private.assert_pipeline_caller(p_actor, v.business_id);

  if v.status <> 'failed' then
    raise exception 'Only a FAILED communication can be retried — % is "%"', p_comm, v.status;
  end if;
  if v.approved_by_actor_id is null then
    -- Structurally unreachable (only approved rows can fail, 0021), but the
    -- retry's promise is "same stamp" — assert it rather than assume it.
    raise exception 'Communication % carries no stamp to retry under — a failed row must keep its approver', p_comm;
  end if;

  select a.actor_type into v_type from public.actors a where a.id = p_actor;
  if v_type is distinct from 'human' then
    raise exception 'Retrying a failed send is a HUMAN act — the stamp''s delivery is stamp authority';
  end if;
  if not private.is_business_owner_actor(p_actor, v.business_id)
     and not private.consume_grant(p_actor, v.business_id, 'approvals.comms', 'execute', v.engagement_id) then
    raise exception 'Actor % does not hold approvals.comms (execute) — retrying a stamped send is exercising stamp authority', p_actor;
  end if;

  -- failed -> approved: the dispatcher's working set takes the row back.
  -- The 0008 human-stamp and 0017/0026 pre-flight triggers fire inside this
  -- UPDATE — the retry re-earns the gate, it does not bypass it. The row
  -- additionally records the retry beside the failure it answers.
  update public.communications
  set status = 'approved',
      scheduled_for = null,
      attributes = coalesce(attributes, '{}'::jsonb)
        || jsonb_build_object(
             'send_retry',
             jsonb_build_object('by_actor_id', p_actor, 'at', now())
           )
  where id = p_comm;
  return p_comm;
end;
$$;

grant execute on function public.retry_failed_communication(uuid, uuid) to authenticated, service_role;
