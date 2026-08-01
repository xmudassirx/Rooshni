-- 0028: inbound capture (Session 16, PR-A) — the supersede engine's
-- prerequisite. Inbound messages become communications rows (direction
-- inbound, status received); this migration ships the idempotency claim
-- tables for both inbound doors and the thread-level state PR-A names.
--
-- WhatsApp inbound arrives via the Cloud API webhook (route
-- /api/whatsapp/webhook — signature verified against the raw body before
-- parsing, the meta_webhook_events discipline). Email inbound arrives via a
-- Microsoft Graph poll on the existing 5-minute cron (webhook subscriptions
-- are a recorded GO-LIVE future tightening). Both paths are idempotent on
-- the PROVIDER's message id: a webhook replay or an overlapping poll hits a
-- unique index and changes nothing.
--
-- Standing principle: anything that must be true is enforced in the
-- database; the app being well-behaved is not a control.

-- ---------------------------------------------------------------------------
-- wa_webhook_events — idempotency on WhatsApp's message id (wamid).
-- JUDGMENT: platform infrastructure, not tenant data — no business envelope
-- (the meta_webhook_events / stripe_events precedent, decision 95); the
-- business is resolved during processing and recorded in `outcome`. RLS on
-- with no policies: service-role only — no signed-in user has any business
-- reading raw provider payloads.
-- ---------------------------------------------------------------------------
create table public.wa_webhook_events (
  id uuid primary key default public.uuid_generate_v7(),
  wamid text not null,
  phone_number_id text,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  outcome text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index wa_webhook_events_wamid_uniq on public.wa_webhook_events (wamid);

create trigger wa_webhook_events_set_updated_at
  before update on public.wa_webhook_events
  for each row execute function private.set_updated_at();

alter table public.wa_webhook_events enable row level security;

-- ---------------------------------------------------------------------------
-- graph_mail_events — idempotency on the inbound mail's RFC 5322 message id.
-- JUDGMENT: the claim key is internet_message_id, not Graph's own row id —
-- Graph message ids MUTATE when a message changes folder; the RFC id is the
-- stable identity (and matches the References/In-Reply-To vocabulary the
-- thread matcher reads). Same platform-infrastructure shape as above.
-- ---------------------------------------------------------------------------
create table public.graph_mail_events (
  id uuid primary key default public.uuid_generate_v7(),
  internet_message_id text not null,
  graph_message_id text,
  mailbox text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  outcome text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index graph_mail_events_message_id_uniq
  on public.graph_mail_events (internet_message_id);

create trigger graph_mail_events_set_updated_at
  before update on public.graph_mail_events
  for each row execute function private.set_updated_at();

alter table public.graph_mail_events enable row level security;

-- ---------------------------------------------------------------------------
-- Thread-level inbound state (PR-A: "record the window state on the thread").
--
-- wa_service_window_expires_at: when Meta's 24-hour customer-service window,
-- opened by the client's last inbound WhatsApp message, closes. PROVIDER law
-- in real time (the decision 92 / claim-lease class — never TIME_SCALE
-- data). The ENFORCEMENT truth remains the 0021 pre-flight's query over
-- inbound communications rows; this column is the recorded state the
-- Conversations surface renders.
--
-- last_inbound_at: the client's most recent inbound on this thread, any
-- channel.
-- JUDGMENT: last_inbound_at is additive bookkeeping the spec's column list
-- omits (decision 4 class) — the settle engine (PR-C) and the Conversations
-- surface both read it; deriving it per render would re-scan communications.
-- ---------------------------------------------------------------------------
alter table public.comm_threads
  add column last_inbound_at timestamptz,
  add column wa_service_window_expires_at timestamptz;
