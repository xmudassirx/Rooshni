-- 0022: template installation + the Contacted transition law (Session 11 —
-- First Light; founder content docs/templates/uk-immigration-v3.md, session
-- prompt rulings of 24 July 2026).
--
-- What ships here, and why together (enforcement travels with the data):
--   * template_definitions — the platform store for installable vertical
--     templates ("template storage", named in scope). The UK Immigration
--     Advisory v3 definition lands as a row in this same migration, so a
--     zero-to-green check-local and a fresh live environment both carry it;
--   * activate_signup is REPLACED (0020 fix-forward, same signature): it now
--     installs the default template — templates row, engagement type, the
--     v3 semantic stage set (founder-ruled rename: `contacted` replaces
--     pending_qualification), field definitions, vocabulary — and points
--     businesses.template_id at the install. First Light rows now render
--     FROM the definition (the session-9 addendum rule), no longer from
--     copy hardcoded in this function;
--   * the transition law — New → Contacted fires automatically on the first
--     genuinely dispatched outbound (not draft, not stamp) — as a trigger on
--     the communications `sent` transition, so it is true whatever code
--     carries the message;
--   * accounts gains the day-3 nurture stamp and the unsubscribe stamp
--     (scope item: nurture days 3 and 7, unsubscribe on all three).

-- ---------------------------------------------------------------------------
-- template_definitions — installable vertical templates, platform-level.
-- JUDGMENT: platform infrastructure, not tenant data — no business envelope
-- (the stripe_events/allowed_emails precedent). RLS on; SELECT is granted to
-- authenticated (the definition is product content — regulated-status
-- options, vocabulary, no-go seed — that signed-in surfaces render from);
-- there are NO write policies: a definition changes only by re-issue with a
-- version bump through a migration (the template-copy law, Session 10's
-- greeting fix applied to the whole template).
-- ---------------------------------------------------------------------------
create table public.template_definitions (
  id uuid primary key default public.uuid_generate_v7(),
  key text not null,
  version int not null,
  display_name text not null,
  definition jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (key, version)
);

create trigger template_definitions_set_updated_at
  before update on public.template_definitions
  for each row execute function private.set_updated_at();

alter table public.template_definitions enable row level security;

create policy template_definitions_select on public.template_definitions
  for select to authenticated
  using (true);
-- No insert/update/delete policies: re-issue by migration only.

-- ---------------------------------------------------------------------------
-- UK Immigration Advisory v3 — the founder content, verbatim from
-- docs/templates/uk-immigration-v3.md with the founder-ruled stage rename
-- from the Session 11 prompt (`contacted` / "Contacted" replaces
-- pending_qualification). British English throughout.
-- ---------------------------------------------------------------------------
insert into public.template_definitions (id, key, version, display_name, definition)
values (
  'd0000000-0000-4000-8000-000000000001',
  'uk_immigration_advisory',
  3,
  'UK Immigration Advisory',
  $defn$
  {
    "signup_footer": "UK Immigration Advisory · v3 applies — Barakah is built for immigration firms first. Vertical settings live in Settings → General.",
    "vocabulary": [
      { "term_key": "engagement", "label": "enquiry" },
      { "term_key": "engagements", "label": "enquiries" },
      { "term_key": "client", "label": "client" },
      { "term_key": "prospective_client", "label": "enquirer" },
      { "term_key": "consultation", "label": "consultation" }
    ],
    "engagement_types": [
      {
        "key": "enquiry",
        "label": "Enquiry",
        "stages": [
          { "key": "new_lead", "label": "New", "sort_order": 1 },
          { "key": "contacted", "label": "Contacted", "sort_order": 2 },
          { "key": "qualified", "label": "Qualified", "sort_order": 3 },
          { "key": "consultation_booked", "label": "Consultation booked", "sort_order": 4 },
          { "key": "consultation_held", "label": "Consultation held", "sort_order": 5 },
          { "key": "instructed", "label": "Instructed", "sort_order": 6 },
          { "key": "won", "label": "Won", "sort_order": 7, "terminal_outcome": "won" },
          { "key": "closed_lost", "label": "Lost", "sort_order": 8, "terminal_outcome": "lost" },
          { "key": "unresponsive", "label": "Unresponsive", "sort_order": 9, "terminal_outcome": "unresponsive" },
          { "key": "disqualified", "label": "Disqualified", "sort_order": 10, "terminal_outcome": "disqualified" }
        ]
      }
    ],
    "field_definitions": [
      { "entity": "contact", "key": "nationality", "label": "Nationality", "data_type": "text" },
      { "entity": "contact", "key": "current_visa_status", "label": "Current visa status", "data_type": "text" },
      { "entity": "contact", "key": "visa_expiry", "label": "Visa expiry", "data_type": "date" },
      { "entity": "engagement", "key": "visa_route", "label": "Visa route", "data_type": "text" },
      { "entity": "engagement", "key": "urgency", "label": "Urgency", "data_type": "text" }
    ],
    "business_identity": {
      "standard_keys": ["business_name", "regulated_status", "address", "business_hours", "languages", "quiet_hours"],
      "regulated_status_options": [
        "IAA Level 1 (advice and assistance)",
        "IAA Level 2 (casework)",
        "IAA Level 3 (advocacy and representation)",
        "SRA-regulated solicitor firm",
        "Not yet accredited / other"
      ],
      "defaults": {
        "locale": "en-GB",
        "timezone": "Europe/London",
        "currency": "GBP",
        "quiet_hours": { "start": "20:00", "end": "08:00" }
      }
    },
    "no_go_rules": [
      "Light never states or implies a guarantee of visa success, application outcome, or Home Office timescales.",
      "Light never gives case-specific legal advice in an unstamped channel — drafts may explain process and generalities; advice happens in consultations with the humans.",
      "Light never quotes fees beyond the firm's published consultation fee without a stamp.",
      "Light never contacts a party identified as the opposing side, a sponsor's employees, or the Home Office."
    ],
    "knowledge_pack_categories": [
      "Service descriptions per visa route (Skilled Worker, Spouse/Family, ILR, Naturalisation, Student, Visitor, EUSS, Asylum & Human Rights, Appeals)",
      "Published fees",
      "Consultation booking policy",
      "Tone exemplars (3–5 approved past emails)",
      "FAQ (financial requirement, evidence formats, processing expectations — generic, non-advisory)"
    ],
    "first_light_rows": [
      { "key": "basics_confirmed", "title": "Confirm your business basics",
        "description": "Light pre-fills what it can — stamp each row or correct it. Fills Settings → General.", "optional": false },
      { "key": "email_calendar_connected", "title": "Connect email & calendar",
        "description": "So Light can draft replies and book from real availability. One door — Settings → Integrations.", "optional": false },
      { "key": "whatsapp_connected", "title": "Connect WhatsApp Business",
        "description": "Where your clients already are. One door — Settings → Integrations.", "optional": false },
      { "key": "meta_lead_forms_connected", "title": "Connect Meta Lead Forms",
        "description": "Only if you run ads — skip freely if you don't. Consent is captured at the form.", "optional": true },
      { "key": "memory_tray_reviewed", "title": "Review what Light found",
        "description": "Proposals from your website wait in the memory tray — confirm, edit or reject each. Nothing is remembered unvouched.", "optional": false },
      { "key": "nogo_rules_acknowledged", "title": "Review your no-go rules",
        "description": "The rules ship with your vertical — read them so you know exactly where Light stops.", "optional": false },
      { "key": "sending_domain_verified", "title": "Verify your sending domain",
        "description": "So your emails arrive as you, and arrive at all. DNS records, guided.", "optional": false },
      { "key": "walkthrough_booked", "title": "Book your walkthrough",
        "description": "An hour with the founder — your setup, your cases, your questions.", "optional": false }
    ]
  }
  $defn$::jsonb
)
on conflict (key, version) do nothing;

-- ---------------------------------------------------------------------------
-- Nurture stamps (scope item 6 — day-3 product story, day-7 founder's note,
-- unsubscribe on all three).
-- JUDGMENT: the session's migration fence names "template storage +
-- predicate needs"; the day-3 stamp and the unsubscribe stamp are read as
-- within the fence's intent — scope item 6 requires both to exist and
-- accounts is their only honest home (an unsubscribed signup must never be
-- mailed again, and that fact must survive the process that learned it).
-- ---------------------------------------------------------------------------
alter table public.accounts
  add column reminder_3d_sent_at timestamptz,
  add column nurture_unsubscribed_at timestamptz;

-- ---------------------------------------------------------------------------
-- The activation door, re-issued (0020 fix-forward; same signature, so no
-- overload ambiguity). New in this issue:
--   * template installation — the deliberate absence 0020 recorded is
--     filled: businesses.template_id becomes real;
--   * the account's workflow engine actor + its enquiries grant.
--     JUDGMENT: dispatch attribution (decision 93) and this session's
--     Contacted transition both require exactly one workflow actor per
--     account; 0020 created none, so a fresh tenant's first dispatched
--     message would fail loudly on attribution. Created here with the same
--     grant the Session 6 engine actor holds.
--   * First Light rows render FROM the template definition (the session-9
--     addendum rule) instead of copy hardcoded below.
-- The ledger is still NOT written here — the caller events through
-- emitEvent() (law 11).
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

-- ---------------------------------------------------------------------------
-- The transition law (founder-ruled, Session 11 prompt): New → Contacted
-- fires automatically on the FIRST genuinely dispatched outbound — not on a
-- draft, not on a stamp. Enforced here as a trigger on the communications
-- `sent` transition so it is true whatever code carries the message; the
-- only path into `sent` is the 0021 door, which re-fires every structural
-- check, and the stage move itself goes through the gated
-- move_engagement_stage() as the account's workflow actor.
--
-- JUDGMENT: "delivered" is read as provider-accepted `sent` — no delivery
-- receipts exist yet for either channel; when they arrive the trigger
-- condition tightens, not the law.
-- JUDGMENT: when the machinery is absent (no `contacted` stage on the
-- engagement's type, or no unique workflow actor) the transition is a
-- NO-OP rather than an exception — a bookkeeping gap must never block
-- carriage of a stamped message. The dispatcher observes the stage after
-- marking sent and events the move when it happened.
-- ---------------------------------------------------------------------------
create or replace function private.contacted_on_first_send()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stage_key text;
  v_type uuid;
  v_contacted uuid;
  v_actor uuid;
begin
  if new.engagement_id is null or new.direction <> 'outbound' then
    return new;
  end if;

  select s.key, e.template_type_id into v_stage_key, v_type
  from public.engagements e
  join public.stage_definitions s on s.id = e.stage_id
  where e.id = new.engagement_id and e.archived_at is null;
  if v_stage_key is distinct from 'new_lead' then
    return new;
  end if;

  select s.id into v_contacted
  from public.stage_definitions s
  where s.engagement_type_id = v_type and s.key = 'contacted' and s.archived_at is null;
  if v_contacted is null then
    return new;
  end if;

  -- Exactly one workflow actor (decision 93) — on ambiguity the transition
  -- no-ops rather than guessing an attribution.
  select case when count(*) = 1 then min(a.id::text)::uuid end into v_actor
  from public.actors a
  join public.businesses b on b.account_id = a.account_id
  where b.id = new.business_id
    and a.actor_type = 'workflow'
    and a.archived_at is null;
  if v_actor is null then
    return new;
  end if;

  perform public.move_engagement_stage(new.engagement_id, v_contacted, v_actor);
  return new;
end;
$$;

create trigger communications_contacted_on_first_send
  after insert or update of status on public.communications
  for each row
  when (new.status = 'sent')
  execute function private.contacted_on_first_send();
