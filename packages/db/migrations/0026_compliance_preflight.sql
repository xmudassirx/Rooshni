-- 0026: the compliance pre-flight goes real (Session 15 — query-aware
-- drafting; scope item 4, founder ruling C-2 of 31 July 2026).
--
-- The COMPLIANCE PENDING chip becomes an actual check recorded against the
-- no-go register (the v3 rules installed on templates.no_go_rules, 0022):
--   (a) deterministic heuristics — a pattern register for guarantee
--       language, outcome promises, Home Office timescale commitments, and
--       fee quotations beyond the firm's published amounts;
--   (b) the drafting model's own attestation, captured at generation.
-- Both are RECORDED on an append-only check row; the readiness pre-flight
-- (decision 19's machinery — one more check in the set) refuses the stamp
-- on a breach, on a missing check, on changed wording, or on a missing
-- attestation. Server-side, fail closed (decision 117): an unrunnable check
-- reads as pending/blocked, never green.
--
-- Founder ruling C-2 (31 July 2026, recorded verbatim for DECISIONS): "The
-- compliance requirement binds agent-drafted communications created after
-- the migration: heuristics + generation-time attestation both required for
-- green on those rows, fail closed. Human-authored communications
-- (including decision-21 insert-at-approved) and pre-migration drafts
-- remain under the existing deterministic check set — decision-21 behaviour
-- unchanged. … v3's no-go rules govern Light's words, not the firm's own;
-- the compliance gate binds the machine."

-- ---------------------------------------------------------------------------
-- Who the gate binds is a DATABASE fact, not app behaviour: a trigger stamps
-- compliance_required at insert from the drafter's actor type, and the stamp
-- is immutable thereafter. Pre-migration rows keep the column default
-- (false) — that IS the C-2 exemption, no timestamp bookkeeping needed. The
-- column is deliberately absent from the 0017 column-grant list, so no API
-- role can update it directly.
-- ---------------------------------------------------------------------------
alter table public.communications
  add column compliance_required boolean not null default false;

create or replace function private.comm_requires_compliance(p_drafter uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.actors a
    where a.id = p_drafter and a.actor_type = 'agent'
  )
$$;

create or replace function private.stamp_compliance_required()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.compliance_required :=
      private.comm_requires_compliance(coalesce(new.drafted_by_actor_id, new.created_by));
  else
    -- Immutable after birth — whatever code carries the write.
    new.compliance_required := old.compliance_required;
  end if;
  return new;
end;
$$;

create trigger communications_compliance_required_stamp
  before insert or update on public.communications
  for each row execute function private.stamp_compliance_required();

-- ---------------------------------------------------------------------------
-- The recorded check. Append-only (a check that ran is history), readable by
-- members, and writable ONLY through the runner function below — no
-- authenticated insert policy exists, so a browser can never record itself a
-- clean check. The row pins the EXACT body it screened: an edit invalidates
-- the check by construction (WYSIWYS — the stamp approves these words and
-- no others).
-- ---------------------------------------------------------------------------
create table public.communication_compliance_checks (
  -- The Spec 1 envelope.
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '[]'::jsonb,

  communication_id uuid not null references public.communications (id),
  -- The exact wording screened — compared verbatim at pre-flight.
  body text not null,
  result text not null,
  -- The no-go rule text the breach matched (named on the RED chip).
  rule_matched text,
  -- The deterministic findings, recorded whatever the result.
  heuristics jsonb not null,
  -- The drafting model's own attestation, captured at generation; null =
  -- absent (and absent never earns the tick on a bound row).
  attestation jsonb,

  constraint communication_compliance_checks_result check (result in ('clean', 'breach')),
  constraint communication_compliance_checks_breach_names_rule check (
    result <> 'breach' or rule_matched is not null
  )
);

create index communication_compliance_checks_business_id_idx
  on public.communication_compliance_checks (business_id);
-- The pre-flight's lookup: latest check per communication.
create index communication_compliance_checks_comm_idx
  on public.communication_compliance_checks (communication_id, created_at desc);

create trigger communication_compliance_checks_append_only
  before update or delete on public.communication_compliance_checks
  for each row execute function private.raise_append_only();

revoke update, delete on public.communication_compliance_checks from anon, authenticated, service_role;

alter table public.communication_compliance_checks enable row level security;

create policy communication_compliance_checks_select on public.communication_compliance_checks
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));
-- No insert policy for authenticated: the runner function is the only door.

-- ---------------------------------------------------------------------------
-- The deterministic heuristics — the pattern register, recorded per run.
--
-- JUDGMENT: the patterns implement v3 rules 1 and 3 (the four groups the
-- session prompt names: guarantee language, outcome promises, Home Office
-- timescale commitments, fee quotations); rules 2 and 4 are not
-- deterministically decidable from body text and are enforced in the
-- generation prompt + attestation (the other half of belt-and-braces).
-- Negated phrasings are masked FIRST so the lawful refusal — "we cannot
-- guarantee an outcome" — reads clean: the DoD's own proof case.
--
-- JUDGMENT: rule 3 reads "fees beyond the firm's published consultation
-- fee"; deterministically, which single amount IS the consultation fee
-- cannot be extracted from free text, so the check is: every £-amount in
-- the draft must appear in a PUBLISHED knowledge entry of category
-- published_fees or consultation_booking_policy — Light may only ever quote
-- amounts the firm has published; a human quoting anything else writes
-- their own message (C-2: the gate binds the machine).
-- ---------------------------------------------------------------------------
create or replace function private.no_go_heuristics(p_business uuid, p_body text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_text text := lower(coalesce(p_body, ''));
  v_masked text;
  v_matches jsonb := '[]'::jsonb;
  v_rules jsonb;
  v_rule_matched text := null;
  v_pattern record;
  v_amount text;
  v_allowed text[];
  v_found text[];
begin
  select t.no_go_rules into v_rules
  from public.businesses b
  join public.templates t on t.id = b.template_id
  where b.id = p_business;

  -- Mask negated guarantee/promise phrasing: the refusal is the lawful,
  -- wanted wording and must never read as a breach.
  v_masked := regexp_replace(
    v_text,
    '(cannot|can[''’]t|no|not|never|unable\s+to|won[''’]t|isn[''’]t|aren[''’]t|do\s+not|does\s+not|doesn[''’]t|couldn[''’]t|wouldn[''’]t|shouldn[''’]t)(\s+\S+){0,3}\s+(guarantee\S*|promise\S*|guaranteed)',
    ' [negated] ', 'g');

  -- Group A — guarantee language, outcome promises, Home Office timescale
  -- commitments (v3 rule 1, index 0).
  for v_pattern in
    select * from (values
      ('guarantee_language', '\mguarantee'),
      ('outcome_promise',    '\m(we|i)\s+(personally\s+)?promise'),
      ('outcome_promise',    '\mpromis(e|ed|ing)\s+(that\s+)?(you|your|the)\M'),
      ('outcome_assured',    '(your|the)\s+(visa|application|case|appeal)[^.!?]{0,40}\m(will|shall)\s+(definitely\s+|certainly\s+)?be\s+(granted|approved|successful)'),
      ('outcome_assured',    '100\s*%\s*(success|approval|approved|guaranteed?)'),
      ('outcome_assured',    '\m(certain|assured|confident)\s+(of|that)\s+(success|approval|a\s+grant)'),
      ('ho_timescale',       '(your|the)\s+(visa|application|decision|case)[^.!?]{0,50}\m(will|shall)[^.!?]{0,30}\m\d+\s*(working\s+|business\s+)?(day|week|month)'),
      ('ho_timescale',       '\mguaranteed?\s+(within|in)\s+\d+')
    ) as p (key, pattern)
  loop
    if v_masked ~* v_pattern.pattern then
      -- Wrap the whole pattern so [1] is the full matched fragment, not an
      -- inner group; the excerpt recorded is the fragment only, never the
      -- whole body (the check row already pins the body it screened).
      v_matches := v_matches || jsonb_build_object(
        'group', 'rule_1', 'key', v_pattern.key,
        'sample', (regexp_match(v_masked, '(' || v_pattern.pattern || ')', 'i'))[1]);
      v_rule_matched := coalesce(v_rule_matched,
        coalesce(v_rules ->> 0,
          'Light never states or implies a guarantee of visa success, application outcome, or Home Office timescales.'));
    end if;
  end loop;

  -- Group B — fee quotations (v3 rule 3, index 2): every amount Light
  -- quotes must be one the firm has published in the pack.
  select coalesce(array_agg(distinct replace(m[1], ',', '')), '{}'::text[]) into v_allowed
  from public.content_items ci,
       lateral regexp_matches(lower(ci.body::text), '£\s*(\d[\d,]*(\.\d\d)?)', 'g') m
  where ci.business_id = p_business
    and ci.content_type = 'knowledge_entry'
    and ci.state = 'published'
    and ci.archived_at is null
    and ci.attributes ->> 'knowledge_category' in ('published_fees', 'consultation_booking_policy');

  select coalesce(array_agg(distinct replace(m[1], ',', '')), '{}'::text[]) into v_found
  from regexp_matches(v_text, '£\s*(\d[\d,]*(\.\d\d)?)', 'g') m;

  foreach v_amount in array v_found loop
    if not (v_amount = any (v_allowed)) then
      v_matches := v_matches || jsonb_build_object(
        'group', 'rule_3', 'key', 'unpublished_fee', 'sample', '£' || v_amount);
      v_rule_matched := coalesce(v_rule_matched,
        coalesce(v_rules ->> 2,
          'Light never quotes fees beyond the firm''s published consultation fee without a stamp.'));
    end if;
  end loop;

  return jsonb_build_object(
    'breach', jsonb_array_length(v_matches) > 0,
    'matches', v_matches,
    'rule_matched', v_rule_matched
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- The runner — the only door into the check table. Service-only (the 0021
-- assert_engine_caller pattern): the drafting engine records the check at
-- generation with the model's attestation; the edit path re-runs it server-
-- side after a wording change (attestation carried forward — heuristics
-- re-screen the edited words; the attestation attests the generation).
-- ---------------------------------------------------------------------------
create or replace function public.run_compliance_check(
  p_comm uuid,
  p_actor uuid,
  p_attestation jsonb default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v record;
  v_heuristics jsonb;
  v_result text;
  v_rule text;
  v_row public.communication_compliance_checks%rowtype;
begin
  perform private.assert_engine_caller();

  select c.business_id, c.body into v
  from public.communications c
  where c.id = p_comm and c.archived_at is null;
  if not found then
    raise exception 'run_compliance_check: communication % not found (or archived)', p_comm;
  end if;
  if v.body is null or btrim(v.body) = '' then
    raise exception 'run_compliance_check: communication % has no body to screen', p_comm;
  end if;

  v_heuristics := private.no_go_heuristics(v.business_id, v.body);
  v_result := case when (v_heuristics ->> 'breach')::boolean then 'breach' else 'clean' end;
  v_rule := v_heuristics ->> 'rule_matched';

  insert into public.communication_compliance_checks
    (business_id, created_by, communication_id, body, result, rule_matched, heuristics, attestation)
  values
    (v.business_id, p_actor, p_comm, v.body, v_result, v_rule,
     v_heuristics, p_attestation)
  returning * into v_row;

  return jsonb_build_object(
    'id', v_row.id,
    'result', v_row.result,
    'rule_matched', v_row.rule_matched,
    'heuristics', v_row.heuristics,
    'attested', v_row.attestation is not null
  );
end;
$$;

revoke execute on function public.run_compliance_check(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.run_compliance_check(uuid, uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Readiness pre-flight v3: the compliance check joins the deterministic set
-- (decision 19 — one more check in the set). Signature gains
-- p_compliance_required; forward-fix of the applied 0021: drop and
-- recreate, then re-point the two callers (the 0021 pattern exactly).
--
-- The compliance entry carries an extra `state` field —
-- pending | stale | breach | unattested | clean — so the chip can render
-- PENDING (dashed, never green) apart from RED (breach, rule named).
-- Fail closed on every non-clean state (decision 117).
-- ---------------------------------------------------------------------------
drop function private.comm_preflight(uuid, uuid, public.comm_channel, text, uuid, jsonb);

create or replace function private.comm_preflight(
  p_business uuid,
  p_contact uuid,
  p_channel public.comm_channel,
  p_body text,
  p_comm uuid,
  p_attributes jsonb default '{}'::jsonb,
  p_compliance_required boolean default false
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
  v_check public.communication_compliance_checks%rowtype;
  v_state text;
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

  -- No-go compliance (Session 15, ruling C-2): binds agent-drafted rows
  -- created after 0026. Green requires a recorded check on EXACTLY this
  -- wording, clean heuristics, and a generation-time attestation — anything
  -- less fails closed (decision 117: pending/blocked, never green).
  if p_compliance_required then
    select cc.* into v_check
    from public.communication_compliance_checks cc
    where cc.communication_id = p_comm
    order by cc.created_at desc, cc.id desc
    limit 1;

    if not found then
      v_pass := false; v_state := 'pending';
      v_detail := 'The compliance check has not run for this draft — pending, never green';
    elsif v_check.body is distinct from p_body then
      v_pass := false; v_state := 'stale';
      v_detail := 'The wording changed after the last compliance check — the check must re-run on these exact words';
    elsif v_check.result = 'breach' then
      v_pass := false; v_state := 'breach';
      v_detail := format('No-go rule breached: %s', coalesce(v_check.rule_matched, 'rule matched'));
    elsif v_check.attestation is null then
      v_pass := false; v_state := 'unattested';
      v_detail := 'No generation-time attestation is recorded — heuristics alone never earn the tick';
    else
      v_pass := true; v_state := 'clean';
      v_detail := null;
    end if;
    v_all := v_all and v_pass;
    v_checks := v_checks || jsonb_build_object(
      'key', 'compliance', 'label', 'No-go compliance', 'pass', v_pass,
      'state', v_state, 'detail', v_detail);
  end if;

  return jsonb_build_object('pass', v_all, 'checks', v_checks);
end;
$$;

-- Public wrapper re-pointed at the seven-argument check.
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
         c.compliance_required,
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
  return private.comm_preflight(
    v.business_id, v.contact_id, v.channel, v.body, p_comm, v.attributes,
    v.compliance_required);
end;
$$;

-- Trigger re-pointed. On INSERT the row is not yet visible to lookups, so
-- requiredness is computed from NEW's drafter (the same rule the stamp
-- trigger writes); on UPDATE the immutable stored column is the truth.
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
  v_required boolean;
begin
  if new.direction <> 'outbound' or new.status not in ('approved', 'sent') then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = new.status then
    return new;
  end if;

  select coalesce(new.contact_id, t.contact_id) into v_contact
  from public.comm_threads t where t.id = new.thread_id;

  v_required := case when tg_op = 'INSERT'
    then private.comm_requires_compliance(coalesce(new.drafted_by_actor_id, new.created_by))
    else new.compliance_required end;

  v_result := private.comm_preflight(
    new.business_id, v_contact, new.channel, new.body, new.id, new.attributes,
    v_required);
  if not (v_result ->> 'pass')::boolean then
    select string_agg(c ->> 'detail', '; ') into v_failures
    from jsonb_array_elements(v_result -> 'checks') c
    where not (c ->> 'pass')::boolean;
    raise exception 'Blocked by readiness pre-flight: %. The Approve control must be earned — fix the failure, then stamp.', v_failures;
  end if;
  return new;
end;
$$;
