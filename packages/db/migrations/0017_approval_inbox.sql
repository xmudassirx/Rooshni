-- 0017: the Approval Inbox (Spec 3 §6, decisions 8 and 11; Spec 4 §2.3).
--
-- The inbox is a VIEW over pending states — communications and content in
-- pending_approval, tasks awaiting approval — never a separate store. The
-- Approve control must be earned: deterministic readiness pre-flight runs
-- before any transition into approved/sent, so approving broken things is
-- impossible, not discouraged. Approve and reject are gated Level 3 acts
-- through a closed pipeline, following the stage-door precedent (0016):
-- status and the approval identity move only through these functions.
--
-- Standing principle: anything that must be true is enforced in the
-- database; the app being well-behaved is not a control.

-- ---------------------------------------------------------------------------
-- Rejection is recorded on the row as well as the ledger (the reason also
-- travels to events as communication.rejected, via emitEvent in the app
-- layer). All-or-none: a rejection without a reason cannot exist.
-- ---------------------------------------------------------------------------
alter table public.communications
  add column rejected_at timestamptz,
  add column rejected_by_actor_id uuid references public.actors (id),
  add column rejection_reason text,
  add constraint communications_rejection_complete check (
    (rejected_at is null and rejected_by_actor_id is null and rejection_reason is null)
    or (rejected_at is not null and rejected_by_actor_id is not null
        and rejection_reason is not null and btrim(rejection_reason) <> '')
  );

-- ---------------------------------------------------------------------------
-- Readiness pre-flight (Spec 3 §6, decision 11) — every check that is
-- deterministically decidable inside the database today: body present, no
-- unresolved template variables, per-channel consent on file, and a message
-- that references an attachment must actually carry one. Link resolution and
-- no-go/standards compliance need the app layer and join later.
-- ---------------------------------------------------------------------------
create or replace function private.comm_preflight(
  p_business uuid,
  p_contact uuid,
  p_channel public.comm_channel,
  p_body text,
  p_comm uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_checks jsonb := '[]'::jsonb;
  v_all boolean := true;
  v_pass boolean;
  v_detail text;
  v_consent_channel public.contact_channel_type;
begin
  -- Body present: there must be something to send.
  v_pass := p_body is not null and btrim(p_body) <> '';
  v_detail := case when v_pass then null
                   else 'The message body is empty — there is nothing to send' end;
  v_all := v_all and v_pass;
  v_checks := v_checks || jsonb_build_object(
    'key', 'body', 'label', 'Message body present', 'pass', v_pass, 'detail', v_detail);

  -- No unresolved template variables ({{…}}). The variable syntax is pinned
  -- here; message_templates (Spec 4 §3) use the same braces when they land.
  v_pass := p_body is null or (p_body !~ '\{\{' and p_body !~ '\}\}');
  v_detail := case when v_pass then null
                   else 'Unresolved template variables remain in the body — ask the drafter to fill them' end;
  v_all := v_all and v_pass;
  v_checks := v_checks || jsonb_build_object(
    'key', 'placeholders', 'label', 'No unresolved template variables', 'pass', v_pass, 'detail', v_detail);

  -- Consent is legally per channel (Spec 1 §4.1): the destination contact
  -- must hold a live, consented channel of the right type.
  v_consent_channel := case p_channel
    when 'email' then 'email'::public.contact_channel_type
    when 'whatsapp' then 'whatsapp'::public.contact_channel_type
    when 'sms' then 'phone'::public.contact_channel_type
    when 'call' then 'phone'::public.contact_channel_type
    else null
  end;
  if v_consent_channel is null then
    v_pass := true;
    v_detail := 'Consent does not apply to this channel';
  elsif p_contact is null then
    v_pass := false;
    v_detail := 'No contact is linked to this message — consent cannot be checked';
  else
    v_pass := exists (
      select 1 from public.contact_channels ch
      where ch.business_id = p_business
        and ch.contact_id = p_contact
        and ch.channel = v_consent_channel
        and ch.archived_at is null
        and (coalesce((ch.consent ->> 'transactional')::boolean, false)
             or coalesce((ch.consent ->> 'marketing')::boolean, false))
    );
    v_detail := case when v_pass then null
                     else format('No consented %s channel is on file for this contact', v_consent_channel) end;
  end if;
  v_all := v_all and v_pass;
  v_checks := v_checks || jsonb_build_object(
    'key', 'consent', 'label', 'Channel consent held', 'pass', v_pass, 'detail', v_detail);

  -- A letter that says "please find attached" with nothing attached is the
  -- founding failure this rule forbids (Spec 3 §6 origin story).
  if p_body is not null and p_body ~* '\m(attach|enclos)' then
    v_pass := p_comm is not null and exists (
      select 1 from public.file_links fl
      where fl.entity_type = 'communication'
        and fl.entity_id = p_comm
        and fl.role = 'attachment'
    );
    v_detail := case when v_pass then null
                     else 'The message references an attachment but none is attached — ask the drafter to attach it' end;
  else
    v_pass := true;
    v_detail := null;
  end if;
  v_all := v_all and v_pass;
  v_checks := v_checks || jsonb_build_object(
    'key', 'attachment', 'label', 'Referenced attachments present', 'pass', v_pass, 'detail', v_detail);

  return jsonb_build_object('pass', v_all, 'checks', v_checks);
end;
$$;

-- Public wrapper: the checklist for one message, as shown on its inbox card.
create or replace function public.preflight_communication(p_comm uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v record;
begin
  select c.business_id, c.channel, c.direction, c.body,
         coalesce(c.contact_id, t.contact_id) as contact_id
  into v
  from public.communications c
  join public.comm_threads t on t.id = c.thread_id
  where c.id = p_comm;
  if not found then
    raise exception 'Communication % not found', p_comm;
  end if;
  if (select auth.uid()) is not null and not exists (
    select 1 from public.memberships m
    where m.user_id = (select auth.uid())
      and m.business_id = v.business_id
      and m.archived_at is null
  ) then
    raise exception 'Caller is not a member of this business';
  end if;
  if v.direction <> 'outbound' then
    return jsonb_build_object('pass', true, 'checks', '[]'::jsonb);
  end if;
  return private.comm_preflight(v.business_id, v.contact_id, v.channel, v.body, p_comm);
end;
$$;

-- Structural enforcement: any transition into approved/sent re-runs the
-- checks (consent can lapse between stamp and dispatch). Insert-at-approved
-- by an authorised human stays legal — and passes through this same gate.
create or replace function private.enforce_comm_preflight()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact uuid;
  v_result jsonb;
  v_failures text;
begin
  if new.direction <> 'outbound' or new.status not in ('approved', 'sent') then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = new.status then
    return new;
  end if;

  select coalesce(new.contact_id, t.contact_id) into v_contact
  from public.comm_threads t where t.id = new.thread_id;

  v_result := private.comm_preflight(new.business_id, v_contact, new.channel, new.body, new.id);
  if not (v_result ->> 'pass')::boolean then
    select string_agg(c ->> 'detail', '; ') into v_failures
    from jsonb_array_elements(v_result -> 'checks') c
    where not (c ->> 'pass')::boolean;
    raise exception 'Blocked by readiness pre-flight: %. The Approve control must be earned — fix the failure, then stamp.', v_failures;
  end if;
  return new;
end;
$$;

create trigger communications_preflight
  before insert or update on public.communications
  for each row execute function private.enforce_comm_preflight();

-- ---------------------------------------------------------------------------
-- Close the approval door (the 0016 stage-door precedent). Postgres column
-- privileges are additive: revoke table-wide UPDATE, re-grant everything
-- except status, the approval identity and the rejection record — those move
-- only through the pipeline functions below. Consequence, on the record: the
-- send pipeline session inherits a locked door and must add its own
-- mark-as-sent function; it cannot flip status directly.
-- ---------------------------------------------------------------------------
revoke update on public.communications from anon, authenticated, service_role;
grant update (
  thread_id, contact_id, engagement_id, channel, body, body_format,
  drafted_by_actor_id, approval_event_id, scheduled_for, occurred_at,
  duration_seconds, transcript, attributes, external_refs, archived_at
) on public.communications to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The pipeline. Signed-in callers act only as their own actor within their
-- own business; server code (service role: no JWT subject) may act for any
-- actor — the triggers (grants, human stamp, pre-flight) still decide.
-- ---------------------------------------------------------------------------
create or replace function private.assert_pipeline_caller(p_actor uuid, p_business uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    return;
  end if;
  if not exists (
    select 1 from public.actors a
    where a.id = p_actor
      and a.user_id = (select auth.uid())
      and a.archived_at is null
  ) then
    raise exception 'The acting actor must be the calling user''s own actor';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.user_id = (select auth.uid())
      and m.business_id = p_business
      and m.archived_at is null
  ) then
    raise exception 'Caller is not a member of this business';
  end if;
end;
$$;

-- Submission is the drafter's act (Spec 3 §4: execute = submit Level 3
-- actions into the approval queue). The grant check on the status change
-- consumes the drafter's comms.<channel> execute.
create or replace function public.submit_communication(p_comm uuid, p_actor uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
begin
  select c.business_id, c.status, c.direction,
         coalesce(c.drafted_by_actor_id, c.created_by) as drafter
  into v
  from public.communications c
  where c.id = p_comm and c.archived_at is null
  for update;
  if not found then
    raise exception 'Communication % not found (or archived)', p_comm;
  end if;

  perform private.assert_pipeline_caller(p_actor, v.business_id);

  if v.direction <> 'outbound' then
    raise exception 'Only outbound messages pass through the approval queue';
  end if;
  if p_actor is distinct from v.drafter then
    raise exception 'Submission is the drafter''s act — % did not draft this message', p_actor;
  end if;
  if v.status <> 'draft' then
    raise exception 'Only drafts can be submitted for approval — communication % is "%"', p_comm, v.status;
  end if;

  update public.communications set status = 'pending_approval' where id = p_comm;
  return p_comm;
end;
$$;

-- The stamp. Every structural rule fires inside the update: the approver
-- must be human (0008), must hold approvals.comms execute (0015), and
-- pre-flight must be green (above). A stale rejection record is cleared —
-- its history is on the ledger.
create or replace function public.approve_communication(p_comm uuid, p_approver uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
begin
  select c.business_id, c.status
  into v
  from public.communications c
  where c.id = p_comm and c.archived_at is null
  for update;
  if not found then
    raise exception 'Communication % not found (or archived)', p_comm;
  end if;

  perform private.assert_pipeline_caller(p_approver, v.business_id);

  if v.status <> 'pending_approval' then
    raise exception 'Only stamp-awaiting items can be approved — communication % is "%", not pending_approval', p_comm, v.status;
  end if;

  update public.communications
  set status = 'approved',
      approved_by_actor_id = p_approver,
      rejected_at = null,
      rejected_by_actor_id = null,
      rejection_reason = null
  where id = p_comm;
  return p_comm;
end;
$$;

-- The refusal. Rejection requires a reason (structurally — this is the only
-- path that can write the status change) and returns the item to the
-- drafter's queue as a draft. Refusing the stamp is exercising stamp
-- authority: human + approvals.comms execute, or the owner.
create or replace function public.reject_communication(p_comm uuid, p_rejected_by uuid, p_reason text)
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
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'Rejection requires a reason — it is recorded for the drafter and the ledger';
  end if;

  select c.business_id, c.status, c.engagement_id
  into v
  from public.communications c
  where c.id = p_comm and c.archived_at is null
  for update;
  if not found then
    raise exception 'Communication % not found (or archived)', p_comm;
  end if;

  perform private.assert_pipeline_caller(p_rejected_by, v.business_id);

  if v.status <> 'pending_approval' then
    raise exception 'Only stamp-awaiting items can be rejected — communication % is "%", not pending_approval', p_comm, v.status;
  end if;

  select a.actor_type into v_type from public.actors a where a.id = p_rejected_by;
  if v_type is distinct from 'human' then
    raise exception 'Communications are rejected only by a HUMAN actor — the stamp, and its refusal, are human acts';
  end if;
  if not private.is_business_owner_actor(p_rejected_by, v.business_id)
     and not private.consume_grant(p_rejected_by, v.business_id, 'approvals.comms', 'execute', v.engagement_id) then
    raise exception 'Rejecter % does not hold approvals.comms (execute) — refusing the stamp is exercising stamp authority', p_rejected_by;
  end if;

  update public.communications
  set status = 'draft',
      rejected_at = now(),
      rejected_by_actor_id = p_rejected_by,
      rejection_reason = btrim(p_reason)
  where id = p_comm;
  return p_comm;
end;
$$;

-- ---------------------------------------------------------------------------
-- The Approval Inbox view — one queue over the pending states everywhere.
-- security_invoker: the underlying tables' RLS decides what each caller
-- sees; the inbox is a view, not a place things live. Spend gates and grant
-- requests join this union when their pipelines exist.
-- ---------------------------------------------------------------------------
create view public.approval_inbox
with (security_invoker = true)
as
select
  'communication'::text as item_type,
  c.id as item_id,
  c.business_id,
  c.engagement_id,
  coalesce(c.contact_id, th.contact_id) as contact_id,
  c.channel::text as channel,
  coalesce(th.subject, left(c.body, 80)) as title,
  left(c.body, 200) as preview,
  coalesce(c.drafted_by_actor_id, c.created_by) as drafted_by_actor_id,
  a.display_name as drafted_by,
  a.actor_type::text as drafted_by_type,
  c.updated_at as awaiting_since,
  c.scheduled_for,
  p.pf as preflight,
  (p.pf ->> 'pass')::boolean as preflight_pass
from public.communications c
join public.comm_threads th on th.id = c.thread_id
left join public.actors a on a.id = coalesce(c.drafted_by_actor_id, c.created_by)
cross join lateral (select public.preflight_communication(c.id) as pf) p
where c.status = 'pending_approval' and c.archived_at is null
union all
select
  'content'::text,
  ci.id,
  ci.business_id,
  null::uuid,
  null::uuid,
  null::text,
  ci.title,
  ci.content_type,
  ci.created_by,
  a.display_name,
  a.actor_type::text,
  ci.updated_at,
  null::timestamptz,
  null::jsonb,
  null::boolean
from public.content_items ci
left join public.actors a on a.id = ci.created_by
where ci.state = 'pending_approval' and ci.archived_at is null
union all
select
  'task'::text,
  t.id,
  t.business_id,
  t.engagement_id,
  null::uuid,
  null::text,
  t.title,
  t.description,
  t.created_by,
  a.display_name,
  a.actor_type::text,
  t.updated_at,
  t.due_at,
  null::jsonb,
  null::boolean
from public.tasks t
left join public.actors a on a.id = t.created_by
where t.status = 'awaiting_approval' and t.archived_at is null
order by awaiting_since;

grant select on public.approval_inbox to authenticated, service_role;

-- Functions are callable by the API roles only — never by anon.
revoke execute on function public.preflight_communication(uuid) from public;
revoke execute on function public.submit_communication(uuid, uuid) from public;
revoke execute on function public.approve_communication(uuid, uuid) from public;
revoke execute on function public.reject_communication(uuid, uuid, text) from public;
grant execute on function public.preflight_communication(uuid) to authenticated, service_role;
grant execute on function public.submit_communication(uuid, uuid) to authenticated, service_role;
grant execute on function public.approve_communication(uuid, uuid) to authenticated, service_role;
grant execute on function public.reject_communication(uuid, uuid, text) to authenticated, service_role;
