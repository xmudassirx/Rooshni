-- 0033: Gmail inbound claims (Session 20) — Google Workspace joins Microsoft
-- Graph as an ALTERNATIVE tenant-mail provider, selected per business
-- (businesses.settings.mail_provider, default graph). The mail-pipes law
-- stands: Resend = platform mail, tenant mail = the firm's own provider —
-- and per-tenant selection changes nothing about the pipes never mixing.
--
-- This migration ships only the idempotency claim table for the Gmail
-- inbound poll — the exact sibling of 0028's graph_mail_events. Provider
-- selection and the mailbox binding live in businesses.settings (the
-- settings.graph.mailbox precedent, set by wire-inbound), which needs no
-- schema; the send/poll adapters are TypeScript.
--
-- Standing principle: anything that must be true is enforced in the
-- database; the app being well-behaved is not a control.

-- ---------------------------------------------------------------------------
-- gmail_mail_events — idempotency on the inbound mail's RFC 5322 message id.
-- JUDGMENT: platform infrastructure, not tenant data — no business envelope
-- (the graph_mail_events / meta_webhook_events precedent, decision 95); the
-- business is resolved during processing and recorded in `outcome`. RLS on
-- with no policies: service-role only. The claim key is the RFC
-- internet_message_id, not Gmail's own row id — the RFC id is the stable
-- identity and matches the References/In-Reply-To vocabulary the thread
-- matcher reads (the 0028 graph_mail_events reasoning, unchanged).
-- ---------------------------------------------------------------------------
create table public.gmail_mail_events (
  id uuid primary key default public.uuid_generate_v7(),
  internet_message_id text not null,
  gmail_message_id text,
  mailbox text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  outcome text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index gmail_mail_events_message_id_uniq
  on public.gmail_mail_events (internet_message_id);

create trigger gmail_mail_events_set_updated_at
  before update on public.gmail_mail_events
  for each row execute function private.set_updated_at();

alter table public.gmail_mail_events enable row level security;
