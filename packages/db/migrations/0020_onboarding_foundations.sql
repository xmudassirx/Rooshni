-- 0020: onboarding foundations (Session 9 — ONBOARDING-HANDOVER rulings
-- 79–84; Lane C rulings of 17 July 2026 on platform-scope events, platform
-- mail and the Google-only door).
--
-- What ships here, and why together (enforcement travels with the tables):
--   * signup holding columns on accounts — a pre-active signup is an
--     accounts row (Spec 1 §5.0: "one row per signup"), holding the four
--     signup facts and nothing else until payment clears;
--   * Stripe references on accounts, website_url on businesses;
--   * platform-scope events — events.business_id becomes nullable, lawful
--     ONLY for the account.* namespace (founder-ruled 17 Jul 2026; this is
--     decision 26's recorded revisit trigger arriving: "when platform-level
--     events arrive for other reasons"), plus the one platform system actor;
--   * stripe_events — webhook idempotency on Stripe's own event id
--     (external-integrations discipline: replay changes nothing);
--   * first_light_predicates — decision 82: predicates are ROWS, state in
--     the database, satisfied-flips paired to ledger events by constraint;
--   * the activation door public.activate_signup() and the deletion door
--     public.delete_unpaid_signup() — service-role only, atomic, idempotent.
--     Neither writes the ledger: events go through emitEvent() in the app
--     layer, per law 11 (the 0019 precedent).

-- ---------------------------------------------------------------------------
-- businesses.website_url — held from signup step 1, read by the crawler
-- session later. Costs nothing to hold (decision 80).
-- ---------------------------------------------------------------------------
alter table public.businesses add column website_url text;

-- ---------------------------------------------------------------------------
-- accounts: signup holding fields + Stripe references + lifecycle stamps.
-- JUDGMENT: the session prompt sketches "businesses gains website_url, plan,
-- stripe refs" but cedes placement as builder's call — plan already lives on
-- accounts (Spec 1 §5.0) and billing identity is account-level (the account
-- is the person, master context 3.11), so the Stripe references land on
-- accounts and only website_url lands on businesses.
-- JUDGMENT: the pre-active record is ruled to hold "name, email, phone, URL
-- only" — signup_business_name is held as well, read as within the ruling's
-- data-minimisation intent: without it activation cannot name the business
-- the payer paid for.
-- ---------------------------------------------------------------------------
alter table public.accounts
  add column signup_business_name text,
  add column signup_email text
    constraint accounts_signup_email_is_lower check (signup_email = lower(signup_email))
    constraint accounts_signup_email_shape check (signup_email is null or position('@' in signup_email) > 1),
  add column signup_phone text,
  add column signup_website_url text,
  -- Fully random (v4) — the resume link in reminder emails must not carry a
  -- timestamp-prefixed (partially guessable) v7 id.
  add column signup_resume_token uuid not null default gen_random_uuid(),
  add column reminder_24h_sent_at timestamptz,
  add column reminder_7d_sent_at timestamptz,
  add column activated_at timestamptz,
  add column stripe_customer_id text,
  add column stripe_subscription_id text;

create unique index accounts_signup_resume_token_uniq on public.accounts (signup_resume_token);
create unique index accounts_stripe_customer_uniq on public.accounts (stripe_customer_id)
  where stripe_customer_id is not null;
create unique index accounts_stripe_subscription_uniq on public.accounts (stripe_subscription_id)
  where stripe_subscription_id is not null;
-- The pre-active sweep walks unpaid signups by age.
create index accounts_pre_active_created_idx on public.accounts (created_at)
  where billing_status = 'pre_active';

-- ---------------------------------------------------------------------------
-- Platform-scope events (founder-ruled, 17 July 2026; decision 26's revisit
-- trigger). account.deleted_unpaid must land on the ledger, and a deleted
-- unpaid signup has no business and no tenant actor. business_id becomes
-- nullable, guarded: a null business is lawful ONLY for the account.*
-- namespace. Tenant RLS is untouched — the 0012 select policy keys on
-- business membership, so a platform-scope row is visible to no API caller;
-- append-only enforcement (0004 trigger + 0013 revokes) is untouched.
-- ---------------------------------------------------------------------------
alter table public.events alter column business_id drop not null;
alter table public.events add constraint events_platform_scope_account_namespace
  check (business_id is not null or action like 'account.%');

-- The platform system actor: the hand that signs platform-scope events.
-- actors.account_id null already means platform-level (decision 3).
-- JUDGMENT: actor_type 'workflow' — the sweep is platform automation, the
-- same register as the Session 6 engine actor; no new enum value invented.
insert into public.actors (id, account_id, actor_type, display_name)
values ('b0000000-0000-4000-8000-000000000001', null, 'workflow', 'Barakah platform')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- stripe_events — webhook idempotency on the provider's id (the
-- external-integrations discipline). Platform infrastructure, not tenant
-- data: no business envelope (the 0018 allowed_emails precedent). RLS on
-- with no policies — service-role only, like allowlist management.
-- ---------------------------------------------------------------------------
create table public.stripe_events (
  id uuid primary key default public.uuid_generate_v7(),
  stripe_event_id text not null,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  outcome text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index stripe_events_stripe_event_id_uniq on public.stripe_events (stripe_event_id);

create trigger stripe_events_set_updated_at
  before update on public.stripe_events
  for each row execute function private.set_updated_at();

alter table public.stripe_events enable row level security;
-- No policies: webhook processing is service-role only; no signed-in user
-- has any business reading raw provider payloads.

-- ---------------------------------------------------------------------------
-- first_light_predicates (decision 82) — every First Light tick is EARNED by
-- a deterministic predicate; predicates are rows, state in the database,
-- flips evented on The Record. The pairing is structural: satisfied_at and
-- satisfied_event_id move together (the 0017 all-or-none precedent), so an
-- uneventful flip is impossible, not discouraged.
-- ---------------------------------------------------------------------------
create table public.first_light_predicates (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '[]'::jsonb,

  task_id uuid not null references public.tasks (id),
  predicate_key text not null,
  -- JUDGMENT: decision 82 marks the Meta Lead Forms row "skippable
  -- (only-if-running-ads, stated)" — the flag records which rows may be
  -- skipped; skip semantics themselves are Session B's (First Light panel).
  optional boolean not null default false,
  satisfied_at timestamptz,
  satisfied_event_id uuid references public.events (id),

  constraint first_light_predicates_key_uniq unique (business_id, predicate_key),
  constraint first_light_predicates_flip_is_evented check (
    (satisfied_at is null) = (satisfied_event_id is null)
  )
);

create index first_light_predicates_business_idx on public.first_light_predicates (business_id);
create index first_light_predicates_task_idx on public.first_light_predicates (task_id);

create trigger first_light_predicates_set_updated_at
  before update on public.first_light_predicates
  for each row execute function private.set_updated_at();

alter table public.first_light_predicates enable row level security;

-- Members read their business's rows; nobody writes through the API.
-- JUDGMENT: select-only deviates from the template's member-insert/update
-- policies deliberately — evaluation logic runs server-side (founder-ruled,
-- handover carried question 3), so flips arrive via service role only and a
-- tick can never be self-reported from a browser.
create policy first_light_predicates_select on public.first_light_predicates
  for select to authenticated
  using (business_id in (select private.actor_business_ids()));

-- ---------------------------------------------------------------------------
-- The activation door. payment.succeeded is the only caller (via the
-- webhook route, service role). Atomic and idempotent: a second call for an
-- activated account is a recorded no-op, so Stripe replays re-do nothing.
-- Creates: the business, the owner/Light/Stripe actors, the owner
-- membership, the allowlist row (the Google door, decision 24/25 machinery),
-- Light's decision-6 grant bundle (granted by the owner), and the First
-- Light task + predicate rows (decision 82's eight, Meta optional).
-- The ledger is NOT written here — the caller events through emitEvent().
-- JUDGMENT: First Light rows carry no due_at — the panel is their surface;
-- a timer would either hardcode a duration (unlawful, law 11) or invent one.
-- JUDGMENT: template installation is deliberately absent — see the session
-- report: no UK Immigration v3 definition exists in the repo to install.
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
  v_business uuid;
  v_owner_actor uuid;
  v_light_actor uuid;
  v_stripe_actor uuid;
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

  insert into public.memberships (user_id, business_id, role)
  values (p_owner_user_id, v_business, 'owner');

  -- The Google door: sign-in completes via the allowlist + Supabase's
  -- verified-email auto-linking (decisions 24/25; founder-ruled 17 Jul 2026).
  insert into public.allowed_emails (email, note)
  values (v_acc.signup_email, 'signup activation — account ' || p_account)
  on conflict (email) do nothing;

  -- Light's Phase 1 bundle (decision 6), granted by the owner at activation —
  -- the first application of the bundle outside the seed (founder-approved).
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

  -- First Light rows (decision 82) — REAL task rows, tagged, one predicate
  -- row each. created_by Light (it is Light's channel; the grant above is
  -- what lets these inserts through the 0015 Level 2 gate — proven in
  -- check-local), assigned to the owner.
  for r in
    select * from (values
      ('basics_confirmed',            'Confirm your business basics',
       'Light pre-fills what your website said — stamp each row or correct it. Fills Settings → General.', false),
      ('email_calendar_connected',    'Connect email & calendar',
       'So Light can draft replies and book from real availability. One door — Settings → Integrations.', false),
      ('whatsapp_connected',          'Connect WhatsApp Business',
       'Where your clients already are. One door — Settings → Integrations.', false),
      ('meta_lead_forms_connected',   'Connect Meta Lead Forms',
       'Only if you run ads — skip freely if you don''t. Consent is captured at the form.', true),
      ('memory_tray_reviewed',        'Review what Light found',
       'Proposals from your website wait in the memory tray — confirm, edit or reject each. Nothing is remembered unvouched.', false),
      ('nogo_rules_acknowledged',     'Review your no-go rules',
       'The rules ship with your vertical — read them so you know exactly where Light stops.', false),
      ('sending_domain_verified',     'Verify your sending domain',
       'So your emails arrive as you, and arrive at all. DNS records, guided.', false),
      ('walkthrough_booked',          'Book your walkthrough',
       'An hour with the founder — your setup, your cases, your questions.', false)
    ) as t (key, title, description, optional)
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
      (v_business, v_light_actor, v_task, r.key, r.optional);

    v_task_ids := v_task_ids || jsonb_build_object(r.key, v_task);
  end loop;

  return jsonb_build_object(
    'already_active', false,
    'business_id', v_business,
    'owner_actor_id', v_owner_actor,
    'light_actor_id', v_light_actor,
    'stripe_actor_id', v_stripe_actor,
    'grant_ids', v_grant_ids,
    'task_ids', v_task_ids
  );
end;
$$;

revoke all on function public.activate_signup(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.activate_signup(uuid, uuid, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- The deletion door for the 30-day sweep. Refuses anything that is not a
-- pre-active, business-less signup — the guard lives here, not in app code
-- (an activated account can NEVER fall to this function, whatever the
-- caller's bug). The caller events account.deleted_unpaid (platform scope)
-- through emitEvent() after the row is gone.
-- ---------------------------------------------------------------------------
create or replace function public.delete_unpaid_signup(p_account uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_acc public.accounts%rowtype;
begin
  select * into v_acc from public.accounts where id = p_account for update;
  if not found then
    return false;
  end if;
  if v_acc.activated_at is not null or v_acc.billing_status <> 'pre_active' then
    raise exception 'delete_unpaid_signup: account % is not a pre-active signup — refusing', p_account;
  end if;
  if exists (select 1 from public.businesses b where b.account_id = p_account) then
    raise exception 'delete_unpaid_signup: account % has a business — refusing', p_account;
  end if;
  if exists (select 1 from public.actors a where a.account_id = p_account) then
    raise exception 'delete_unpaid_signup: account % has actors — refusing', p_account;
  end if;

  delete from public.accounts where id = p_account;
  return true;
end;
$$;

revoke all on function public.delete_unpaid_signup(uuid) from public, anon, authenticated;
grant execute on function public.delete_unpaid_signup(uuid) to service_role;
