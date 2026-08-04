-- 0043: the attachment-honesty pre-flight, mismatch named (Session 27,
-- D159 — founder-ruled 2 Aug 2026, quoted in DECISIONS.md entry 159).
--
-- The ruling: "a draft body referencing an attachment ('attached',
-- 'enclosed', 'attachment' pattern register) while the communication
-- carries no attachment FAILS pre-flight with the mismatch named. …
-- Attachment-present-but-unmentioned is fine."
--
-- The decision-19 check has refused reference-without-attachment since
-- 0017 (retained through 0026 and 0032); what it never did was NAME the
-- mismatch — the failure said "an attachment" without quoting the phrase
-- the body actually used. This re-issue (fix-forward, same signature — the
-- 0026 wrapper and trigger keep pointing here) quotes the matched register
-- phrase in the failure detail, and widens the register to the ruling's
-- pattern set (attach…/enclos…/attachment — the word-stem match already
-- covers all three; the stem list is now stated in one place).
-- Everything else is verbatim 0032. The prompt-side half of D159 (the
-- generation prompts instructed to reference an attachment only when one
-- is attached) lives in packages/db/src/drafting.ts.
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
  v_att jsonb;
  v_att_file uuid;
  v_file public.files%rowtype;
  v_mismatch text;
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

  -- Session 19 (PR-i): DECLARED attachments — the file must EXIST, be LINKED
  -- to this communication, and sit within the ruled 8MB ceiling. A declared
  -- attachment that fails any of the three refuses the stamp with the reason.
  if jsonb_typeof(p_attributes -> 'attachments') = 'array'
     and jsonb_array_length(p_attributes -> 'attachments') > 0 then
    v_pass := true;
    v_detail := null;
    for v_att in select * from jsonb_array_elements(p_attributes -> 'attachments') loop
      v_att_file := null;
      begin
        v_att_file := (v_att ->> 'file_id')::uuid;
      exception when others then
        v_att_file := null;
      end;
      if v_att_file is null then
        v_pass := false;
        v_detail := 'A declared attachment carries no file id — the declaration is broken';
        exit;
      end if;
      select f.* into v_file from public.files f
      where f.id = v_att_file and f.archived_at is null;
      if not found then
        v_pass := false;
        v_detail := format('Declared attachment %s does not exist (or is archived) — nothing would be attached', v_att ->> 'filename');
        exit;
      end if;
      if v_file.size_bytes > 8 * 1024 * 1024 then
        v_pass := false;
        v_detail := format('Attachment "%s" is over the 8MB limit — a smaller file must be uploaded', v_file.filename);
        exit;
      end if;
      if p_comm is null or not exists (
        select 1 from public.file_links fl
        where fl.file_id = v_att_file
          and fl.entity_type = 'communication'
          and fl.entity_id = p_comm
          and fl.role = 'attachment'
      ) then
        v_pass := false;
        v_detail := format('Attachment "%s" is declared but not linked to this message', v_file.filename);
        exit;
      end if;
    end loop;
    v_all := v_all and v_pass;
    v_checks := v_checks || jsonb_build_object(
      'key', 'attachment', 'label', 'Declared attachments present and linked', 'pass', v_pass, 'detail', v_detail);
  -- D159 (Session 27): the attachment-honesty check, mismatch NAMED — a
  -- letter that says "please find attached" with nothing attached is the
  -- founding failure this rule forbids (Spec 3 §6 origin story). The
  -- register stems: attach…, enclos… (covering "attached", "attachment",
  -- "enclosed", "enclosure").
  elsif p_body is not null and p_body ~* '\m(attach|enclos)' then
    v_pass := p_comm is not null and exists (
      select 1 from public.file_links fl
      where fl.entity_type = 'communication'
        and fl.entity_id = p_comm
        and fl.role = 'attachment'
    );
    if v_pass then
      v_detail := null;
    else
      v_mismatch := coalesce(substring(p_body from '(?i)\m(attach\w*|enclos\w*)'), 'an attachment reference');
      v_detail := format('The body says "%s" but this message carries no attachment — the mismatch refuses the stamp', v_mismatch);
    end if;
    v_all := v_all and v_pass;
    v_checks := v_checks || jsonb_build_object(
      'key', 'attachment', 'label', 'Referenced attachments present', 'pass', v_pass, 'detail', v_detail);
  else
    v_checks := v_checks || jsonb_build_object(
      'key', 'attachment', 'label', 'Referenced attachments present', 'pass', true, 'detail', null);
  end if;

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
