-- 0021: the send pipeline door + Meta inbound idempotency (Session 10).
--
-- Decision 16 promised this moment: the send session inherits a LOCKED door,
-- not a gap. 0017 revoked direct UPDATE of communications.status from every
-- API role; the only lawful ways a stamped message becomes SENT (or visibly
-- FAILED) are the two service-only pipeline functions below. APPROVED ≠ SENT
-- becomes a real distinction with real failure states — a failed send is a
-- visible status and a ledger event (app layer, via emitEvent), never a
-- silent drop.
--
-- Also here: meta_webhook_events — idempotency on Meta's leadgen id (the
-- Session 9 stripe_events pattern: signature verified before parsing in the
-- route, replay changes nothing, rejections leave a mark) — and the readiness
-- pre-flight extended with the WhatsApp session-window rule.
--
-- Standing principle: anything that must be true is enforced in the
-- database; the app being well-behaved is not a control.

-- ---------------------------------------------------------------------------
-- The send door. Service-only (a signed-in browser session is refused — the
-- 0019 assert_engine_caller pattern): dispatch is a trusted server act, and
-- every structural rule still fires inside the UPDATE — the 0008 human-stamp
-- trigger (sent requires a human approved_by_actor_id) and the 0017
-- readiness pre-flight (consent can lapse between stamp and dispatch; the
-- transition into 'sent' re-runs the checks).
-- ---------------------------------------------------------------------------
create or replace function public.mark_communication_sent(
  p_comm uuid,
  p_provider text,
  p_provider_message_id text default null
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
begin
  perform private.assert_engine_caller();
  if p_provider is null or btrim(p_provider) = '' then
    raise exception 'mark_communication_sent requires the provider name — the ledger must say who carried the message';
  end if;

  select c.status, c.direction into v
  from public.communications c
  where c.id = p_comm and c.archived_at is null
  for update;
  if not found then
    raise exception 'Communication % not found (or archived)', p_comm;
  end if;
  if v.direction <> 'outbound' then
    raise exception 'Only outbound messages pass through the send pipeline';
  end if;
  if v.status <> 'approved' then
    raise exception 'Only an APPROVED communication can be marked sent — % is "%" (approved ≠ sent is the pipeline distinction)', p_comm, v.status;
  end if;

  update public.communications
  set status = 'sent',
      occurred_at = now(),
      external_refs = external_refs || jsonb_build_array(jsonb_build_object(
        'system', p_provider,
        'external_id', p_provider_message_id,
        'synced_at', now()
      ))
  where id = p_comm;
  return p_comm;
end;
$$;

-- The visible failure state. Only a provider REFUSAL lands here (transient
-- transport errors stay 'approved' and retry on the next tick — the app
-- layer's distinction); the reason is recorded on the row and, via
-- emitEvent in the app layer, on The Record.
create or replace function public.mark_communication_send_failed(
  p_comm uuid,
  p_provider text,
  p_reason text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
begin
  perform private.assert_engine_caller();
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A failed send requires a reason — a silent drop is the exact failure this pipeline forbids';
  end if;

  select c.status, c.direction into v
  from public.communications c
  where c.id = p_comm and c.archived_at is null
  for update;
  if not found then
    raise exception 'Communication % not found (or archived)', p_comm;
  end if;
  if v.direction <> 'outbound' then
    raise exception 'Only outbound messages pass through the send pipeline';
  end if;
  if v.status <> 'approved' then
    raise exception 'Only an APPROVED communication can fail dispatch — % is "%"', p_comm, v.status;
  end if;

  update public.communications
  set status = 'failed',
      attributes = attributes || jsonb_build_object('send_failure', jsonb_build_object(
        'provider', p_provider,
        'reason', btrim(p_reason),
        'failed_at', now()
      ))
  where id = p_comm;
  return p_comm;
end;
$$;

revoke execute on function public.mark_communication_sent(uuid, text, text) from public;
revoke execute on function public.mark_communication_send_failed(uuid, text, text) from public;
grant execute on function public.mark_communication_sent(uuid, text, text) to service_role;
grant execute on function public.mark_communication_send_failed(uuid, text, text) to service_role;

-- The dispatcher's working set: stamped messages awaiting carriage.
create index communications_approved_idx on public.communications (business_id, scheduled_for)
  where status = 'approved' and direction = 'outbound' and archived_at is null;

-- ---------------------------------------------------------------------------
-- meta_webhook_events — inbound idempotency on Meta's leadgen id (the
-- stripe_events pattern, 0020). A webhook replay hits the unique index and
-- changes nothing; a signature rejection leaves a mark under a synthetic id.
-- JUDGMENT: platform infrastructure, not tenant data — no business envelope
-- (the 0018 allowed_emails / 0020 stripe_events precedent); the business is
-- resolved during processing and recorded in `outcome`. RLS on with no
-- policies: service-role only — no signed-in user has any business reading
-- raw provider payloads.
-- ---------------------------------------------------------------------------
create table public.meta_webhook_events (
  id uuid primary key default public.uuid_generate_v7(),
  leadgen_id text not null,
  page_id text,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  outcome text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index meta_webhook_events_leadgen_id_uniq on public.meta_webhook_events (leadgen_id);

create trigger meta_webhook_events_set_updated_at
  before update on public.meta_webhook_events
  for each row execute function private.set_updated_at();

alter table public.meta_webhook_events enable row level security;

-- ---------------------------------------------------------------------------
-- Readiness pre-flight v2: the WhatsApp session-window rule joins the
-- deterministic check set (Spec 3 §6, decision 19's "everything checkable in
-- the database today" — the window is a communications-table fact).
--
-- WhatsApp Business platform law: outside a 24-hour customer-service window
-- (opened by the customer's last inbound message) only PRE-APPROVED TEMPLATE
-- messages are deliverable. A free-form WhatsApp draft with no inbound
-- inside the window is undeliverable — so approving it must be impossible,
-- not discouraged. Template messages (attributes.wa_template names the
-- Meta-approved template) pass regardless of the window.
-- JUDGMENT: the 24 hours is PROVIDER law, not a workflow timer — like the
-- 0019 claim lease (decision 44) it is not TIME_SCALE data and runs in real
-- time everywhere.
--
-- The function signature gains p_attributes (the draft's attributes carry
-- the template reference); forward-fix of the applied 0017: drop and
-- recreate, then re-point the two callers.
-- ---------------------------------------------------------------------------
drop function private.comm_preflight(uuid, uuid, public.comm_channel, text, uuid);

create or replace function private.comm_preflight(
  p_business uuid,
  p_contact uuid,
  p_channel public.comm_channel,
  p_body text,
  p_comm uuid,
  p_attributes jsonb default '{}'::jsonb
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
  -- here; message_templates (Spec 4 §3) use the same braces.
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

  -- WhatsApp session window (Session 10): a template message is deliverable
  -- any time; free-form needs the customer's inbound within a real 24h.
  if p_channel = 'whatsapp' then
    if coalesce(p_attributes -> 'wa_template' ->> 'name', '') <> '' then
      v_pass := true;
      v_detail := 'Approved template message — deliverable outside the session window';
    elsif p_contact is null then
      v_pass := false;
      v_detail := 'No contact is linked to this message — the session window cannot be checked';
    else
      v_pass := exists (
        select 1
        from public.communications c
        join public.comm_threads t on t.id = c.thread_id
        where c.business_id = p_business
          and c.channel = 'whatsapp'
          and c.direction = 'inbound'
          and c.archived_at is null
          and coalesce(c.contact_id, t.contact_id) = p_contact
          and c.occurred_at > now() - interval '24 hours'
      );
      v_detail := case when v_pass then null
                       else 'Outside the WhatsApp 24h session window and no approved template is set — WhatsApp will not deliver free-form messages to this contact' end;
    end if;
    v_all := v_all and v_pass;
    v_checks := v_checks || jsonb_build_object(
      'key', 'wa_session_window', 'label', 'WhatsApp session window or approved template', 'pass', v_pass, 'detail', v_detail);
  end if;

  return jsonb_build_object('pass', v_all, 'checks', v_checks);
end;
$$;

-- Public wrapper re-pointed at the six-argument check.
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
  select c.business_id, c.channel, c.direction, c.body, c.attributes,
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
  return private.comm_preflight(v.business_id, v.contact_id, v.channel, v.body, p_comm, v.attributes);
end;
$$;

-- Trigger re-pointed: the row's own attributes travel into the check (at
-- insert time the row is not yet visible to lookups — NEW carries the truth).
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

  v_result := private.comm_preflight(new.business_id, v_contact, new.channel, new.body, new.id, new.attributes);
  if not (v_result ->> 'pass')::boolean then
    select string_agg(c ->> 'detail', '; ') into v_failures
    from jsonb_array_elements(v_result -> 'checks') c
    where not (c ->> 'pass')::boolean;
    raise exception 'Blocked by readiness pre-flight: %. The Approve control must be earned — fix the failure, then stamp.', v_failures;
  end if;
  return new;
end;
$$;

revoke execute on function public.preflight_communication(uuid) from public;
grant execute on function public.preflight_communication(uuid) to authenticated, service_role;
