-- 0010: money domain (Spec 1 §4.6) — what is owed, paid, and spent.
-- Operational money truth; the general ledger stays connected (Xero).

create type public.invoice_status as enum ('draft', 'pending_approval', 'issued', 'paid', 'partially_paid', 'overdue', 'void');
create type public.payment_method as enum ('stripe', 'bank_transfer', 'cash', 'other');
create type public.spend_source as enum ('meta_ads', 'google_ads', 'platform_credits', 'other');

create table public.invoices (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '[]'::jsonb,

  engagement_id uuid references public.engagements (id),
  contact_id uuid not null references public.contacts (id),
  -- Per-business sequence (§4.6); allocation is an application concern.
  number int not null,
  status public.invoice_status not null default 'draft',
  currency text not null default 'GBP',
  issued_at timestamptz,
  due_at timestamptz,
  -- Computed from invoice_lines by the application when lines change.
  total numeric not null default 0,
  unique (business_id, number)
);

create index invoices_business_idx on public.invoices (business_id);
create index invoices_contact_idx on public.invoices (contact_id);
create index invoices_engagement_idx on public.invoices (engagement_id) where engagement_id is not null;

create trigger invoices_set_updated_at
  before update on public.invoices
  for each row execute function private.set_updated_at();

-- Line-level tax because UK VAT treatment varies by service (§4.6).
create table public.invoice_lines (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '[]'::jsonb,

  invoice_id uuid not null references public.invoices (id),
  description text not null,
  quantity numeric not null default 1,
  unit_amount numeric not null,
  tax_rate numeric not null default 0
);

create index invoice_lines_invoice_idx on public.invoice_lines (invoice_id);

create trigger invoice_lines_set_updated_at
  before update on public.invoice_lines
  for each row execute function private.set_updated_at();

-- Stripe webhooks create these via an integration actor; reconciliation is
-- AI-proposed, human-approved (§4.6).
create table public.payments (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '[]'::jsonb,

  -- Nullable: supports on-account payments.
  invoice_id uuid references public.invoices (id),
  contact_id uuid not null references public.contacts (id),
  amount numeric not null,
  currency text not null default 'GBP',
  method public.payment_method not null,
  received_at timestamptz not null default now(),
  reconciled boolean not null default false
);

create index payments_invoice_idx on public.payments (invoice_id) where invoice_id is not null;
create index payments_contact_idx on public.payments (contact_id);

create trigger payments_set_updated_at
  before update on public.payments
  for each row execute function private.set_updated_at();

-- The missing half of the moat loop: money out beside money in (§4.6).
create table public.spend_records (
  id uuid primary key default public.uuid_generate_v7(),
  business_id uuid not null references public.businesses (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references public.actors (id),
  archived_at timestamptz,
  attributes jsonb not null default '{}'::jsonb,
  external_refs jsonb not null default '[]'::jsonb,

  source public.spend_source not null,
  campaign_id text,
  adset_id text,
  ad_id text,
  period_start date not null,
  period_end date not null,
  amount numeric not null,
  currency text not null default 'GBP'
);

create index spend_records_business_idx on public.spend_records (business_id, period_start);

create trigger spend_records_set_updated_at
  before update on public.spend_records
  for each row execute function private.set_updated_at();
