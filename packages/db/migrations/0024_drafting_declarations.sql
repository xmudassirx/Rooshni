-- 0024: the drafting declarations (Session 15 — query-aware drafting;
-- founder pre-rulings PR-1 and PR-2, session prompt of 31 July 2026).
--
-- PR-1: knowledge entries are CONTENT, not a new table — content_items rows
-- of content_type `knowledge_entry`, category and visa route held as
-- DECLARED attributes (Spec 1 §2.3: every attributes key corresponds to a
-- field_definitions row). PR-2: the Meta form's answers persist on the
-- engagement at ingest as attributes.form_answers, declared the same way.
-- This migration DECLARES — vocab, field definitions, the retrieval index —
-- it creates no parallel store.
--
-- JUDGMENT: the declarations land as field_definitions rows on each
-- per-business INSTALL (field_definitions.template_id → templates, decision
-- 2), not as a template_definitions v4 re-issue — decision 79 pins "v3
-- applies by default" to the founder-signed document, and these rows are
-- install configuration the v3 doc already anticipates (§Knowledge pack
-- seed), not a change to the signed definition. activate_signup is re-issued
-- below (the 0022 fix-forward precedent, same signature) so future installs
-- carry the same declarations from birth.
--
-- JUDGMENT: the category and route vocabularies ride in
-- field_definitions.validation.allowed ({key, label} lists) — the 0003
-- validation jsonb exists for exactly this, the lists stay per-install
-- (firm-editable later without touching the platform definition), and the
-- Settings surface renders its options FROM the declaration, never from
-- hardcoded chrome. Route keys mirror the v3 §Knowledge pack seed list;
-- content.visa_route is the same declared vocabulary the enquiry rows use
-- (engagement.visa_route, installed by 0022).

-- ---------------------------------------------------------------------------
-- The declaration set, in one place — read by both the backfill insert below
-- and the re-issued activate_signup, so install-time and migration-time
-- declarations can never drift.
-- ---------------------------------------------------------------------------
create or replace function private.drafting_field_declarations()
returns table (entity text, key text, label text, data_type text, validation jsonb)
language sql
immutable
set search_path = ''
as $$
  select * from (values
    (
      'content', 'knowledge_category', 'Knowledge category', 'text',
      jsonb_build_object('allowed', jsonb_build_array(
        jsonb_build_object('key', 'service_description', 'label', 'Service descriptions (per visa route)'),
        jsonb_build_object('key', 'published_fees', 'label', 'Published fees'),
        jsonb_build_object('key', 'consultation_booking_policy', 'label', 'Consultation booking policy'),
        jsonb_build_object('key', 'tone_exemplar', 'label', 'Tone exemplars (approved past emails)'),
        jsonb_build_object('key', 'faq', 'label', 'FAQ')
      ))
    ),
    (
      'content', 'visa_route', 'Visa route', 'text',
      jsonb_build_object('allowed', jsonb_build_array(
        jsonb_build_object('key', 'skilled_worker', 'label', 'Skilled Worker'),
        jsonb_build_object('key', 'spouse_family', 'label', 'Spouse/Family'),
        jsonb_build_object('key', 'ilr', 'label', 'ILR'),
        jsonb_build_object('key', 'naturalisation', 'label', 'Naturalisation'),
        jsonb_build_object('key', 'student', 'label', 'Student'),
        jsonb_build_object('key', 'visitor', 'label', 'Visitor'),
        jsonb_build_object('key', 'euss', 'label', 'EUSS'),
        jsonb_build_object('key', 'asylum_human_rights', 'label', 'Asylum & Human Rights'),
        jsonb_build_object('key', 'appeals', 'label', 'Appeals')
      ))
    ),
    -- PR-2: the ordered Meta form answers, names verbatim —
    -- [{name, label, value}] — written at ingest, rendered in the Approval
    -- Inbox context-in-card through this declaration.
    (
      'engagement', 'form_answers', 'Form answers', 'json', '{}'::jsonb
    )
  ) as t (entity, key, label, data_type, validation)
$$;

-- Existing installs of the vertical (X Law, Jurists, the test tenants)
-- receive the declarations now; idempotent on the 0003 unique key.
insert into public.field_definitions (template_id, entity, key, label, data_type, validation)
select t.id, d.entity, d.key, d.label, d.data_type, d.validation
from public.templates t
cross join private.drafting_field_declarations() d
where t.vertical = 'uk_immigration_advisory'
  and t.archived_at is null
on conflict (template_id, entity, key) do nothing;

-- ---------------------------------------------------------------------------
-- Retrieval index (PR-1: "any index retrieval needs"). Task-scoped retrieval
-- reads PUBLISHED knowledge entries by category (and route) per business —
-- never the whole pack (LIGHT-OPERATING-DOCTRINE: assemble, never dump).
-- ---------------------------------------------------------------------------
create index content_items_knowledge_retrieval_idx
  on public.content_items (business_id, state, (attributes ->> 'knowledge_category'))
  where content_type = 'knowledge_entry' and archived_at is null;

-- ---------------------------------------------------------------------------
-- activate_signup re-issued (0022 fix-forward, same signature — the 0020
-- precedent): future installs declare the drafting fields at birth. The only
-- change from the 0022 issue is the drafting-declarations insert after the
-- definition's own field_definitions block; everything else is verbatim.
-- ---------------------------------------------------------------------------
create or replace function public.activate_signup(
  p_account uuid,
  p_owner_user_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_plan text default 'pilot_firm'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_acc public.accounts%rowtype;
  v_def public.template_definitions%rowtype;
  v_business uuid;
  v_template uuid;
  v_type uuid;
  v_owner_actor uuid;
  v_light_actor uuid;
  v_stripe_actor uuid;
  v_workflow_actor uuid;
  v_task uuid;
  v_task_ids jsonb := '{}'::jsonb;
  v_grant_ids jsonb := '{}'::jsonb;
  v_grant uuid;
  r record;
begin
  select * into v_acc from public.accounts where id = p_account for update;
  if not found then
    raise exception 'activate_signup: no account %', p_account;
  end if;

  -- Idempotency: an activated account activates exactly once.
  if v_acc.activated_at is not null then
    select b.id into v_business from public.businesses b where b.account_id = p_account limit 1;
    return jsonb_build_object('already_active', true, 'business_id', v_business);
  end if;

  if v_acc.signup_business_name is null or btrim(v_acc.signup_business_name) = ''
     or v_acc.signup_email is null then
    raise exception 'activate_signup: account % is missing signup fields', p_account;
  end if;

  -- The default vertical (decision 79: UK Immigration Advisory v3 applies by
  -- default; no template picker exists). Latest issued version wins.
  select * into v_def
  from public.template_definitions
  where key = 'uk_immigration_advisory' and archived_at is null
  order by version desc
  limit 1;
  if not found then
    raise exception 'activate_signup: no installable template definition — refusing to activate a template-less business';
  end if;

  update public.accounts set
    owner_user_id = p_owner_user_id,
    plan = p_plan,
    billing_status = 'active',
    activated_at = now(),
    stripe_customer_id = p_stripe_customer_id,
    stripe_subscription_id = p_stripe_subscription_id
  where id = p_account;

  insert into public.businesses (account_id, name, website_url)
  values (p_account, v_acc.signup_business_name, v_acc.signup_website_url)
  returning id into v_business;

  insert into public.actors (account_id, actor_type, display_name, user_id)
  values (p_account, 'human', v_acc.name, p_owner_user_id)
  returning id into v_owner_actor;

  insert into public.actors (account_id, actor_type, display_name)
  values (p_account, 'agent', 'Light')
  returning id into v_light_actor;

  insert into public.actors (account_id, actor_type, display_name)
  values (p_account, 'integration', 'Stripe')
  returning id into v_stripe_actor;

  -- The account's one workflow engine actor (decisions 46/93).
  insert into public.actors (account_id, actor_type, display_name)
  values (p_account, 'workflow', 'Workflow engine')
  returning id into v_workflow_actor;

  insert into public.memberships (user_id, business_id, role)
  values (p_owner_user_id, v_business, 'owner');

  -- The Google door: sign-in completes via the allowlist + Supabase's
  -- verified-email auto-linking (decisions 24/25; founder-ruled 17 Jul 2026).
  insert into public.allowed_emails (email, note)
  values (v_acc.signup_email, 'signup activation — account ' || p_account)
  on conflict (email) do nothing;

  -- ------------------------------------------------------------------
  -- Template installation — the definition becomes per-business rows.
  -- ------------------------------------------------------------------
  insert into public.templates (business_id, vertical, version, no_go_rules)
  values (v_business, v_def.key, v_def.version, coalesce(v_def.definition -> 'no_go_rules', '[]'::jsonb))
  returning id into v_template;

  update public.businesses set template_id = v_template where id = v_business;

  for r in select * from jsonb_to_recordset(v_def.definition -> 'engagement_types')
             as t (key text, label text, stages jsonb)
  loop
    insert into public.engagement_types (template_id, key, label)
    values (v_template, r.key, r.label)
    returning id into v_type;

    insert into public.stage_definitions
      (engagement_type_id, key, label, sort_order, is_terminal, terminal_outcome)
    select v_type, s.key, s.label, s.sort_order,
           s.terminal_outcome is not null,
           s.terminal_outcome::public.engagement_outcome
    from jsonb_to_recordset(r.stages)
      as s (key text, label text, sort_order int, terminal_outcome text);
  end loop;

  insert into public.field_definitions (template_id, entity, key, label, data_type)
  select v_template, f.entity, f.key, f.label, f.data_type
  from jsonb_to_recordset(v_def.definition -> 'field_definitions')
    as f (entity text, key text, label text, data_type text);

  -- Session 15 (PR-1/PR-2): the drafting declarations — knowledge-entry
  -- category + route vocab, and the engagement's form_answers — installed
  -- from birth, from the same single source the 0024 backfill used.
  insert into public.field_definitions (template_id, entity, key, label, data_type, validation)
  select v_template, d.entity, d.key, d.label, d.data_type, d.validation
  from private.drafting_field_declarations() d
  on conflict (template_id, entity, key) do nothing;

  insert into public.vocabulary (template_id, term_key, label)
  select v_template, v.term_key, v.label
  from jsonb_to_recordset(v_def.definition -> 'vocabulary')
    as v (term_key text, label text);

  -- Light's Phase 1 bundle (decision 6), granted by the owner at activation.
  for r in
    select * from (values
      ('enquiries'), ('comms.email'), ('comms.whatsapp')
    ) as t (tool)
  loop
    insert into public.grants
      (business_id, created_by, grantee_actor_id, tool, access, scope, duration, granted_by_actor_id, via)
    values
      (v_business, v_owner_actor, v_light_actor, r.tool, 'execute',
       jsonb_build_object('level', 'business', 'ref', v_business),
       'standing', v_owner_actor, 'dashboard')
    returning id into v_grant;
    v_grant_ids := v_grant_ids || jsonb_build_object(r.tool, v_grant);
  end loop;

  -- The engine actor's enquiries grant (the Session 6 bundle — runs, stage
  -- moves and the Contacted transition all consume it).
  insert into public.grants
    (business_id, created_by, grantee_actor_id, tool, access, scope, duration, granted_by_actor_id, via)
  values
    (v_business, v_owner_actor, v_workflow_actor, 'enquiries', 'execute',
     jsonb_build_object('level', 'business', 'ref', v_business),
     'standing', v_owner_actor, 'dashboard')
  returning id into v_grant;
  v_grant_ids := v_grant_ids || jsonb_build_object('enquiries.workflow_engine', v_grant);

  -- First Light rows (decision 82) — REAL task rows, one predicate row each,
  -- rendered FROM the template definition. created_by Light (it is Light's
  -- channel), assigned to the owner. No due_at (the 0020 ruling holds).
  for r in select * from jsonb_to_recordset(v_def.definition -> 'first_light_rows')
             as t (key text, title text, description text, optional boolean)
  loop
    insert into public.tasks
      (business_id, created_by, title, description, status, assignee_actor_id, attributes)
    values
      (v_business, v_light_actor, r.title, r.description, 'open', v_owner_actor,
       jsonb_build_object('first_light', true, 'predicate_key', r.key))
    returning id into v_task;

    insert into public.first_light_predicates
      (business_id, created_by, task_id, predicate_key, optional)
    values
      (v_business, v_light_actor, v_task, r.key, coalesce(r.optional, false));

    v_task_ids := v_task_ids || jsonb_build_object(r.key, v_task);
  end loop;

  return jsonb_build_object(
    'already_active', false,
    'business_id', v_business,
    'template_id', v_template,
    'owner_actor_id', v_owner_actor,
    'light_actor_id', v_light_actor,
    'stripe_actor_id', v_stripe_actor,
    'workflow_actor_id', v_workflow_actor,
    'grant_ids', v_grant_ids,
    'task_ids', v_task_ids
  );
end;
$$;

revoke all on function public.activate_signup(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.activate_signup(uuid, uuid, text, text, text) to service_role;
